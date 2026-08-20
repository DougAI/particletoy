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

// Largest slice of simulated time taken in a single step. A particle sim
// integrates once per step, so an oversized dt doesn't merely look choppy —
// gravity and drag land the particles somewhere else entirely. 1/30 is what a
// default 30 fps clip has always stepped, so nothing about a 1x clip changes;
// coarser steps (a 2x clip, or GIF's 12 fps) get split instead of stretched.
const MAX_SIM_DT = 1 / 30;

// Sim steps between breaths while winding an effect forward. Half a second of
// simulated time: often enough that the tab keeps painting and Cancel keeps
// working, rare enough that the yields don't dominate the wind-forward.
const YIELD_EVERY = 15;

/** The ranges the preview controls offer, and what they mean.
 *
 *  start   simulated seconds to run before the first recorded frame. Defaults
 *          to whatever prerollFor() reads off the effect.
 *  speed   simulated seconds per second of clip: 0.5 is slow motion, 2 fits
 *          twice as much effect into the same file. The choices match the
 *          editor's own time-scale control so the numbers mean one thing
 *          across the app.
 *  seconds how long the finished clip runs. Unchanged by speed — speed decides
 *          how much effect is inside it, not how long it plays.
 *
 *  The cap on start is a wall-clock cap in disguise: winding forward is not a
 *  seek, it is the simulation actually being run (see prerollTo), so a minute
 *  of skip-ahead is a minute-ish of somebody watching a progress bar.
 */
export const CLIP_LIMITS = {
  start:   { min: 0, max: 30, step: 0.5 },
  speeds:  [0.25, 0.5, 1, 2],
  seconds: { min: 1, max: MAX_EXPORT_SECONDS, step: 0.5 },
};

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

/** How many steps `seconds` of simulated time has to be cut into, and how big
 *  each one is. Splitting evenly rather than taking MAX_SIM_DT slices and a
 *  remainder keeps every step the same size, which is what the sim wants. */
function stepPlan(seconds) {
  const steps = Math.max(1, Math.ceil(seconds / MAX_SIM_DT));
  return { steps, dt: seconds / steps };
}

// Run the simulation forward before the first recorded frame. Distinct from
// warmUp() above, which waits for compiles and then rewinds to t = 0: this
// deliberately advances simulated time. An effect at t = 0 has no particles in
// it yet, so a clip that starts there opens on an empty frame — fine for a
// download the viewer scrubs, useless for a preview card where those first
// frames are the whole impression. Runs after warmUp(), so the rewind doesn't
// undo it.
//
// It renders every step and throws all of them away, which looks wasteful and
// isn't: a shader-mode emitter's compute pass is driven by the render, not by
// step() — step() only banks the spawn budget and the dt the next render will
// consume (see particles.js). Stepping without rendering would advance the
// CPU-side clock past a GPU sim that never moved. There is no seek here to
// reach for instead; winding forward *is* running the effect.
//
// Async, and yielding every so often, because the owner picks this number: at
// the top of the range it is nine hundred renders, and a synchronous run of
// those is a frozen tab with a dead Cancel button on it. Nothing is being
// recorded yet, so the pauses cost the clip nothing.
async function prerollTo(player, seconds, w, h, { onStep, signal } = {}) {
  if (!(seconds > 0)) return;
  const { steps, dt } = stepPlan(seconds);
  for (let i = 0; i < steps; i++) {
    if (signal?.cancelled) return;
    stepAndRender(player, dt, w, h);
    onStep?.();
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await wait(0);
  }
}

/** Everything the two exporters share about *when* the clip is, resolved and
 *  clamped once so a caller can pass whatever a form gave it. Exported for
 *  exportmedia.test.mjs, which is the only thing outside this file to call it.
 *
 *  Speed is deliberately not applied to `seconds` or to the frame cadence: a
 *  2x clip is the same length and the same smoothness as a 1x one, it just
 *  covers twice as much of the effect. What moves is how far the simulation
 *  travels between two recorded frames — and once that slice grows past
 *  MAX_SIM_DT it is walked in sub-steps rather than taken in one lurch, so
 *  the fast clip is a fast clip and not a coarser sim. */
