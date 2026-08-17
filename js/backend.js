// Community backend client — Supabase over plain REST (no SDK, no deps).
//
// Covers: auth (email/password, recovery, email/password change), profiles,
// particles CRUD + browse/search, likes, comments, featured/POTD curation,
// in-app notifications, and storage uploads (avatars + thumbnails).
//
// The database side lives in supabase/schema.sql — run it once in the
// Supabase SQL editor (see setup.html). Until then the site shows a
// "backend not set up" banner and degrades gracefully.

// ─── project constants (see setup.html) ─────────────────────────────────────
const SUPABASE_URL = 'https://kqbbghyfpxxowwhdtjnj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JsVww6ububer-Yi-s0AG4A_0Di7CjOh';
// ────────────────────────────────────────────────────────────────────────────

const SKEY = 'particletoy.session.v2';

let session = null;        // { access_token, refresh_token, expires_at, user }
let profile = null;        // row from public.profiles for the signed-in user
let recoveryMode = false;  // true when the page was opened from a reset-password email
let refreshTimer = 0;

export function backendConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// ─── errors ─────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let schemaMissing = false;
export function isSchemaMissing() { return schemaMissing; }

function noteError(err) {
  // PGRST205 = table not in schema cache, PGRST202 = function not found:
  // the SQL in supabase/schema.sql hasn't been run yet.
  if (err.code === 'PGRST205' || err.code === 'PGRST202' || err.code === '42P01') {
    if (!schemaMissing) {
      schemaMissing = true;
      window.dispatchEvent(new CustomEvent('pt:schema-missing'));
    }
  }
  return err;
}

async function asApiError(res) {
  let msg = `${res.status}`;
  let code = null;
  try {
    const j = await res.json();
    msg = j.msg || j.message || j.error_description || j.error || msg;
    code = j.code || j.error_code || null;
  } catch { /* non-JSON body */ }
  return noteError(new ApiError(msg, res.status, code));
}

// ─── auth core ──────────────────────────────────────────────────────────────

function emitAuth() {
  window.dispatchEvent(new CustomEvent('pt:auth', { detail: { user: currentUser(), profile } }));
}

export function currentUser() { return session?.user ?? null; }
export function currentProfile() { return profile; }
export function isRecoveryMode() { return recoveryMode; }
export function clearRecoveryMode() { recoveryMode = false; }

function saveSession() {
  if (session) localStorage.setItem(SKEY, JSON.stringify(session));
  else localStorage.removeItem(SKEY);
}

function setSession(s) {
  session = s;
  saveSession();
  clearTimeout(refreshTimer);
  if (session) {
    // refresh one minute before expiry
    const ms = Math.max(15000, session.expires_at - Date.now() - 60000);
    refreshTimer = setTimeout(() => refreshSession().catch(() => {}), ms);
  }
}

function sessionFromTokenResponse(j) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
    user: j.user ?? session?.user ?? null,
  };
}

