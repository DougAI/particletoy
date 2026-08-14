// Shader source library and builders.
//
// User-authored material code is Slang, wrapped shadertoy-style: the user writes
//   void mainVertex(inout VertexData v, Particle p)      (vertex stage)
//   void mainSurface(inout Surface s, SurfaceInput i)    (fragment stage)
// and the engine wraps it with a Slang prelude + entry point for each pipeline
// variant:
//   'gbuffer' — writes PBR surface data to MRT G-buffer (deferred, opaque/cutout)
//   'forward' — full PBR lighting evaluated inline (forward pipeline, and
//               blended particles in the deferred pipeline)
// The whole module is then compiled to WGSL by js/slangc.js.
//
// The engine's own fullscreen and floor passes stay hand-written WGSL: they
// never touch user code, so routing them through the compiler would only add
// startup cost — and it would put the 24 MB wasm on the critical path for the
// gallery pages, which must never load it.
//
// Uniform data reaches shaders through two uniform blocks whose layouts are
// generated from the field lists below (see defineBlock in gpu.js), so the
// shader structs and the JS byte offsets always agree.

import { defineBlock } from './gpu.js';
import { LUT_ROW, lutRowV, LUT_SAMPLE_WGSL, LUT_SAMPLE_SLANG } from './curves.js';

// Render-target formats shared by the renderer (pass setup) and materials
// (pipeline fragment targets). Living here avoids an import cycle.
export const GBUF_FORMATS = ['rgba8unorm', 'rgba8unorm', 'rgba16float']; // albedo+metal, normal+rough, emissive+AO
export const SCENE_FORMAT = 'rgba16float';
export const DEPTH_FORMAT = 'depth32float';

// ---------------------------------------------------------------- uniform blocks

// Per-frame data shared by every pass. Exposed to user code as `u.<field>`.
export const FRAME_FIELDS = [
  ['view', 'mat4'],
  ['proj', 'mat4'],
  ['invViewProj', 'mat4'],
  ['cameraPos', 'vec3'], ['time', 'f32'],
  ['resolution', 'vec2'], ['nearFar', 'vec2'],
  ['mouse', 'vec4'],           // xy pixels (y-up), z = mouse down
  ['sunDir', 'vec3'], ['ambient', 'f32'],
  ['sunColor', 'vec3'], ['numPoints', 'i32'],
  ['skyTop', 'vec3'], ['pad0', 'f32'],
  ['skyBottom', 'vec3'], ['pad1', 'f32'],
  ['pointPos', 'vec4', 4],
  ['pointColor', 'vec4', 4],
];

// Per-emitter-draw data (internal; not part of the documented user API).
export const DRAW_FIELDS = [
  ['meshMode', 'i32'],      // 0 = camera-facing quad, 1 = mesh
  ['alphaCutoff', 'f32'],
  ['softDistance', 'f32'],
  ['hasGBuffer', 'f32'],
];

export const LIGHTPASS_FIELDS = [['debugMode', 'i32']]; // 0 lit, 1 albedo, 2 normal, 3 rough/metal, 4 emissive, 5 depth
export const FLOOR_FIELDS = [['gridEnabled', 'f32']];
export const BRIGHT_FIELDS = [['threshold', 'f32']];
export const BLUR_FIELDS = [['dir', 'vec2']];           // texel-space step
export const POST_FIELDS = [['exposure', 'f32'], ['bloomIntensity', 'f32'], ['mode', 'i32']];

// The WGSL frame binding is still used by the engine's own passes (sky,
// deferred lighting, floor); the rest of the group-0 slots are declared only in
// Slang now, since materials are the only thing that binds them.
const FRAME_STRUCT = defineBlock(FRAME_FIELDS).wgslStruct('Frame');

const FRAME_BINDING = `${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> u: Frame;
`;

// ---------------------------------------------------------------- Slang bindings
//
// Same group-0 slots as the WGSL blocks above. Slang honours [[vk::binding]]
// exactly, so the bind group layouts in renderer.js are untouched.
//
// One type does shift: the depth texture is Texture2D<float>, which Slang emits
// as texture_2d<f32> rather than WGSL's texture_depth_2d. HLSL has no distinct
// depth-texture type and Slang offers no way to ask for one, so the forward
// bind group layout declares binding 4 as 'unfilterable-float' instead of
// 'depth' (both are legal sample types for depth32float, and the material only
// ever textureLoad()s it — no comparison sampling).

const FRAME_SLANG = defineBlock(FRAME_FIELDS).slangStruct('Frame');
const DRAW_SLANG = defineBlock(DRAW_FIELDS).slangStruct('DrawParams');

const FRAME_BINDING_SLANG = `${FRAME_SLANG}
[[vk::binding(0, 0)]] ConstantBuffer<Frame> u;
`;

const DRAW_BINDING_SLANG = `${DRAW_SLANG}
[[vk::binding(1, 0)]] ConstantBuffer<DrawParams> ptDraw;
`;

const LUT_BINDINGS_SLANG = `
[[vk::binding(2, 0)]] SamplerState ptSamp;
[[vk::binding(3, 0)]] Texture2D<float4> ptLut;
${LUT_SAMPLE_SLANG}`;

