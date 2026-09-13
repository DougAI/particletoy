import assert from 'node:assert/strict';
import {
  applyAiPatch, buildAiRequest, buildEffectBrief, describeAiChanges, effectForAi, parseAiPatch,
} from './ai.js';

const source = {
  v: 2, shaderLang: 'slang', name: 'Test',
  emitters: [{ id: 'em1', materialId: 'mat1' }],
  materials: [{ id: 'mat1', vertexSrc: 'void mainVertex() {}' }],
  scene: { bloom: 0.5 },
  wgslCache: { materials: { mat1: { enormous: true } } },
};
const clean = effectForAi(source);
assert.equal('wgslCache' in clean, false);
assert.ok('wgslCache' in source, 'brief generation does not mutate editor state');
const brief = buildEffectBrief(source);
assert.match(brief, /particletoy effect brief v1/);
assert.match(brief, /Shader language: slang/);
assert.match(brief, /"name": "Test"/);
assert.doesNotMatch(brief, /enormous/);

const request = buildAiRequest({
  prompt: 'Make the campfire sparks brighter',
  data: source,
  diagnostics: ['fragment.slang:12: unknown identifier glow'],
});
assert.match(request, /Make the campfire sparks brighter/);
assert.match(request, /"operations"/);
assert.match(request, /\/scene\/bloom/);
assert.match(request, /unknown identifier glow/);
assert.match(request, /"name": "Test"/);
assert.throws(() => buildAiRequest({ prompt: '  ', data: source }), /Describe/);

console.log('AI effect brief: ok');

const patch = parseAiPatch(`\`\`\`json
{"version":1,"summary":"brighter","operations":[
  {"op":"replace","path":"/scene/bloom","value":1.2},
  {"op":"replace","path":"/name","value":"Brighter Test"}
]}
\`\`\``);
const applied = applyAiPatch(source, patch);
assert.equal(applied.effect.scene.bloom, 1.2);
assert.equal(applied.effect.name, 'Brighter Test');
assert.equal(source.scene.bloom, 0.5, 'patch preview does not mutate the live effect');
assert.match(describeAiChanges(applied.changes), /REPLACE \/scene\/bloom/);
assert.throws(() => applyAiPatch(source, {
  version: 1, operations: [{ op: 'replace', path: '/__proto__/polluted', value: true }],
}), /not editable|Unsafe/);
assert.throws(() => applyAiPatch(source, {
  version: 1, operations: [{ op: 'remove', path: '/materials/0' }],
}), /At least one material/);
assert.throws(() => parseAiPatch('{bad'), /not valid JSON/);

console.log('AI patch validation and preview: ok');
