// Community gallery backend.
//
// ParticleToy is a static app: local editing, URL sharing, and JSON
// export/import all work with zero infrastructure. Publishing to a public
// gallery needs a tiny backend. A complete Supabase REST implementation is
// included below — fill in the two constants and follow setup.html to enable
// it. Until then, publish/browse show a friendly "not configured" message.

// ─── FILL THESE IN (see setup.html, step 3) ─────────────────────────────────
const SUPABASE_URL = 'https://kqbbghyfpxxowwhdtjnj.supabase.co';      // e.g. 'https://abcdefgh.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_JsVww6ububer-Yi-s0AG4A_0Di7CjOh'; // the "anon public" API key from your project
// ────────────────────────────────────────────────────────────────────────────

export function backendConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function headers() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Publishes an effect. Returns {id} on success. */
export async function publishEffect(name, author, data) {
  if (!backendConfigured()) throw new Error('not-configured');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/effects`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify({ name, author, data }),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return { id: rows[0]?.id };
}

/** Lists the most recent published effects. */
export async function browseEffects(limit = 50) {
  if (!backendConfigured()) throw new Error('not-configured');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/effects?select=id,name,author,created_at&order=created_at.desc&limit=${limit}`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`browse failed: ${res.status}`);
  return res.json();
}

/** Loads one published effect by id. */
export async function loadEffect(id) {
  if (!backendConfigured()) throw new Error('not-configured');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/effects?id=eq.${encodeURIComponent(id)}&select=name,author,data`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] ?? null;
}
