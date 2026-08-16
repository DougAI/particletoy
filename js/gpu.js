// WebGPU helpers: device + canvas context creation, uniform blocks whose JS
// layout mirrors WGSL struct layout rules, shader-module compilation with
// structured error info, texture and mesh upload, and small conversions.

export async function createGPU(canvas) {
  if (!navigator.gpu) {
    return { error: 'WebGPU is not supported by this browser. It needs a recent Chrome, Edge, Safari or Firefox.' };
  }
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch { /* fall through */ }
  if (!adapter) return { error: 'WebGPU is available but no GPU adapter was found.' };
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) return { error: 'Could not create a WebGPU canvas context.' };
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  device.addEventListener?.('uncapturederror', (e) => {
    console.error('[particletoy] WebGPU error:', e.error?.message || e);
  });
  return { device, context, format, error: null };
}

// ---------------------------------------------------------------- uniforms
//
// A block is defined once as [[name, type]] (or [name, 'vec4', count] for
// arrays) and produces BOTH the WGSL struct source and the JS byte offsets,
// so the two can never disagree. Offsets follow WGSL struct layout rules:
// member offset = roundUp(alignOf(type), prevEnd); vec3 aligns to 16 but a
// following f32 packs into its 4th lane. Arrays are vec4-only (stride 16).

// `slang` is the type as written in Slang source. Matrices carry an explicit
// column_major: Slang defaults to row-major storage, which would read the four
// vec4s written here as rows and silently transpose every matrix.
const TYPE_INFO = {
  f32: { size: 4, align: 4, wgsl: 'f32', slang: 'float' },
  i32: { size: 4, align: 4, wgsl: 'i32', slang: 'int' },
  vec2: { size: 8, align: 8, wgsl: 'vec2f', slang: 'float2' },
  vec3: { size: 12, align: 16, wgsl: 'vec3f', slang: 'float3' },
  vec4: { size: 16, align: 16, wgsl: 'vec4f', slang: 'float4' },
  mat4: { size: 64, align: 16, wgsl: 'mat4x4f', slang: 'column_major float4x4' },
};

const alignUp = (x, a) => Math.ceil(x / a) * a;

export function defineBlock(fields) {
  const layout = new Map();
  let cur = 0;
  for (const [name, type, count] of fields) {
    if (count !== undefined) {
      if (type !== 'vec4') throw new Error(`array field ${name}: only vec4 arrays are supported`);
      const offset = alignUp(cur, 16);
      layout.set(name, { offset, type, count });
      cur = offset + 16 * count;
    } else {
      const info = TYPE_INFO[type];
      if (!info) throw new Error(`unknown uniform type ${type}`);
      const offset = alignUp(cur, info.align);
      layout.set(name, { offset, type });
      cur = offset + info.size;
    }
  }
  const size = alignUp(cur, 16);
  const wgslStruct = (structName) => {
    const lines = fields.map(([name, type, count]) =>
      count !== undefined ? `  ${name}: array<vec4f, ${count}>,` : `  ${name}: ${TYPE_INFO[type].wgsl},`);
    return `struct ${structName} {\n${lines.join('\n')}\n}`;
  };
  // Slang's std140/std430 rules agree with the WGSL rules `layout` was computed
  // under (vec3 aligns to 16 with a following f32 packing into its 4th lane,
  // vec4 arrays stride 16), so both emitters and the JS offsets stay in step.
  const slangStruct = (structName) => {
    const lines = fields.map(([name, type, count]) =>
      count !== undefined ? `  float4 ${name}[${count}];` : `  ${TYPE_INFO[type].slang} ${name};`);
    return `struct ${structName} {\n${lines.join('\n')}\n};`;
  };
  return { layout, size, wgslStruct, slangStruct, fields };
}