const SCENE_READ_BINDINGS_SLANG = `
[[vk::binding(4, 0)]] Texture2D<float> ptDepth;
[[vk::binding(5, 0)]] Texture2D<float4> ptGBufA;
[[vk::binding(6, 0)]] Texture2D<float4> ptGBufB;
[[vk::binding(7, 0)]] Texture2D<float4> ptGBufC;
`;

// ---------------------------------------------------------------- noise / util
export const NOISE_WGSL = `
const PI = 3.14159265359;
const TAU = 6.28318530718;

// GLSL-style mod (floor, not trunc).
fn fmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn fmod3(x: vec3f, y: f32) -> vec3f { return x - y * floor(x / y); }

fn hash11(p0: f32) -> f32 { var p = fract(p0 * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash33(p0: vec3f) -> vec3f {
  var p = fract(p0 * vec3f(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
fn noise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let uu = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), uu.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), uu.x), uu.y);
}
fn noise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let uu = f * f * (3.0 - 2.0 * f);
  let o = vec2f(37.0, 239.0);
  let n000 = hash21(i.xy + o * i.z);
  let n100 = hash21(i.xy + vec2f(1.0, 0.0) + o * i.z);
  let n010 = hash21(i.xy + vec2f(0.0, 1.0) + o * i.z);
  let n110 = hash21(i.xy + vec2f(1.0, 1.0) + o * i.z);
  let n001 = hash21(i.xy + o * (i.z + 1.0));
  let n101 = hash21(i.xy + vec2f(1.0, 0.0) + o * (i.z + 1.0));
  let n011 = hash21(i.xy + vec2f(0.0, 1.0) + o * (i.z + 1.0));
  let n111 = hash21(i.xy + vec2f(1.0, 1.0) + o * (i.z + 1.0));
  return mix(mix(mix(n000, n100, uu.x), mix(n010, n110, uu.x), uu.y),
             mix(mix(n001, n101, uu.x), mix(n011, n111, uu.x), uu.y), uu.z);
}
fn fbm2(p0: vec2f) -> f32 {
  var v = 0.0; var a = 0.5; var p = p0;
  for (var i = 0; i < 4; i++) { v += a * noise2(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
fn fbm3(p0: vec3f) -> f32 {
  var v = 0.0; var a = 0.5; var p = p0;
  for (var i = 0; i < 4; i++) { v += a * noise3(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
`;

// The same library in Slang. Kept deliberately close to the WGSL above so the
// two read as translations of each other: hash constants, octave count and the
// 2.03/17.1 lacunarity are all load-bearing for visual parity with saved
// effects, and drifting them would silently change every noise-based material.
export const NOISE_SLANG = `
static const float PI = 3.14159265359;
static const float TAU = 6.28318530718;

// GLSL-style mod (floor, not trunc). HLSL's fmod truncates, so this shadows it.
float fmod(float x, float y) { return x - y * floor(x / y); }
float3 fmod3(float3 x, float y) { return x - y * floor(x / y); }

float hash11(float p0) { float p = frac(p0 * 0.1031); p *= p + 33.33; p *= p + p; return frac(p); }
float hash21(float2 p) {
  float3 p3 = frac(float3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return frac((p3.x + p3.y) * p3.z);
}
float3 hash33(float3 p0) {
  float3 p = frac(p0 * float3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return frac((p.xxy + p.yxx) * p.zyx);
}
float noise2(float2 p) {
  float2 i = floor(p); float2 f = frac(p);
  float2 uu = f * f * (3.0 - 2.0 * f);
  return lerp(lerp(hash21(i), hash21(i + float2(1.0, 0.0)), uu.x),
              lerp(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), uu.x), uu.y);
}
float noise3(float3 p) {
  float3 i = floor(p); float3 f = frac(p);
  float3 uu = f * f * (3.0 - 2.0 * f);
  float2 o = float2(37.0, 239.0);
  float n000 = hash21(i.xy + o * i.z);
  float n100 = hash21(i.xy + float2(1.0, 0.0) + o * i.z);
  float n010 = hash21(i.xy + float2(0.0, 1.0) + o * i.z);
  float n110 = hash21(i.xy + float2(1.0, 1.0) + o * i.z);
  float n001 = hash21(i.xy + o * (i.z + 1.0));
  float n101 = hash21(i.xy + float2(1.0, 0.0) + o * (i.z + 1.0));
  float n011 = hash21(i.xy + float2(0.0, 1.0) + o * (i.z + 1.0));
  float n111 = hash21(i.xy + float2(1.0, 1.0) + o * (i.z + 1.0));
  return lerp(lerp(lerp(n000, n100, uu.x), lerp(n010, n110, uu.x), uu.y),
              lerp(lerp(n001, n101, uu.x), lerp(n011, n111, uu.x), uu.y), uu.z);
}
float fbm2(float2 p0) {
  float v = 0.0; float a = 0.5; float2 p = p0;
  for (int i = 0; i < 4; i++) { v += a * noise2(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
float fbm3(float3 p0) {
  float v = 0.0; float a = 0.5; float3 p = p0;
  for (int i = 0; i < 4; i++) { v += a * noise3(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
`;


