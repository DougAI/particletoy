import assert from 'node:assert/strict';
import { buildEffectBrief, effectForAi } from './ai.js';

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

console.log('AI effect brief: ok');