export class UniformBlock {
  constructor(device, fields, label = 'uniforms') {
    const def = defineBlock(fields);
    this.layout = def.layout;
    this.size = def.size;
    this.wgslStruct = def.wgslStruct;
    this.device = device;
    this.data = new ArrayBuffer(def.size);
    this.f32 = new Float32Array(this.data);
    this.i32 = new Int32Array(this.data);
    this.buffer = device.createBuffer({
      label, size: def.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dirty = true;
  }

  /** set('name', scalar | [x,y,..] | Float32Array). Arrays take count*4 floats. */
  set(name, v) {
    const f = this.layout.get(name);
    if (!f) throw new Error(`unknown uniform field ${name}`);
    const o = f.offset >> 2;
    if (typeof v === 'number') {
      if (f.type === 'i32') this.i32[o] = v | 0;
      else this.f32[o] = v;
    } else {
      const n = f.count !== undefined ? f.count * 4 : Math.min(v.length, TYPE_INFO[f.type].size >> 2);
      for (let i = 0; i < n; i++) this.f32[o + i] = v[i];
    }
    this.dirty = true;
    return this;
  }

  upload() {
    if (!this.dirty) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.data);
    this.dirty = false;
  }

  dispose() { this.buffer.destroy(); }
}

// ---------------------------------------------------------------- shaders

/**
 * Creates a shader module and collects structured compile errors.
 * Returns { module, errors: [{line, msg}] } — line numbers are 1-based
 * relative to the full module source (callers subtract their prelude).
 */
export async function compileModule(device, code, label) {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errors = [];
  for (const m of info.messages) {
    if (m.type === 'error') errors.push({ line: m.lineNum || 0, msg: m.message });
  }
  return { module, errors };
}

// ---------------------------------------------------------------- textures

export function createTex(device, w, h, format, usage, label) {
  return device.createTexture({
    label, format,
    size: { width: Math.max(1, w), height: Math.max(1, h) },
    usage: usage ?? (GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING),
  });
}

/** float32 -> float16 bits (round-to-nearest-even not needed for our LUT use). */
const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);
export function toHalf(x) {
  f32Scratch[0] = x;
  const bits = u32Scratch[0];
  const sign = (bits >>> 16) & 0x8000;
  let exp = (bits >>> 23) & 0xff;
  let mant = bits & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 1 : 0);       // inf / nan
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00;                          // overflow -> inf
  if (exp <= 0) {                                                 // subnormal / zero
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | (mant >> 13);
  }
  return sign | (exp << 10) | (mant >> 13);
}

export function toHalfArray(f32arr) {
  const out = new Uint16Array(f32arr.length);
  for (let i = 0; i < f32arr.length; i++) out[i] = toHalf(f32arr[i]);
  return out;
}

// ---------------------------------------------------------------- buffers / meshes

export function makeBuffer(device, data, usage, label) {
  const size = alignUp(data.byteLength, 4);
  const buf = device.createBuffer({ label, size, usage, mappedAtCreation: true });
  new data.constructor(buf.getMappedRange()).set(data);
  buf.unmap();
  return buf;
}

/** Uploads a mesh to GPU buffers. Returns {vboPos, vboNrm, vboUV, ibo, count, indexFormat}. */
export function uploadMesh(device, mesh) {
  const vboPos = makeBuffer(device, mesh.positions, GPUBufferUsage.VERTEX, 'mesh-pos');
  const vboNrm = makeBuffer(device, mesh.normals, GPUBufferUsage.VERTEX, 'mesh-nrm');
  const vboUV = makeBuffer(device, mesh.uvs, GPUBufferUsage.VERTEX, 'mesh-uv');
  const ibo = makeBuffer(device, mesh.indices, GPUBufferUsage.INDEX, 'mesh-idx');
  return {
    vboPos, vboNrm, vboUV, ibo,
    count: mesh.indices.length,
    indexFormat: mesh.indices instanceof Uint32Array ? 'uint32' : 'uint16',
    dispose() {
      vboPos.destroy(); vboNrm.destroy(); vboUV.destroy(); ibo.destroy();
    },
  };
}

// Vertex buffer layouts shared by every mesh-drawing pipeline. Slots 0-2 are
// the mesh, slot 3 the per-instance data (INSTANCE_FLOATS * 4 bytes).
export const MESH_VERTEX_BUFFERS = [
  { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
];

// Particle materials can't use a fixed table: their vertex stage is compiled
// from Slang, and Slang picks WGSL @location indices from HLSL semantics rather
// than declaration order (POSITION lands on 0, but NORMAL on 5 and TEXCOORD0 on
// 6). slangc.parseVertexLocations() reads the real indices back off the
// generated code and they get threaded through here.
//
// Buffer *slot* order is unchanged and still matches the setVertexBuffer()
// calls in the renderer — only shaderLocation moves.
const PARTICLE_ATTRS = ['pos', 'normal', 'uv', 'iPosSize', 'iColor', 'iMisc', 'iVel'];

export function particleVertexBuffers(loc) {
  const at = (name) => {
    const i = loc?.[name];
    if (typeof i !== 'number') {
      throw new Error(`vertex stage did not declare an input named '${name}' (got: ${Object.keys(loc || {}).join(', ') || 'none'})`);
    }
    return i;
  };
  // Unused inputs are stripped from the generated WGSL, and a layout that
  // references a location the shader doesn't declare is a pipeline error — so
  // the engine's VS entry point must consume all seven, which it does.
  for (const name of PARTICLE_ATTRS) at(name);
  return [
    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: at('pos'), offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: at('normal'), offset: 0, format: 'float32x3' }] },
    { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: at('uv'), offset: 0, format: 'float32x2' }] },
    {
      arrayStride: 64, stepMode: 'instance',
      attributes: [
        { shaderLocation: at('iPosSize'), offset: 0, format: 'float32x4' },  // xyz center, w base size
        { shaderLocation: at('iColor'), offset: 16, format: 'float32x4' },   // start color RGBA
        { shaderLocation: at('iMisc'), offset: 32, format: 'float32x4' },    // x life01, y seed, z rotation
        { shaderLocation: at('iVel'), offset: 48, format: 'float32x4' },     // xyz velocity
      ],
    },
  ];
}
