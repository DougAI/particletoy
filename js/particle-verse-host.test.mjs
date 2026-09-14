import assert from 'node:assert/strict';
import { ParticleVerseHost } from './particle-verse-host.js';

const emitter = { p: { id: 'em1', name: 'Sparks', enabled: true, spawn: { rate: 5 } }, requestBurst: (n) => { emitter.burst = n; } };
const app = { scene: { bloom: 1, exposure: 0, background: [0, 0, 0] }, playing: true, timeScale: 1, emitters: [emitter] };
let mutations = 0;
const host = new ParticleVerseHost(app, { onMutate: () => mutations++ });
host.dispatch({ namespace: 'Scene', method: 'SetBloom', args: [20] });
host.dispatch({ namespace: 'Emitter', method: 'SetRate', args: ['Sparks', 30] });
host.dispatch({ namespace: 'Emitter', method: 'Burst', args: ['em1', 12000] });
assert.equal(app.scene.bloom, 5);
assert.equal(emitter.p.spawn.rate, 30);
assert.equal(emitter.burst, 10000);
assert.equal(mutations, 3);
assert.throws(() => host.dispatch({ namespace: 'Browser', method: 'Fetch', args: [] }), /does not allow/);
console.log('Particle Verse host API: ok');