// The user-facing struct API in Slang. Field names and meanings are identical
// to the WGSL above — these are what Help (?) documents.
const STRUCTS_SLANG = `
struct Particle {
  float3 center;    // particle center, world space
  float3 velocity;  // world-space velocity
  float4 color;     // start color * color/alpha-over-life
  float size;       // size after size-over-life
  float rotation;   // radians
  float life;       // normalized age 0..1
  float seed;       // stable per-particle random 0..1
};
struct VertexData {
  float3 positionWS;
  float3 normalWS;
  float2 uv;
};
struct Surface {
  float3 albedo;
  float metallic;
  float roughness;
  float3 normal;    // world space
  float3 emissive;  // HDR, added after lighting
  float occlusion;
  float alpha;
};
struct SurfaceInput {
  float2 uv;
  float4 color;
  float life;
  float seed;
  float3 positionWS;
  float3 normalWS;
  float3 viewDirWS; // surface -> camera
};
`;

// ---------------------------------------------------------------- lighting
export const PBR_WGSL = `
fn skyColor(d: vec3f) -> vec3f {
  let t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  var c = mix(u.skyBottom, u.skyTop, pow(t, 0.75));
  let s = max(dot(normalize(d), normalize(u.sunDir)), 0.0);
  c += u.sunColor * 0.06 * pow(s, 64.0);
  return c;
}
fn D_GGX(NoH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}
fn G_SmithApprox(NoV: f32, NoL: f32, a: f32) -> f32 {
  let k = a * 0.5 + 1e-4;
  let gv = NoV / (NoV * (1.0 - k) + k);
  let gl2 = NoL / (NoL * (1.0 - k) + k);
  return gv * gl2;
}
// Every Fresnel base is saturated before pow(): pow() of a negative base is
// NaN, and dot() of two unit vectors routinely lands an ulp above 1.0 — which
// happens constantly on camera-facing billboards, where the normal and the
// view vector are the same vector by construction. An unguarded 1.0 - NoV then
// poisons the whole fragment (NaN * 0 is still NaN, so even a zero-weighted
// specular term propagates it), and bloom smears it across the screen.
fn F_Schlick(F0: vec3f, VoH: f32) -> vec3f { return F0 + (1.0 - F0) * pow(saturate(1.0 - VoH), 5.0); }

fn directBRDF(N: vec3f, V: vec3f, L: vec3f, F0: vec3f, diffuse: vec3f, a: f32) -> vec3f {
  // V == -L would make normalize() return NaN; fall back to N (NoL is 0 there).
  let VpL = V + L;
  let H = select(normalize(VpL), N, dot(VpL, VpL) < 1e-12);
  let NoL = saturate(dot(N, L));
  let NoV = clamp(dot(N, V), 1e-4, 1.0);
  let NoH = saturate(dot(N, H));
  let VoH = saturate(dot(V, H));
  let D = D_GGX(NoH, a);
  let G = G_SmithApprox(NoV, NoL, a);
  let F = F_Schlick(F0, VoH);
  let spec = D * G * F / (4.0 * NoV * max(NoL, 1e-4) + 1e-4);
  return (diffuse / PI + spec) * NoL;
}

fn shadeSurface(P: vec3f, N: vec3f, V: vec3f, albedo: vec3f, metallic: f32, roughness: f32, ao: f32) -> vec3f {
  let F0 = mix(vec3f(0.04), albedo, metallic);
  let diffuseColor = albedo * (1.0 - metallic);
  let a = max(roughness * roughness, 0.002);
  var col = vec3f(0.0);
  col += directBRDF(N, V, normalize(u.sunDir), F0, diffuseColor, a) * u.sunColor;
  for (var i = 0; i < 4; i++) {
    if (i >= u.numPoints) { break; }
    let Ld = u.pointPos[i].xyz - P;
    let dist = length(Ld);
    let L = Ld / max(dist, 1e-4);
    let atten = 1.0 / (1.0 + dist * dist * 0.35);
    col += directBRDF(N, V, L, F0, diffuseColor, a) * u.pointColor[i].xyz * atten;
  }
  // Hemisphere ambient diffuse + fake environment specular from the sky model
  let amb = mix(u.skyBottom, u.skyTop, N.y * 0.5 + 0.5) * u.ambient;
  col += diffuseColor * amb * ao;
  let R = reflect(-V, N);
  let NoV = saturate(dot(N, V));
  let F = F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(1.0 - NoV, 5.0);
  let envSpec = mix(skyColor(R), (u.skyTop + u.skyBottom) * 0.5, roughness) * u.ambient;
  col += envSpec * F * (1.0 - roughness * 0.8) * ao;
  return col;
}
`;

