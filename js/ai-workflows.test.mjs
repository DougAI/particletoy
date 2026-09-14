import assert from 'node:assert/strict';
import { assessSimulationBudget, buildWorkflowRequest, collectAiDiagnostics, validateWorkflowPatch } from './ai-workflows.js';

const effect = {
  v: 2, shaderLang: 'slang', name: 'Test', scene: { bloom: 1 },
  materials: [{ id: 'mat1', vertexSrc: 'old vs', fragmentSrc: 'old fs' }],
  emitters: [{ id: 'em1', materialId: 'mat1', simMode: 'props', simSrc: '', fields: [], spawn: { max: 1000 } }],
};
const op = (path, value) => ({ version: 1, operations: [{ op: 'replace', path, value }] });

assert.equal(validateWorkflowPatch(effect, op('/scene/bloom', 2), 'properties').effect.scene.bloom, 2);
assert.throws(() => validateWorkflowPatch(effect, op('/materials/0/fragmentSrc', 'x'), 'properties'), /cannot edit/);
const materialSrc = 'void mainSurface(inout Surface s, SurfaceInput i) {}';
assert.equal(validateWorkflowPatch(effect, op('/materials/0/fragmentSrc', materialSrc), 'material').effect.materials[0].fragmentSrc, materialSrc);
assert.throws(() => validateWorkflowPatch(effect, op('/materials/0/fragmentSrc', 'broken {'), 'material'), /Unbalanced|Missing/);
assert.throws(() => validateWorkflowPatch(effect, op('/scene/bloom', 2), 'material'), /out-of-scope/);
assert.throws(() => validateWorkflowPatch(effect, op('/emitters/0/spawn/max', 100001), 'simulation'), /capacity/);
const simPatch = { version: 1, operations: [
  { op: 'replace', path: '/emitters/0/simSrc', value: 'void simulate() {}' },
  { op: 'replace', path: '/emitters/0/simMode', value: 'shader' },
] };
assert.equal(validateWorkflowPatch(effect, simPatch, 'simulation').effect.emitters[0].simMode, 'shader');
assert.equal(assessSimulationBudget(effect).particles, 1000);
assert.throws(() => assessSimulationBudget({ emitters: [{ id: 'x', spawn: { max: 1 }, fields: [
  { name: 'a', type: 'vec4' }, { name: 'b', type: 'vec4' }, { name: 'c', type: 'vec4' },
  { name: 'd', type: 'vec4' }, { name: 'e', type: 'f32' },
]}] }), /16 custom/);

const diagnostics = collectAiDiagnostics({
  materialErrors: new Map([['mat1', [{ stage: 'fragment', line: 4, msg: 'unknown glow' }]]]),
  simErrors: new Map(),
});
assert.match(buildWorkflowRequest({ workflow: 'repair', prompt: 'Fix it', data: effect, diagnostics }), /unknown glow/);
console.log('AI scoped workflows: ok');
