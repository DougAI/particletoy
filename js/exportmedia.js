// Video/GIF export for sharing an effect on social media.
//
// Renders on a detached offscreen canvas with its own EffectPlayer (own GL
// context, own emitters cloned from the current effect data) so the export
// runs independently of — and doesn't disturb — the live editor viewport.
// Frames are stepped with a fixed timestep rather than requestAnimationFrame
// so exported clips are deterministic regardless of how fast the machine
// can render.

import { EffectPlayer } from './player.js';
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.js';

export const MAX_EXPORT_SECONDS = 15;

// Download quality first: VP9 is smaller and cleaner than H.264 at the same
// bitrate, and every browser that can record at all plays back WebM.
const DOWNLOAD_CODECS = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/mp4;codecs=h264',
  'video/webm',
  'video/mp4',
];

// Link previews invert that preference. Discord and Twitter will play a bare
// MP4 they can fetch, and are unreliable-to-hostile towards WebM, so the
// preview capture asks for H.264 first and only falls back to WebM (still
// better than a still frame) when the browser can't produce MP4.
const PREVIEW_CODECS = [
  'video/mp4;codecs=h264',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

export function getVideoMimeType(candidates = DOWNLOAD_CODECS) {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

// isTypeSupported() is a claim, not a promise. Chromium builds without an
// H.264 encoder answer isTypeSupported('video/mp4') with true and then record
// zero bytes — so every recording gets weighed before it is believed. Any real
// clip is orders of magnitude over this; only an empty or header-only file
// falls under it.
const MIN_CLIP_BYTES = 512;
// Ceiling on the wait for the compute sims to compile. Building their
// pipelines from WGSL is well under a second on real hardware, so reaching
// this means something is wrong — export whatever does render rather than
// leaving the dialog to look hung.
const WARMUP_TIMEOUT_MS = 15_000;

// Async because EffectPlayer creates its device, renderer and camera in an
// async setup step — touching player.camera/renderer before `ready` resolves
// throws. Also waits on the material compiles so the first frames aren't blank.
async function makeExportPlayer({ data, camera, pipeline, w, h, signal, allowCompile }) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // allowCompile is the caller's to decide, because it decides who might pay
  // for the 24 MB Slang compiler. In the editor it is already resident, so a
  // cache miss (a shader edited a moment ago is still compiling, so the cache
  // holds the previous source's WGSL) should recompile — without it, the miss
  // silently exports an effect with no particles. On a gallery page nothing
  // may fetch the compiler, so a miss has to stay a miss; published effects
  // carry their WGSL, so there is nothing to miss in the normal case.
  const player = new EffectPlayer(canvas, { interactive: false, pipeline, allowCompile });
  let ok = false;
  try {
    ok = await player.ready;
  } catch (ex) {
    player.dispose();
    throw new Error(ex.message || 'WebGPU is not available for export');
  }
  if (!ok) {
    player.dispose();
    throw new Error(player.error || 'WebGPU is not available for export');
  }
  try {
    player.load(data);
    await player._loading;
    player.camera.target = [...camera.target];
    player.camera.yaw = camera.yaw;
    player.camera.pitch = camera.pitch;
    player.camera.dist = camera.dist;
    player.renderer.resize(w, h);
    await warmUp(player, w, h, signal);
  } catch (ex) {
    player.dispose();
    throw ex;
  }
  return { canvas, player };
}

/**
 * Gets the compute sims compiled before recording starts, then rewinds to
 * t = 0.
 *
 * A shader-mode emitter's SimRuntime is built by its first render, which also
 * starts the compile; until the pipelines land the emitter draws nothing. So:
 * render one throwaway frame to create the runtimes, wait for them, then put
 * the clock back to zero so the clip opens where the effect does rather than
 * a few empty frames in.
 *
 * The throwaway frame is stepped with dt = 0, which advances no simulated time
 * and spawns nothing the rewind would have to undo. Waiting is a plain sleep
 * loop rather than a render loop on purpose — rendering while a pipeline
 * compiles just makes the GPU do both at once, and the sims need nothing more
 * from us until they are ready.
 */
async function warmUp(player, w, h, signal) {
  stepAndRender(player, 0, w, h);
  // Collected after that first render: emitters with no material never get a
  // runtime at all, and waiting on one would burn the whole timeout.
  const sims = player.emitters.map((em) => em.simRt).filter(Boolean);
  const deadline = performance.now() + WARMUP_TIMEOUT_MS;
  while (sims.some((rt) => !rt.pipeUpdate && !rt.errors.length)) {
    if (signal?.cancelled || performance.now() > deadline) break;
    await wait(16);
  }
  player.time = 0;
  for (const em of player.emitters) em.restart();
}

function stepAndRender(player, dt, w, h) {
  for (const em of player.emitters) em.step(dt);
  player.time += dt;
  player.renderer.render({
    camera: player.camera.matrices(w / h),
    scene: player.scene,
    effect: { emitters: player.emitters },
    materials: player.runtimes,
    pipeline: player.pipeline,
    debugMode: 0,
    time: player.time,
    mouse: [0, 0, 0, 0],
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run the simulation forward before the first recorded frame. Distinct from
// warmUp() above, which waits for compiles and then rewinds to t = 0: this
// deliberately advances simulated time. An effect at t = 0 has no particles in
// it yet, so a clip that starts there opens on an empty frame — fine for a
// download the viewer scrubs, useless for a preview card where those first
// frames are the whole impression. Runs after warmUp(), so the rewind doesn't
// undo it.
function preroll(player, seconds, dt, w, h) {
  for (let i = Math.round(seconds / dt); i > 0; i--) stepAndRender(player, dt, w, h);
}

/** @param opts { data, camera, w, h, fps, seconds, pipeline, mimeType, bitrate,
 *                preroll, onProgress, signal } */
export async function exportVideo(opts) {
  const { data, camera, w, h, fps, pipeline, onProgress, signal } = opts;
  const mimeType = opts.mimeType || getVideoMimeType();
  if (!mimeType) throw new Error('Video recording is not supported in this browser.');
  const seconds = Math.min(MAX_EXPORT_SECONDS, Math.max(0.5, opts.seconds));
  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const dt = 1 / fps;

  const { canvas, player } = await makeExportPlayer({
    data, camera, pipeline, w, h, signal, allowCompile: opts.allowCompile ?? true,
  });
  try {
    preroll(player, opts.preroll || 0, dt, w, h);
    if (typeof canvas.captureStream !== 'function') {
      throw new Error('This browser cannot record a canvas — try GIF instead.');
    }
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Could not capture the export canvas — try GIF instead.');
    const manual = typeof track.requestFrame === 'function';
    const chunks = [];
    const rec = new MediaRecorder(stream, {
      mimeType, videoBitsPerSecond: opts.bitrate || 8_000_000,
    });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    rec.start();

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.cancelled) break;
      stepAndRender(player, dt, w, h);
      if (manual) track.requestFrame();
      onProgress?.(i / totalFrames);
      await wait(1000 / fps);
    }
    rec.stop();
    await stopped;
    if (signal?.cancelled) return null;
    onProgress?.(1);
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size < MIN_CLIP_BYTES) {
      throw new Error(`This browser claims to record ${mimeType} but produced an empty file.`);
    }
    return { blob, ext };
  } finally {
    player.dispose();
  }
}

/** @param opts { data, camera, w, h, fps, seconds, pipeline, preroll, onProgress, signal } */
export async function exportGif(opts) {
  const { data, camera, w, h, fps, pipeline, onProgress, signal } = opts;
  const seconds = Math.min(MAX_EXPORT_SECONDS, Math.max(0.5, opts.seconds));
  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const dt = 1 / fps;
  const delay = Math.round(1000 / fps);

  const { canvas, player } = await makeExportPlayer({
    data, camera, pipeline, w, h, signal, allowCompile: opts.allowCompile ?? true,
  });
  const read = document.createElement('canvas');
  read.width = w;
  read.height = h;
  const ctx = read.getContext('2d', { willReadFrequently: true });

  try {
    preroll(player, opts.preroll || 0, dt, w, h);
    const gif = GIFEncoder();
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.cancelled) return null;
      stepAndRender(player, dt, w, h);
      ctx.drawImage(canvas, 0, 0, w, h);
      const { data: pixels } = ctx.getImageData(0, 0, w, h);
      const palette = quantize(pixels, 256);
      const index = applyPalette(pixels, palette);
      gif.writeFrame(index, w, h, { palette, delay });
      onProgress?.(i / totalFrames);
      await new Promise(requestAnimationFrame);
    }
    gif.finish();
    onProgress?.(1);
    return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), ext: 'gif' };
  } finally {
    player.dispose();
  }
}

