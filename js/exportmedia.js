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

// Async because EffectPlayer creates its device, renderer and camera in an
// async setup step — touching player.camera/renderer before `ready` resolves
// throws. Also waits on the material compiles so the first frames aren't blank.
async function makeExportPlayer(data, camera, pipeline, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const player = new EffectPlayer(canvas, { interactive: false, pipeline });
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
  } catch (ex) {
    player.dispose();
    throw ex;
  }
  return { canvas, player };
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

  const { canvas, player } = await makeExportPlayer(data, camera, pipeline, w, h);
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

  const { canvas, player } = await makeExportPlayer(data, camera, pipeline, w, h);
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
