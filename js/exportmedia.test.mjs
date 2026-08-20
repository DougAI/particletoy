// Tests for the preview-clip preroll heuristic. No dependencies, no install:
//
//     node js/exportmedia.test.mjs
//
// exportmedia.js reaches WebGPU through player.js, and a couple of those
// modules read WebGPU enums at import time — so the four constants below are
// stubbed to let the module load under Node. Nothing here renders anything;
// prerollFor is pure, and it decides whether a clip opens on the effect or a
// second after it, which is the difference between a burst reading as a burst
// and reading as nothing at all.

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage = new Proxy({}, { get: () => 1 });
globalThis.GPUTextureUsage = new Proxy({}, { get: () => 1 });
globalThis.GPUMapMode = new Proxy({}, { get: () => 1 });

const { prerollFor, clipTiming, CLIP_LIMITS } = await import('./exportmedia.js');

const em = (o = {}) => ({ enabled: true, looping: true, spawn: { rate: 20, bursts: [] }, ...o });
const burst = (time, count = 100) => ({ rate: 0, bursts: [{ time, count }] });

const cases = [
  // A steady emitter has nothing on screen at t = 0, so the clip should not
  // open there.
  ['steady looping emitter (campfire)', { emitters: [em()] }, 1.5],

  // …but a burst IS the opening. Skipping into one throws the effect away,
  // which is the bug this exists to prevent.
  ['burst at t=0 (confetti)', { emitters: [em({ spawn: burst(0) })] }, 0],
  ['one-shot, no bursts', { emitters: [em({ looping: false })] }, 0],
  ['two emitters, one one-shot', { emitters: [em(), em({ looping: false })] }, 0],

  // A burst later on is no reason to open on an empty frame — clamp to it
  // rather than zeroing.
  ['burst later at t=3 keeps the full preroll', { emitters: [em({ spawn: burst(3) })] }, 1.5],
  ['burst at t=0.4 clamps the preroll to it', { emitters: [em({ spawn: burst(0.4) })] }, 0.4],
  ['burst with no time counts as t=0', { emitters: [em({ spawn: { rate: 5, bursts: [{ count: 10 }] } })] }, 0],

  // A disabled emitter contributes nothing to the frame, so it shouldn't get
  // a vote on when the frame is worth recording.
  ['disabled burst emitter is ignored',
    { emitters: [em(), em({ enabled: false, spawn: burst(0) })] }, 1.5],

  ['no emitters at all', { emitters: [] }, 0],
  ['missing emitters array', {}, 0],
  ['missing data', undefined, 0],
];

let bad = 0;
for (const [name, data, want] of cases) {
  const got = prerollFor(data);
  if (got === want) {
    console.log(`✓ ${name} → ${got}s`);
  } else {
    bad++;
    console.log(`✗ ${name} → want ${want}s, got ${got}s`);
  }
}

// The second argument is the ceiling, so callers can ask for a different one.
if (prerollFor({ emitters: [em()] }, 4) !== 4) { bad++; console.log('✗ custom ceiling ignored'); }
else console.log('✓ custom ceiling honored');


// ── clipTiming ─────────────────────────────────────────────────────────────
// The other half of "when is this clip": how far the sim moves between two
// recorded frames, and in how many pieces. The invariant worth protecting is
// the first one — a 1x clip has to step exactly as it always did, or every
// preview on the site quietly renders differently than it used to.
const near = (a, b) => Math.abs(a - b) < 1e-9;

const timings = [
  // [name, opts, fps, wantSub, wantDt, wantTotalFrames]
  ['1x @30fps steps as it always did', {}, 30, 1, 1 / 30, 105],
  ['0.5x slow motion halves the step', { speed: 0.5 }, 30, 1, 1 / 60, 105],
  ['0.25x quarters it', { speed: 0.25 }, 30, 1, 1 / 120, 105],
  // 2x wants 1/15 of sim per frame, which is over MAX_SIM_DT — so it walks it
  // in two 1/30 steps rather than taking one lurch twice the size.
  ['2x sub-steps instead of lurching', { speed: 2 }, 30, 2, 1 / 30, 105],
  // GIF's 12 fps has always been coarser than the sim wants; it gets split now
  // too, which is a change to GIF output and a deliberate one.
  ['12fps gif splits its frame step', { seconds: 3 }, 12, 3, 1 / 36, 36],
  ['speed and fps compose', { speed: 2, seconds: 3 }, 12, 5, 1 / 30, 36],
];

for (const [name, opts, fps, wantSub, wantDt, wantFrames] of timings) {
  const t = clipTiming({ seconds: 3.5, ...opts }, fps);
  const ok = t.sub === wantSub && near(t.dt, wantDt) && t.totalFrames === wantFrames
    // Whatever the split, one frame is always exactly speed/fps of sim time.
    && near(t.sub * t.dt, (opts.speed ?? 1) / fps);
  if (ok) console.log(`✓ ${name} → ${t.sub}×${t.dt.toFixed(5)}s`);
  else {
    bad++;
    console.log(`✗ ${name} → want ${wantSub}×${wantDt.toFixed(5)} / ${wantFrames} frames, `
      + `got ${t.sub}×${t.dt.toFixed(5)} / ${t.totalFrames} frames`);
  }
}

// Both dialogs clamp before calling, so these are the second line of defence —
// a hand-written call, or a number input someone typed nonsense into.
const clamps = [
  ['start is capped', { preroll: 999 }, (t) => t.start === CLIP_LIMITS.start.max],
  ['negative start floors at 0', { preroll: -5 }, (t) => t.start === 0],
  ['absent start is 0', {}, (t) => t.start === 0],
  ['NaN speed falls back to 1x', { speed: NaN }, (t) => t.speed === 1],
  ['absent speed is 1x', {}, (t) => t.speed === 1],
  ['zero speed floors above 0', { speed: 0 }, (t) => t.speed > 0],
  ['length is capped', { seconds: 999 }, (t) => t.seconds === 15],
];

for (const [name, opts, check] of clamps) {
  const t = clipTiming({ seconds: 3.5, ...opts }, 30);
  if (check(t)) console.log(`✓ ${name}`);
  else { bad++; console.log(`✗ ${name} → got ${JSON.stringify(t)}`); }
}

// A skip-ahead is simulated, not sought, so the work it adds has to be counted
// into the progress bar — otherwise a 20-second start sits at 0% and reads as
// a hang. Steps, not seconds: it is what the bar actually ticks through.
const plain = clipTiming({ seconds: 3.5 }, 30);
const skipped = clipTiming({ seconds: 3.5, preroll: 10 }, 30);
if (plain.totalSteps === 105 && skipped.totalSteps === 105 + 300) {
  console.log('✓ skip-ahead counts into the progress total');
} else {
  bad++;
  console.log(`✗ skip-ahead progress → got ${plain.totalSteps} / ${skipped.totalSteps}`);
}

console.log(bad ? '\nFAILED' : '\nall good');
process.exit(bad ? 1 : 0);