// ─── link-preview clip ──────────────────────────────────────────────────────
// The moving thumbnail that Discord/Slack/Twitter embed. Deliberately small:
// a crawler fetches it before it will show anything, and a 3-second 960×540
// H.264 clip lands around a megabyte.

const PREVIEW_VIDEO = { w: 960, h: 540, fps: 30, seconds: 3.5, preroll: 1.5, bitrate: 2_500_000 };
// The last resort, when no video codec works out. GIF is far heavier per
// second of motion, so it gets a smaller frame and a slower shutter.
const PREVIEW_GIF = { w: 400, h: 225, fps: 10, seconds: 3, preroll: 1.5 };

// Storage matches the bucket's mime whitelist against the Content-Type header
// verbatim, and "video/mp4;codecs=h264" is not "video/mp4" to it. .slice()
// re-tags the bytes without copying them. The type is also written to a column
// with a CHECK constraint, so an unexpected one is pinned back to the
// container we actually asked the recorder for rather than sent on to fail.
const CLIP_TYPES = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif' };

function packClip(result, spec, fallbackType) {
  let type = (result.blob.type || fallbackType).split(';')[0].trim();
  if (!Object.values(CLIP_TYPES).includes(type)) type = CLIP_TYPES[result.ext] || 'video/mp4';
  return {
    blob: result.blob.slice(0, result.blob.size, type),
    type,
    ext: result.ext,
    w: spec.w,
    h: spec.h,
  };
}

