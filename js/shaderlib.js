// WGSL source library and shader builders.
//
// User-authored material code is wrapped shadertoy-style: the user writes
//   fn mainVertex(v: ptr<function, VertexData>, p: Particle)     (vertex stage)
//   fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput)   (fragment stage)
// and the engine wraps it with a prelude + entry point for each pipeline
// variant:
//   'gbuffer' — writes PBR surface data to MRT G-buffer (deferred, opaque/cutout)
//   'forward' — full PBR lighting evaluated inline (forward pipeline, and
//               blended particles in the deferred pipeline)
//
// Uniform data reaches shaders through two uniform blocks whose layouts are
// generated from the field lists below (see defineBlock in gpu.js), so the
// WGSL structs and the JS byte offsets always agree.

import { defineBlock } from './gpu.js';

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

const FRAME_STRUCT = defineBlock(FRAME_FIELDS).wgslStruct('Frame');
const DRAW_STRUCT = defineBlock(DRAW_FIELDS).wgslStruct('DrawParams');

const FRAME_BINDING = `${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> u: Frame;
`;

const DRAW_BINDING = `${DRAW_STRUCT}
@group(0) @binding(1) var<uniform> ptDraw: DrawParams;
`;

const LUT_BINDINGS = `
@group(0) @binding(2) var ptSamp: sampler;
@group(0) @binding(3) var ptLut: texture_2d<f32>;
`;

const SCENE_READ_BINDINGS = `
@group(0) @binding(4) var ptDepth: texture_depth_2d;
@group(0) @binding(5) var ptGBufA: texture_2d<f32>;
@group(0) @binding(6) var ptGBufB: texture_2d<f32>;
@group(0) @binding(7) var ptGBufC: texture_2d<f32>;
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

// ---------------------------------------------------------------- structs
const STRUCTS_WGSL = `
struct Particle {
  center: vec3f,    // particle center, world space
  velocity: vec3f,  // world-space velocity
  color: vec4f,     // start color * color/alpha-over-life
  size: f32,        // size after size-over-life
  rotation: f32,    // radians
  life: f32,        // normalized age 0..1
  seed: f32,        // stable per-particle random 0..1
}
struct VertexData {
  positionWS: vec3f,
  normalWS: vec3f,
  uv: vec2f,
}
struct Surface {
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  normal: vec3f,    // world space
  emissive: vec3f,  // HDR, added after lighting
  occlusion: f32,
  alpha: f32,
}
struct SurfaceInput {
  uv: vec2f,
  color: vec4f,
  life: f32,
  seed: f32,
  positionWS: vec3f,
  normalWS: vec3f,
  viewDirWS: vec3f, // surface -> camera
}
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

const DEPTH_UTIL = `
fn linearizeDepth(d: f32) -> f32 {
  let n = u.nearFar.x; let f = u.nearFar.y;
  return n * f / (f - d * (f - n));
}
fn uvToNdc(uv: vec2f) -> vec2f { return vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0); }
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
const GBUFFER_STRUCT = `
struct GBuffer {
  albedo: vec3f,
  metallic: f32,
  normal: vec3f,      // world space
  roughness: f32,
  emissive: vec3f,
  occlusion: f32,
  depth: f32,         // raw 0..1 (1.0 = nothing drawn / sky)
  linearDepth: f32,   // world units from the camera
  positionWS: vec3f,  // reconstructed world position
  valid: bool,        // false on sky, or when no G-buffer is bound
}
var<private> ptFragCoord: vec4f;
fn screenUV() -> vec2f { return ptFragCoord.xy / u.resolution; }
`;

const GBUFFER_READ = GBUFFER_STRUCT + `
fn ptTexel(uv: vec2f) -> vec2i {
  return vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (u.resolution - 1.0));
}
fn gbufferAvailable() -> bool { return ptDraw.hasGBuffer > 0.5; }
fn sceneDepth(uv: vec2f) -> f32 { return textureLoad(ptDepth, ptTexel(uv), 0); }
fn sceneLinearDepth(uv: vec2f) -> f32 { return linearizeDepth(sceneDepth(uv)); }
fn sceneWorldPos(uv: vec2f) -> vec3f {
  let d = sceneDepth(uv);
  let wp = u.invViewProj * vec4f(uvToNdc(uv), d, 1.0);
  return wp.xyz / wp.w;
}
fn sampleGBuffer(uv: vec2f) -> GBuffer {
  var g: GBuffer;
  let d = sceneDepth(uv);
  g.depth = d;
  g.linearDepth = linearizeDepth(d);
  g.positionWS = sceneWorldPos(uv);
  if (ptDraw.hasGBuffer > 0.5) {
    let a = textureLoad(ptGBufA, ptTexel(uv), 0);
    let b = textureLoad(ptGBufB, ptTexel(uv), 0);
    let c = textureLoad(ptGBufC, ptTexel(uv), 0);
    g.albedo = a.rgb;
    g.metallic = a.a;
    g.normal = normalize(b.rgb * 2.0 - 1.0);
    g.roughness = b.a;
    g.emissive = c.rgb;
    g.occlusion = c.a;
    g.valid = d < 1.0;
  } else {
    g.albedo = vec3f(0.0);
    g.metallic = 0.0;
    g.normal = vec3f(0.0, 1.0, 0.0);
    g.roughness = 1.0;
    g.emissive = vec3f(0.0);
    g.occlusion = 1.0;
    g.valid = false;
  }
  return g;
}
`;

// Inert version for the G-buffer variant: same signatures, no texture reads,
// so a material that reads the scene still compiles when drawn as opaque.
const GBUFFER_STUB = GBUFFER_STRUCT + `
fn gbufferAvailable() -> bool { return false; }
fn sceneDepth(uv: vec2f) -> f32 { return 1.0; }
fn sceneLinearDepth(uv: vec2f) -> f32 { return 0.0; }
fn sceneWorldPos(uv: vec2f) -> vec3f { return vec3f(0.0); }
fn sampleGBuffer(uv: vec2f) -> GBuffer {
  var g: GBuffer;
  g.albedo = vec3f(0.0);
  g.metallic = 0.0;
  g.normal = vec3f(0.0, 1.0, 0.0);
  g.roughness = 1.0;
  g.emissive = vec3f(0.0);
  g.occlusion = 1.0;
  g.depth = 1.0;
  g.linearDepth = 0.0;
  g.positionWS = vec3f(0.0);
  g.valid = false;
  return g;
}
`;

// ---------------------------------------------------------------- particle VS
const PARTICLE_VS_MAIN = `
struct VSIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) iPosSize: vec4f,  // xyz center, w base size
  @location(4) iColor: vec4f,    // start color RGBA
  @location(5) iMisc: vec4f,     // x life01, y seed, z rotation, w free
  @location(6) iVel: vec4f,      // xyz velocity
}
struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) life: f32,
  @location(3) seed: f32,
  @location(4) worldPos: vec3f,
  @location(5) normalWS: vec3f,
}

