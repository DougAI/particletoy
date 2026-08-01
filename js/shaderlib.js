// GLSL source library and shader builders.
//
// User-authored material code is wrapped shadertoy-style: the user writes
//   void mainVertex(inout VertexData v, in Particle p)   (vertex stage)
//   void mainSurface(inout Surface s, in SurfaceInput i) (fragment stage)
// and the engine wraps it with a prelude + main() for each pipeline variant:
//   'gbuffer' — writes PBR surface data to MRT G-buffer (deferred, opaque/cutout)
//   'forward' — full PBR lighting evaluated inline (forward pipeline, and
//               blended particles in the deferred pipeline)

const VERSION = `#version 300 es
precision highp float;
precision highp int;
`;

// ---------------------------------------------------------------- noise / util
export const NOISE_GLSL = `
#define PI 3.14159265359
#define TAU 6.28318530718

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p){
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float noise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float noise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(37.0, 239.0);
  float n000 = hash21(i.xy + o * i.z);
  float n100 = hash21(i.xy + vec2(1, 0) + o * i.z);
  float n010 = hash21(i.xy + vec2(0, 1) + o * i.z);
  float n110 = hash21(i.xy + vec2(1, 1) + o * i.z);
  float n001 = hash21(i.xy + o * (i.z + 1.0));
  float n101 = hash21(i.xy + vec2(1, 0) + o * (i.z + 1.0));
  float n011 = hash21(i.xy + vec2(0, 1) + o * (i.z + 1.0));
  float n111 = hash21(i.xy + vec2(1, 1) + o * (i.z + 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm2(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ v += a * noise2(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
float fbm3(vec3 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ v += a * noise3(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
`;

// ---------------------------------------------------------------- structs
const STRUCTS_GLSL = `
struct Particle {
  vec3 center;    // particle center, world space
  vec3 velocity;  // world-space velocity
  vec4 color;     // start color * color/alpha-over-life
  float size;     // size after size-over-life
  float rotation; // radians
  float life;     // normalized age 0..1
  float seed;     // stable per-particle random 0..1
};
struct VertexData {
  vec3 positionWS;
  vec3 normalWS;
  vec2 uv;
};
struct Surface {
  vec3 albedo;
  float metallic;
  float roughness;
  vec3 normal;    // world space
  vec3 emissive;  // HDR, added after lighting
  float occlusion;
  float alpha;
};
struct SurfaceInput {
  vec2 uv;
  vec4 color;
  float life;
  float seed;
  vec3 positionWS;
  vec3 normalWS;
  vec3 viewDirWS; // surface -> camera
};
`;

const COMMON_UNIFORMS = `
uniform float uTime;
uniform vec2 uResolution;
uniform vec4 uMouse;      // xy pixels (y-up), z = mouse down
uniform vec3 uCameraPos;
#define iTime uTime
#define iResolution uResolution
#define iMouse uMouse
`;

// ---------------------------------------------------------------- lighting
export const LIGHT_UNIFORMS = `
uniform vec3 uSunDir;      // TOWARD the sun
uniform vec3 uSunColor;    // premultiplied by intensity
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform float uAmbient;
uniform vec3 uPointPos[4];
uniform vec3 uPointColor[4];
uniform int uNumPoints;
`;

