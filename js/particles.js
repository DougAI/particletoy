// Particle emitter: parameters, CPU simulation, and GPU instance data.
//
// An Effect is composed of multiple Emitters (composability); each emitter
// references a Material by id and owns its over-lifetime curves.

import { makeCurve, makeGradient, evalCurve, bakeEmitterLUT, uploadLUT, LUT_SIZE, LUT_ROWS } from './curves.js';
import { makeQuad, makeCube, makeSphere, parseOBJ } from './geometry.js';
import { UniformBlock, createTex, uploadMesh } from './gpu.js';
import { DRAW_FIELDS } from './shaderlib.js';
import { randRange, lerp, degToRad } from './math3d.js';

export const INSTANCE_FLOATS = 16; // pos(3) size(1) color(4) life seed rot pad vel(3) pad
const SIM_FLOATS = 16;             // px py pz vx vy vz age life seed size0 rot rotVel r g b a

// Per-emitter particle count ceiling, shared by both simulation modes.
export const MAX_CAPACITY = 100_000;

let nextEmitterId = 1;

export function defaultEmitterParams() {
  return {
    id: `em${nextEmitterId++}`,
    name: 'Emitter',
    enabled: true,
    materialId: null,
    // GPU sim: 'props' runs the classic CPU sim driven by the properties
    // below; 'shader' runs a WGSL compute sim (simSrc, or the generated
    // default when empty) with optional extra per-particle fields.
    simMode: 'props',
    simSrc: '',
    fields: [], // [{name, type: 'f32'|'vec2'|'vec3'|'vec4'}]
    meshType: 'quad', // quad | sphere | cube | custom
    customMeshObj: '',
    position: [0, 0, 0],
    duration: 5,
    looping: true,
    spawn: { rate: 20, max: 1000, bursts: [] }, // bursts: [{time, count}]
    lifetime: [1, 2],
    shape: { type: 'cone', radius: 0.15, angle: 25, boxSize: [1, 0.2, 1] },
    speed: [1, 2],
    spread: 0,
    gravity: [0, 0, 0],
    drag: 0,
    speedOverLife: makeCurve([{ t: 0, v: 1 }, { t: 1, v: 1 }]),
    sizeStart: [0.15, 0.25],
    sizeOverLife: makeCurve([{ t: 0, v: 1 }, { t: 1, v: 1 }]),
    rotationStart: [0, 360],
    rotationSpeed: [0, 0],
    colorStartA: [1, 1, 1, 1],
    colorStartB: [1, 1, 1, 1],
    colorOverLife: makeGradient([{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }]),
    alphaOverLife: makeCurve([{ t: 0, v: 1 }, { t: 0.8, v: 1 }, { t: 1, v: 0 }]),
  };
}

