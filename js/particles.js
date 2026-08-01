// Particle emitter: parameters, CPU simulation, and GPU instance data.
//
// An Effect is composed of multiple Emitters (composability); each emitter
// references a Material by id and owns its over-lifetime curves.

import { makeCurve, makeGradient, evalCurve, bakeEmitterLUT, uploadLUT } from './curves.js';
import { makeQuad, makeCube, makeSphere, parseOBJ, uploadMesh } from './geometry.js';
import { randRange, lerp, degToRad } from './math3d.js';

export const INSTANCE_FLOATS = 16; // pos(3) size(1) color(4) life seed rot pad vel(3) pad
const SIM_FLOATS = 16;             // px py pz vx vy vz age life seed size0 rot rotVel r g b a

let nextEmitterId = 1;

export function defaultEmitterParams() {
  return {
    id: `em${nextEmitterId++}`,
    name: 'Emitter',
    enabled: true,
    materialId: null,
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
    this.sim = null;       // Float32Array
    this.inst = null;      // Float32Array
    this.sortKeys = null;  // Float32Array for transparent sorting
    this.sortOrder = null; // Uint32Array
    // GPU state
    this.lutTex = null;
    this.lutDirty = true;
    this.instanceBuf = null;
    this.vao = null;
    this.mesh = null;      // uploaded mesh currently bound in vao
    this.meshKey = '';
    this.customMeshCache = null; // {src, mesh}
    this._ensureCapacity();
  }

  _ensureCapacity() {
    const cap = Math.max(1, Math.min(100000, this.p.spawn.max | 0));
    if (cap === this.capacity && this.sim) return false;
    this.capacity = cap;
    this.sim = new Float32Array(cap * SIM_FLOATS);
    this.inst = new Float32Array(cap * INSTANCE_FLOATS);
    this.sortKeys = new Float32Array(cap);
    this.sortOrder = new Uint32Array(cap);
    this.count = Math.min(this.count, cap);
    return true; // GPU buffer needs realloc
  }

  restart() {
    this.time = 0;
    this.spawnAccum = 0;
    this.count = 0;
  }

  /** Advance simulation by dt seconds (already time-scaled). */
  step(dt) {
    const p = this.p;
    if (!p.enabled) { this.count = 0; return; }
    const capChanged = this._ensureCapacity();
    if (capChanged) this._gpuBufferDirty = true;

    const prevTime = this.time;
    this.time += dt;

    // --- spawning
    const dur = Math.max(0.01, p.duration);
    const active = p.looping || this.time <= dur;
    if (active && dt > 0) {
      // continuous rate
      this.spawnAccum += p.spawn.rate * dt;
      let n = Math.floor(this.spawnAccum);
      this.spawnAccum -= n;
      while (n-- > 0) this._spawnOne();
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
        if (fire) for (let i = 0; i < b.count; i++) this._spawnOne();
      }
    }

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
  ensureGL(gl, meshLib) {
    if (!this.lutTex) { this.lutTex = gl.createTexture(); this.lutDirty = true; }
    if (this.lutDirty) {
      uploadLUT(gl, this.lutTex, bakeEmitterLUT(this.p));
      this.lutDirty = false;
    }
    if (!this.instanceBuf) {
      this.instanceBuf = gl.createBuffer();
      this._gpuBufferDirty = true;
    }
    if (this._gpuBufferDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this._gpuBufferDirty = false;
      this._vaoDirty = true;
    }
    // mesh
    const key = this.p.meshType === 'custom'
      ? `custom:${this.p.customMeshObj.length}:${this.p.customMeshObj.slice(0, 64)}`
      : this.p.meshType;
    if (key !== this.meshKey || !this.vao || this._vaoDirty) {
      this.meshKey = key;
      this.mesh = meshLib.get(gl, this.p);
      this._buildVAO(gl);
      this._vaoDirty = false;
    }
  }

  _buildVAO(gl) {
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const m = this.mesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboNrm);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboUV);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(3 + i);
      gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(3 + i, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  uploadInstances(gl, n) {
    if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, n * INSTANCE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  dispose(gl) {
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.instanceBuf) gl.deleteBuffer(this.instanceBuf);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.customMeshCache?.mesh) this.customMeshCache.mesh.dispose();
    this.lutTex = this.instanceBuf = this.vao = null;
  }
}

/** Shared mesh library: quad/cube/sphere shared, custom meshes cached per emitter source. */
export class MeshLibrary {
  constructor() { this.shared = {}; }
  get(gl, emitterParams) {
    const t = emitterParams.meshType;
    if (t === 'custom') {
      const src = emitterParams.customMeshObj || '';
      if (!this.customCache) this.customCache = new Map();
      if (!this.customCache.has(src)) {
        const parsed = parseOBJ(src);
        this.customCache.set(src, parsed ? uploadMesh(gl, parsed) : this.get(gl, { meshType: 'cube' }));
      }
      return this.customCache.get(src);
    }
    if (!this.shared[t]) {
      const mesh = t === 'sphere' ? makeSphere() : t === 'cube' ? makeCube() : makeQuad();
      this.shared[t] = uploadMesh(gl, mesh);
    }
    return this.shared[t];
  }
}
