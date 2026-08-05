// Material model: user vertex + fragment WGSL wrapped per pipeline variant.

import { compileModule, PARTICLE_VERTEX_BUFFERS } from './gpu.js';
import {
  buildParticleVS, buildParticleFS, DEFAULT_VS, DEFAULT_FS,
  GBUF_FORMATS, SCENE_FORMAT, DEPTH_FORMAT,
} from './shaderlib.js';

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

function blendState(m) {
  if (m.blendMode === 'add') {
    const f = { srcFactor: 'one', dstFactor: 'one' };
    return { color: f, alpha: f };
  }
  if (m.blendMode === 'blend') {
    const f = { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' };
    return { color: f, alpha: f };
  }
  return undefined; // opaque / cutout
}

/**
 * GPU-side compiled state for a material. Keeps last-good pipelines on error
 * (shadertoy-style: broken edits don't kill the running effect).
 *
 * compile() is async (WGSL compile info and pipeline creation both are); the
 * returned promise resolves to the error list. A newer compile supersedes an
 * older in-flight one.
 */
export class MaterialRuntime {
  constructor(renderer, material) {
    this.renderer = renderer;
    this.material = material;
    this.pipelines = { gbuffer: null, forward: null };
    this.errors = [];   // [{stage: 'vertex'|'fragment', variant, line, msg}]
    this.dirty = true;
    this._seq = 0;
  }

  _pipelineDesc(variant, vsModule, fsModule) {
    const m = this.material;
    const opaque = isOpaqueMode(m);
    return {
      label: `${m.name}:${variant}`,
      layout: this.renderer.particleLayout[variant],
      vertex: { module: vsModule, entryPoint: 'vsMain', buffers: PARTICLE_VERTEX_BUFFERS },
      fragment: {
        module: fsModule, entryPoint: 'fsMain',
        targets: variant === 'gbuffer'
          ? GBUF_FORMATS.map((format) => ({ format }))
          : [{ format: SCENE_FORMAT, blend: blendState(m) }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: m.doubleSided ? 'none' : 'back',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: 'less-equal',
        // gbuffer + forward-opaque write depth; the blended pass does not.
        depthWriteEnabled: variant === 'gbuffer' ? true : opaque,
      },
    };
  }

  /** Recompile the variants required by the current pipeline. */
  async compile(neededVariants) {
    const seq = ++this._seq;
    const device = this.renderer.device;
    const m = this.material;
    this.dirty = false;
    const errors = [];
    const opts = { blendMode: m.blendMode, lit: m.lit, soft: m.softParticles };

    const vs = buildParticleVS(m.vertexSrc);
    const vsRes = await compileModule(device, vs.src, `${m.name}:vs`);
    for (const e of vsRes.errors) {
      errors.push({ stage: 'vertex', variant: '', line: Math.max(1, e.line - vs.lineOffset), msg: e.msg });
    }

    // Blended materials are never drawn through the G-buffer pass.
    const variants = neededVariants.filter((v) => v !== 'gbuffer' || isOpaqueMode(m));
    for (const variant of variants) {
      const fs = buildParticleFS(m.fragmentSrc, variant, opts);
      const fsRes = await compileModule(device, fs.src, `${m.name}:${variant}`);
      for (const e of fsRes.errors) {
        errors.push({ stage: 'fragment', variant, line: Math.max(1, e.line - fs.lineOffset), msg: e.msg });
      }
      if (vsRes.errors.length || fsRes.errors.length) continue;
      try {
        const pipeline = await device.createRenderPipelineAsync(this._pipelineDesc(variant, vsRes.module, fsRes.module));
        if (seq === this._seq) this.pipelines[variant] = pipeline;
        // keep previous pipeline for this variant on failure
      } catch (ex) {
        errors.push({ stage: 'fragment', variant, line: 0, msg: ex?.message || 'pipeline creation failed' });
      }
    }
    if (!isOpaqueMode(m)) this.pipelines.gbuffer = null;

    if (seq === this._seq) this.errors = errors;
    return errors;
  }

  dispose() {
    this.pipelines = { gbuffer: null, forward: null };
    this._seq++;
  }
}
