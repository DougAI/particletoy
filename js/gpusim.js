// GPU particle simulation runtime: per-emitter compute resources/pipelines,
// plus a shared bitonic sorter for back-to-front blended rendering.
//
// Frame flow (all in the frame's one command encoder, before any render pass):
//   [clearBuffer on restart] -> compute pass: spawnMain, updateMain
//   -> (blended, non-additive) buildKeys, bitonic steps, scatter
//   -> render passes draw with drawIndexedIndirect; no CPU readback anywhere.

import { UniformBlock, compileModule } from './gpu.js';
import { INSTANCE_FLOATS } from './particles.js';
import {
  buildSimSlang, particleBlock, sanitizeFields,
  SIM_FIELDS, SHAPE_INDEX, PROPS_SIM_SRC, WORKGROUP_SIZE,
} from './simlib.js';
import { loadSlang, compileSlang, STAGE } from './slangc.js';
import { simFromCache } from './wgslcache.js';
import { degToRad } from './math3d.js';

const nextPow2 = (x) => { let n = 1; while (n < x) n <<= 1; return n; };

// ---------------------------------------------------------------- sort WGSL

const SORT_WGSL = `
struct SortParams { camPos: vec3f, n: u32, viewDir: vec3f, pad: u32 }
struct KJ { k: u32, j: u32 }
@group(0) @binding(0) var<uniform> sq: SortParams;
@group(0) @binding(1) var<uniform> kj: KJ;
@group(0) @binding(2) var<storage, read_write> pairs: array<vec2f>;
struct InstanceData { posSize: vec4f, color: vec4f, misc: vec4f, vel: vec4f }
@group(0) @binding(3) var<storage, read> instIn: array<InstanceData>;
@group(0) @binding(4) var<storage, read_write> instSorted: array<InstanceData>;
struct DrawArgsRO { indexCount: u32, instanceCount: u32, firstIndex: u32, baseVertex: u32, firstInstance: u32 }
@group(0) @binding(5) var<storage, read> argsRO: DrawArgsRO;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn buildKeys(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sq.n) { return; }
  if (i < argsRO.instanceCount) {
    let d = dot(instIn[i].posSize.xyz - sq.camPos, sq.viewDir);
    pairs[i] = vec2f(-d, f32(i));      // ascending sort => farthest first
  } else {
    pairs[i] = vec2f(3.0e38, f32(i));  // dead slots sink to the end
  }
}
@compute @workgroup_size(${WORKGROUP_SIZE})
fn bitonicStep(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sq.n) { return; }
  let ixj = i ^ kj.j;
  if (ixj > i) {
    let a = pairs[i];
    let b = pairs[ixj];
    let up = (i & kj.k) == 0u;
    if ((a.x > b.x) == up) {
      pairs[i] = b;
      pairs[ixj] = a;
    }
  }
}
@compute @workgroup_size(${WORKGROUP_SIZE})
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= argsRO.instanceCount) { return; }
  instSorted[i] = instIn[u32(pairs[i].y)];
}
`;

/** Shared, lazily-built sorter: pipelines + a dynamic-offset (k,j) schedule
 *  buffer per pow2 size. Owned by the renderer (one per device). */
