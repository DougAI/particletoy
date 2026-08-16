// GPU particle simulation: Slang codegen.
//
// A sim-shader emitter owns its particle state in a GPU storage buffer and
// steps it with a compute shader. The user writes two hooks:
//
//   void spawn(inout Particle p, SpawnCtx ctx)     // initialize
//   void simulate(inout Particle p, SimCtx ctx)    // per-frame step
//
// The engine wraps them with spawn/update kernels, slot recycling (ring
// cursor fed by the CPU's rate/burst logic), instance compaction via an
// atomic counter, and indirect draw args — so dead particles cost nothing to
// render and no CPU readback is needed.
//
// The Particle struct = core fields (below) + user-defined fields from the
// emitter's schema. PROPS_SIM_SRC reproduces the property-editor behavior
// entirely from uniforms; it is also what "Convert to sim shader" hands the
// user as a starting point.

import { defineBlock } from './gpu.js';
import { NOISE_SLANG } from './shaderlib.js';
import { LUT_ROW, lutRowV, LUT_SAMPLE_SLANG } from './curves.js';

export const WORKGROUP_SIZE = 64;

// Engine-managed core fields. age/lifetime/seed drive the lifecycle; the rest
// feed the renderer's instance data every frame.
export const CORE_FIELDS = [
  ['position', 'vec3'], ['age', 'f32'],
  ['velocity', 'vec3'], ['lifetime', 'f32'],
  ['color', 'vec4'],
  ['seed', 'f32'], ['size', 'f32'], ['rotation', 'f32'], ['rotVel', 'f32'],
];

export const FIELD_TYPES = ['f32', 'vec2', 'vec3', 'vec4'];

// Slang keywords and built-in type names that are legal WGSL field names but
// would not survive being written into a Slang struct. `float`/`int`/`bool` and
// friends were perfectly good field names under WGSL, so this list is doing
// real work for anyone who had one.
const RESERVED_FIELD_NAMES = [
  'in', 'out', 'inout', 'static', 'const', 'struct', 'class', 'interface',
  'extension', 'typedef', 'namespace', 'import', 'export', 'uniform',
  'void', 'bool', 'int', 'uint', 'half', 'float', 'double',
  'float2', 'float3', 'float4', 'int2', 'int3', 'int4', 'uint2', 'uint3', 'uint4',
  'bool2', 'bool3', 'bool4', 'matrix', 'vector',
  'true', 'false', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'default', 'break', 'continue', 'return', 'discard',
];

/** Sanitizes a user field list: valid Slang identifiers, known types, no
 *  collisions with core fields, reserved words, or each other. Returns a clean
 *  copy. */
export function sanitizeFields(fields) {
  const seen = new Set([...CORE_FIELDS.map(([n]) => n), ...RESERVED_FIELD_NAMES]);
  const out = [];
  for (const f of fields || []) {
    const name = String(f.name || '').replace(/\W/g, '');
    if (!name || /^\d/.test(name) || seen.has(name)) continue;
    if (!FIELD_TYPES.includes(f.type)) continue;
    seen.add(name);
    out.push({ name, type: f.type, init: f.init ?? 0 });
  }
  return out;
}

/** Particle struct layout (core + user fields) — one source of truth for the
 *  Slang struct text and the JS stride that sizes the particle buffer.
 *
 *  Slang lays this struct out under the same std430 rules defineBlock encodes,
 *  and the two were checked field for field against Slang's own reflection.
 *  The one place they could in principle disagree is the trailing pad:
 *  defineBlock always rounds the total to 16, while the real rule rounds to the
 *  struct's own alignment. Those coincide here because CORE_FIELDS always
 *  contributes a vec3 and a vec4, so the alignment is always 16 no matter what
 *  the user adds — user fields are limited to f32/vec2/vec3/vec4, none of which
 *  can raise it. Undersizing this buffer would be a silent out-of-bounds, so
 *  that invariant is worth preserving if CORE_FIELDS ever changes. */