// The same lighting model in Slang, for forward-lit user materials.
//
// KEEP IN SYNC WITH PBR_WGSL ABOVE. The engine's own passes (the deferred
// lighting pass and the forward floor) are hand-written WGSL and use that copy;
// forward-lit particles are compiled from Slang and use this one. If the two
// drift, particles stop matching the floor they sit on. Any change to the BRDF,
// the ambient term or the sky model has to land in both.
export const PBR_SLANG = `
float3 skyColor(float3 d) {
  float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  float3 c = lerp(u.skyBottom, u.skyTop, pow(t, 0.75));
  float s = max(dot(normalize(d), normalize(u.sunDir)), 0.0);
  c += u.sunColor * 0.06 * pow(s, 64.0);
  return c;
}
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}
float G_SmithApprox(float NoV, float NoL, float a) {
  float k = a * 0.5 + 1e-4;
  float gv = NoV / (NoV * (1.0 - k) + k);
  float gl2 = NoL / (NoL * (1.0 - k) + k);
  return gv * gl2;
}
// Every Fresnel base is saturated before pow(): pow() of a negative base is
// NaN, and dot() of two unit vectors routinely lands an ulp above 1.0 — which
// happens constantly on camera-facing billboards, where the normal and the
// view vector are the same vector by construction. An unguarded 1.0 - NoV then
// poisons the whole fragment (NaN * 0 is still NaN, so even a zero-weighted
// specular term propagates it), and bloom smears it across the screen.
float3 F_Schlick(float3 F0, float VoH) { return F0 + (1.0 - F0) * pow(saturate(1.0 - VoH), 5.0); }

float3 directBRDF(float3 N, float3 V, float3 L, float3 F0, float3 diffuse, float a) {
  // V == -L would make normalize() return NaN; fall back to N (NoL is 0 there).
  float3 VpL = V + L;
  float3 H = dot(VpL, VpL) < 1e-12 ? N : normalize(VpL);
  float NoL = saturate(dot(N, L));
  float NoV = clamp(dot(N, V), 1e-4, 1.0);
  float NoH = saturate(dot(N, H));
  float VoH = saturate(dot(V, H));
  float D = D_GGX(NoH, a);
  float G = G_SmithApprox(NoV, NoL, a);
  float3 F = F_Schlick(F0, VoH);
  float3 spec = D * G * F / (4.0 * NoV * max(NoL, 1e-4) + 1e-4);
  return (diffuse / PI + spec) * NoL;
}

float3 shadeSurface(float3 P, float3 N, float3 V, float3 albedo, float metallic, float roughness, float ao) {
  float3 F0 = lerp(float3(0.04), albedo, metallic);
  float3 diffuseColor = albedo * (1.0 - metallic);
  float a = max(roughness * roughness, 0.002);
  float3 col = float3(0.0);
  col += directBRDF(N, V, normalize(u.sunDir), F0, diffuseColor, a) * u.sunColor;
  for (int i = 0; i < 4; i++) {
    if (i >= u.numPoints) { break; }
    float3 Ld = u.pointPos[i].xyz - P;
    float dist = length(Ld);
    float3 L = Ld / max(dist, 1e-4);
    float atten = 1.0 / (1.0 + dist * dist * 0.35);
    col += directBRDF(N, V, L, F0, diffuseColor, a) * u.pointColor[i].xyz * atten;
  }
  // Hemisphere ambient diffuse + fake environment specular from the sky model
  float3 amb = lerp(u.skyBottom, u.skyTop, N.y * 0.5 + 0.5) * u.ambient;
  col += diffuseColor * amb * ao;
  float3 R = reflect(-V, N);
  float NoV = saturate(dot(N, V));
  float3 F = F0 + (max(float3(1.0 - roughness), F0) - F0) * pow(1.0 - NoV, 5.0);
  float3 envSpec = lerp(skyColor(R), (u.skyTop + u.skyBottom) * 0.5, roughness) * u.ambient;
  col += envSpec * F * (1.0 - roughness * 0.8) * ao;
  return col;
}
`;

const DEPTH_UTIL = `
fn linearizeDepth(d: f32) -> f32 {
  let n = u.nearFar.x; let f = u.nearFar.y;
  return n * f / (f - d * (f - n));
}
fn uvToNdc(uv: vec2f) -> vec2f { return vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0); }
`;

const DEPTH_UTIL_SLANG = `
float linearizeDepth(float d) {
  float n = u.nearFar.x; float f = u.nearFar.y;
  return n * f / (f - d * (f - n));
}
float2 uvToNdc(float2 uv) { return float2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0); }
`;

// ---------------------------------------------------------------- G-buffer reads
//
// Materials can sample the scene behind them. In the deferred pipeline the
// blended pass runs after the G-buffer and lighting passes, so the full
// G-buffer is readable there — that is what makes refraction, distortion,
// scene-aware tinting and contact effects possible.
//
// The same API is compiled into BOTH variants so user code never breaks when a
// material is used as opaque (which writes the G-buffer and therefore cannot
// read it) or under the forward pipeline (which has no G-buffer at all). In
// those cases gbufferAvailable() is false and the material channels read as
// neutral defaults. Depth is available in the forward pipeline too.



// ---- the same G-buffer API in Slang
const GBUFFER_STRUCT_SLANG = `
struct GBuffer {
  float3 albedo;
  float metallic;
  float3 normal;      // world space
  float roughness;
  float3 emissive;
  float occlusion;
  float depth;        // raw 0..1 (1.0 = nothing drawn / sky)
  float linearDepth;  // world units from the camera
  float3 positionWS;  // reconstructed world position
  bool valid;         // false on sky, or when no G-buffer is bound
};
static float4 ptFragCoord;
float2 screenUV() { return ptFragCoord.xy / u.resolution; }
`;