@vertex fn vsMain(vin: VSIn) -> VSOut {
  let life = vin.iMisc.x;
  let seed = vin.iMisc.y;
  let rot = vin.iMisc.z;
  let lifeColor = textureSampleLevel(ptLut, ptSamp, vec2f(life, 0.166667), 0.0);
  let sizeMul = textureSampleLevel(ptLut, ptSamp, vec2f(life, 0.5), 0.0).r;
  let size = vin.iPosSize.w * sizeMul;
  let centerWS = vin.iPosSize.xyz;

  var v: VertexData;
  if (ptDraw.meshMode == 0) {
    let right = vec3f(u.view[0][0], u.view[1][0], u.view[2][0]);
    let up = vec3f(u.view[0][1], u.view[1][1], u.view[2][1]);
    let c = cos(rot); let s = sin(rot);
    let p2 = vec2f(vin.pos.x * c - vin.pos.y * s, vin.pos.x * s + vin.pos.y * c) * size;
    v.positionWS = centerWS + right * p2.x + up * p2.y;
    v.normalWS = normalize(u.cameraPos - centerWS);
  } else {
    let c = cos(rot); let s = sin(rot);
    let R = mat3x3f(vec3f(c, 0.0, -s), vec3f(0.0, 1.0, 0.0), vec3f(s, 0.0, c));
    v.positionWS = centerWS + R * (vin.pos * size);
    v.normalWS = R * vin.normal;
  }
  v.uv = vin.uv;

  var p: Particle;
  p.center = centerWS;
  p.velocity = vin.iVel.xyz;
  p.color = vin.iColor * lifeColor;
  p.size = size;
  p.rotation = rot;
  p.life = life;
  p.seed = seed;

  mainVertex(&v, p);

  var o: VSOut;
  o.uv = v.uv;
  o.color = p.color;
  o.life = life;
  o.seed = seed;
  o.worldPos = v.positionWS;
  o.normalWS = v.normalWS;
  o.clip = u.proj * u.view * vec4f(v.positionWS, 1.0);
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
  const prelude = FRAME_BINDING + DRAW_BINDING + LUT_BINDINGS + NOISE_WGSL + STRUCTS_WGSL;
  const src = prelude + userCode + '\n' + PARTICLE_VS_MAIN;
  return { src, lineOffset: countLines(prelude) };
}

// ---------------------------------------------------------------- particle FS
const FS_IN = `
struct FSIn {
  @builtin(position) fragPos: vec4f,
  @builtin(front_facing) ff: bool,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) life: f32,
  @location(3) seed: f32,
  @location(4) worldPos: vec3f,
  @location(5) normalWS: vec3f,
}
`;