/** Renders the short looping clip used for link previews.
 *  @param opts { data, camera, pipeline, allowCompile, onProgress, signal }
 *    allowCompile defaults to false: this one runs from the view page as well
 *    as the editor, and a gallery page must never fetch the Slang compiler.
 *    The editor's publish flow passes true.
 *  @returns { blob, type, ext, w, h } — or null if cancelled. */
export async function capturePreviewClip(opts) {
  const { data, camera, pipeline = 'deferred', allowCompile = false, onProgress, signal } = opts;

  // Walk the list rather than taking the first "yes": a codec can pass
  // isTypeSupported and still record nothing, and the fallbacks are only
  // worth anything if a lie about the preferred one doesn't end the attempt.
  const candidates = PREVIEW_CODECS.filter((t) => getVideoMimeType([t]));
  for (const mimeType of candidates) {
    try {
      const result = await exportVideo({
        data, camera, pipeline, allowCompile, ...PREVIEW_VIDEO, mimeType, onProgress, signal,
      });
      if (!result) return null;                      // cancelled
      return packClip(result, PREVIEW_VIDEO, mimeType);
    } catch (ex) {
      console.warn(`preview clip: ${mimeType} didn't work out —`, ex.message);
    }
  }

  const gif = await exportGif({
    data, camera, pipeline, allowCompile, ...PREVIEW_GIF, onProgress, signal,
  });
  return gif ? packClip(gif, PREVIEW_GIF, 'image/gif') : null;
}