export function particleBlock(userFields) {
  const fields = [...CORE_FIELDS, ...sanitizeFields(userFields).map((f) => [f.name, f.type])];
  return defineBlock(fields);
}

// Per-dispatch uniforms. In props mode these carry every emitter parameter so
// slider edits are live with zero recompiles; a custom sim can read them too.
export const SIM_FIELDS = [
  ['emitterPos', 'vec3'], ['dt', 'f32'],
  ['gravity', 'vec3'], ['time', 'f32'],
  ['boxSize', 'vec3'], ['drag', 'f32'],
  ['colorA', 'vec4'],
  ['colorB', 'vec4'],
  ['speedRange', 'vec2'], ['lifetimeRange', 'vec2'],
  ['sizeRange', 'vec2'], ['rotationRange', 'vec2'],
  ['rotSpeedRange', 'vec2'], ['spread', 'f32'], ['shapeRadius', 'f32'],
  ['shapeAngle', 'f32'], ['shapeType', 'i32'], ['spawnCount', 'i32'], ['spawnCursor', 'i32'],
  ['capacity', 'i32'], ['frameSeed', 'i32'], ['pad0', 'f32'], ['pad1', 'f32'],
];

export const SHAPE_INDEX = { point: 0, sphere: 1, hemisphere: 2, cone: 3, box: 4, circle: 5 };

// ---------------------------------------------------------------- prelude

const SIM_PRELUDE_HEAD = `${defineBlock(SIM_FIELDS).slangStruct('SimParams')}
[[vk::binding(0, 0)]] ConstantBuffer<SimParams> sp;
[[vk::binding(4, 0)]] SamplerState ptSamp;
[[vk::binding(5, 0)]] Texture2D<float4> ptLut;
${LUT_SAMPLE_SLANG}`;

const SIM_CTX_SLANG = `
// Read-only snapshot of every particle as of the end of last frame. Reading
// the live buffer while other invocations write it would be a data race, so
// the engine copies it aside first — and only when a sim actually mentions
// \`neighbors\`, since the copy costs bandwidth.
[[vk::binding(6, 0)]] StructuredBuffer<Particle> neighbors;

struct SpawnCtx {
  uint index;        // particle slot
  float3 emitterPos;
  float time;
};
struct SimCtx {
  uint index;
  float dt;
  float time;
};

// Deterministic per-invocation RNG (PCG). rand() gives a fresh 0..1 each call.
static uint ptRng;
void ptSeedRng(uint a, uint b) {
  ptRng = (a * 747796405u) ^ (b * 2891336453u) ^ (uint(sp.frameSeed) * 277803737u);
}
float rand() {
  ptRng = ptRng * 747796405u + 2891336453u;
  uint x = ((ptRng >> ((ptRng >> 28u) + 4u)) ^ ptRng) * 277803737u;
  x = (x >> 22u) ^ x;
  return float(x) / 4294967295.0;
}
float randRange(float lo, float hi) { return lerp(lo, hi, rand()); }
float3 randUnitVec() {
  float z = rand() * 2.0 - 1.0;
  float a = rand() * TAU;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return float3(r * cos(a), z, r * sin(a));
}

// The emitter's over-lifetime curves, baked by the editor into one small LUT
// texture that the sim and the renderer share.
//
// Only Speed/life is the sim's job to apply — see simulate() below. Size/life,
// Color/life and Alpha/life are applied to the instance data at draw time (for
// both sim modes), so p.size and p.color stay the values spawn() gave them and
// multiplying a curve in here would apply it twice. They're readable anyway:
// a sim that needs the size a particle is actually drawn at (collisions,
// spacing, spawning children) wants base size * curveSize(life01).
float curveSpeed(float life01) {
  return ptLut.SampleLevel(ptSamp, float2(ptLutU(life01), ${lutRowV(LUT_ROW.speed)}), 0).r;
}
float curveSize(float life01) {
  return ptLut.SampleLevel(ptSamp, float2(ptLutU(life01), ${lutRowV(LUT_ROW.size)}), 0).r;
}
float3 curveColor(float life01) {
  return ptLut.SampleLevel(ptSamp, float2(ptLutU(life01), ${lutRowV(LUT_ROW.color)}), 0).rgb;
}
float curveAlpha(float life01) {
  return ptLut.SampleLevel(ptSamp, float2(ptLutU(life01), ${lutRowV(LUT_ROW.color)}), 0).a;
}
`;