const GBUFFER_READ_SLANG = GBUFFER_STRUCT_SLANG + `
int2 ptTexel(float2 uv) {
  return int2(clamp(uv, float2(0.0), float2(1.0)) * (u.resolution - 1.0));
}
bool gbufferAvailable() { return ptDraw.hasGBuffer > 0.5; }
float sceneDepth(float2 uv) { return ptDepth.Load(int3(ptTexel(uv), 0)); }
float sceneLinearDepth(float2 uv) { return linearizeDepth(sceneDepth(uv)); }
float3 sceneWorldPos(float2 uv) {
  float d = sceneDepth(uv);
  float4 wp = mul(u.invViewProj, float4(uvToNdc(uv), d, 1.0));
  return wp.xyz / wp.w;
}
GBuffer sampleGBuffer(float2 uv) {
  GBuffer g;
  float d = sceneDepth(uv);
  g.depth = d;
  g.linearDepth = linearizeDepth(d);
  g.positionWS = sceneWorldPos(uv);
  if (ptDraw.hasGBuffer > 0.5) {
    float4 a = ptGBufA.Load(int3(ptTexel(uv), 0));
    float4 b = ptGBufB.Load(int3(ptTexel(uv), 0));
    float4 c = ptGBufC.Load(int3(ptTexel(uv), 0));
    g.albedo = a.rgb;
    g.metallic = a.a;
    g.normal = normalize(b.rgb * 2.0 - 1.0);
    g.roughness = b.a;
    g.emissive = c.rgb;
    g.occlusion = c.a;
    g.valid = d < 1.0;
  } else {
    g.albedo = float3(0.0);
    g.metallic = 0.0;
    g.normal = float3(0.0, 1.0, 0.0);
    g.roughness = 1.0;
    g.emissive = float3(0.0);
    g.occlusion = 1.0;
    g.valid = false;
  }
  return g;
}
`;

// Inert version for the G-buffer variant: same signatures, no texture reads,
// so a material that reads the scene still compiles when drawn as opaque.
const GBUFFER_STUB_SLANG = GBUFFER_STRUCT_SLANG + `
bool gbufferAvailable() { return false; }
float sceneDepth(float2 uv) { return 1.0; }
float sceneLinearDepth(float2 uv) { return 0.0; }
float3 sceneWorldPos(float2 uv) { return float3(0.0); }
GBuffer sampleGBuffer(float2 uv) {
  GBuffer g;
  g.albedo = float3(0.0);
  g.metallic = 0.0;
  g.normal = float3(0.0, 1.0, 0.0);
  g.roughness = 1.0;
  g.emissive = float3(0.0);
  g.occlusion = 1.0;
  g.depth = 1.0;
  g.linearDepth = 0.0;
  g.positionWS = float3(0.0);
  g.valid = false;
  return g;
}
`;


// The Slang vertex entry point.
//
// VSIn field *names* matter: slangc.parseVertexLocations() reads them back off
// the generated WGSL to build the pipeline's vertex buffer layout, since Slang
// assigns @location from the HLSL semantics rather than declaration order. All
// seven inputs must stay referenced — Slang strips unused ones, and a layout
// pointing at a location the shader never declared is a pipeline error.
// The varying struct is shared: the vertex stage returns it and the fragment
// stage takes it as input, matched by semantic. Both modules need the
// declaration, but only the vertex module carries the entry point below (which
// calls mainVertex, and so cannot be compiled into a fragment module).
const VS_OUT_SLANG = `
struct VSOut {
  float4 clip : SV_Position;
  float2 uv : UV;
  float4 color : COLOR0;
  float life : LIFE;
  float seed : SEED;
  float3 worldPos : WORLDPOS;
  float3 normalWS : NORMALWS;
};
`;

const PARTICLE_VS_MAIN_SLANG = VS_OUT_SLANG + `
struct VSIn {
  float3 pos : POSITION;
  float3 normal : NORMAL;
  float2 uv : TEXCOORD0;
  float4 iPosSize : TEXCOORD1;  // xyz center, w base size
  float4 iColor : TEXCOORD2;    // start color RGBA
  float4 iMisc : TEXCOORD3;     // x life01, y seed, z rotation, w free
  float4 iVel : TEXCOORD4;      // xyz velocity
};

[shader("vertex")]
VSOut vsMain(VSIn vin) {
  float life = vin.iMisc.x;
  float seed = vin.iMisc.y;
  float rot = vin.iMisc.z;
  // Over-lifetime curves are applied here, after the sim (CPU or compute) has
  // produced the particle's start color and base size.
  float lutU = ptLutU(life);
  float4 lifeColor = ptLut.SampleLevel(ptSamp, float2(lutU, ${lutRowV(LUT_ROW.color)}), 0);
  float sizeMul = ptLut.SampleLevel(ptSamp, float2(lutU, ${lutRowV(LUT_ROW.size)}), 0).r;
  float size = vin.iPosSize.w * sizeMul;
  float3 centerWS = vin.iPosSize.xyz;

  VertexData v;
  if (ptDraw.meshMode == 0) {
    // Rows 0 and 1 of the view matrix are the camera's right and up axes.
    // HLSL's M[i] is the i-th row whatever the storage order, so this is the
    // same pair the WGSL engine passes read out column-wise.
    float3 right = u.view[0].xyz;
    float3 up = u.view[1].xyz;
    float c = cos(rot); float s = sin(rot);
    float2 p2 = float2(vin.pos.x * c - vin.pos.y * s, vin.pos.x * s + vin.pos.y * c) * size;
    v.positionWS = centerWS + right * p2.x + up * p2.y;
    v.normalWS = normalize(u.cameraPos - centerWS);
  } else {
    float c = cos(rot); float s = sin(rot);
    // Written row-wise here; the WGSL form lists the same matrix column-wise.
    float3x3 R = float3x3(c, 0.0, s,
                          0.0, 1.0, 0.0,
                          -s, 0.0, c);
    v.positionWS = centerWS + mul(R, vin.pos * size);
    v.normalWS = mul(R, vin.normal);
  }
  v.uv = vin.uv;

  Particle p;
  p.center = centerWS;
  p.velocity = vin.iVel.xyz;
  p.color = vin.iColor * lifeColor;
  p.size = size;
  p.rotation = rot;
  p.life = life;
  p.seed = seed;

  mainVertex(v, p);

  VSOut o;
  o.uv = v.uv;
  o.color = p.color;
  o.life = life;
  o.seed = seed;
  o.worldPos = v.positionWS;
  o.normalWS = v.normalWS;
  o.clip = mul(u.proj, mul(u.view, float4(v.positionWS, 1.0)));
  return o;
}
`;

