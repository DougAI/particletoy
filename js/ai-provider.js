import { parseAiPatch } from './ai.js';

export const AI_PROVIDER_CONTRACT_VERSION = 1;
export const MAX_PROVIDER_RESPONSE_BYTES = 512_000;

export function resolveProviderEndpoint(endpoint, baseUrl = globalThis.location?.href || 'https://particletoy.com/editor.html') {
  const value = String(endpoint || '').trim();
  if (!value) throw new Error('Configure a provider endpoint first');
  let url;
  try { url = new URL(value, baseUrl); }
  catch { throw new Error('Provider endpoint is not a valid URL'); }
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => /key|token|secret|password/i.test(key))) {
    throw new Error('Do not put credentials in the provider URL');
  }
  const base = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && url.origin !== base.origin && !local) {
    throw new Error('Remote provider endpoints must use HTTPS');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider endpoint must use HTTP or HTTPS');
  return url;
}

export async function requestAiPatch({ endpoint, request, baseUrl, fetchImpl = fetch, signal }) {
  const url = resolveProviderEndpoint(endpoint, baseUrl);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: url.origin === new URL(baseUrl || globalThis.location?.href || url).origin ? 'same-origin' : 'omit',
    body: JSON.stringify({ version: AI_PROVIDER_CONTRACT_VERSION, request }),
    signal,
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response is too large');
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response is too large');
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('Provider did not return JSON'); }
  const patch = payload?.patch || payload;
  return parseAiPatch(JSON.stringify(patch));
}