async function gotrue(path, { method = 'POST', body, auth = false } = {}) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth && session ? session.access_token : SUPABASE_ANON_KEY}`,
  };
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await asApiError(res);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function refreshSession() {
  if (!session?.refresh_token) throw new ApiError('no session', 401);
  try {
    const j = await gotrue('token?grant_type=refresh_token', {
      body: { refresh_token: session.refresh_token },
    });
    setSession(sessionFromTokenResponse(j));
    emitAuth();
  } catch (e) {
    // refresh token consumed/expired → drop the local session
    setSession(null);
    profile = null;
    emitAuth();
    throw e;
  }
}

// Adopt a session arriving in the URL fragment (password-recovery links,
// email-change confirmations, signup confirmations).
async function adoptHashSession() {
  const h = location.hash;
  if (!h.includes('access_token=')) return;
  const p = new URLSearchParams(h.slice(1));
  const access_token = p.get('access_token');
  const refresh_token = p.get('refresh_token');
  if (!access_token) return;
  recoveryMode = p.get('type') === 'recovery';
  session = {
    access_token,
    refresh_token,
    expires_at: Date.now() + parseInt(p.get('expires_in') || '3600', 10) * 1000,
    user: null,
  };
  try {
    session.user = await gotrue('user', { method: 'GET', auth: true });
  } catch { /* keep going; refresh may still work */ }
  setSession(session);
  history.replaceState(null, '', location.pathname + location.search);
}

/** Call once per page, before using anything else. */
export async function initBackend() {
  if (!backendConfigured()) return;
  await adoptHashSession();
  if (!session) {
    try { session = JSON.parse(localStorage.getItem(SKEY)); } catch { session = null; }
  }
  if (session) {
    if (session.expires_at - Date.now() < 60000) {
      try { await refreshSession(); } catch { /* signed out */ }
    } else {
      setSession(session); // arm the refresh timer
    }
  }
  if (session) {
    try { profile = await ensureProfile(); } catch { profile = null; }
  }
  emitAuth();
}

// ─── auth API ───────────────────────────────────────────────────────────────

export async function signUp({ email, password, username, displayName }) {
  const j = await gotrue('signup', {
    body: {
      email, password,
      data: { username, display_name: displayName || username },
    },
  });
  if (j.access_token) {           // email confirmation disabled → signed in now
    setSession(sessionFromTokenResponse(j));
    profile = await ensureProfile().catch(() => null);
    emitAuth();
    return { confirmed: true };
  }
  return { confirmed: false };    // confirmation email sent
}

export async function signIn({ email, password }) {
  const j = await gotrue('token?grant_type=password', { body: { email, password } });
  setSession(sessionFromTokenResponse(j));
  profile = await ensureProfile().catch(() => null);
  emitAuth();
}

export async function signOut({ everywhere = false } = {}) {
  if (session) {
    try { await gotrue(`logout${everywhere ? '?scope=global' : ''}`, { auth: true }); }
    catch { /* local sign-out regardless */ }
  }
  setSession(null);
  profile = null;
  emitAuth();
}

export async function requestPasswordReset(email) {
  const redirect = new URL('account.html', location.href).href;
  await gotrue(`recover?redirect_to=${encodeURIComponent(redirect)}`, { body: { email } });
}

export async function updateEmail(newEmail) {
  const redirect = new URL('account.html', location.href).href;
  return gotrue(`user?redirect_to=${encodeURIComponent(redirect)}`, {
    method: 'PUT', auth: true, body: { email: newEmail },
  });
}

export async function updatePassword(newPassword) {
  const j = await gotrue('user', { method: 'PUT', auth: true, body: { password: newPassword } });
  if (session && j) { session.user = j; saveSession(); }
  recoveryMode = false;
}

export async function deleteAccount() {
  await rpc('delete_account', {});
  setSession(null);
  profile = null;
  emitAuth();
}

// ─── REST core (PostgREST) ──────────────────────────────────────────────────

function restHeaders(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session ? session.access_token : SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function rest(path, { method = 'GET', body, headers = {}, retried = false } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: restHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && session && !retried) {
    await refreshSession();     // throws (→ signed out) if it can't
    return rest(path, { method, body, headers, retried: true });
  }
  if (!res.ok) throw await asApiError(res);
  const total = parseContentRangeTotal(res.headers.get('content-range'));
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (total !== null && Array.isArray(data)) data.total = total;
  return data;
}

function parseContentRangeTotal(cr) {
  const m = cr && cr.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

async function rpc(name, args) {
  return rest(`rpc/${name}`, { method: 'POST', body: args });
}

// Escape a user string for use inside a PostgREST ilike pattern within or=().
function likePattern(q) {
  return '*' + q.replace(/[,()"\\*%]/g, ' ').trim().replace(/\s+/g, '*') + '*';
}

const AUTHOR_EMBED = 'author:profiles!owner(username,display_name,avatar_url)';
const CARD_COLS = `id,title,thumb_url,views,likes,comment_count,visibility,tags,created_at,updated_at,owner,${AUTHOR_EMBED}`;

// ─── profiles ───────────────────────────────────────────────────────────────

async function ensureProfile() {
  const uid = session.user?.id;
  if (!uid) return null;
  const rows = await rest(`profiles?id=eq.${uid}&select=*`);
  if (rows[0]) return rows[0];
  // Account predates the schema (no trigger ran) → self-heal.
  let base = (session.user.email || 'user').split('@')[0]
    .toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  if (base.length < 3) base = `user${uid.replace(/-/g, '').slice(0, 8)}`;
  for (let n = 0; n < 6; n++) {
    const username = n === 0 ? base : `${base.slice(0, 18)}${n}`;
    try {
      const made = await rest('profiles?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: { id: uid, username, display_name: username },
      });
      return made[0];
    } catch (e) {
      if (e.code !== '23505') throw e;   // 23505 = username taken → try next
    }
  }
  return null;
}

export async function getProfileByUsername(username) {
  const rows = await rest(
    `profiles?username=eq.${encodeURIComponent(username)}&select=id,username,display_name,avatar_url,bio,created_at`);
  return rows[0] ?? null;
}

export async function updateProfile(patch) {
  const rows = await rest(`profiles?id=eq.${session.user.id}&select=*`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch,
  });
  profile = rows[0] ?? profile;
  emitAuth();
  return profile;
}

export async function usernameAvailable(username) {
  const rows = await rest(`profiles?username=eq.${encodeURIComponent(username)}&select=id`);
  return rows.length === 0;
}

// ─── particles ──────────────────────────────────────────────────────────────

export async function createParticle({ title, description = '', tags = [], visibility = 'public', data }) {
  const rows = await rest('particles?select=id', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: { title, description, tags, visibility, data },
  });
  return rows[0];
}

export async function updateParticle(id, patch) {
  const rows = await rest(`particles?id=eq.${id}&select=id,updated_at`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch,
  });
  return rows[0] ?? null;
}

export async function deleteParticle(id) {
  await rest(`particles?id=eq.${id}`, { method: 'DELETE' });
}

/** Full particle row incl. data + author. Falls back to the legacy prototype
 *  "effects" table so pre-accounts links keep working. */
export async function getParticle(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const rows = await rest(`particles?id=eq.${id}&select=*,${AUTHOR_EMBED}`);
    if (rows[0]) return rows[0];
  } catch (e) { noteError(e); }
  try {
    const rows = await rest(`effects?id=eq.${id}&select=id,name,author,data,created_at`);
    if (rows[0]) {
      const r = rows[0];
      return {
        legacy: true, id: r.id, title: r.name, description: '', tags: [],
        data: r.data, visibility: 'public', views: 0, likes: 0, comment_count: 0,
        created_at: r.created_at, updated_at: r.created_at, owner: null,
        author: { username: null, display_name: r.author },
      };
    }
  } catch { /* legacy table absent — fine */ }
  return null;
}

/** Just the effect data (for hover-preview). */
export async function getParticleData(id) {
  const rows = await rest(`particles?id=eq.${id}&select=data`);
  return rows[0]?.data ?? null;
}

const SORTS = {
  newest: 'created_at.desc',
  popular: 'views.desc',
  loved: 'likes.desc',
  updated: 'updated_at.desc',
};

/** Browse/search public particles. Returns array with .total set. */
export async function listParticles({ q = '', tag = '', sort = 'newest', page = 0, perPage = 24 } = {}) {
  const p = new URLSearchParams();
  p.set('select', CARD_COLS);
  p.set('visibility', 'eq.public');
  if (q) p.set('or', `(title.ilike.${likePattern(q)},description.ilike.${likePattern(q)})`);
  if (tag) p.set('tags', `cs.{"${tag.replace(/["{},\\]/g, '')}"}`);
  p.set('order', SORTS[sort] || SORTS.newest);
  p.set('limit', String(perPage));
  p.set('offset', String(page * perPage));
  return rest(`particles?${p}`, { headers: { Prefer: 'count=exact' } });
}