function countLines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

/** Vertex module is variant-independent: compiled once per material. */
export function buildParticleVS(userCode) {
  const prelude = FRAME_BINDING_SLANG + DRAW_BINDING_SLANG + LUT_BINDINGS_SLANG + NOISE_SLANG + STRUCTS_SLANG;
  const src = prelude + userCode + '\n' + PARTICLE_VS_MAIN_SLANG;
  return { src, lineOffset: countLines(prelude) };
}

// ---------------------------------------------------------------- particle FS
//
// VSOut doubles as the fragment input: Slang matches the stages by semantic,
// and lifts the SV_Position member out to @builtin(position) on its own. It
// must NOT also be declared as a separate fragment parameter — that emits two
// @builtin(position) params, which is invalid WGSL.

const FS_SURFACE_SETUP_SLANG = `
  ptFragCoord = fin.clip;
  SurfaceInput si;
  si.uv = fin.uv;
  si.color = fin.color;
  si.life = fin.life;
  si.seed = fin.seed;
  si.positionWS = fin.worldPos;
  si.normalWS = normalize(fin.normalWS);
  si.viewDirWS = normalize(u.cameraPos - fin.worldPos);
  Surface s;
  s.albedo = si.color.rgb;
  s.metallic = 0.0;
  s.roughness = 0.5;
  s.normal = si.normalWS;
  s.emissive = float3(0.0);
  s.occlusion = 1.0;
  s.alpha = si.color.a;
  mainSurface(s, si);
  float3 N = normalize(ff ? s.normal : -s.normal);
`;

const FS_GBUFFER_MAIN_SLANG = `
struct GBufOut {
  float4 albedoMetal : SV_Target0;
  float4 normalRough : SV_Target1;
  float4 emissiveAO : SV_Target2;
};

[shader("fragment")]
GBufOut fsMain(VSOut fin, bool ff : SV_IsFrontFace) {
${FS_SURFACE_SETUP_SLANG}
  if (BLENDMODE == 1) {
    if (s.alpha < ptDraw.alphaCutoff) { discard; }
  }
  GBufOut o;
  if (SHADING_LIT) {
    o.albedoMetal = float4(s.albedo, s.metallic);
    o.normalRough = float4(N * 0.5 + 0.5, clamp(s.roughness, 0.03, 1.0));
    o.emissiveAO = float4(s.emissive, s.occlusion);
  } else {
    o.albedoMetal = float4(0.0);
    o.normalRough = float4(N * 0.5 + 0.5, 1.0);
    o.emissiveAO = float4(s.albedo + s.emissive, s.occlusion);
  }
  return o;
}
`;

const FS_FORWARD_MAIN_SLANG = `
[shader("fragment")]
float4 fsMain(VSOut fin, bool ff : SV_IsFrontFace) : SV_Target {
${FS_SURFACE_SETUP_SLANG}
  if (BLENDMODE == 1) {
    if (s.alpha < ptDraw.alphaCutoff) { discard; }
  }
  float fade = 1.0;
  if (SOFT_PARTICLES) {
    float sceneD = ptDepth.Load(int3(int2(fin.clip.xy), 0));
    float sceneZ = linearizeDepth(sceneD);
    float fragZ = linearizeDepth(fin.clip.z);
    fade = clamp((sceneZ - fragZ) / max(ptDraw.softDistance, 1e-4), 0.0, 1.0);
  }
  float3 col;
  if (SHADING_LIT) {
    col = shadeSurface(si.positionWS, N, si.viewDirWS, s.albedo, s.metallic, clamp(s.roughness, 0.03, 1.0), s.occlusion) + s.emissive;
  } else {
    col = s.albedo + s.emissive;
  }
  float alpha = clamp(s.alpha * fade, 0.0, 1.0);
  if (BLENDMODE == 3) {
    return float4(col * alpha, 0.0);  // additive (one, one)
  } else if (BLENDMODE == 2) {
    return float4(col, alpha);        // alpha blend
  }
  return float4(col, 1.0);            // opaque / cutout
}
`;

const BLENDMODE_INDEX = { opaque: 0, cutout: 1, blend: 2, add: 3 };