// ---------------------------------------------------------------- kernels

const SIM_MAIN = `
struct InstanceData {
  float4 posSize;  // xyz center, w size
  float4 color;
  float4 misc;     // x life01, y seed, z rotation, w free
  float4 vel;
};
// instanceCount is Atomic<uint> rather than a plain uint incremented with
// InterlockedAdd: Slang rejects InterlockedAdd on the WGSL target outright
// (E36107), and only the Atomic<T> type lowers to WGSL's atomic<u32>.
struct DrawArgs {
  uint indexCount;
  Atomic<uint> instanceCount;
  uint firstIndex;
  uint baseVertex;
  uint firstInstance;
};
[[vk::binding(1, 0)]] RWStructuredBuffer<Particle> particles;
[[vk::binding(2, 0)]] RWStructuredBuffer<InstanceData> instOut;
[[vk::binding(3, 0)]] RWStructuredBuffer<DrawArgs> args;

void ptWriteInstance(uint slot, Particle p) {
  InstanceData inst;
  float lifeN = saturate(p.age / max(p.lifetime, 1e-4));
  inst.posSize = float4(p.position, p.size);
  inst.color = p.color;
  inst.misc = float4(lifeN, p.seed, p.rotation, 0.0);
  inst.vel = float4(p.velocity, 0.0);
  instOut[slot] = inst;
}

[shader("compute")]
[numthreads(${WORKGROUP_SIZE}, 1, 1)]
void spawnMain(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= uint(sp.spawnCount)) { return; }
  uint slot = (uint(sp.spawnCursor) + i) % uint(sp.capacity);
  ptSeedRng(slot + 1u, i + 0x9e3779b9u);
  // Slang, unlike WGSL, does not zero a bare local — and user fields would
  // otherwise start as garbage rather than the 0 the field editor promises.
  Particle p = (Particle)0;
  p.age = 0.0;
  p.seed = rand();
  SpawnCtx ctx;
  ctx.index = slot;
  ctx.emitterPos = sp.emitterPos;
  ctx.time = sp.time;
  spawn(p, ctx);
  p.lifetime = max(p.lifetime, 0.01);
  particles[slot] = p;
}

[shader("compute")]
[numthreads(${WORKGROUP_SIZE}, 1, 1)]
void updateMain(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= uint(sp.capacity)) { return; }
  Particle p = particles[i];
  if (p.lifetime <= 0.0) { return; }        // free slot
  p.age += sp.dt;
  if (p.age >= p.lifetime) {                // died this frame
    particles[i].lifetime = 0.0;
    return;
  }
  ptSeedRng(i + 1u, 0xffffu);
  SimCtx ctx;
  ctx.index = i;
  ctx.dt = sp.dt;
  ctx.time = sp.time;
  simulate(p, ctx);
  particles[i] = p;
  uint slot = args[0].instanceCount.add(1u);
  ptWriteInstance(slot, p);
}
`;

function countLines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

/** Builds the complete sim module for an emitter. userFields extend the
 *  Particle struct; userCode supplies spawn()/simulate(). Returns Slang source
 *  — js/slangc.js turns it into the WGSL the device sees. */