export const PBR_GLSL = `
vec3 skyColor(vec3 d){
  float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(uSkyBottom, uSkyTop, pow(t, 0.75));
  float s = max(dot(normalize(d), normalize(uSunDir)), 0.0);
  c += uSunColor * 0.06 * pow(s, 64.0);
  return c;
}
float D_GGX(float NoH, float a){
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}
float G_SmithApprox(float NoV, float NoL, float a){
  float k = a * 0.5 + 1e-4;
  float gv = NoV / (NoV * (1.0 - k) + k);
  float gl2 = NoL / (NoL * (1.0 - k) + k);
  return gv * gl2;
}
vec3 F_Schlick(vec3 F0, float VoH){ return F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0); }

vec3 directBRDF(vec3 N, vec3 V, vec3 L, vec3 F0, vec3 diffuse, float a){
  vec3 H = normalize(V + L);
  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float D = D_GGX(NoH, a);
  float G = G_SmithApprox(NoV, NoL, a);
  vec3 F = F_Schlick(F0, VoH);
  vec3 spec = D * G * F / (4.0 * NoV * max(NoL, 1e-4) + 1e-4);
  return (diffuse / PI + spec) * NoL;
}

vec3 shadeSurface(vec3 P, vec3 N, vec3 V, vec3 albedo, float metallic, float roughness, float ao){
  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  vec3 diffuseColor = albedo * (1.0 - metallic);
  float a = max(roughness * roughness, 0.002);
  vec3 col = vec3(0.0);
  col += directBRDF(N, V, normalize(uSunDir), F0, diffuseColor, a) * uSunColor;
  for (int i = 0; i < 4; i++){
    if (i >= uNumPoints) break;
    vec3 Ld = uPointPos[i] - P;
    float dist = length(Ld);
    vec3 L = Ld / max(dist, 1e-4);
    float atten = 1.0 / (1.0 + dist * dist * 0.35);
    col += directBRDF(N, V, L, F0, diffuseColor, a) * uPointColor[i] * atten;
  }
  // Hemisphere ambient diffuse + fake environment specular from the sky model
  vec3 amb = mix(uSkyBottom, uSkyTop, N.y * 0.5 + 0.5) * uAmbient;
  col += diffuseColor * amb * ao;
  vec3 R = reflect(-V, N);
  float NoV = max(dot(N, V), 0.0);
  vec3 F = F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(1.0 - NoV, 5.0);
  vec3 envSpec = mix(skyColor(R), (uSkyTop + uSkyBottom) * 0.5, roughness) * uAmbient;
  col += envSpec * F * (1.0 - roughness * 0.8) * ao;
  return col;
}
`;

const DEPTH_UTIL = `
uniform vec2 uCamNearFar;
float linearizeDepth(float d){
  float n = uCamNearFar.x, f = uCamNearFar.y;
  return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n));
}
`;

// ---------------------------------------------------------------- particle VS
const PARTICLE_VS_PRELUDE = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec4 iPosSize;  // xyz center, w base size
layout(location = 4) in vec4 iColor;    // start color RGBA
layout(location = 5) in vec4 iMisc;     // x life01, y seed, z rotation, w free
layout(location = 6) in vec4 iVel;      // xyz velocity

uniform mat4 uView;
uniform mat4 uProj;
uniform sampler2D uCurveTex;
uniform int uMeshMode; // 0 = camera-facing quad, 1 = mesh

