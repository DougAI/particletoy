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

const { prerollFor } = await import('./exportmedia.js');

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

console.log(bad ? '\nFAILED' : '\nall good');
process.exit(bad ? 1 : 0);