export class ParticleSorter {
  constructor(device) {
    this.device = device;
    const C = GPUShaderStage.COMPUTE;
    this.bgl = device.createBindGroupLayout({
      label: 'sort',
      entries: [
        { binding: 0, visibility: C, buffer: {} },
        { binding: 1, visibility: C, buffer: { hasDynamicOffset: true, minBindingSize: 8 } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const module = device.createShaderModule({ code: SORT_WGSL, label: 'particle-sort' });
    compileModule(device, SORT_WGSL, 'particle-sort').then(({ errors }) => {
      if (errors.length) console.error('[particletoy] sort shader failed:', errors);
    });
    const mk = (entryPoint) => device.createComputePipeline({
      layout, compute: { module, entryPoint },
    });
    this.pipeKeys = mk('buildKeys');
    this.pipeStep = mk('bitonicStep');
    this.pipeScatter = mk('scatter');
    this.schedules = new Map(); // n2 -> {buf, offsets[]}
  }

  /** (k, j) pass schedule for a pow2 size, in one dynamic-offset buffer. */
  schedule(n2) {
    let s = this.schedules.get(n2);
    if (s) return s;
    const kj = [];
    for (let k = 2; k <= n2; k <<= 1) {
      for (let j = k >> 1; j > 0; j >>= 1) kj.push([k, j]);
    }
    const STRIDE = 256; // minUniformBufferOffsetAlignment
    // Always allocate at least one stride: a size-1 buffer has an empty
    // schedule, and a zero-length uniform buffer can't satisfy the bind
    // group's minBindingSize (it would invalidate the whole frame).
    const data = new Uint32Array((STRIDE / 4) * Math.max(1, kj.length));
    kj.forEach(([k, j], i) => {
      data[(STRIDE / 4) * i] = k;
      data[(STRIDE / 4) * i + 1] = j;
    });
    const buf = this.device.createBuffer({
      label: `sort-kj-${n2}`, size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, data);
    s = { buf, offsets: kj.map((_, i) => i * STRIDE) };
    this.schedules.set(n2, s);
    return s;
  }
}

// ---------------------------------------------------------------- sim runtime

/**
 * Per-emitter GPU sim state. Created when an emitter enters simMode 'shader';
 * owns particle/instance/args buffers, the generated compute pipelines, and
 * (for sorted blending) the sort scratch buffers.
 */
export class SimRuntime {
  constructor(renderer, em) {
    this.renderer = renderer;
    this.device = renderer.device;
    this.em = em;
    this.simUB = new UniformBlock(this.device, SIM_FIELDS, 'sim-params');
    this.sortUB = new UniformBlock(this.device,
      [['camPos', 'vec3'], ['n', 'i32'], ['viewDir', 'vec3'], ['pad', 'i32']], 'sort-params');
    this.pipeSpawn = null;
    this.pipeUpdate = null;
    this.errors = [];
    this.dirty = true;       // shader source / fields changed
    this.capacity = 0;
    this.resetPending = true;
    this.frame = 0;
    this._seq = 0;
    this._statBuf = this.device.createBuffer({
      label: 'sim-stats', size: 20,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this._mapping = false;
    this._bgDirty = true;

    const C = GPUShaderStage.COMPUTE;
    this.bgl = renderer.simBGL ?? (renderer.simBGL = this.device.createBindGroupLayout({
      label: 'sim',
      entries: [
        { binding: 0, visibility: C, buffer: {} },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, sampler: {} },
        { binding: 5, visibility: C, texture: {} },
        { binding: 6, visibility: C, buffer: { type: 'read-only-storage' } },
      ],
    }));
    this.layout = renderer.simLayout ?? (renderer.simLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bgl],
    }));
  }

  /** Buffers sized to capacity × particle stride (recreated when either changes). */
  _ensureBuffers() {
    const em = this.em;
    const stride = particleBlock(em.p.fields).size;
    // Full-size only when the sim reads neighbors; otherwise a one-element
    // placeholder keeps the bind group valid for free.
    const neighborBytes = this.usesNeighbors ? stride * em.capacity : stride;
    if (this.capacity === em.capacity && this.stride === stride
      && this._neighborBytes === neighborBytes && this.particleBuf) return;
    this.capacity = em.capacity;
    this.stride = stride;
    this._neighborBytes = neighborBytes;
    for (const b of [this.particleBuf, this.prevBuf, this.instanceBuf, this.argsBuf, this.pairsBuf, this.sortedBuf]) b?.destroy();
    const dev = this.device;
    this.particleBuf = dev.createBuffer({
      label: 'sim-particles', size: this.stride * this.capacity,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.prevBuf = dev.createBuffer({
      label: 'sim-particles-prev', size: neighborBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.instanceBuf = dev.createBuffer({
      label: 'sim-instances', size: this.capacity * INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.argsBuf = dev.createBuffer({
      label: 'sim-args', size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.n2 = nextPow2(this.capacity);
    this.pairsBuf = dev.createBuffer({
      label: 'sim-sort-pairs', size: this.n2 * 8,
      usage: GPUBufferUsage.STORAGE,
    });
    this.sortedBuf = dev.createBuffer({
      label: 'sim-instances-sorted', size: this.capacity * INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.em.restart(); // fresh buffers hold no state; replay the spawn timeline
    this._bgDirty = true;
  }

  /** Recompiles the sim module (fields or source changed). */
  async compile() {
    const seq = ++this._seq;
    this.dirty = false;
    const em = this.em;
    const userCode = em.p.simSrc?.trim() ? em.p.simSrc : PROPS_SIM_SRC;

    // Cached path: the WGSL saved with the effect still matches this source, so
    // the compiler isn't needed. This is how the gallery runs compute sims.
    const cached = simFromCache(this.renderer.wgslCache, em.p);
    if (cached && await this._buildPipelines(seq, cached)) return this.errors;

    if (!this.renderer.allowCompile) {
      const errs = [{ stage: 'sim', variant: '', line: 0,
        msg: 'this effect was saved without a compiled sim shader, so it cannot run here — open it in the editor' }];
      if (seq === this._seq) this.errors = errs;
      return errs;
    }

    try {
      await loadSlang();
    } catch (ex) {
      const errs = [{ stage: 'sim', variant: '', line: 0, msg: `could not load the Slang compiler: ${ex?.message || ex}` }];
      if (seq === this._seq) this.errors = errs;
      return errs;
    }

    const build = buildSimSlang(userCode, em.p.fields);
    const slang = compileSlang(build.src, [
      { name: 'spawnMain', stage: STAGE.compute },
      { name: 'updateMain', stage: STAGE.compute },
    ]);
    const errors = slang.errors.map((e) => ({
      stage: 'sim', variant: '', line: Math.max(1, e.line - build.lineOffset), msg: e.msg,
    }));
    const res = slang.wgsl ? await compileModule(this.device, slang.wgsl, `sim:${em.p.name}`) : null;
    for (const e of res?.errors ?? []) {
      errors.push({ stage: 'sim', variant: '', line: 0, msg: e.msg });
    }
    if (res && !res.errors.length) {
      if (!await this._buildPipelines(seq, slang.wgsl)) {
        errors.push({ stage: 'sim', variant: '', line: 0, msg: 'pipeline creation failed' });
      }
    }
    if (seq === this._seq) this.errors = errors;
    return errors;
  }

  /**
   * Builds both compute pipelines from WGSL, skipping Slang. Returns false if
   * the WGSL turns out unusable, which the cached path treats as a miss.
   */
  async _buildPipelines(seq, wgsl) {
    const res = await compileModule(this.device, wgsl, `sim:${this.em.p.name}`);
    if (res.errors.length) return false;
    try {
      const [spawn, update] = await Promise.all([
        this.device.createComputePipelineAsync({ layout: this.layout, compute: { module: res.module, entryPoint: 'spawnMain' } }),
        this.device.createComputePipelineAsync({ layout: this.layout, compute: { module: res.module, entryPoint: 'updateMain' } }),
      ]);
      if (seq === this._seq) {
        this.pipeSpawn = spawn;
        this.pipeUpdate = update;
        // Kept so it can be saved with the effect — the gallery pages render
        // from that cache instead of loading the compiler.
        this.compiledWGSL = wgsl;
        this.errors = [];
        // The field layout may have changed, so existing particle state is
        // stale and gets cleared. Replay the emitter's spawn timeline too:
        // an emitter that populates itself from a t=0 burst has already
        // fired it, and would otherwise stay empty forever after an edit.
        this.em.restart();
      }
      return true;
    } catch {
      return false;
    }
  }

  _ensureBindGroups() {
    if (!this._bgDirty && this._lutView === this.em.lutView) return;
    this._lutView = this.em.lutView;
    this.bindGroup = this.device.createBindGroup({
      label: 'sim', layout: this.bgl,
      entries: [
        { binding: 0, resource: { buffer: this.simUB.buffer } },
        { binding: 1, resource: { buffer: this.particleBuf } },
        { binding: 2, resource: { buffer: this.instanceBuf } },
        { binding: 3, resource: { buffer: this.argsBuf } },
        { binding: 4, resource: this.renderer.linearClamp },
        { binding: 5, resource: this.em.lutView },
        { binding: 6, resource: { buffer: this.prevBuf } },
      ],
    });
    const sorter = this.renderer.sorter;
    this.sortBindGroup = this.device.createBindGroup({
      label: 'sim-sort', layout: sorter.bgl,
      entries: [
        { binding: 0, resource: { buffer: this.sortUB.buffer } },
        { binding: 1, resource: { buffer: sorter.schedule(this.n2).buf, size: 8 } },
        { binding: 2, resource: { buffer: this.pairsBuf } },
        { binding: 3, resource: { buffer: this.instanceBuf } },
        { binding: 4, resource: { buffer: this.sortedBuf } },
        { binding: 5, resource: { buffer: this.argsBuf } },
      ],
    });
    this._bgDirty = false;
  }

  /** Called once per frame before the compute pass: uniforms + arg reset. */
  prepare(frame) {
    const em = this.em;
    const src = em.p.simSrc?.trim() ? em.p.simSrc : PROPS_SIM_SRC;
    this.usesNeighbors = /\bneighbors\b/.test(src);
    this._ensureBuffers();
    if (this.dirty) {
      this.compile().then((errors) => this.renderer.onSimCompiled?.(this.em, errors));
    }
    this._ensureBindGroups();

    // Hold the spawn budget until the pipelines exist, otherwise an emitter
    // that spawns entirely from a t=0 burst loses it during the first frames
    // and never produces a single particle.
    const ready = !!(this.pipeSpawn && this.pipeUpdate);
    this._spawnNow = ready ? Math.min(em._pendingSpawn | 0, this.capacity) : 0;

    const p = em.p;
    const sh = p.shape;
    const dt = em._stepDt || 0;
    this.frame++;
    this.simUB
      .set('emitterPos', p.position).set('dt', dt)
      .set('gravity', p.gravity).set('time', em.time)
      .set('boxSize', sh.boxSize).set('drag', p.drag)
      .set('colorA', p.colorStartA).set('colorB', p.colorStartB)
      .set('speedRange', p.speed).set('lifetimeRange', p.lifetime)
      .set('sizeRange', p.sizeStart)
      .set('rotationRange', [degToRad(p.rotationStart[0]), degToRad(p.rotationStart[1])])
      .set('rotSpeedRange', [degToRad(p.rotationSpeed[0]), degToRad(p.rotationSpeed[1])])
      .set('spread', p.spread).set('shapeRadius', sh.radius)
      .set('shapeAngle', degToRad(sh.angle)).set('shapeType', SHAPE_INDEX[sh.type] ?? 0)
      .set('spawnCount', this._spawnNow).set('spawnCursor', em._spawnCursor | 0)
      .set('capacity', this.capacity).set('frameSeed', (this.frame * 2654435761) & 0x7fffffff)
      .upload();

    // reset instance count + set index count for this frame's mesh
    this.device.queue.writeBuffer(this.argsBuf, 0, new Uint32Array([em.mesh.count, 0, 0, 0, 0]));

    if (ready) {
      em._spawnCursor = ((em._spawnCursor | 0) + this._spawnNow) % this.capacity;
      em._pendingSpawn = 0;
      em._stepDt = 0;
    }
  }

  /** Encoder-level work that must precede the compute pass. */
  preEncode(enc) {
    if (this.resetPending) {
      enc.clearBuffer(this.particleBuf);
      enc.clearBuffer(this.prevBuf);
      this.resetPending = false;
    }
    // Snapshot last frame's state so neighbor lookups can't race this frame's
    // writes. Taken before the compute pass, so it excludes particles spawned
    // this frame — they join the flock next frame.
    if (this.usesNeighbors) {
      enc.copyBufferToBuffer(this.particleBuf, 0, this.prevBuf, 0, this._neighborBytes);
    }
  }

  /** Spawn + update dispatches (inside an open compute pass). */
  dispatch(cpass) {
    if (!this.pipeSpawn || !this.pipeUpdate) return;
    cpass.setBindGroup(0, this.bindGroup);
    if (this._spawnNow > 0) {
      cpass.setPipeline(this.pipeSpawn);
      cpass.dispatchWorkgroups(Math.ceil(this._spawnNow / WORKGROUP_SIZE));
    }
    cpass.setPipeline(this.pipeUpdate);
    cpass.dispatchWorkgroups(Math.ceil(this.capacity / WORKGROUP_SIZE));
  }

  /** Back-to-front sort of the live instances (inside the compute pass,
   *  after dispatch). Draw from sortedBuf afterwards. */
  encodeSort(cpass, camPos, viewDir) {
    if (!this.pipeUpdate) return false;
    // Nothing to order below two slots, and the bitonic schedule is empty at
    // that size — skip rather than encode a degenerate pass. Draw then falls
    // back to instanceBuf, which is trivially in order at one particle.
    if (this.n2 < 2) return false;
    const sorter = this.renderer.sorter;
    this.sortUB.set('camPos', camPos).set('n', this.n2).set('viewDir', viewDir).upload();
    const sched = sorter.schedule(this.n2);
    const groups = Math.ceil(this.n2 / WORKGROUP_SIZE);
    cpass.setPipeline(sorter.pipeKeys);
    cpass.setBindGroup(0, this.sortBindGroup, [0]);
    cpass.dispatchWorkgroups(groups);
    cpass.setPipeline(sorter.pipeStep);
    for (const off of sched.offsets) {
      cpass.setBindGroup(0, this.sortBindGroup, [off]);
      cpass.dispatchWorkgroups(groups);
    }
    cpass.setPipeline(sorter.pipeScatter);
    cpass.setBindGroup(0, this.sortBindGroup, [0]);
    cpass.dispatchWorkgroups(Math.ceil(this.capacity / WORKGROUP_SIZE));
    this.sorted = true;
    return true;
  }

  /** Async particle-count readback for the stats line (throttled, 1 frame stale). */
  encodeStats(enc) {
    if (this._mapping) return;
    enc.copyBufferToBuffer(this.argsBuf, 0, this._statBuf, 0, 20);
    this._statPending = true;
  }

  readStats() {
    if (this._mapping || !this._statPending) return;
    this._mapping = true;
    this._statPending = false;
    this._statBuf.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(this._statBuf.getMappedRange());
      this.em.count = u[1];
      this._statBuf.unmap();
      this._mapping = false;
    }).catch(() => { this._mapping = false; });
  }

  dispose() {
    this._seq++;
    for (const b of [this.particleBuf, this.prevBuf, this.instanceBuf, this.argsBuf,
      this.pairsBuf, this.sortedBuf, this._statBuf]) {
      b?.destroy();
    }
    this.simUB.dispose();
    this.sortUB.dispose();
    this.particleBuf = null;
  }
}
