// Embeddable effect player — a lightweight, editor-free wrapper around the
// renderer. Used by the front page (particle of the day), card hover
// previews, and the view page.
//
// WebGPU device creation is async, but the public API stays synchronous:
// `ok` is a fast navigator.gpu presence check, and load()/start() calls made
// before the device is ready are queued and replayed once it is.

import { createGPU } from './gpu.js';
import { Renderer, defaultScene } from './renderer.js';
import { OrbitCamera } from './camera.js';
import { Emitter, defaultEmitterParams } from './particles.js';
import { makeMaterial, MaterialRuntime } from './materials.js';
import { isPreSlang } from './share.js';
import { cacheGaps } from './wgslcache.js';

function mergeEmitterParams(p) {
  const d = defaultEmitterParams();
  const merged = { ...d, ...p };
  merged.spawn = { ...d.spawn, ...(p.spawn || {}) };
  merged.shape = { ...d.shape, ...(p.shape || {}) };
  return merged;
}

export class EffectPlayer {
  /** @param canvas target canvas
   *  @param opts   { interactive: orbit camera on drag (default true),
   *                  pipeline: 'deferred' | 'forward',
   *                  maxDpr: devicePixelRatio cap (default 1.5),
   *                  allowCompile: fall back to the Slang compiler when the
   *                    effect carries no usable WGSL (default false — the
   *                    gallery pages must never fetch the 24 MB compiler; the
   *                    editor's media export, which already has it, opts in) } */
  constructor(canvas, { interactive = true, pipeline = 'deferred', maxDpr = 1.5, allowCompile = false } = {}) {
    this.canvas = canvas;
    this.pipeline = pipeline;
    this.maxDpr = maxDpr;
    this.allowCompile = allowCompile;
    this.playing = false;
    this.time = 0;
    this.raf = 0;
    this.emitters = [];
    this.runtimes = new Map();
    this.scene = defaultScene();
    this.device = null;
    this._pendingData = null;
    this.unrenderable = null;   // why the loaded effect can't be drawn, if it can't
    this._wantPlay = false;
    this._loading = Promise.resolve();

    this.error = navigator.gpu ? null : 'WebGPU is not supported by this browser.';
    this.ready = this.error ? Promise.resolve(false) : this._setup(interactive);
  }

  get ok() { return !this.error; }

  async _setup(interactive) {
    const { device, context, format, error } = await createGPU(this.canvas);
    if (!device) {
      this.error = error;
      return false;
    }
    this.device = device;
    this.renderer = new Renderer({ device, context, format, canvas: this.canvas });
    this.camera = new OrbitCamera(this.canvas);
    if (!interactive) this.canvas.style.pointerEvents = 'none';
    if (this._pendingData) this._load(this._pendingData);
    if (this._wantPlay) this._startLoop();
    return true;
  }

  load(data) {
    this._pendingData = data;
    // Answered here rather than in _load, which waits on the device: callers
    // put this on screen the moment they hand the effect over.
    //
    // A partly-filled cache is as fatal as no cache at all — one missing
    // module and every emitter using it draws nothing — so ask what the
    // effect is actually missing, not whether it brought anything.
    this.unrenderable = isPreSlang(data) ? 'made with an older shader language'
      : !this.allowCompile && cacheGaps(data).length ? 'saved without its compiled shaders'
      : null;
    if (this.device) this._load(data);
  }

  _load(data) {
    this._clear();

    // The player is embedded in the gallery pages, which must never pull down
    // the 24 MB Slang compiler just to animate a hover preview. There it
    // renders only from the WGSL saved with the effect; anything else (a
    // pre-Slang effect, or one published without a cache) reports rather than
    // compiles. Callers that already hold the compiler — the editor's media
    // export — pass allowCompile and get the source path as a fallback.
    this.renderer.wgslCache = data.wgslCache ?? null;
    this.renderer.allowCompile = this.allowCompile;

    const materials = (data.materials || []).map((m) => ({ ...makeMaterial({}), ...m }));
    if (!materials.length) materials.push(makeMaterial({ name: 'Default' }));
    const compiles = [];
    for (const m of materials) {
      const rt = new MaterialRuntime(this.renderer, m);
      rt.material = m;
      compiles.push(rt.compile(['gbuffer', 'forward'])); // errors tolerated: bad stages keep defaults
      this.runtimes.set(m.id, rt);
    }
    this._loading = Promise.all(compiles);
    this.emitters = (data.emitters || [])
      .map((p) => new Emitter(mergeEmitterParams(structuredClone(p))));
    this.scene = { ...defaultScene(), ...(data.scene ? structuredClone(data.scene) : {}) };
    this.time = 0;
    for (const em of this.emitters) em.restart();
  }

  start() {
    this._wantPlay = true;
    if (this.device) this._startLoop();
  }

  _startLoop() {
    if (this.playing) return;
    this.playing = true;
    this._last = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      this.frame(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this._wantPlay = false;
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  frame(now) {
    if (!this.device) return;
    const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;

    const dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.renderer.resize(w, h);

    this.time += dt;
    for (const em of this.emitters) em.step(dt);

    this.renderer.render({
      camera: this.camera.matrices(w / h),
      scene: this.scene,
      effect: { emitters: this.emitters },
      materials: this.runtimes,
      pipeline: this.pipeline,
      debugMode: 0,
      time: this.time,
      mouse: [0, 0, 0, 0],
    });
  }

  /** Renders a frame right now and returns a JPEG blob. Waits for the device
   *  and material pipelines so the first capture isn't black.
   *
   *  1200x630 is Open Graph's canonical card size and clears LinkedIn's
   *  documented 1200x627 minimum, below which it declines to build a card at
   *  all. Particles on black compress so well that the larger frame costs
   *  ~33 KB against ~14 KB for 640x360 — cheap enough that the gallery grid,
   *  which lazy-loads these, can share the one image. */
  async captureJPEG(w = 1200, h = 630, quality = 0.85) {
    if (!(await this.ready)) return null;
    await this._loading;
    this._last = performance.now() - 16;
    this.frame(performance.now());
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    drawCover(ctx, this.canvas, w, h);
    return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/jpeg', quality));
  }

  _clear() {
    for (const em of this.emitters) em.dispose();
    this.emitters = [];
    for (const rt of this.runtimes.values()) rt.dispose();
    this.runtimes.clear();
  }

  dispose() {
    this.stop();
    if (!this.device) return;
    this._clear();
    this.renderer.dispose?.();
    this.device.destroy();
    this.device = null;
  }
}

/** Draw src into ctx covering w×h (center-crop, like CSS object-fit: cover). */
export function drawCover(ctx, src, w, h) {
  const sw = src.width;
  const sh = src.height;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Capture a JPEG thumbnail from a live (already-rendering) canvas whose frame
 *  function can be invoked synchronously — used by the editor's publish flow.
 *  See captureJPEG above for why 1200x630. */
export function captureCanvasJPEG(canvas, renderFrameNow, w = 1200, h = 630, quality = 0.85) {
  return new Promise((resolve) => {
    renderFrameNow();
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    drawCover(out.getContext('2d'), canvas, w, h);
    out.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
}
