// Provider-neutral AI collaboration helpers. Nothing in this module talks to a
// model or executes returned text; it only describes and validates editor state.

export const AI_BRIEF_VERSION = 1;

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

