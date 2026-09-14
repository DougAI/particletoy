import assert from 'node:assert/strict';
import { parseParticleVerse } from './particle-verse.js';

const valid = `particle_verse := 1

OnBegin():void=
    Scene.SetBloom(1.2)
    Emitter.Burst("sparks", 12)

OnTick(Delta):void=
    Scene.SetExposure(Time)

OnEvent("boost"):void=
    Wait(0.25)
    Emit("finished")`;
const parsed = parseParticleVerse(valid);
assert.deepEqual(parsed.diagnostics, []);
assert.equal(parsed.ast.handlers.length, 3);
assert.equal(parsed.ast.handlers[0].body[0].method, 'SetBloom');
assert.equal(parsed.ast.handlers[2].event, 'boost');
assert.equal(parseParticleVerse('OnBegin():void=\n\tScene.SetBloom(1)').ast, null);
assert.match(parseParticleVerse('particle_verse := 1\n  nope()').diagnostics[0].message, /four spaces/);
const implementation = (await import('node:fs')).readFileSync(new URL('./particle-verse.js', import.meta.url), 'utf8');
assert.equal(/\beval\s*\(|\bnew\s+Function\s*\(/.test(implementation), false);
console.log('Particle Verse parser: ok');