out vec2 vUV;
out vec4 vColor;
out float vLife;
out float vSeed;
out vec3 vWorldPos;
out vec3 vNormal;
`;

const PARTICLE_VS_MAIN = `
void main(){
  float life = iMisc.x;
  float seed = iMisc.y;
  float rot  = iMisc.z;
  vec4 lifeColor = texture(uCurveTex, vec2(life, 0.25));
  float sizeMul  = texture(uCurveTex, vec2(life, 0.75)).r;
  float size = iPosSize.w * sizeMul;
  vec3 centerWS = iPosSize.xyz;

  VertexData v;
  if (uMeshMode == 0) {
    vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
    vec3 up    = vec3(uView[0][1], uView[1][1], uView[2][1]);
    float c = cos(rot), s = sin(rot);
    vec2 p = vec2(aPos.x * c - aPos.y * s, aPos.x * s + aPos.y * c) * size;
    v.positionWS = centerWS + right * p.x + up * p.y;
    v.normalWS = normalize(uCameraPos - centerWS);
  } else {
    float c = cos(rot), s = sin(rot);
    mat3 R = mat3(c, 0.0, -s,  0.0, 1.0, 0.0,  s, 0.0, c);
    v.positionWS = centerWS + R * (aPos * size);
    v.normalWS = R * aNormal;
  }
  v.uv = aUV;

  Particle p;
  p.center = centerWS;
  p.velocity = iVel.xyz;
  p.color = iColor * lifeColor;
  p.size = size;
  p.rotation = rot;
  p.life = life;
  p.seed = seed;

  mainVertex(v, p);

  vUV = v.uv;
  vColor = p.color;
  vLife = life;
  vSeed = seed;
  vWorldPos = v.positionWS;
  vNormal = v.normalWS;
  gl_Position = uProj * uView * vec4(v.positionWS, 1.0);
}
`;

function countLines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

export function buildParticleVS(userCode) {
  const prelude = VERSION + COMMON_UNIFORMS + PARTICLE_VS_PRELUDE + NOISE_GLSL + STRUCTS_GLSL;
  const src = prelude + userCode + '\n' + PARTICLE_VS_MAIN;
  return { src, lineOffset: countLines(prelude) };
}

// ---------------------------------------------------------------- particle FS
const PARTICLE_FS_VARYINGS = `
in vec2 vUV;
in vec4 vColor;
in float vLife;
in float vSeed;
in vec3 vWorldPos;
in vec3 vNormal;
uniform float uAlphaCutoff;
`;

const FS_SURFACE_SETUP = `
  SurfaceInput si;
  si.uv = vUV;
  si.color = vColor;
  si.life = vLife;
  si.seed = vSeed;
  si.positionWS = vWorldPos;
  si.normalWS = normalize(vNormal);
  si.viewDirWS = normalize(uCameraPos - vWorldPos);
  Surface s;
  s.albedo = si.color.rgb;
  s.metallic = 0.0;
  s.roughness = 0.5;
  s.normal = si.normalWS;
  s.emissive = vec3(0.0);
  s.occlusion = 1.0;
  s.alpha = si.color.a;
  mainSurface(s, si);
  vec3 N = normalize(gl_FrontFacing ? s.normal : -s.normal);
`;

const FS_GBUFFER_MAIN = `
layout(location = 0) out vec4 oAlbedoMetal;
layout(location = 1) out vec4 oNormalRough;
layout(location = 2) out vec4 oEmissiveAO;
void main(){
${FS_SURFACE_SETUP}
#if BLENDMODE == 1
  if (s.alpha < uAlphaCutoff) discard;
#endif
#if SHADING_LIT == 0
  oAlbedoMetal = vec4(0.0);
  oNormalRough = vec4(N * 0.5 + 0.5, 1.0);
  oEmissiveAO = vec4(s.albedo + s.emissive, s.occlusion);
#else
  oAlbedoMetal = vec4(s.albedo, s.metallic);
  oNormalRough = vec4(N * 0.5 + 0.5, clamp(s.roughness, 0.03, 1.0));
  oEmissiveAO = vec4(s.emissive, s.occlusion);
#endif
}
`;

const FS_FORWARD_MAIN = `
uniform sampler2D uSceneDepth;
uniform float uSoftDistance;
layout(location = 0) out vec4 oColor;
void main(){
${FS_SURFACE_SETUP}
#if BLENDMODE == 1
  if (s.alpha < uAlphaCutoff) discard;
#endif
  float fade = 1.0;
#ifdef SOFT_PARTICLES
  float sceneD = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r;
  float sceneZ = linearizeDepth(sceneD);
  float fragZ = linearizeDepth(gl_FragCoord.z);
  fade = clamp((sceneZ - fragZ) / max(uSoftDistance, 1e-4), 0.0, 1.0);
#endif
#if SHADING_LIT == 1
  vec3 col = shadeSurface(si.positionWS, N, si.viewDirWS, s.albedo, s.metallic, clamp(s.roughness, 0.03, 1.0), s.occlusion) + s.emissive;
#else
  vec3 col = s.albedo + s.emissive;
#endif
  float alpha = clamp(s.alpha * fade, 0.0, 1.0);
#if BLENDMODE == 3
  oColor = vec4(col * alpha, 0.0);   // additive (ONE, ONE)
#elif BLENDMODE == 2
  oColor = vec4(col, alpha);         // alpha blend
#else
  oColor = vec4(col, 1.0);           // opaque / cutout
#endif
}
`;

const BLENDMODE_INDEX = { opaque: 0, cutout: 1, blend: 2, add: 3 };

export function buildParticleFS(userCode, variant, opts) {
  const defines =
    `#define BLENDMODE ${BLENDMODE_INDEX[opts.blendMode] ?? 0}\n` +
    `#define SHADING_LIT ${opts.lit ? 1 : 0}\n` +
    (opts.soft && variant === 'forward' ? '#define SOFT_PARTICLES\n' : '');
  let prelude = VERSION + defines + COMMON_UNIFORMS + PARTICLE_FS_VARYINGS + NOISE_GLSL + STRUCTS_GLSL;
  if (variant === 'forward') {
    prelude += LIGHT_UNIFORMS + PBR_GLSL + DEPTH_UTIL;
  }
  const main = variant === 'gbuffer' ? FS_GBUFFER_MAIN : FS_FORWARD_MAIN;
  return { src: prelude + userCode + '\n' + main, lineOffset: countLines(prelude) };
}

