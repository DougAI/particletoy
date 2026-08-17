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

export function getVideoMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4;codecs=h264',
    'video/webm',
    'video/mp4',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

// Ceiling on the wait for the compute sims to compile. Building their
// pipelines from WGSL is well under a second on real hardware, so reaching
// this means something is wrong — export whatever does render rather than
// leaving the dialog to look hung.
const WARMUP_TIMEOUT_MS = 15_000;

// Async because EffectPlayer creates its device, renderer and camera in an
// async setup step — touching player.camera/renderer before `ready` resolves
// throws. Also waits on the material compiles so the first frames aren't blank.
async function makeExportPlayer(data, camera, pipeline, w, h, signal) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // allowCompile: the export player defaults, like the gallery, to rendering
  // only from the WGSL the effect carries. The editor hands it that cache, but
  // it can be a miss — a shader edited a moment ago is still compiling, so the
  // cache holds the previous source's WGSL. We are running inside the editor
  // with the compiler already resident, so recompiling is the right fallback;
  // without it a cache miss silently exports an effect with no particles.
  const player = new EffectPlayer(canvas, { interactive: false, pipeline, allowCompile: true });
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

/** @param opts { data, camera, w, h, fps, seconds, pipeline, onProgress, signal } */
export async function exportVideo(opts) {
  const { data, camera, w, h, fps, pipeline, onProgress, signal } = opts;
  const mimeType = getVideoMimeType();
  if (!mimeType) throw new Error('Video recording is not supported in this browser.');
  const seconds = Math.min(MAX_EXPORT_SECONDS, Math.max(0.5, opts.seconds));
  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const dt = 1 / fps;

  const { canvas, player } = await makeExportPlayer(data, camera, pipeline, w, h, signal);
  try {
    if (typeof canvas.captureStream !== 'function') {
      throw new Error('This browser cannot record a canvas — try GIF instead.');
    }
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Could not capture the export canvas — try GIF instead.');
    const manual = typeof track.requestFrame === 'function';
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
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
    return { blob: new Blob(chunks, { type: mimeType }), ext };
  } finally {
    player.dispose();
  }
}

/** @param opts { data, camera, w, h, fps, seconds, pipeline, onProgress, signal } */
export async function exportGif(opts) {
  const { data, camera, w, h, fps, pipeline, onProgress, signal } = opts;
  const seconds = Math.min(MAX_EXPORT_SECONDS, Math.max(0.5, opts.seconds));
  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const dt = 1 / fps;
  const delay = Math.round(1000 / fps);

  const { canvas, player } = await makeExportPlayer(data, camera, pipeline, w, h, signal);
  const read = document.createElement('canvas');
  read.width = w;
  read.height = h;
  const ctx = read.getContext('2d', { willReadFrequently: true });

  try {
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
