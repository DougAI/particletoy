import assert from 'node:assert/strict';
import { requestAiPatch, resolveProviderEndpoint } from './ai-provider.js';

assert.equal(resolveProviderEndpoint('/api/particletoy-ai', 'https://particletoy.com/editor.html').href,
  'https://particletoy.com/api/particletoy-ai');
assert.throws(() => resolveProviderEndpoint('http://example.com/ai'), /HTTPS/);
assert.throws(() => resolveProviderEndpoint('https://example.com/ai?api_key=secret'), /credentials/);
assert.equal(resolveProviderEndpoint('http://localhost:8787/ai').port, '8787');

let captured;
const patch = await requestAiPatch({
  endpoint: 'https://adapter.example/ai',
  baseUrl: 'https://particletoy.com/editor.html',
  request: 'make it brighter',
  fetchImpl: async (url, options) => {
    captured = { url: url.href, options };
    return new Response(JSON.stringify({ patch: {
      version: 1, summary: 'brighter',
      operations: [{ op: 'replace', path: '/scene/bloom', value: 1 }],
    } }), { headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(patch.summary, 'brighter');
assert.equal(captured.options.credentials, 'omit');
assert.equal(JSON.parse(captured.options.body).version, 1);
assert.doesNotMatch(captured.options.body, /apiKey|token/i);

await assert.rejects(() => requestAiPatch({
  endpoint: '/ai', baseUrl: 'https://particletoy.com/', request: 'x',
  fetchImpl: async () => new Response('not json'),
}), /did not return JSON/);

console.log('AI provider boundary: ok');