function randomUnitVec() {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

export class Emitter {
  constructor(params) {
    this.p = params;
    this.time = 0;
    this.spawnAccum = 0;
    this.count = 0;
    this.capacity = 0;
    // GPU sim state (runtime attached by the renderer in shader mode)
    this.simRt = null;
    this.simDirty = false;
    this._pendingSpawn = 0;
    this._spawnCursor = 0;
    this._stepDt = 0;
    this.sim = null;       // Float32Array
    this.inst = null;      // Float32Array
    this.sortKeys = null;  // Float32Array for transparent sorting
    this.sortOrder = null; // Uint32Array
    // GPU state
    this.lutTex = null;
    this.lutView = null;
    this.lutDirty = true;
    this.instanceBuf = null;
    this.drawUB = null;      // per-draw uniform block (mesh mode, cutoff, ...)
    this.bindGroups = null;  // {gbuffer, forward}
    this._bgVersion = -1;    // renderer.targetsVersion the bind groups were built for
    this._gpuCapacity = 0;
    this.mesh = null;        // uploaded mesh currently in use
    this.meshKey = '';
    this._ensureCapacity();
  }

  _ensureCapacity() {
    const cap = Math.max(1, Math.min(MAX_CAPACITY, this.p.spawn.max | 0));
    // Compute-sim emitters never touch the CPU-side arrays (step() returns
    // before reaching them, fillInstances() is only called for CPU-driven
    // emitters) — skip allocating them so a GPU sim doesn't also carry a
    // same-size CPU allocation it never uses.
    const needsCPU = this.p.simMode !== 'shader';
    const cpuStale = needsCPU ? !this.sim : !!this.sim;
    if (cap === this.capacity && !cpuStale) return false;
    this.capacity = cap;
    if (needsCPU) {
      this.sim = new Float32Array(cap * SIM_FLOATS);
      this.inst = new Float32Array(cap * INSTANCE_FLOATS);
      this.sortKeys = new Float32Array(cap);
      this.sortOrder = new Uint32Array(cap);
    } else {
      this.sim = this.inst = this.sortKeys = this.sortOrder = null;
    }
    this.count = Math.min(this.count, cap);
    return true; // GPU buffer needs realloc
  }

  restart() {
    this.time = 0;
    this.spawnAccum = 0;
    this.count = 0;
    this._pendingSpawn = 0;
    this._spawnCursor = 0;
    this._stepDt = 0;
    if (this.simRt) this.simRt.resetPending = true;
  }

  /** Advance simulation by dt seconds (already time-scaled). */
  step(dt) {
    const p = this.p;
    if (!p.enabled) { this.count = 0; this._pendingSpawn = 0; return; }
    this._ensureCapacity(); // GPU buffer realloc is detected in ensureGPU

    const prevTime = this.time;
    this.time += dt;
    this._stepDt = dt;

    // --- spawn budget (rate + bursts), shared by the CPU and GPU sim paths
    let budget = 0;
    const dur = Math.max(0.01, p.duration);
    const active = p.looping || this.time <= dur;
    if (active && dt > 0) {
      // continuous rate
      this.spawnAccum += p.spawn.rate * dt;
      budget = Math.floor(this.spawnAccum);
      this.spawnAccum -= budget;
      // bursts: fire when local time crosses burst.time
      const prevLocal = p.looping ? prevTime % dur : prevTime;
      const curLocal = p.looping ? this.time % dur : this.time;
      for (const b of p.spawn.bursts) {
        const bt = Math.min(Math.max(b.time, 0), dur);
        let fire = false;
        if (curLocal >= prevLocal) {
          fire = bt > prevLocal - 1e-9 && bt <= curLocal || (prevTime === 0 && bt === 0);
        } else { // wrapped
          fire = bt > prevLocal - 1e-9 || bt <= curLocal;
        }
        if (prevTime === 0 && bt <= 1e-9) fire = true;
        if (fire) budget += b.count;
      }
    }

    if (p.simMode === 'shader') {
      // GPU path: the compute shader spawns and integrates; the renderer
      // consumes _pendingSpawn on the next frame.
      this._pendingSpawn = (this._pendingSpawn | 0) + budget;
      return;
    }

    while (budget-- > 0) this._spawnOne();

    // --- integrate
    const s = this.sim;
    const g = p.gravity;
    const dragK = Math.max(0, 1 - p.drag * dt);
    let i = 0;
    while (i < this.count) {
      const o = i * SIM_FLOATS;
      const age = s[o + 6] + dt;
      if (age >= s[o + 7]) {
        // swap-remove with last alive
        const last = (this.count - 1) * SIM_FLOATS;
        if (o !== last) s.copyWithin(o, last, last + SIM_FLOATS);
        this.count--;
        continue;
      }
      s[o + 6] = age;
      // velocity over time: gravity + drag
      s[o + 3] = (s[o + 3] + g[0] * dt) * dragK;
      s[o + 4] = (s[o + 4] + g[1] * dt) * dragK;
      s[o + 5] = (s[o + 5] + g[2] * dt) * dragK;
      const speedMul = evalCurve(p.speedOverLife, age / s[o + 7]);
      s[o] += s[o + 3] * speedMul * dt;
      s[o + 1] += s[o + 4] * speedMul * dt;
      s[o + 2] += s[o + 5] * speedMul * dt;
      s[o + 10] += s[o + 11] * dt; // rotation
      i++;
    }
  }

  _spawnOne() {
    if (this.count >= this.capacity) return;
    const p = this.p;
    const o = this.count * SIM_FLOATS;
    const s = this.sim;
    const sh = p.shape;

    let pos = [0, 0, 0];
    let dir = [0, 1, 0];
    const type = sh.type;
    if (type === 'point') {
      dir = randomUnitVec();
    } else if (type === 'sphere' || type === 'hemisphere') {
      const u = randomUnitVec();
      const r = sh.radius * Math.cbrt(Math.random());
      if (type === 'hemisphere' && u[1] < 0) u[1] = -u[1];
      pos = [u[0] * r, u[1] * r, u[2] * r];
      dir = u;
    } else if (type === 'cone') {
      const a = Math.random() * Math.PI * 2;
      const rr = sh.radius * Math.sqrt(Math.random());
      pos = [Math.cos(a) * rr, 0, Math.sin(a) * rr];
      const ang = degToRad(sh.angle) * Math.sqrt(Math.random());
      const az = Math.random() * Math.PI * 2;
      const sa = Math.sin(ang);
      dir = [sa * Math.cos(az), Math.cos(ang), sa * Math.sin(az)];
    } else if (type === 'box') {
      const bs = sh.boxSize;
      pos = [(Math.random() - 0.5) * bs[0], (Math.random() - 0.5) * bs[1], (Math.random() - 0.5) * bs[2]];
      dir = [0, 1, 0];
    } else if (type === 'circle') {
      const a = Math.random() * Math.PI * 2;
      pos = [Math.cos(a) * sh.radius, 0, Math.sin(a) * sh.radius];
      dir = [Math.cos(a), 0, Math.sin(a)];
    }
    if (p.spread > 0) {
      const rnd = randomUnitVec();
      dir = [
        lerp(dir[0], rnd[0], p.spread),
        lerp(dir[1], rnd[1], p.spread),
        lerp(dir[2], rnd[2], p.spread),
      ];
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir = [dir[0] / l, dir[1] / l, dir[2] / l];
    }
    const spd = randRange(p.speed[0], p.speed[1]);
    const ct = Math.random();
    s[o] = pos[0] + p.position[0];
    s[o + 1] = pos[1] + p.position[1];
    s[o + 2] = pos[2] + p.position[2];
    s[o + 3] = dir[0] * spd;
    s[o + 4] = dir[1] * spd;
    s[o + 5] = dir[2] * spd;
    s[o + 6] = 0;
    s[o + 7] = Math.max(0.01, randRange(p.lifetime[0], p.lifetime[1]));
    s[o + 8] = Math.random();
    s[o + 9] = randRange(p.sizeStart[0], p.sizeStart[1]);
    s[o + 10] = degToRad(randRange(p.rotationStart[0], p.rotationStart[1]));
    s[o + 11] = degToRad(randRange(p.rotationSpeed[0], p.rotationSpeed[1]));
    s[o + 12] = lerp(p.colorStartA[0], p.colorStartB[0], ct);
    s[o + 13] = lerp(p.colorStartA[1], p.colorStartB[1], ct);
    s[o + 14] = lerp(p.colorStartA[2], p.colorStartB[2], ct);
    s[o + 15] = lerp(p.colorStartA[3], p.colorStartB[3], ct);
    this.count++;
  }

  /**
   * Fills the instance array. If sortCam = {pos, dir} is given, particles are
   * sorted back-to-front (needed for alpha-blended materials).
   */
  fillInstances(sortCam) {
    const s = this.sim;
    const out = this.inst;
    const n = this.count;
    if (sortCam) {
      const [cx, cy, cz] = sortCam.pos;
      const [dx, dy, dz] = sortCam.dir;
      for (let i = 0; i < n; i++) {
        const o = i * SIM_FLOATS;
        this.sortKeys[i] = (s[o] - cx) * dx + (s[o + 1] - cy) * dy + (s[o + 2] - cz) * dz;
        this.sortOrder[i] = i;
      }
      const keys = this.sortKeys;
      const order = this.sortOrder.subarray(0, n);
      order.sort((a, b) => keys[b] - keys[a]); // back-to-front

      for (let j = 0; j < n; j++) this._writeInstance(out, j, order[j] * SIM_FLOATS);
    } else {
      for (let i = 0; i < n; i++) this._writeInstance(out, i, i * SIM_FLOATS);
    }
    return n;
  }

  _writeInstance(out, slot, o) {
    const s = this.sim;
    const w = slot * INSTANCE_FLOATS;
    out[w] = s[o]; out[w + 1] = s[o + 1]; out[w + 2] = s[o + 2];
    out[w + 3] = s[o + 9];
    out[w + 4] = s[o + 12]; out[w + 5] = s[o + 13]; out[w + 6] = s[o + 14]; out[w + 7] = s[o + 15];
    out[w + 8] = s[o + 6] / s[o + 7];
    out[w + 9] = s[o + 8];
    out[w + 10] = s[o + 10];
    out[w + 11] = 0;
    out[w + 12] = s[o + 3]; out[w + 13] = s[o + 4]; out[w + 14] = s[o + 5];
    out[w + 15] = 0;
  }

  // ------------------------------------------------------------- GPU
  /** Ensures all GPU-side state (LUT, instance buffer, draw uniforms, mesh,
   *  bind groups) exists and is current. Called by the renderer each frame. */
  ensureGPU(renderer) {
    const device = renderer.device;
    this._ensureCapacity();

    if (!this.drawUB) {
      this.drawUB = new UniformBlock(device, DRAW_FIELDS, 'emitter-draw');
      this._bgVersion = -1;
    }
    if (!this.lutTex) {
      this.lutTex = createTex(device, LUT_SIZE, LUT_ROWS, 'rgba16float',
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, 'emitter-lut');
      this.lutView = this.lutTex.createView();
      this.lutDirty = true;
      this._bgVersion = -1;
    }
    if (this.lutDirty) {
      uploadLUT(device, this.lutTex, bakeEmitterLUT(this.p));
      this.lutDirty = false;
    }
    // This buffer is only the target of uploadInstances() for CPU-driven
    // emitters; a compute-sim emitter draws from its SimRuntime's own storage
    // buffers instead, so skip (and free) it in shader mode — at large
    // capacities it would otherwise be a same-size dead GPU allocation.
    const needsInstanceBuf = this.p.simMode !== 'shader';
    if (!needsInstanceBuf) {
      if (this.instanceBuf) { this.instanceBuf.destroy(); this.instanceBuf = null; this._gpuCapacity = 0; }
    } else if (!this.instanceBuf || this._gpuCapacity !== this.capacity) {
      this.instanceBuf?.destroy();
      this.instanceBuf = device.createBuffer({
        label: 'emitter-instances',
        size: this.capacity * INSTANCE_FLOATS * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this._gpuCapacity = this.capacity;
    }
    // mesh
    const key = this.p.meshType === 'custom'
      ? `custom:${this.p.customMeshObj.length}:${this.p.customMeshObj.slice(0, 64)}`
      : this.p.meshType;
    if (key !== this.meshKey || !this.mesh) {
      this.meshKey = key;
      this.mesh = renderer.meshLib.get(device, this.p);
    }
    if (this._bgVersion !== renderer.targetsVersion) {
      this.bindGroups = renderer.makeEmitterBindGroups(this);
      this._bgVersion = renderer.targetsVersion;
    }
  }

  uploadInstances(device, n) {
    if (!n) return;
    device.queue.writeBuffer(this.instanceBuf, 0, this.inst, 0, n * INSTANCE_FLOATS);
  }

  dispose() {
    this.lutTex?.destroy();
    this.instanceBuf?.destroy();
    this.drawUB?.dispose();
    this.simRt?.dispose();
    this.lutTex = this.lutView = this.instanceBuf = this.drawUB = this.bindGroups = this.simRt = null;
  }
}

/** Shared mesh library: quad/cube/sphere shared, custom meshes cached per emitter source. */
export class MeshLibrary {
  constructor() { this.shared = {}; }
  get(device, emitterParams) {
    const t = emitterParams.meshType;
    if (t === 'custom') {
      const src = emitterParams.customMeshObj || '';
      if (!this.customCache) this.customCache = new Map();
      if (!this.customCache.has(src)) {
        const parsed = parseOBJ(src);
        this.customCache.set(src, parsed ? uploadMesh(device, parsed) : this.get(device, { meshType: 'cube' }));
      }
      return this.customCache.get(src);
    }
    if (!this.shared[t]) {
      const mesh = t === 'sphere' ? makeSphere() : t === 'cube' ? makeCube() : makeQuad();
      this.shared[t] = uploadMesh(device, mesh);
    }
    return this.shared[t];
  }
}
