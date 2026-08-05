// Best-effort legacy GLSL -> WGSL migration for user material code.
//
// particletoy originally wrapped user GLSL (WebGL2); the engine now runs on
// WebGPU and speaks WGSL. Old shaders persist in share links, localStorage
// libraries and the community DB, so sources that look like GLSL are
// syntactically converted on load. The dialect users wrote against is small
// and regular, which makes a light textual translation resurrect almost all
// of them; anything it misses surfaces as a normal compile error in the
// editor where it can be fixed by hand.

const TYPE_MAP = {
  float: 'f32', int: 'i32', bool: 'bool',
  vec2: 'vec2f', vec3: 'vec3f', vec4: 'vec4f',
  mat3: 'mat3x3f', mat4: 'mat4x4f',
};

export function looksLikeGLSL(src) {
  return /\bvoid\s+main(Vertex|Surface)\b|\binout\s+\w|\bvec[234]\s+\w+\s*=/.test(src || '');
}

function mapParam(p) {
  const cleaned = p.trim().replace(/^(in|inout|out)\s+/, '');
  const m = cleaned.match(/^(\w+)\s+(\w+)$/);
  if (!m) return cleaned;
  return `${m[2]}: ${TYPE_MAP[m[1]] || m[1]}`;
}

/** clamp(x, 0.0, 1.0) -> saturate(x), with real paren matching (regexes
 *  can't see nesting and this idiom is everywhere in GLSL). */
function clampToSaturate(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const at = s.indexOf('clamp(', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    // balanced-paren scan of the argument list
    let depth = 1;
    let j = at + 6;
    const commas = [];
    while (j < s.length && depth > 0) {
      const c = s[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 1) commas.push(j);
      j++;
    }
    const inner = s.slice(at + 6, j - 1);
    if (depth === 0 && commas.length === 2) {
      const a1 = s.slice(at + 6, commas[0]).trim();
      const a2 = s.slice(commas[0] + 1, commas[1]).trim();
      const a3 = s.slice(commas[1] + 1, j - 1).trim();
      if (/^0\.?0*$/.test(a2) && /^1\.?0*$/.test(a3)) {
        out += `saturate(${clampToSaturate(a1)})`;
        i = j;
        continue;
      }
    }
    out += `clamp(${clampToSaturate(inner)})`;
    i = j;
  }
  return out;
}

export function glslToWGSL(src) {
  let s = src;
  // 1. the two entry points become pointer-parameter WGSL functions
  s = s.replace(
    /void\s+mainVertex\s*\(\s*inout\s+VertexData\s+(\w+)\s*,\s*(?:in\s+)?Particle\s+(\w+)\s*\)/g,
    'fn mainVertex($1: ptr<function, VertexData>, $2: Particle)');
  s = s.replace(
    /void\s+mainSurface\s*\(\s*inout\s+Surface\s+(\w+)\s*,\s*(?:in\s+)?SurfaceInput\s+(\w+)\s*\)/g,
    'fn mainSurface($1: ptr<function, Surface>, $2: SurfaceInput)');
  // 2. other function definitions: `vec3 hue(float h) {` -> `fn hue(h: f32) -> vec3f {`
  s = s.replace(/^(float|int|bool|vec[234]|mat[34]|void)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm,
    (all, ret, name, params) => {
      const ps = params.trim() ? params.split(',').map(mapParam).join(', ') : '';
      const retTy = ret === 'void' ? '' : ` -> ${TYPE_MAP[ret] || ret}`;
      return `fn ${name}(${ps})${retTy} {`;
    });
  // 3. local declarations -> var (GLSL locals are mutable)
  s = s.replace(/(^|[({;]\s*|\n\s*)(float|int|bool|vec[234])\s+(\w+)\s*=/g, '$1var $3 =');
  s = s.replace(/(^|[({;]\s*|\n\s*)(float|int|bool|vec[234])\s+(\w+)\s*;/g,
    (a, pre, ty, name) => `${pre}var ${name}: ${TYPE_MAP[ty]};`);
  // 4. constructors / casts
  s = s.replace(/\bvec2\s*\(/g, 'vec2f(').replace(/\bvec3\s*\(/g, 'vec3f(').replace(/\bvec4\s*\(/g, 'vec4f(');
  s = s.replace(/\bmat3\s*\(/g, 'mat3x3f(').replace(/\bmat4\s*\(/g, 'mat4x4f(');
  s = s.replace(/\bfloat\s*\(/g, 'f32(').replace(/\bint\s*\(/g, 'i32(');
  // 5. built-in uniforms (uTime / iTime shadertoy aliases)
  s = s.replace(/\b[ui]Time\b/g, 'u.time')
    .replace(/\b[ui]Resolution\b/g, 'u.resolution')
    .replace(/\b[ui]Mouse\b/g, 'u.mouse')
    .replace(/\buCameraPos\b/g, 'u.cameraPos');
  // 6. common idioms
  s = clampToSaturate(s);
  s = s.replace(/\bmod\(/g, 'fmod('); // note: vec3 mod needs fmod3 by hand
  return s;
}

/** Converts a material's sources in place when they look like GLSL. */
export function migrateMaterial(m) {
  if (m.vertexSrc && looksLikeGLSL(m.vertexSrc)) m.vertexSrc = glslToWGSL(m.vertexSrc);
  if (m.fragmentSrc && looksLikeGLSL(m.fragmentSrc)) m.fragmentSrc = glslToWGSL(m.fragmentSrc);
  return m;
}