const FS_SURFACE_SETUP = `
  ptFragCoord = fin.fragPos;
  var si: SurfaceInput;
  si.uv = fin.uv;
  si.color = fin.color;
  si.life = fin.life;
  si.seed = fin.seed;
  si.positionWS = fin.worldPos;
  si.normalWS = normalize(fin.normalWS);
  si.viewDirWS = normalize(u.cameraPos - fin.worldPos);
  var s: Surface;
  s.albedo = si.color.rgb;
  s.metallic = 0.0;
  s.roughness = 0.5;
  s.normal = si.normalWS;
  s.emissive = vec3f(0.0);
  s.occlusion = 1.0;
  s.alpha = si.color.a;
  mainSurface(&s, si);
  let N = normalize(select(-s.normal, s.normal, fin.ff));
`;

const FS_GBUFFER_MAIN = FS_IN + `
struct GBufOut {
  @location(0) albedoMetal: vec4f,
  @location(1) normalRough: vec4f,
  @location(2) emissiveAO: vec4f,
}
@fragment fn fsMain(fin: FSIn) -> GBufOut {
${FS_SURFACE_SETUP}
  if (BLENDMODE == 1) {
    if (s.alpha < ptDraw.alphaCutoff) { discard; }
  }
  var o: GBufOut;
  if (SHADING_LIT) {
    o.albedoMetal = vec4f(s.albedo, s.metallic);
    o.normalRough = vec4f(N * 0.5 + 0.5, clamp(s.roughness, 0.03, 1.0));
    o.emissiveAO = vec4f(s.emissive, s.occlusion);
  } else {
    o.albedoMetal = vec4f(0.0);
    o.normalRough = vec4f(N * 0.5 + 0.5, 1.0);
    o.emissiveAO = vec4f(s.albedo + s.emissive, s.occlusion);
  }
  return o;
}
`;

const FS_FORWARD_MAIN = FS_IN + `
@fragment fn fsMain(fin: FSIn) -> @location(0) vec4f {
${FS_SURFACE_SETUP}
  if (BLENDMODE == 1) {
    if (s.alpha < ptDraw.alphaCutoff) { discard; }
  }
  var fade = 1.0;
  if (SOFT_PARTICLES) {
    let sceneD = textureLoad(ptDepth, vec2i(fin.fragPos.xy), 0);
    let sceneZ = linearizeDepth(sceneD);
    let fragZ = linearizeDepth(fin.fragPos.z);
    fade = clamp((sceneZ - fragZ) / max(ptDraw.softDistance, 1e-4), 0.0, 1.0);
  }
  var col: vec3f;
  if (SHADING_LIT) {
    col = shadeSurface(si.positionWS, N, si.viewDirWS, s.albedo, s.metallic, clamp(s.roughness, 0.03, 1.0), s.occlusion) + s.emissive;
  } else {
    col = s.albedo + s.emissive;
  }
  let alpha = clamp(s.alpha * fade, 0.0, 1.0);
  if (BLENDMODE == 3) {
    return vec4f(col * alpha, 0.0);   // additive (one, one)
  } else if (BLENDMODE == 2) {
    return vec4f(col, alpha);         // alpha blend
  }
  return vec4f(col, 1.0);             // opaque / cutout
}
`;

const BLENDMODE_INDEX = { opaque: 0, cutout: 1, blend: 2, add: 3 };

export function buildParticleFS(userCode, variant, opts) {
  const consts =
    `const BLENDMODE: i32 = ${BLENDMODE_INDEX[opts.blendMode] ?? 0};\n` +
    `const SHADING_LIT: bool = ${opts.lit ? 'true' : 'false'};\n` +
    `const SOFT_PARTICLES: bool = ${opts.soft && variant === 'forward' ? 'true' : 'false'};\n`;
  let prelude = consts + FRAME_BINDING + DRAW_BINDING + LUT_BINDINGS;
  if (variant === 'forward') {
    prelude += SCENE_READ_BINDINGS + NOISE_WGSL + STRUCTS_WGSL + PBR_WGSL + DEPTH_UTIL + GBUFFER_READ;
  } else {
    prelude += NOISE_WGSL + STRUCTS_WGSL + DEPTH_UTIL + GBUFFER_STUB;
  }
  const main = variant === 'gbuffer' ? FS_GBUFFER_MAIN : FS_FORWARD_MAIN;
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
export const DEFAULT_VS = `// Vertex stage — runs for every vertex of every particle (WGSL).
// Modify v.positionWS / v.normalWS / v.uv. See Help (?) for the full API.

fn mainVertex(v: ptr<function, VertexData>, p: Particle) {
  // Example: stretch along velocity
  // v.positionWS += p.velocity * 0.05 * (v.uv.y - 0.5);
}
`;

export const DEFAULT_FS = `// Fragment stage — fill in the PBR Surface (WGSL). See Help (?) for the API.
// i.color already includes color-over-life and alpha-over-life.

fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;   // soft round sprite
  s.albedo = i.color.rgb;
  s.roughness = 0.6;
  s.metallic = 0.0;
  s.emissive = vec3f(0.0);
  s.alpha = i.color.a * smoothstep(1.0, 0.55, d);
}
`;
