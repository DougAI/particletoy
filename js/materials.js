// Material model: user vertex + fragment Slang wrapped per pipeline variant,
// compiled to WGSL by js/slangc.js on the way to the device.

import { compileModule, particleVertexBuffers } from './gpu.js';
import { loadSlang, compileSlang, STAGE } from './slangc.js';
import { materialFromCache } from './wgslcache.js';
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
    this.compiledWGSL = null; // { vs, gbuffer?, forward?, vertexLocations } once compiled
    this.dirty = true;
    this._seq = 0;
  }

  _pipelineDesc(variant, vsModule, fsModule, vertexLocations) {
    const m = this.material;
    const opaque = isOpaqueMode(m);
    return {
      label: `${m.name}:${variant}`,
      layout: this.renderer.particleLayout[variant],
      vertex: { module: vsModule, entryPoint: 'vsMain', buffers: particleVertexBuffers(vertexLocations) },
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

  /**
   * Builds pipelines straight from WGSL, skipping Slang entirely. Returns an
   * error list on success, or null if the WGSL turned out unusable — which the
   * cached path treats as a miss rather than an error, since the source is
   * still there to recompile from.
   */
  async _buildPipelines(seq, variants, vsCode, fsCodeFor, vertexLocations) {
    const device = this.renderer.device;
    const m = this.material;
    const vsRes = await compileModule(device, vsCode, `${m.name}:vs`);
    if (vsRes.errors.length) return null;
    for (const variant of variants) {
      const fsRes = await compileModule(device, fsCodeFor(variant), `${m.name}:${variant}`);
      if (fsRes.errors.length) return null;
      try {
        const pipeline = await device.createRenderPipelineAsync(
          this._pipelineDesc(variant, vsRes.module, fsRes.module, vertexLocations));
        if (seq === this._seq) this.pipelines[variant] = pipeline;
      } catch {
        return null;
      }
    }
    if (!isOpaqueMode(m)) this.pipelines.gbuffer = null;
    if (seq === this._seq) this.errors = [];
    return this.errors;
  }

  /** Recompile the variants required by the current pipeline. */
  async compile(neededVariants) {
    const seq = ++this._seq;
    const device = this.renderer.device;
    const m = this.material;
    this.dirty = false;
    const errors = [];
    const opts = { blendMode: m.blendMode, lit: m.lit, soft: m.softParticles };

    // Blended materials are never drawn through the G-buffer pass.
    const variants = neededVariants.filter((v) => v !== 'gbuffer' || isOpaqueMode(m));

    // Cached path: the effect was saved with WGSL matching this exact source,
    // so the compiler is not needed at all. This is how the gallery renders.
    const hit = materialFromCache(this.renderer.wgslCache, m, variants);
    if (hit) {
      const built = await this._buildPipelines(seq, variants, hit.vs.code,
        (v) => hit[v].code, hit.locations);
      if (built) return built;
      // Cache present but unusable (engine changed under it) — fall through and
      // recompile if we're allowed to.
    }

    if (!this.renderer.allowCompile) {
      const msg = 'this effect was saved without compiled shaders for these settings, so it cannot be rendered here — open it in the editor';
      if (seq === this._seq) this.errors = [{ stage: 'fragment', variant: '', line: 0, msg }];
      return this.errors;
    }

    try {
      await loadSlang();
    } catch (ex) {
      const msg = `could not load the Slang compiler: ${ex?.message || ex}`;
      if (seq === this._seq) this.errors = [{ stage: 'vertex', variant: '', line: 0, msg }];
      return this.errors;
    }

    // Slang first (source -> WGSL), then the device (WGSL -> module). Slang
    // catches everything the user can get wrong; a WGSL-stage error here would
    // mean the engine emitted bad code, so both are reported the same way.
    const vs = buildParticleVS(m.vertexSrc);
    const vsSlang = compileSlang(vs.src, [{ name: 'vsMain', stage: STAGE.vertex }]);
    for (const e of vsSlang.errors) {
      errors.push({ stage: 'vertex', variant: '', line: Math.max(1, e.line - vs.lineOffset), msg: e.msg });
    }
    const vsRes = vsSlang.wgsl ? await compileModule(device, vsSlang.wgsl, `${m.name}:vs`) : null;
    for (const e of vsRes?.errors ?? []) {
      errors.push({ stage: 'vertex', variant: '', line: 0, msg: e.msg });
    }
    const vsOk = vsRes && !vsRes.errors.length;

    // The generated WGSL is kept so it can be saved alongside the effect — the
    // gallery pages render from that cache rather than loading the compiler.
    const wgsl = vsOk ? { vs: vsSlang.wgsl } : null;

    for (const variant of variants) {
      const fs = buildParticleFS(m.fragmentSrc, variant, opts);
      const fsSlang = compileSlang(fs.src, [{ name: 'fsMain', stage: STAGE.fragment }]);
      for (const e of fsSlang.errors) {
        errors.push({ stage: 'fragment', variant, line: Math.max(1, e.line - fs.lineOffset), msg: e.msg });
      }
      const fsRes = fsSlang.wgsl ? await compileModule(device, fsSlang.wgsl, `${m.name}:${variant}`) : null;
      for (const e of fsRes?.errors ?? []) {
        errors.push({ stage: 'fragment', variant, line: 0, msg: e.msg });
      }
      if (!vsOk || !fsRes || fsRes.errors.length) continue;
      try {
        const pipeline = await device.createRenderPipelineAsync(
          this._pipelineDesc(variant, vsRes.module, fsRes.module, vsSlang.vertexLocations));
        if (seq === this._seq) this.pipelines[variant] = pipeline;
        // keep previous pipeline for this variant on failure
        if (wgsl) wgsl[variant] = fsSlang.wgsl;
      } catch (ex) {
        errors.push({ stage: 'fragment', variant, line: 0, msg: ex?.message || 'pipeline creation failed' });
      }
    }
    if (!isOpaqueMode(m)) this.pipelines.gbuffer = null;

    if (seq === this._seq) {
      this.errors = errors;
      if (wgsl) this.compiledWGSL = { ...this.compiledWGSL, ...wgsl, vertexLocations: vsSlang.vertexLocations };
    }
    return errors;
  }

  dispose() {
    this.pipelines = { gbuffer: null, forward: null };
    this._seq++;
  }
}