// ---------------------------------------------------------------- floor
export const FLOOR_VS = VERSION + `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vWorldPos;
out vec3 vNormal;
void main(){
  vWorldPos = aPos;
  vNormal = aNormal;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}
`;

const FLOOR_SURFACE = `
in vec3 vWorldPos;
in vec3 vNormal;
uniform float uGridEnabled;
vec4 floorAlbedoRough(){
  vec2 xz = vWorldPos.xz;
  float checker = mod(floor(xz.x) + floor(xz.y), 2.0);
  vec3 albedo = mix(vec3(0.135), vec3(0.16), checker);
  vec2 g = abs(fract(xz + 0.5) - 0.5) / max(fwidth(xz), vec2(1e-5));
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  albedo = mix(albedo, vec3(0.32), line * 0.45 * uGridEnabled);
  float dist = length(xz);
  albedo = mix(albedo, vec3(0.10), smoothstep(8.0, 22.0, dist));
  return vec4(albedo, 0.82);
}
`;

export const FLOOR_FS_GBUFFER = VERSION + FLOOR_SURFACE + `
layout(location = 0) out vec4 oAlbedoMetal;
layout(location = 1) out vec4 oNormalRough;
layout(location = 2) out vec4 oEmissiveAO;
void main(){
  vec4 ar = floorAlbedoRough();
  oAlbedoMetal = vec4(ar.rgb, 0.0);
  oNormalRough = vec4(normalize(vNormal) * 0.5 + 0.5, ar.a);
  oEmissiveAO = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

export const FLOOR_FS_FORWARD = VERSION + `
#define PI 3.14159265359
uniform vec3 uCameraPos;
` + LIGHT_UNIFORMS + PBR_GLSL + FLOOR_SURFACE + `
layout(location = 0) out vec4 oColor;
void main(){
  vec4 ar = floorAlbedoRough();
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  oColor = vec4(shadeSurface(vWorldPos, N, V, ar.rgb, 0.0, ar.a, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------- fullscreen
export const FULLSCREEN_VS = VERSION + `
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const SKY_FS = VERSION + `
#define PI 3.14159265359
in vec2 vUV;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
` + LIGHT_UNIFORMS + PBR_GLSL + `
layout(location = 0) out vec4 oColor;
void main(){
  vec4 wp = uInvViewProj * vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - uCameraPos);
  oColor = vec4(skyColor(dir), 1.0);
}
`;

export const DEFERRED_LIGHT_FS = VERSION + `
#define PI 3.14159265359
in vec2 vUV;
uniform sampler2D uGA;   // albedo + metallic
uniform sampler2D uGB;   // normal + roughness
uniform sampler2D uGC;   // emissive + ao
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform int uDebugMode;  // 0 lit, 1 albedo, 2 normal, 3 rough/metal, 4 emissive, 5 depth
` + LIGHT_UNIFORMS + PBR_GLSL + DEPTH_UTIL + `
layout(location = 0) out vec4 oColor;
void main(){
  float d = texture(uDepth, vUV).r;
  if (d >= 1.0) {
    if (uDebugMode != 0) { oColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    discard; // keep the sky pass result
  }
  vec4 ga = texture(uGA, vUV);
  vec4 gb = texture(uGB, vUV);
  vec4 gc = texture(uGC, vUV);
  vec3 N = normalize(gb.rgb * 2.0 - 1.0);
  vec4 wp = uInvViewProj * vec4(vUV * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 P = wp.xyz / wp.w;
  vec3 V = normalize(uCameraPos - P);
  vec3 col = shadeSurface(P, N, V, ga.rgb, ga.a, gb.a, gc.a) + gc.rgb;
  if (uDebugMode == 1) col = ga.rgb + gc.rgb * step(length(ga.rgb), 0.001);
  else if (uDebugMode == 2) col = N * 0.5 + 0.5;
  else if (uDebugMode == 3) col = vec3(gb.a, ga.a, 0.0);
  else if (uDebugMode == 4) col = gc.rgb;
  else if (uDebugMode == 5) col = vec3(linearizeDepth(d) / uCamNearFar.y);
  oColor = vec4(col, 1.0);
}
`;

export const BRIGHT_FS = VERSION + `
in vec2 vUV;
uniform sampler2D uSrc;
uniform float uThreshold;
layout(location = 0) out vec4 oColor;
void main(){
  vec3 c = texture(uSrc, vUV).rgb;
  float l = max(max(c.r, c.g), c.b);
  float k = max(0.0, l - uThreshold) / max(l, 1e-4);
  oColor = vec4(c * k, 1.0);
}
`;

export const BLUR_FS = VERSION + `
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uDir; // texel-space step
layout(location = 0) out vec4 oColor;
void main(){
  const float w[5] = float[](0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
  vec3 c = texture(uSrc, vUV).rgb * w[0];
  for (int i = 1; i < 5; i++){
    c += texture(uSrc, vUV + uDir * float(i)).rgb * w[i];
    c += texture(uSrc, vUV - uDir * float(i)).rgb * w[i];
  }
  oColor = vec4(c, 1.0);
}
`;

export const POST_FS = VERSION + `
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform float uExposure;
uniform float uBloomIntensity;
uniform int uMode; // 0 = tonemap, 1 = passthrough (debug views)
layout(location = 0) out vec4 oColor;
vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
void main(){
  vec3 c = texture(uScene, vUV).rgb;
  if (uMode == 1) { oColor = vec4(pow(max(c, 0.0), vec3(1.0 / 2.2)), 1.0); return; }
  vec3 bloom = texture(uBloomA, vUV).rgb * 0.6 + texture(uBloomB, vUV).rgb * 0.6;
  c += bloom * uBloomIntensity;
  c *= uExposure;
  c = aces(c);
  c = pow(c, vec3(1.0 / 2.2));
  oColor = vec4(c, 1.0);
}
`;

// ---------------------------------------------------------------- templates
export const DEFAULT_VS = `// Vertex stage — runs for every vertex of every particle.
// Modify v.positionWS / v.normalWS / v.uv. See Help (?) for the full API.

void mainVertex(inout VertexData v, in Particle p) {
  // Example: stretch along velocity
  // v.positionWS += p.velocity * 0.05 * (v.uv.y - 0.5);
}
`;

export const DEFAULT_FS = `// Fragment stage — fill in the PBR Surface. See Help (?) for the full API.
// i.color already includes color-over-life and alpha-over-life.

void mainSurface(inout Surface s, in SurfaceInput i) {
  float d = length(i.uv - 0.5) * 2.0;   // soft round sprite
  s.albedo = i.color.rgb;
  s.roughness = 0.6;
  s.metallic = 0.0;
  s.emissive = vec3(0.0);
  s.alpha = i.color.a * smoothstep(1.0, 0.55, d);
}
`;
