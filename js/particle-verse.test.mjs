import assert from 'node:assert/strict';
import { parseParticleVerse, ParticleVerseRuntime } from './particle-verse.js';

const valid = `particle_verse := 1

OnBegin():void=
    Scene.SetBloom(1.2)
    Wait(0.25)
    Emitter.Burst("sparks", 12)

OnTick(Delta):void=
    Scene.SetExposure(Time)

OnEvent("boost"):void=
    Wait(0.25)
    Emit("finished")

OnEvent("finished"):void=
    Playback.Pause()`;
const parsed = parseParticleVerse(valid);
assert.deepEqual(parsed.diagnostics, []);
assert.equal(parsed.ast.handlers.length, 4);
assert.equal(parsed.ast.handlers[0].body[0].method, 'SetBloom');
assert.equal(parsed.ast.handlers[2].event, 'boost');
assert.equal(parseParticleVerse('OnBegin():void=\n\tScene.SetBloom(1)').ast, null);
assert.match(parseParticleVerse('particle_verse := 1\n  nope()').diagnostics[0].message, /four spaces/);
const implementation = (await import('node:fs')).readFileSync(new URL('./particle-verse.js', import.meta.url), 'utf8');
assert.equal(/\beval\s*\(|\bnew\s+Function\s*\(/.test(implementation), false);

const calls = [];
const runtime = new ParticleVerseRuntime(parsed.ast, { dispatch: (call) => calls.push(call), instructionBudget: 10 });
assert.equal(runtime.restart().error, null);
assert.equal(calls[0].method, 'SetBloom');
assert.equal(calls.length, 1, 'OnBegin yields at Wait');
runtime.tick(0.1);
assert.equal(calls.at(-1).args[0], 0.1, 'Time is deterministic from supplied deltas');
runtime.tick(0.15);
assert.equal(calls.some((call) => call.method === 'Burst'), true, 'waiting OnBegin body resumes deterministically');
runtime.emit('boost');
runtime.tick(0.25);
runtime.tick(0.25);
assert.equal(calls.some((call) => call.method === 'Pause'), true, 'events may schedule bounded named handlers');
assert.throws(() => runtime.emit('x'.repeat(65)), /1–64/);
const tiny = new ParticleVerseRuntime(parsed.ast, { instructionBudget: 1 });
assert.match(tiny.restart().error.message, /budget/);
const forbiddenAst = parseParticleVerse('particle_verse := 1\n\nOnBegin():void=\n    Browser.Fetch("https://example.com")').ast;
const forbidden = new ParticleVerseRuntime(forbiddenAst, { dispatch: () => { throw new Error('API denied'); } });
assert.match(forbidden.restart().error.message, /denied/);
console.log('Particle Verse parser: ok');
