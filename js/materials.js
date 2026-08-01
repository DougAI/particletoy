// Material model: user vertex + fragment GLSL wrapped per pipeline variant.

import { Program, parseShaderErrors } from './glutil.js';
import { buildParticleVS, buildParticleFS, DEFAULT_VS, DEFAULT_FS } from './shaderlib.js';

let nextId = 1;

export function makeMaterial(opts = {}) {
  return {
    id: opts.id ?? `mat${nextId++}`,
    name: opts.name ?? 'New Material',
    blendMode: opts.blendMode ?? 'blend', // opaque | cutout | blend | add
    lit: opts.lit ?? true,
    doubleSided: opts.doubleSided ?? true,
    softParticles: opts.softParticles ?? false,
    softDistance: opts.softDistance ?? 0.5,
    alphaCutoff: opts.alphaCutoff ?? 0.5,
    vertexSrc: opts.vertexSrc ?? DEFAULT_VS,
    fragmentSrc: opts.fragmentSrc ?? DEFAULT_FS,
  };
}

export function serializeMaterial(m) {
  const { id, name, blendMode, lit, doubleSided, softParticles, softDistance, alphaCutoff, vertexSrc, fragmentSrc } = m;
  return { id, name, blendMode, lit, doubleSided, softParticles, softDistance, alphaCutoff, vertexSrc, fragmentSrc };
}

export function isOpaqueMode(m) {
  return m.blendMode === 'opaque' || m.blendMode === 'cutout';
}

/**
 * GPU-side compiled state for a material. Keeps last-good programs on error
 * (shadertoy-style: broken edits don't kill the running effect).
 */
export class MaterialRuntime {
  constructor(gl, material) {
    this.gl = gl;
    this.material = material;
    this.programs = { gbuffer: null, forward: null }; // Program instances
    this.errors = [];   // [{stage: 'vertex'|'fragment', variant, line, msg}]
    this.dirty = true;
  }

  /** Recompile the variants required by the current pipeline. */
  compile(neededVariants) {
    const gl = this.gl;
    const m = this.material;
    this.errors = [];
    const opts = { blendMode: m.blendMode, lit: m.lit, soft: m.softParticles };

    for (const variant of neededVariants) {
      const vs = buildParticleVS(m.vertexSrc);
      const fs = buildParticleFS(m.fragmentSrc, variant, opts);
      const prog = new Program(gl, vs.src, fs.src, `${m.name}:${variant}`);
      if (prog.error) {
        const offset = prog.error.stage === 'vertex' ? vs.lineOffset : fs.lineOffset;
        const stage = prog.error.stage === 'link' ? 'fragment' : prog.error.stage;
        for (const e of parseShaderErrors(prog.error.log, offset)) {
          this.errors.push({ stage, variant, line: e.line, msg: e.msg });
        }
        if (!this.errors.length) {
          this.errors.push({ stage, variant, line: 0, msg: prog.error.log || 'unknown shader error' });
        }
        prog.dispose();
        // keep previous program for this variant if it exists
      } else {
        if (this.programs[variant]) this.programs[variant].dispose();
        this.programs[variant] = prog;
      }
    }
    this.dirty = false;
    return this.errors;
  }

  dispose() {
    for (const k of Object.keys(this.programs)) {
      if (this.programs[k]) this.programs[k].dispose();
      this.programs[k] = null;
    }
  }
}
