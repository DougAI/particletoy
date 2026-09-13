// Provider-neutral AI collaboration helpers. Nothing in this module talks to a
// model or executes returned text; it only describes and validates editor state.

export const AI_BRIEF_VERSION = 1;
export const AI_PATCH_VERSION = 1;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ALLOWED_ROOTS = new Set(['name', 'scene', 'emitters', 'materials']);

export function effectForAi(data) {
  const effect = structuredClone(data);
  delete effect.wgslCache;
  return effect;
}

export function buildEffectBrief(data) {
  const effect = effectForAi(data);
  return `# particletoy effect brief v${AI_BRIEF_VERSION}

You are helping edit a particletoy effect: a static WebGPU particle system whose
materials and GPU simulations are written in Slang (not WGSL). Preserve existing IDs
unless you are deliberately adding an object. Do not return JavaScript or HTML.

## Effect contract

- Schema version: ${effect.v ?? 2}
- Shader language: ${effect.shaderLang ?? 'slang'}
- Top-level fields: v, shaderLang, name, emitters, materials, scene
- Emitters reference materials by materialId.
- Colors are linear RGB arrays; colorStart values include alpha.
- Curves use keys with normalized time t and numeric value v.
- Gradients use stops with normalized time t and linear color c.
- Shader source belongs in vertexSrc, fragmentSrc, or simSrc.
- Keep the result valid JSON. Explain proposed changes separately from the JSON.

## Current effect

\`\`\`json
${JSON.stringify(effect, null, 2)}
\`\`\`
`;
}

export function buildAiRequest({ prompt, data, diagnostics = [] }) {
  const request = String(prompt || '').trim();
  if (!request) throw new Error('Describe the effect change you want first');
  const diagnosticText = diagnostics.length
    ? `\n## Current diagnostics\n\n${diagnostics.map((item) => `- ${item}`).join('\n')}\n`
    : '';
  return `# particletoy AI edit request

## Request

${request}

## Required response format

Return exactly one JSON object and no surrounding prose or Markdown fence:

{"version":1,"summary":"short description","operations":[{"op":"replace","path":"/scene/bloom","value":1}]}

- Use only add, replace, or remove operations.
- Paths are JSON Pointers rooted at /name, /scene, /emitters, or /materials.
- Preserve schema version 2, Slang shader language, unique IDs, and valid material references.
- Do not return JavaScript, HTML, commands, or a complete replacement effect.
- Keep the edit focused on the request and avoid unrelated changes.
${diagnosticText}
${buildEffectBrief(data)}`;
}

function pointerSegments(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Every operation needs a JSON Pointer path');
  const parts = path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!parts.length || !ALLOWED_ROOTS.has(parts[0])) throw new Error(`Path is not editable: ${path}`);
  if (parts.some((part) => BLOCKED_KEYS.has(part))) throw new Error(`Unsafe path: ${path}`);
  return parts;
}

function atPath(root, parts, { parent = false } = {}) {
  const limit = parent ? parts.length - 1 : parts.length;
  let value = root;
  for (let i = 0; i < limit; i++) {
    if (value === null || typeof value !== 'object' || !(parts[i] in value)) {
      throw new Error(`Path does not exist: /${parts.join('/')}`);
    }
    value = value[parts[i]];
  }
  return value;
}

function assertSafeValue(value, path = 'value') {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} must be finite`);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) throw new Error(`${path} contains an unsafe key`);
    assertSafeValue(child, `${path}.${key}`);
  }
}

export function parseAiPatch(text) {
  if (typeof text !== 'string' || text.length > 256_000) throw new Error('Patch must be text under 256 KB');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let patch;
  try { patch = JSON.parse(fence ? fence[1] : text); }
  catch { throw new Error('Patch is not valid JSON'); }
  if (!patch || patch.version !== AI_PATCH_VERSION || !Array.isArray(patch.operations)) {
    throw new Error(`Patch must have version ${AI_PATCH_VERSION} and an operations array`);
  }
  if (patch.operations.length < 1 || patch.operations.length > 100) {
    throw new Error('Patch must contain between 1 and 100 operations');
  }
  return patch;
}

export function validateEffect(effect) {
  if (!effect || typeof effect !== 'object') throw new Error('Effect must be an object');
  if ((effect.v ?? 2) !== 2 || (effect.shaderLang ?? 'slang') !== 'slang') {
    throw new Error('AI patches must preserve the v2 Slang effect format');
  }
  if (!Array.isArray(effect.materials) || effect.materials.length < 1) throw new Error('At least one material is required');
  if (!Array.isArray(effect.emitters)) throw new Error('Emitters must be an array');
  if (!effect.scene || typeof effect.scene !== 'object') throw new Error('Scene must be an object');
  const materialIds = new Set();
  for (const material of effect.materials) {
    if (!material?.id || materialIds.has(material.id)) throw new Error('Material IDs must be present and unique');
    materialIds.add(material.id);
  }
  const emitterIds = new Set();
  for (const emitter of effect.emitters) {
    if (!emitter?.id || emitterIds.has(emitter.id)) throw new Error('Emitter IDs must be present and unique');
    emitterIds.add(emitter.id);
    if (!materialIds.has(emitter.materialId)) throw new Error(`Emitter ${emitter.id} references a missing material`);
  }
  assertSafeValue(effect, 'effect');
  if (JSON.stringify(effect).length > 1_000_000) throw new Error('Patched effect exceeds 1 MB');
  return effect;
}

export function applyAiPatch(effect, patch) {
  const next = effectForAi(effect);
  const changes = [];
  for (const [index, operation] of patch.operations.entries()) {
    if (!operation || !['add', 'replace', 'remove'].includes(operation.op)) {
      throw new Error(`Operation ${index + 1} has an unsupported op`);
    }
    const parts = pointerSegments(operation.path);
    const parent = atPath(next, parts, { parent: true });
    const key = parts.at(-1);
    const before = key === '-' ? undefined : structuredClone(parent?.[key]);
    if (operation.op !== 'remove') assertSafeValue(operation.value, `operation ${index + 1} value`);
    if (Array.isArray(parent)) {
      const arrayIndex = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex > parent.length) {
        throw new Error(`Operation ${index + 1} has an invalid array index`);
      }
      if (operation.op === 'add') parent.splice(arrayIndex, 0, structuredClone(operation.value));
      else if (arrayIndex >= parent.length) throw new Error(`Operation ${index + 1} path does not exist`);
      else if (operation.op === 'replace') parent[arrayIndex] = structuredClone(operation.value);
      else parent.splice(arrayIndex, 1);
    } else {
      if (!parent || typeof parent !== 'object') throw new Error(`Operation ${index + 1} parent is not an object`);
      if (operation.op !== 'add' && !(key in parent)) throw new Error(`Operation ${index + 1} path does not exist`);
      if (operation.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(operation.value);
    }
    changes.push({ op: operation.op, path: operation.path, before, after: operation.op === 'remove' ? undefined : structuredClone(operation.value) });
  }
  validateEffect(next);
  return { effect: next, changes };
}

function short(value) {
  if (value === undefined) return '∅';
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function describeAiChanges(changes) {
  return changes.map((change, index) =>
    `${index + 1}. ${change.op.toUpperCase()} ${change.path}\n   ${short(change.before)} → ${short(change.after)}`,
  ).join('\n');
}
