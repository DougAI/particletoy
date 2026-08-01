// Embeddable effect player — a lightweight, editor-free wrapper around the
// renderer. Used by the front page (particle of the day), card hover
// previews, and the view page.

import { createGL } from './glutil.js';
import { Renderer, defaultScene } from './renderer.js';
import { OrbitCamera } from './camera.js';
import { Emitter, defaultEmitterParams } from './particles.js';
import { makeMaterial, MaterialRuntime } from './materials.js';

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
   *                  maxDpr: devicePixelRatio cap (default 1.5) } */
  constructor(canvas, { interactive = true, pipeline = 'deferred', maxDpr = 1.5 } = {}) {
    this.canvas = canvas;
    this.pipeline = pipeline;
    this.maxDpr = maxDpr;
    this.playing = false;
    this.time = 0;
    this.raf = 0;
    this.emitters = [];
    this.runtimes = new Map();
    this.scene = defaultScene();
    this.error = null;

    const { gl, error } = createGL(canvas);
    if (!gl) { this.error = error; return; }
    this.gl = gl;
    this.renderer = new Renderer(gl, canvas);
    this.camera = new OrbitCamera(canvas);
    if (!interactive) canvas.style.pointerEvents = 'none';
  }

  get ok() { return Boolean(this.gl); }

  load(data) {
    if (!this.gl) return;
    this._clear();
    const materials = (data.materials || []).map((m) => ({ ...makeMaterial({}), ...m }));
    if (!materials.length) materials.push(makeMaterial({ name: 'Default' }));
    for (const m of materials) {
      const rt = new MaterialRuntime(this.gl, m);
      rt.material = m;
      rt.compile(['gbuffer', 'forward']);   // errors tolerated: bad stages keep defaults
      this.runtimes.set(m.id, rt);
    }
    this.emitters = (data.emitters || [])
      .map((p) => new Emitter(mergeEmitterParams(structuredClone(p))));
    this.scene = { ...defaultScene(), ...(data.scene ? structuredClone(data.scene) : {}) };
    this.time = 0;
    for (const em of this.emitters) em.restart();
  }

  start() {
    if (!this.gl || this.playing) return;
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
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  frame(now) {
    const gl = this.gl;
    if (!gl) return;
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

  /** Renders a frame right now and returns a JPEG blob (same-task capture —
   *  the default GL context does not preserve its drawing buffer). */
  captureJPEG(w = 640, h = 360, quality = 0.85) {
    return new Promise((resolve) => {
      if (!this.gl) return resolve(null);
      this._last = performance.now() - 16;
      this.frame(performance.now());
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      drawCover(ctx, this.canvas, w, h);
      out.toBlob((b) => resolve(b), 'image/jpeg', quality);
    });
  }

  _clear() {
    for (const em of this.emitters) em.dispose(this.gl);
    this.emitters = [];
    for (const rt of this.runtimes.values()) rt.dispose();
    this.runtimes.clear();
  }

  dispose() {
    this.stop();
    if (!this.gl) return;
    this._clear();
    this.renderer.dispose?.();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
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
 *  function can be invoked synchronously — used by the editor's publish flow. */
export function captureCanvasJPEG(canvas, renderFrameNow, w = 640, h = 360, quality = 0.85) {
  return new Promise((resolve) => {
    renderFrameNow();
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    drawCover(out.getContext('2d'), canvas, w, h);
    out.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
}
