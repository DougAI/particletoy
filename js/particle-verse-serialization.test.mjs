import assert from 'node:assert/strict';
import { serializeState } from './share.js';
import { parseParticleVerse } from './particle-verse.js';

const script = 'particle_verse := 1\n\nOnBegin():void=\n    Playback.Play()';
const data = serializeState('Scripted', [{ p: { id: 'em1' } }], [{ id: 'mat1' }], {}, null, script);
const roundTrip = JSON.parse(JSON.stringify(data));
assert.equal(roundTrip.script, script);
assert.ok(parseParticleVerse(roundTrip.script).ast);
assert.equal('script' in serializeState('Plain', [], [], {}, null), false);
console.log('Particle Verse serialization: ok');