export function clipTiming(opts, fps) {
  const seconds = Math.min(MAX_EXPORT_SECONDS, Math.max(0.5, opts.seconds));
  const speed = Math.min(8, Math.max(0.05, Number.isFinite(opts.speed) ? opts.speed : 1));
  const start = Math.min(CLIP_LIMITS.start.max, Math.max(0, opts.preroll || 0));
  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const { steps: sub, dt } = stepPlan(speed / fps);
  // Sized before anything runs so the bar moves at one rate throughout: a long
  // skip-ahead is real work and reporting 0% through all of it reads as a hang.
  const prerollSteps = start > 0 ? stepPlan(start).steps : 0;
  return { seconds, speed, start, totalFrames, sub, dt,
           totalSteps: prerollSteps + totalFrames * sub };
}

/** @param opts { data, camera, w, h, fps, seconds, speed, pipeline, mimeType,
 *                bitrate, preroll, onProgress, signal } */
export async function exportVideo(opts) {
  const { data, camera, w, h, fps, pipeline, onProgress, signal } = opts;
  const mimeType = opts.mimeType || getVideoMimeType();
  if (!mimeType) throw new Error('Video recording is not supported in this browser.');
  const { start, totalFrames, sub, dt, totalSteps } = clipTiming(opts, fps);
  let done = 0;

  const { canvas, player } = await makeExportPlayer({
    data, camera, pipeline, w, h, signal, allowCompile: opts.allowCompile ?? true,
  });
  try {
    await prerollTo(player, start, w, h,
      { signal, onStep: () => onProgress?.(++done / totalSteps) });
    if (signal?.cancelled) return null;
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

    // Paced against a fixed deadline rather than sleeping a frame's worth after
    // each one. MediaRecorder timestamps by wall clock, so the recorded clip is
    // as long as the loop takes: sleep 1/fps *plus* however long the renders
    // took and every clip comes out slow and overlong, by more the heavier the
    // effect — and a 2x clip, which renders several sub-steps per frame, worst
    // of all. Against a deadline the render time is absorbed by the wait
    // instead of added to it, and a machine too slow to keep up degrades by
    // dropping frames at the right speed instead of stretching the clip.
    const frameMs = 1000 / fps;
    const startedAt = performance.now();
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.cancelled) break;
      for (let k = 0; k < sub; k++) stepAndRender(player, dt, w, h);
      if (manual) track.requestFrame();
      done += sub;
      onProgress?.(done / totalSteps);
      await wait(Math.max(0, startedAt + (i + 1) * frameMs - performance.now()));
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

/** @param opts { data, camera, w, h, fps, seconds, speed, pipeline, preroll,
 *                onProgress, signal } */
export async function exportGif(opts) {
  const { data, camera, w, h, fps, pipeline, onProgress, signal } = opts;
  const { start, totalFrames, sub, dt, totalSteps } = clipTiming(opts, fps);
  // The frame delay is what makes the GIF play at the right speed, and it is
  // fps alone — speed has already been spent on how far the sim moves between
  // frames. No pacing loop to match it: nothing here records in real time.
  const delay = Math.round(1000 / fps);
  let done = 0;

  const { canvas, player } = await makeExportPlayer({
    data, camera, pipeline, w, h, signal, allowCompile: opts.allowCompile ?? true,
  });
  const read = document.createElement('canvas');
  read.width = w;
  read.height = h;
  const ctx = read.getContext('2d', { willReadFrequently: true });

  try {
    await prerollTo(player, start, w, h,
      { signal, onStep: () => onProgress?.(++done / totalSteps) });
    if (signal?.cancelled) return null;
    const gif = GIFEncoder();
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.cancelled) return null;
      for (let k = 0; k < sub; k++) stepAndRender(player, dt, w, h);
      ctx.drawImage(canvas, 0, 0, w, h);
      const { data: pixels } = ctx.getImageData(0, 0, w, h);
      const palette = quantize(pixels, 256);
      const index = applyPalette(pixels, palette);
      gif.writeFrame(index, w, h, { palette, delay });
      done += sub;
      onProgress?.(done / totalSteps);
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

const PREVIEW_VIDEO = { w: 960, h: 540, fps: 30, seconds: 3.5, bitrate: 2_500_000 };
// The fallback when no video codec works out, and what you get if you ask for
// GIF outright. Lower and slower than the video because GIF costs far more per
// second of motion — though less than you would think for this subject:
// particles on black quantize well, and these settings measure ~0.7 MB.
const PREVIEW_GIF = { w: 640, h: 360, fps: 12, seconds: 3 };

/** What the preview dialogs prefill their length field with. Taken off the
 *  specs above rather than repeated, so an owner who changes nothing still
 *  gets exactly the clip the automatic capture would have made — and can see
 *  what that was before deciding otherwise. */
export const PREVIEW_DEFAULT_SECONDS = {
  video: PREVIEW_VIDEO.seconds,
  gif: PREVIEW_GIF.seconds,
};

// How long a continuous effect gets to fill the frame before recording starts.
const PREVIEW_PREROLL = 1.5;

/**
 * How far to run this particular effect before the first recorded frame.
 *
 * A steady emitter has nothing on screen at t = 0 and needs a moment to fill,
 * so a clip that starts there opens on an empty frame and wastes the seconds
 * that make the impression. A burst or a one-shot is the exact opposite: its
 * opening instant is the whole effect, and skipping into it throws away the
 * part worth showing. Same preroll, opposite outcomes — so it has to be read
 * off the effect rather than fixed.
 *
 * @param data    a serialized effect
 * @param seconds the preroll to use when nothing argues against it
 */
export function prerollFor(data, seconds = PREVIEW_PREROLL) {
  const emitters = (data?.emitters || []).filter((e) => e?.enabled !== false);
  if (!emitters.length) return 0;

  // A one-shot plays once and is over. Whatever it does, it does from the
  // start, so start where it starts.
  if (emitters.some((e) => e.looping === false)) return 0;

  // Never run past the first burst — that flash is the point of it. A burst
  // later in the timeline is no reason to open on an empty frame, so this
  // clamps rather than zeroes.
  let limit = seconds;
  for (const e of emitters) {
    for (const b of e.spawn?.bursts || []) {
      limit = Math.min(limit, Math.max(0, b.time ?? 0));
    }
  }
  return limit;
}

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
 *  @param opts { data, camera, pipeline, allowCompile, format,
 *                start, speed, seconds, onProgress, signal }
 *    allowCompile defaults to false: this one runs from the view page as well
 *    as the editor, and a gallery page must never fetch the Slang compiler.
 *    The editor's publish flow passes true.
 *    format 'auto' (default) records video and falls back to GIF; 'gif' skips
 *    video entirely. Worth knowing before choosing: Discord plays an MP4 given
 *    to it as og:video, but shows only the first frame of a GIF given as
 *    og:image — so 'gif' trades away the motion that most people are after.
 *    start, speed and seconds are the owner's overrides — see CLIP_LIMITS.
 *    Each falls back to the automatic choice when it isn't a number, so the
 *    no-arguments call still produces exactly the clip it always did.
 *  @returns { blob, type, ext, w, h } — or null if cancelled. */
export async function capturePreviewClip(opts) {
  const {
    data, camera, pipeline = 'deferred', allowCompile = false,
    format = 'auto', start, speed, seconds, onProgress, signal,
  } = opts;
  // Read off the effect, not fixed: see prerollFor. Named apart from the
  // prerollTo() stepper above so neither shadows the other.
  const prerollSeconds = Number.isFinite(start) ? start : prerollFor(data);
  const common = {
    data, camera, pipeline, allowCompile, preroll: prerollSeconds, onProgress, signal,
  };
  // Length is the one override that can't be a blanket ...spread: video and
  // GIF carry different defaults for it (a GIF second costs far more than a
  // video one), and an unset length has to leave each on its own.
  const tuning = {
    ...(Number.isFinite(speed) ? { speed } : {}),
    ...(Number.isFinite(seconds) ? { seconds } : {}),
  };

  if (format !== 'gif') {
    // Walk the list rather than taking the first "yes": a codec can pass
    // isTypeSupported and still record nothing, and the fallbacks are only
    // worth anything if a lie about the preferred one doesn't end the attempt.
    const candidates = PREVIEW_CODECS.filter((t) => getVideoMimeType([t]));
    for (const mimeType of candidates) {
      try {
        const result = await exportVideo({ ...common, ...PREVIEW_VIDEO, ...tuning, mimeType });
        if (!result) return null;                    // cancelled
        return packClip(result, PREVIEW_VIDEO, mimeType);
      } catch (ex) {
        console.warn(`preview clip: ${mimeType} didn't work out —`, ex.message);
      }
    }
  }

  const gif = await exportGif({ ...common, ...PREVIEW_GIF, ...tuning });
  return gif ? packClip(gif, PREVIEW_GIF, 'image/gif') : null;
}
