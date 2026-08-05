// GPU particle simulation: WGSL codegen.
//
// A sim-shader emitter owns its particle state in a GPU storage buffer and
// steps it with a compute shader. The user writes two hooks:
//
//   fn spawn(p: ptr<function, Particle>, ctx: SpawnCtx)     // initialize
//   fn simulate(p: ptr<function, Particle>, ctx: SimCtx)    // per-frame step
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
import { NOISE_WGSL } from './shaderlib.js';
import { LUT_ROW, lutRowV, LUT_SAMPLE_WGSL } from './curves.js';

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

/** Sanitizes a user field list: valid WGSL identifiers, known types, no
 *  collisions with core fields or each other. Returns a clean copy. */
export function sanitizeFields(fields) {
  const seen = new Set(CORE_FIELDS.map(([n]) => n));
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
 *  WGSL struct text and the JS stride/offsets. */
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

const SIM_PRELUDE_HEAD = `${defineBlock(SIM_FIELDS).wgslStruct('SimParams')}
@group(0) @binding(0) var<uniform> sp: SimParams;
@group(0) @binding(4) var ptSamp: sampler;
@group(0) @binding(5) var ptLut: texture_2d<f32>;
${LUT_SAMPLE_WGSL}`;

const SIM_CTX_WGSL = `
// Read-only snapshot of every particle as of the end of last frame. Reading
// the live buffer while other invocations write it would be a data race, so
// the engine copies it aside first — and only when a sim actually mentions
// \`neighbors\`, since the copy costs bandwidth.
@group(0) @binding(6) var<storage, read> neighbors: array<Particle>;

struct SpawnCtx {
  index: u32,        // particle slot
  emitterPos: vec3f,
  time: f32,
}
struct SimCtx {
  index: u32,
  dt: f32,
  time: f32,
}

// Deterministic per-invocation RNG (PCG). rand() gives a fresh 0..1 each call.
var<private> ptRng: u32;
fn ptSeedRng(a: u32, b: u32) {
  ptRng = (a * 747796405u) ^ (b * 2891336453u) ^ (u32(sp.frameSeed) * 277803737u);
}
fn rand() -> f32 {
  ptRng = ptRng * 747796405u + 2891336453u;
  var x = ((ptRng >> ((ptRng >> 28u) + 4u)) ^ ptRng) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}
fn randRange(lo: f32, hi: f32) -> f32 { return mix(lo, hi, rand()); }
fn randUnitVec() -> vec3f {
  let z = rand() * 2.0 - 1.0;
  let a = rand() * TAU;
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(a), z, r * sin(a));
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
fn curveSpeed(life01: f32) -> f32 {
  return textureSampleLevel(ptLut, ptSamp, vec2f(ptLutU(life01), ${lutRowV(LUT_ROW.speed)}), 0.0).r;
}
fn curveSize(life01: f32) -> f32 {
  return textureSampleLevel(ptLut, ptSamp, vec2f(ptLutU(life01), ${lutRowV(LUT_ROW.size)}), 0.0).r;
}
fn curveColor(life01: f32) -> vec3f {
  return textureSampleLevel(ptLut, ptSamp, vec2f(ptLutU(life01), ${lutRowV(LUT_ROW.color)}), 0.0).rgb;
}
fn curveAlpha(life01: f32) -> f32 {
  return textureSampleLevel(ptLut, ptSamp, vec2f(ptLutU(life01), ${lutRowV(LUT_ROW.color)}), 0.0).a;
}
`;

// ---------------------------------------------------------------- kernels

const SIM_MAIN = `
struct InstanceData {
  posSize: vec4f,  // xyz center, w size
  color: vec4f,
  misc: vec4f,     // x life01, y seed, z rotation, w free
  vel: vec4f,
}
struct DrawArgs {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> instOut: array<InstanceData>;
@group(0) @binding(3) var<storage, read_write> args: DrawArgs;

fn ptWriteInstance(slot: u32, p: Particle) {
  var inst: InstanceData;
  let lifeN = saturate(p.age / max(p.lifetime, 1e-4));
  inst.posSize = vec4f(p.position, p.size);
  inst.color = p.color;
  inst.misc = vec4f(lifeN, p.seed, p.rotation, 0.0);
  inst.vel = vec4f(p.velocity, 0.0);
  instOut[slot] = inst;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn spawnMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(sp.spawnCount)) { return; }
  let slot = (u32(sp.spawnCursor) + i) % u32(sp.capacity);
  ptSeedRng(slot + 1u, i + 0x9e3779b9u);
  var p: Particle;             // zero-initialized
  p.age = 0.0;
  p.seed = rand();
  var ctx: SpawnCtx;
  ctx.index = slot;
  ctx.emitterPos = sp.emitterPos;
  ctx.time = sp.time;
  spawn(&p, ctx);
  p.lifetime = max(p.lifetime, 0.01);
  particles[slot] = p;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn updateMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(sp.capacity)) { return; }
  var p = particles[i];
  if (p.lifetime <= 0.0) { return; }        // free slot
  p.age += sp.dt;
  if (p.age >= p.lifetime) {                // died this frame
    particles[i].lifetime = 0.0;
    return;
  }
  ptSeedRng(i + 1u, 0xffffu);
  var ctx: SimCtx;
  ctx.index = i;
  ctx.dt = sp.dt;
  ctx.time = sp.time;
  simulate(&p, ctx);
  particles[i] = p;
  let slot = atomicAdd(&args.instanceCount, 1u);
  ptWriteInstance(slot, p);
}
`;

function countLines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

/** Builds the complete sim module for an emitter. userFields extend the
 *  Particle struct; userCode supplies spawn()/simulate(). */
export function buildSimWGSL(userCode, userFields) {
  const pStruct = particleBlock(userFields).wgslStruct('Particle');
  const prelude = SIM_PRELUDE_HEAD + NOISE_WGSL + pStruct + '\n' + SIM_CTX_WGSL;
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

fn spawn(p: ptr<function, Particle>, ctx: SpawnCtx) {
  // --- emission shape -> local position + direction
  var pos = vec3f(0.0);
  var dir = vec3f(0.0, 1.0, 0.0);
  let st = sp.shapeType;
  if (st == 0) {                       // point
    dir = randUnitVec();
  } else if (st == 1 || st == 2) {     // sphere / hemisphere
    var uv3 = randUnitVec();
    let r = sp.shapeRadius * pow(rand(), 1.0 / 3.0);
    if (st == 2 && uv3.y < 0.0) { uv3.y = -uv3.y; }
    pos = uv3 * r;
    dir = uv3;
  } else if (st == 3) {                // cone
    let a = rand() * TAU;
    let rr = sp.shapeRadius * sqrt(rand());
    pos = vec3f(cos(a) * rr, 0.0, sin(a) * rr);
    let ang = sp.shapeAngle * sqrt(rand());
    let az = rand() * TAU;
    let sa = sin(ang);
    dir = vec3f(sa * cos(az), cos(ang), sa * sin(az));
  } else if (st == 4) {                // box
    pos = (vec3f(rand(), rand(), rand()) - 0.5) * sp.boxSize;
  } else if (st == 5) {                // circle
    let a = rand() * TAU;
    pos = vec3f(cos(a) * sp.shapeRadius, 0.0, sin(a) * sp.shapeRadius);
    dir = vec3f(cos(a), 0.0, sin(a));
  }
  if (sp.spread > 0.0) {
    dir = normalize(mix(dir, randUnitVec(), sp.spread));
  }

  p.position = pos + sp.emitterPos;
  p.velocity = dir * randRange(sp.speedRange.x, sp.speedRange.y);
  p.lifetime = randRange(sp.lifetimeRange.x, sp.lifetimeRange.y);  // Lifetime (s)
  p.size = randRange(sp.sizeRange.x, sp.sizeRange.y);              // Start size
  p.rotation = randRange(sp.rotationRange.x, sp.rotationRange.y);
  p.rotVel = randRange(sp.rotSpeedRange.x, sp.rotSpeedRange.y);
  p.color = mix(sp.colorA, sp.colorB, rand());
}

fn simulate(p: ptr<function, Particle>, ctx: SimCtx) {
  let dragK = max(0.0, 1.0 - sp.drag * ctx.dt);
  p.velocity = (p.velocity + sp.gravity * ctx.dt) * dragK;
  let speedMul = curveSpeed(p.age / p.lifetime);   // Speed/life curve
  p.position += p.velocity * speedMul * ctx.dt;
  p.rotation += p.rotVel * ctx.dt;
}
`;