/** All particles of one user; includePrivate only works for yourself. */
export async function listByOwner(ownerId, { includePrivate = false } = {}) {
  const vis = includePrivate ? '' : '&visibility=eq.public';
  return rest(`particles?owner=eq.${ownerId}${vis}&select=${CARD_COLS}&order=updated_at.desc&limit=200`,
    { headers: { Prefer: 'count=exact' } });
}

export function bumpViews(id) {
  rpc('bump_views', { pid: id }).catch(() => {});
}

// ─── likes ──────────────────────────────────────────────────────────────────

export async function myLike(particleId) {
  if (!session) return false;
  const rows = await rest(`likes?particle_id=eq.${particleId}&user_id=eq.${session.user.id}&select=particle_id`);
  return rows.length > 0;
}

export async function like(particleId) {
  await rest('likes', { method: 'POST', body: { particle_id: particleId } });
}

export async function unlike(particleId) {
  await rest(`likes?particle_id=eq.${particleId}&user_id=eq.${session.user.id}`, { method: 'DELETE' });
}

// ─── comments ───────────────────────────────────────────────────────────────

export async function listComments(particleId) {
  return rest(`comments?particle_id=eq.${particleId}` +
    `&select=id,body,created_at,user_id,author:profiles!user_id(username,display_name,avatar_url)` +
    `&order=created_at.asc&limit=500`);
}

export async function addComment(particleId, body) {
  const rows = await rest('comments?select=id,body,created_at,user_id', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: { particle_id: particleId, body },
  });
  return rows[0];
}

export async function deleteComment(id) {
  await rest(`comments?id=eq.${id}`, { method: 'DELETE' });
}

// ─── featured / front page ──────────────────────────────────────────────────

