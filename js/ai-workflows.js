import { applyAiPatch, buildAiRequest } from './ai.js';
import { MAX_CAPACITY } from './particles.js';

export const AI_WORKFLOW_VERSION = 1;
export const AI_WORKFLOWS = Object.freeze({
  properties: 'Properties',
  material: 'Material shader',
  simulation: 'Simulation shader',
  repair: 'Repair diagnostics',
});

const CODE_LIMIT = 64 * 1024;
const PROPERTY_BLOCKED = /\/(vertexSrc|fragmentSrc|simSrc)(?:\/|$)/;
const MATERIAL_PATH = /^\/materials\/(\d+)\/(vertexSrc|fragmentSrc)$/;
const SIM_PATH = /^\/emitters\/(\d+)\/(simSrc|simMode|fields|spawn\/max)$/;
const FIELD_WIDTH = Object.freeze({ f32: 1, vec2: 2, vec3: 3, vec4: 4 });

export function assessSimulationBudget(effect) {
  let particles = 0;
  let estimatedBytes = 0;
  const warnings = [];
  for (const emitter of effect.emitters || []) {
    const max = Number(emitter.spawn?.max ?? 0);
    particles += max;
    let customFloats = 0;
    const names = new Set();
    for (const field of emitter.fields || []) {
      if (!field?.name || names.has(field.name) || !(field.type in FIELD_WIDTH)) {
        throw new Error(`Emitter ${emitter.id} has invalid or duplicate simulation fields`);
      }
      names.add(field.name);
      customFloats += FIELD_WIDTH[field.type];
    }
    if (customFloats > 16) throw new Error(`Emitter ${emitter.id} exceeds 16 custom simulation floats`);
    estimatedBytes += max * (64 + customFloats * 4);
    if (Number(emitter.spawn?.rate || 0) > max * 2) warnings.push(`${emitter.id}: spawn rate may saturate capacity in under 0.5 seconds`);
  }
  return { particles, estimatedBytes, warnings };
}

export function preflightShaderChanges(changes) {
  const diagnostics = [];
  for (const change of changes || []) {
    const match = String(change.path).match(/\/(vertexSrc|fragmentSrc|simSrc)$/);
    if (!match || typeof change.after !== 'string') continue;
    const source = change.after;
    const expected = { vertexSrc: 'mainVertex', fragmentSrc: 'mainSurface', simSrc: 'simulate' }[match[1]];
    let depth = 0;
    for (const char of source) {
      if (char === '{') depth++;
      if (char === '}') depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) diagnostics.push({ path: change.path, severity: 'error', message: 'Unbalanced braces' });
    if (!new RegExp(`\\b${expected}\\s*\\(`).test(source)) {
      diagnostics.push({ path: change.path, severity: 'error', message: `Missing required ${expected}(...) function` });
    }
  }
  return diagnostics;
}

export function collectAiDiagnostics(app) {
  const out = [];
  for (const [id, errors] of app.materialErrors || []) {
    for (const error of errors || []) out.push({ kind: 'material', id, ...error });
  }
  for (const [id, errors] of app.simErrors || []) {
    for (const error of errors || []) out.push({ kind: 'simulation', id, ...error });
  }
  return out;
}

export function formatAiDiagnostics(items) {
  return (items || []).slice(0, 100).map((item) => {
    const where = [item.kind, item.id, item.stage, item.variant].filter(Boolean).join(':');
    const location = item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : '';
    return `${where || 'runtime'}${location}: ${item.msg || item.message || String(item)}`;
  });
}

export function buildWorkflowRequest({ workflow = 'properties', prompt, data, diagnostics = [] }) {
  if (!(workflow in AI_WORKFLOWS)) throw new Error(`Unknown AI workflow: ${workflow}`);
  const scope = {
    properties: 'Change properties and emitter structure only. Do not edit vertexSrc, fragmentSrc, or simSrc.',
    material: 'Edit only vertexSrc or fragmentSrc on an existing material. Return complete Slang source for each changed field.',
    simulation: `Edit only simSrc, simMode, fields, or spawn/max on an existing emitter. spawn/max may not exceed ${MAX_CAPACITY}.`,
    repair: 'Make the smallest source edit that addresses the supplied diagnostics. Do not change unrelated properties.',
  }[workflow];
  return `# Workflow\n\nparticletoy AI workflow v${AI_WORKFLOW_VERSION}: ${AI_WORKFLOWS[workflow]}\n\n## Scope\n\n${scope}\n\n${buildAiRequest({
    prompt, data, diagnostics: formatAiDiagnostics(diagnostics),
  })}`;
}

export function validateWorkflowPatch(effect, patch, workflow = 'properties') {
  if (!(workflow in AI_WORKFLOWS)) throw new Error(`Unknown AI workflow: ${workflow}`);
  for (const operation of patch.operations || []) {
    const path = operation.path || '';
    if (workflow === 'properties' && PROPERTY_BLOCKED.test(path)) {
      throw new Error('Properties workflow cannot edit shader source');
    }
    if ((workflow === 'material' || workflow === 'repair') && !MATERIAL_PATH.test(path)
        && !(workflow === 'repair' && SIM_PATH.test(path))) {
      throw new Error(`${AI_WORKFLOWS[workflow]} workflow received an out-of-scope path: ${path}`);
    }
    if (workflow === 'simulation' && !SIM_PATH.test(path)) {
      throw new Error(`Simulation workflow received an out-of-scope path: ${path}`);
    }
    if (/\/(vertexSrc|fragmentSrc|simSrc)$/.test(path)
        && (typeof operation.value !== 'string' || operation.value.length > CODE_LIMIT)) {
      throw new Error('Shader source must be text under 64 KB');
    }
  }
  const result = applyAiPatch(effect, patch);
  let capacity = 0;
  for (const emitter of result.effect.emitters) {
    const max = Number(emitter.spawn?.max ?? 0);
    if (!Number.isFinite(max) || max < 1 || max > MAX_CAPACITY) {
      throw new Error(`Emitter ${emitter.id} capacity must be between 1 and ${MAX_CAPACITY}`);
    }
    capacity += max;
    if (emitter.simMode === 'shader' && !String(emitter.simSrc || '').trim()) {
      throw new Error(`Emitter ${emitter.id} needs simSrc when shader simulation is enabled`);
    }
  }
  if (workflow === 'simulation' && capacity > 250_000) {
    throw new Error('Combined particle capacity exceeds the AI workflow safety budget of 250,000');
  }
  const simulationBudget = assessSimulationBudget(result.effect);
  const preflight = preflightShaderChanges(result.changes);
  if (preflight.some((item) => item.severity === 'error')) {
    throw new Error(preflight.map((item) => `${item.path}: ${item.message}`).join('; '));
  }
  return { ...result, workflow, capacity, simulationBudget, preflight };
}
