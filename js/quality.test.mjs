import assert from 'node:assert/strict';
import {
  AdaptiveQuality, fixedQualityScale, loadQualityMode, normalizeQualityMode,
  QUALITY_KEY, saveQualityMode,
} from './quality.js';

assert.equal(normalizeQualityMode('nonsense'), 'auto');
assert.equal(fixedQualityScale('balanced'), 0.75);

const auto = new AdaptiveQuality({ initialScale: 1 });
for (let i = 0; i < 180; i++) auto.update(1 / 30);
assert.ok(auto.scale < 1, 'sustained slow frames reduce internal resolution');
const reduced = auto.scale;
for (let i = 0; i < 500; i++) auto.update(1 / 120);
assert.ok(auto.scale > reduced, 'sustained headroom restores internal resolution');

auto.setMode('performance');
for (let i = 0; i < 500; i++) auto.update(1 / 10);
assert.equal(auto.scale, 0.5, 'manual modes never adapt');

const values = new Map();
const storage = {
  getItem(key) { return values.get(key); },
  setItem(key, value) { values.set(key, value); },
};
saveQualityMode(storage, 'full');
assert.equal(values.get(QUALITY_KEY), 'full');
assert.equal(loadQualityMode(storage), 'full');

console.log('adaptive render quality: ok');