export async function getPOTD() {
  try {
    const rows = await rest(
      `featured?kind=eq.potd&select=featured_on,note,particle:particles(*,${AUTHOR_EMBED})` +
      `&order=featured_on.desc&limit=5`);
    const hit = rows.find((r) => r.particle);  // RLS nulls out now-private ones
    if (hit) return { ...hit.particle, potd_on: hit.featured_on, potd_note: hit.note };
  } catch (e) { noteError(e); }
  // fallback: most loved public particle
  const rows = await rest(
    `particles?visibility=eq.public&select=*,${AUTHOR_EMBED}&order=likes.desc,views.desc&limit=1`);
  return rows[0] ?? null;
}

export async function getFeatured(limit = 8) {
  try {
    const rows = await rest(
      `featured?kind=eq.featured&select=featured_on,particle:particles(${CARD_COLS})` +
      `&order=featured_on.desc&limit=${limit}`);
    const out = rows.map((r) => r.particle).filter(Boolean);
    if (out.length) return out;
  } catch (e) { noteError(e); }
  return rest(`particles?visibility=eq.public&select=${CARD_COLS}&order=likes.desc,views.desc&limit=${limit}`);
}

export async function getLatest(limit = 8) {
  return rest(`particles?visibility=eq.public&select=${CARD_COLS}&order=created_at.desc&limit=${limit}`);
}

/** Admin: set curation. kind = 'potd' | 'featured' | null (remove). */
export async function setFeatured(particleId, kind) {
  if (!kind) return rest(`featured?particle_id=eq.${particleId}`, { method: 'DELETE' });
  return rest('featured?on_conflict=particle_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: { particle_id: particleId, kind, featured_on: new Date().toISOString().slice(0, 10) },
  });
}

// ─── notifications ──────────────────────────────────────────────────────────

export async function listNotifications(limit = 20) {
  return rest(`notifications?select=id,kind,read,created_at,particle_id,` +
    `actor_profile:profiles!actor(username,display_name,avatar_url),` +
    `particle:particles(id,title)` +
    `&order=created_at.desc&limit=${limit}`, { headers: { Prefer: 'count=exact' } });
}

export async function unreadCount() {
  if (!session) return 0;
  const rows = await rest(`notifications?read=is.false&select=id&limit=1`,
    { headers: { Prefer: 'count=exact' } });
  return rows.total ?? rows.length;
}

export async function markAllRead() {
  await rest(`notifications?read=is.false`, { method: 'PATCH', body: { read: true } });
}

// ─── storage ────────────────────────────────────────────────────────────────

async function uploadMedia(path, blob, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/media/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': contentType || blob.type || 'image/jpeg',
      'x-upsert': 'true',
    },
    body: blob,
  });
  if (!res.ok) throw await asApiError(res);
  return `${SUPABASE_URL}/storage/v1/object/public/media/${path}?v=${Date.now()}`;
}

export async function uploadAvatar(blob) {
  const url = await uploadMedia(`${session.user.id}/avatar.jpg`, blob);
  return updateProfile({ avatar_url: url });
}

export async function uploadThumb(particleId, blob) {
  const url = await uploadMedia(`${session.user.id}/thumbs/${particleId}.jpg`, blob, 'image/jpeg');
  await updateParticle(particleId, { thumb_url: url });
  return url;
}

/** The short looping clip that link previews embed.
 *  @param clip { blob, type, ext, w, h } from exportmedia.capturePreviewClip */
export async function uploadPreview(particleId, clip) {
  const path = `${session.user.id}/previews/${particleId}.${clip.ext}`;
  const url = await uploadMedia(path, clip.blob, clip.type);
  await updateParticle(particleId, {
    preview_url: url,
    preview_type: clip.type,
    preview_w: clip.w,
    preview_h: clip.h,
  });
  return url;
}

// ─── share links ────────────────────────────────────────────────────────────
// A link crawler (Discord, Slack, Twitter) does not run JavaScript, and this
// site is static: every particle is the same view.html as far as a crawler is
// concerned. So the link people share points at the `og` edge function, which
// renders per-particle Open Graph tags and bounces real browsers on to the
// page. See supabase/functions/og/index.ts.

// Set this if the previews are served from somewhere prettier — a Cloudflare
// Worker or Netlify function on your own domain, say. Anything that answers
// <base>/<particle-id> with Open Graph tags will do.
const SHARE_BASE = '';

/** The link to hand to Discord et al. Falls back to the plain page link when
 *  the backend isn't configured at all. */
export function shareLink(particleId) {
  if (!backendConfigured()) return pageLink(particleId);
  return `${SHARE_BASE || `${SUPABASE_URL}/functions/v1/og`}/${particleId}`;
}

/** The particle's page on this site. */
export function pageLink(particleId) {
  return new URL(`view.html?id=${particleId}`, location.href).href;
}