export function buildSimSlang(userCode, userFields) {
  const pStruct = particleBlock(userFields).slangStruct('Particle');
  const prelude = SIM_PRELUDE_HEAD + NOISE_SLANG + pStruct + '\n' + SIM_CTX_SLANG;
  const src = prelude + userCode + '\n' + SIM_MAIN;
  return { src, lineOffset: countLines(prelude) };
}

// ---------------------------------------------------------------- props behavior
//
// The default simulation, expressed in the same dialect users write. Every
// tunable comes from `sp`, so the property editor stays live. This exact text
// is what "Convert to sim shader" places in the editor.
export const PROPS_SIM_SRC = `// Default particle behavior — everything the property editor drives.
// spawn() runs once per new particle; simulate() runs every frame.
// sp.* mirrors the emitter properties (see Help ? for the full list).
//
// What this shader owns, and what it doesn't:
//   Lifetime, Start size/rot/color, the emission shape, gravity, drag and the
//   Speed/life curve are all applied below — they only affect particles
//   through this code now, so deleting a line really does remove the feature.
//   Size/life, Color/life and Alpha/life are applied later, when the particle
//   is drawn: p.size and p.color are the values at birth, and the curves scale
//   them per frame. Read them with curveSize()/curveColor()/curveAlpha() if
//   you need them here, but don't multiply them in — that would apply twice.

void spawn(inout Particle p, SpawnCtx ctx) {
  // --- emission shape -> local position + direction
  float3 pos = float3(0.0);
  float3 dir = float3(0.0, 1.0, 0.0);
  int st = sp.shapeType;
  if (st == 0) {                       // point
    dir = randUnitVec();
  } else if (st == 1 || st == 2) {     // sphere / hemisphere
    float3 uv3 = randUnitVec();
    float r = sp.shapeRadius * pow(rand(), 1.0 / 3.0);
    if (st == 2 && uv3.y < 0.0) { uv3.y = -uv3.y; }
    pos = uv3 * r;
    dir = uv3;
  } else if (st == 3) {                // cone
    float a = rand() * TAU;
    float rr = sp.shapeRadius * sqrt(rand());
    pos = float3(cos(a) * rr, 0.0, sin(a) * rr);
    float ang = sp.shapeAngle * sqrt(rand());
    float az = rand() * TAU;
    float sa = sin(ang);
    dir = float3(sa * cos(az), cos(ang), sa * sin(az));
  } else if (st == 4) {                // box
    pos = (float3(rand(), rand(), rand()) - 0.5) * sp.boxSize;
  } else if (st == 5) {                // circle
    float a = rand() * TAU;
    pos = float3(cos(a) * sp.shapeRadius, 0.0, sin(a) * sp.shapeRadius);
    dir = float3(cos(a), 0.0, sin(a));
  }
  if (sp.spread > 0.0) {
    dir = normalize(lerp(dir, randUnitVec(), sp.spread));
  }

  p.position = pos + sp.emitterPos;
  p.velocity = dir * randRange(sp.speedRange.x, sp.speedRange.y);
  p.lifetime = randRange(sp.lifetimeRange.x, sp.lifetimeRange.y);  // Lifetime (s)
  p.size = randRange(sp.sizeRange.x, sp.sizeRange.y);              // Start size
  p.rotation = randRange(sp.rotationRange.x, sp.rotationRange.y);
  p.rotVel = randRange(sp.rotSpeedRange.x, sp.rotSpeedRange.y);
  p.color = lerp(sp.colorA, sp.colorB, rand());
}

void simulate(inout Particle p, SimCtx ctx) {
  float dragK = max(0.0, 1.0 - sp.drag * ctx.dt);
  p.velocity = (p.velocity + sp.gravity * ctx.dt) * dragK;
  float speedMul = curveSpeed(p.age / p.lifetime);   // Speed/life curve
  p.position += p.velocity * speedMul * ctx.dt;
  p.rotation += p.rotVel * ctx.dt;
}
`;