export function buildParticleFS(userCode, variant, opts) {
  const consts =
    `static const int BLENDMODE = ${BLENDMODE_INDEX[opts.blendMode] ?? 0};\n` +
    `static const bool SHADING_LIT = ${opts.lit ? 'true' : 'false'};\n` +
    `static const bool SOFT_PARTICLES = ${opts.soft && variant === 'forward' ? 'true' : 'false'};\n`;
  let prelude = consts + FRAME_BINDING_SLANG + DRAW_BINDING_SLANG + LUT_BINDINGS_SLANG;
  if (variant === 'forward') {
    prelude += SCENE_READ_BINDINGS_SLANG + NOISE_SLANG + STRUCTS_SLANG + PBR_SLANG + DEPTH_UTIL_SLANG + GBUFFER_READ_SLANG;
  } else {
    prelude += NOISE_SLANG + STRUCTS_SLANG + DEPTH_UTIL_SLANG + GBUFFER_STUB_SLANG;
  }
  const main = VS_OUT_SLANG + (variant === 'gbuffer' ? FS_GBUFFER_MAIN_SLANG : FS_FORWARD_MAIN_SLANG);
  return { src: prelude + userCode + '\n' + main, lineOffset: countLines(prelude) };
}

// ---------------------------------------------------------------- fullscreen
//
// Fullscreen triangle from vertex_index. uv is texture-space (v = 0 at the
// top), matching both WebGPU framebuffer coords and texture row order, so
// sampling rendered targets with it needs no flip; NDC reconstruction from it
// goes through uvToNdc().
const FULLSCREEN_VS = `
struct FSQ {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vsMain(@builtin(vertex_index) vid: u32) -> FSQ {
  let p = vec2f(f32((vid << 1u) & 2u), f32(vid & 2u));
  var o: FSQ;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;

export const SKY_WGSL = FRAME_BINDING + NOISE_WGSL + PBR_WGSL + DEPTH_UTIL + FULLSCREEN_VS + `
@fragment fn fsMain(fin: FSQ) -> @location(0) vec4f {
  let wp = u.invViewProj * vec4f(uvToNdc(fin.uv), 1.0, 1.0);
  let dir = normalize(wp.xyz / wp.w - u.cameraPos);
  return vec4f(skyColor(dir), 1.0);
}
`;

export const DEFERRED_LIGHT_WGSL = FRAME_BINDING + `
${defineBlock(LIGHTPASS_FIELDS).wgslStruct('LightPass')}
@group(0) @binding(1) var<uniform> lp: LightPass;
@group(0) @binding(2) var gbA: texture_2d<f32>;
@group(0) @binding(3) var gbB: texture_2d<f32>;
@group(0) @binding(4) var gbC: texture_2d<f32>;
@group(0) @binding(5) var gbDepth: texture_depth_2d;
` + NOISE_WGSL + PBR_WGSL + DEPTH_UTIL + FULLSCREEN_VS + `
@fragment fn fsMain(fin: FSQ) -> @location(0) vec4f {
  let px = vec2i(fin.pos.xy);
  let d = textureLoad(gbDepth, px, 0);
  if (d >= 1.0) {
    if (lp.debugMode != 0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    discard; // keep the sky pass result
  }
  let ga = textureLoad(gbA, px, 0);
  let gb = textureLoad(gbB, px, 0);
  let gc = textureLoad(gbC, px, 0);
  let N = normalize(gb.rgb * 2.0 - 1.0);
  let wp = u.invViewProj * vec4f(uvToNdc(fin.uv), d, 1.0);
  let P = wp.xyz / wp.w;
  let V = normalize(u.cameraPos - P);
  var col = shadeSurface(P, N, V, ga.rgb, ga.a, gb.a, gc.a) + gc.rgb;
  if (lp.debugMode == 1) { col = ga.rgb + gc.rgb * step(length(ga.rgb), 0.001); }
  else if (lp.debugMode == 2) { col = N * 0.5 + 0.5; }
  else if (lp.debugMode == 3) { col = vec3f(gb.a, ga.a, 0.0); }
  else if (lp.debugMode == 4) { col = gc.rgb; }
  else if (lp.debugMode == 5) { col = vec3f(linearizeDepth(d) / u.nearFar.y); }
  return vec4f(col, 1.0);
}
`;

export const BRIGHT_WGSL = `
${defineBlock(BRIGHT_FIELDS).wgslStruct('Bright')}
@group(0) @binding(0) var<uniform> bp: Bright;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
` + FULLSCREEN_VS + `
@fragment fn fsMain(fin: FSQ) -> @location(0) vec4f {
  let raw = textureSampleLevel(src, samp, fin.uv, 0.0).rgb;
  // Keep non-finite fragments out of the blur chain. A single NaN pixel (an
  // unlucky pow() in a user shader, say) would otherwise spread through the
  // separable blurs into a large black block far from the particle that
  // produced it, which is impossible to debug from the picture.
  let c = select(vec3f(0.0), min(raw, vec3f(65504.0)), raw == raw);
  let l = max(max(c.r, c.g), c.b);
  let k = max(0.0, l - bp.threshold) / max(l, 1e-4);
  return vec4f(c * k, 1.0);
}
`;

export const BLUR_WGSL = `
${defineBlock(BLUR_FIELDS).wgslStruct('Blur')}
@group(0) @binding(0) var<uniform> bp: Blur;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
` + FULLSCREEN_VS + `
@fragment fn fsMain(fin: FSQ) -> @location(0) vec4f {
  let w = array<f32, 5>(0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
  var c = textureSampleLevel(src, samp, fin.uv, 0.0).rgb * w[0];
  for (var i = 1; i < 5; i++) {
    c += textureSampleLevel(src, samp, fin.uv + bp.dir * f32(i), 0.0).rgb * w[i];
    c += textureSampleLevel(src, samp, fin.uv - bp.dir * f32(i), 0.0).rgb * w[i];
  }
  return vec4f(c, 1.0);
}
`;

export const POST_WGSL = `
${defineBlock(POST_FIELDS).wgslStruct('Post')}
@group(0) @binding(0) var<uniform> pp: Post;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var scene: texture_2d<f32>;
@group(0) @binding(3) var bloomA: texture_2d<f32>;
@group(0) @binding(4) var bloomB: texture_2d<f32>;
` + FULLSCREEN_VS + `
fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
@fragment fn fsMain(fin: FSQ) -> @location(0) vec4f {
  var c = textureSampleLevel(scene, samp, fin.uv, 0.0).rgb;
  if (pp.mode == 1) {
    return vec4f(pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
  }
  let bloom = textureSampleLevel(bloomA, samp, fin.uv, 0.0).rgb * 0.6
            + textureSampleLevel(bloomB, samp, fin.uv, 0.0).rgb * 0.6;
  c += bloom * pp.bloomIntensity;
  c *= pp.exposure;
  c = aces(c);
  c = pow(c, vec3f(1.0 / 2.2));
  return vec4f(c, 1.0);
}
`;

// ---------------------------------------------------------------- floor
const FLOOR_VS = `
struct FloorVSOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
}
@vertex fn vsMain(@location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) uv: vec2f) -> FloorVSOut {
  var o: FloorVSOut;
  o.worldPos = pos;
  o.normal = nrm;
  o.clip = u.proj * u.view * vec4f(pos, 1.0);
  return o;
}
`;

const FLOOR_COMMON = FRAME_BINDING + `
${defineBlock(FLOOR_FIELDS).wgslStruct('Floor')}
@group(0) @binding(1) var<uniform> fl: Floor;
` + NOISE_WGSL + FLOOR_VS + `
fn floorAlbedoRough(worldPos: vec3f) -> vec4f {
  let xz = worldPos.xz;
  let checker = fmod(floor(xz.x) + floor(xz.y), 2.0);
  var albedo = mix(vec3f(0.135), vec3f(0.16), checker);
  let g = abs(fract(xz + 0.5) - 0.5) / max(fwidth(xz), vec2f(1e-5));
  let gridLine = 1.0 - min(min(g.x, g.y), 1.0);
  albedo = mix(albedo, vec3f(0.32), gridLine * 0.45 * fl.gridEnabled);
  let dist = length(xz);
  albedo = mix(albedo, vec3f(0.10), smoothstep(8.0, 22.0, dist));
  return vec4f(albedo, 0.82);
}
`;

export const FLOOR_GBUFFER_WGSL = FLOOR_COMMON + `
struct GBufOut {
  @location(0) albedoMetal: vec4f,
  @location(1) normalRough: vec4f,
  @location(2) emissiveAO: vec4f,
}
@fragment fn fsMain(fin: FloorVSOut) -> GBufOut {
  let ar = floorAlbedoRough(fin.worldPos);
  var o: GBufOut;
  o.albedoMetal = vec4f(ar.rgb, 0.0);
  o.normalRough = vec4f(normalize(fin.normal) * 0.5 + 0.5, ar.a);
  o.emissiveAO = vec4f(0.0, 0.0, 0.0, 1.0);
  return o;
}
`;

export const FLOOR_FORWARD_WGSL = FLOOR_COMMON + PBR_WGSL + `
@fragment fn fsMain(fin: FloorVSOut) -> @location(0) vec4f {
  let ar = floorAlbedoRough(fin.worldPos);
  let N = normalize(fin.normal);
  let V = normalize(u.cameraPos - fin.worldPos);
  return vec4f(shadeSurface(fin.worldPos, N, V, ar.rgb, 0.0, ar.a, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------- templates
export const DEFAULT_VS = `// Vertex stage — runs for every vertex of every particle (Slang).
// Modify v.positionWS / v.normalWS / v.uv. See Help (?) for the full API.

void mainVertex(inout VertexData v, Particle p) {
  // Example: stretch along velocity
  // v.positionWS += p.velocity * 0.05 * (v.uv.y - 0.5);
}
`;

export const DEFAULT_FS = `// Fragment stage — fill in the PBR Surface (Slang). See Help (?) for the API.
// i.color already includes color-over-life and alpha-over-life.

void mainSurface(inout Surface s, SurfaceInput i) {
  float d = length(i.uv - 0.5) * 2.0;   // soft round sprite
  s.albedo = i.color.rgb;
  s.roughness = 0.6;
  s.metallic = 0.0;
  s.emissive = float3(0.0);
  s.alpha = i.color.a * (1.0 - smoothstep(0.55, 1.0, d));
}
`;
