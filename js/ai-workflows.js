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
  return { ...result, workflow, capacity };
}
