// Shared site chrome: header (search / browse / new / notifications / user
// menu), sign-in + sign-up modals, toasts, particle cards with live
// hover-preview, and small formatting helpers. Used by every site page;
// the editor imports only the auth pieces.

import * as api from './backend.js';
import { EffectPlayer } from './player.js';

// ─── support links (shown on the front page — put your real URLs here) ──────
export const LINKS = {
  paypal: 'https://www.paypal.com/donate/?hosted_button_id=YOUR_BUTTON_ID',
  patreon: 'https://www.patreon.com/YOUR_PAGE',
  github: 'https://github.com/DougAI/particletoy',
};

/** A link still holding its YOUR_… placeholder is treated as unconfigured, and
 *  the UI hides it rather than shipping a button that 404s. */
export function linkReady(url) {
  return Boolean(url) && !url.includes('YOUR_');
}
// ────────────────────────────────────────────────────────────────────────────

// ─── tiny DOM helpers ───────────────────────────────────────────────────────

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'],
                 [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [sec, name] of units) {
    if (s >= sec) {
      const n = Math.floor(s / sec);
      return `${n} ${name}${n > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}

export function fmtCount(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function authorName(p) {
  const a = p?.author;
  return a?.display_name || a?.username || 'anonymous';
}

export function avatarHTML(prof, cls = '') {
  const url = prof?.avatar_url;
  return url
    ? `<span class="avatar ${cls}" style="background-image:url('${esc(url)}')"></span>`
    : `<span class="avatar ${cls}">✦</span>`;
}

// ─── toast + modal ──────────────────────────────────────────────────────────

let toastTimer = 0;
export function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('<div id="toast"></div>');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

export function modal(title, contentNode, { wide = false } = {}) {
  closeModal();
  const overlay = el(`<div class="modal-overlay">
    <div class="modal${wide ? ' wide' : ''}">
      <div class="modal-head"><h2>${esc(title)}</h2>
        <button class="modal-close" aria-label="Close">✕</button></div>
      <div class="modal-body"></div>
    </div></div>`);
  const body = overlay.querySelector('.modal-body');
  if (typeof contentNode === 'string') body.innerHTML = contentNode;
  else body.appendChild(contentNode);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  document.body.appendChild(overlay);
  return { overlay, body, close: closeModal };
}

export function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
}

// ─── auth dialogs ───────────────────────────────────────────────────────────

/** Opens the sign-in / sign-up dialog. Resolves true once signed in. */
export function showAuthDialog(mode = 'signin') {
  return new Promise((resolve) => {
    const div = el('<div></div>');
    const m = modal(mode === 'signup' ? 'Create account' : 'Sign in', div);
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    m.overlay.addEventListener('pointerdown', (e) => { if (e.target === m.overlay) done(false); });
    m.overlay.querySelector('.modal-close').addEventListener('click', () => done(false));

    const render = () => {
      m.overlay.querySelector('.modal-head h2').textContent =
        mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Reset password' : 'Sign in';
      div.innerHTML = `
        <div class="modal-tabs">
          <button class="btn small ${mode === 'signin' ? 'blue' : ''}" data-m="signin">Sign in</button>
          <button class="btn small ${mode === 'signup' ? 'blue' : ''}" data-m="signup">Create account</button>
        </div>
        <form id="auth-form">
          ${mode === 'signup' ? `
          <div class="field"><label>Username</label>
            <input type="text" id="au" required minlength="3" maxlength="20"
                   pattern="[a-zA-Z0-9_]+" autocomplete="username">
            <div class="hint">3–20 chars: letters, numbers, underscore. Public, permanent.</div></div>` : ''}
          <div class="field"><label>Email</label>
            <input type="email" id="ae" required autocomplete="email"></div>
          ${mode !== 'forgot' ? `
          <div class="field"><label>Password</label>
            <input type="password" id="ap" required minlength="6"
                   autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></div>` : ''}
          <div class="form-error" id="aerr"></div>
          <button class="btn accent" type="submit" id="asub" style="width:100%">
            ${mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset email' : 'Sign in'}</button>
        </form>
        ${mode === 'signin' ? '<p class="small" style="margin-top:10px"><a href="#" id="aforgot">Forgot your password?</a></p>' : ''}`;

      div.querySelectorAll('[data-m]').forEach((b) =>
        b.addEventListener('click', () => { mode = b.dataset.m; render(); }));
      div.querySelector('#aforgot')?.addEventListener('click', (e) => {
        e.preventDefault(); mode = 'forgot'; render();
      });

      div.querySelector('#auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = div.querySelector('#aerr');
        const sub = div.querySelector('#asub');
        err.textContent = '';
        sub.disabled = true;
        try {
          const email = div.querySelector('#ae').value.trim();
          if (mode === 'forgot') {
            await api.requestPasswordReset(email);
            err.textContent = '';
            div.innerHTML = '<p class="form-ok">If that address has an account, a reset link is on its way. Check your inbox.</p>';
            return;
          }
          const password = div.querySelector('#ap').value;
          if (mode === 'signup') {
            const username = div.querySelector('#au').value.trim().toLowerCase();
            if (!(await api.usernameAvailable(username))) throw new Error('That username is taken.');
            const r = await api.signUp({ email, password, username });
            if (!r.confirmed) {
              div.innerHTML = '<p class="form-ok">Almost there — we sent a confirmation link to your email. Click it, then sign in.</p>';
              return;
            }
          } else {
            await api.signIn({ email, password });
          }
          closeModal();
          done(true);
        } catch (ex) {
          err.textContent = ex.message === 'Invalid login credentials'
            ? 'Wrong email or password.' : ex.message;
        } finally {
          sub.disabled = false;
        }
      });
    };
    render();
  });
}

/** Resolves true if signed in (prompting if needed). */
export async function ensureSignedIn() {
  if (api.currentUser()) return true;
  return showAuthDialog('signin');
}

// ─── header ─────────────────────────────────────────────────────────────────

function closeDropdowns(except) {
  document.querySelectorAll('.dropdown').forEach((d) => { if (d !== except) d.remove(); });
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.dropdown') && !e.target.closest('[data-drop]')) closeDropdowns();
});

function renderHeader() {
  const host = document.getElementById('site-header');
  if (!host) return;
  const user = api.currentUser();
  const prof = api.currentProfile();
  const q = new URLSearchParams(location.search).get('q') || '';

  host.innerHTML = `
    <div class="hdr-inner">
      <a class="brand" href="index.html">particle<b>toy</b></a>
      <form class="hdr-search" id="hdr-search">
        <span class="mag">⌕</span>
        <input type="search" name="q" placeholder="Search particles…" value="${esc(q)}">
      </form>
      <nav class="hdr-links">
        <a class="hdr-link" href="browse.html">Browse</a>
        <a class="hdr-link primary" href="editor.html">+ New</a>
        ${user ? `
          <button class="hdr-link bell" id="hdr-bell" data-drop title="Notifications">🔔<span class="bell-badge hidden" id="bell-badge"></span></button>
          <div class="user-menu">
            <button class="user-btn" id="hdr-user" data-drop>
              ${avatarHTML(prof)}<span>${esc(prof?.display_name || prof?.username || 'account')}</span> ▾
            </button>
          </div>`
        : `<button class="hdr-link" id="hdr-signin">Sign in</button>`}
      </nav>
    </div>`;

  host.querySelector('#hdr-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.q.value.trim();
    location.href = `browse.html${v ? `?q=${encodeURIComponent(v)}` : ''}`;
  });

  host.querySelector('#hdr-signin')?.addEventListener('click', () => showAuthDialog('signin'));

  host.querySelector('#hdr-user')?.addEventListener('click', (e) => {
    const menu = e.currentTarget.parentElement;
    if (menu.querySelector('.dropdown')) { closeDropdowns(); return; }
    closeDropdowns();
    const d = el(`<div class="dropdown">
      <a href="user.html?u=${encodeURIComponent(prof?.username || '')}">My page</a>
      <a href="account.html">My particles</a>
      <a href="account.html#settings">Account settings</a>
      <div class="sep"></div>
      <button id="dd-signout">Sign out</button>
    </div>`);
    d.querySelector('#dd-signout').addEventListener('click', async () => {
      await api.signOut();
      toast('Signed out');
    });
    menu.appendChild(d);
  });

  host.querySelector('#hdr-bell')?.addEventListener('click', async (e) => {
    const bellBtn = e.currentTarget;
    if (document.querySelector('.notif-panel')) { closeDropdowns(); return; }
    closeDropdowns();
    const d = el(`<div class="dropdown notif-panel">
      <div class="notif-head"><b class="small">Notifications</b>
        <button class="btn small" id="nf-read">Mark all read</button></div>
      <div id="nf-list" class="small muted" style="padding:10px">Loading…</div>
    </div>`);
    bellBtn.parentElement.style.position = 'relative';
    bellBtn.parentElement.appendChild(d);
    d.querySelector('#nf-read').addEventListener('click', async () => {
      await api.markAllRead().catch(() => {});
      refreshBell();
      d.querySelectorAll('.notif-row').forEach((r) => r.classList.remove('unread'));
    });
    try {
      const rows = await api.listNotifications();
      const list = d.querySelector('#nf-list');
      list.style.padding = '0';
      list.classList.remove('muted');
      if (!rows.length) { list.innerHTML = '<div style="padding:12px" class="muted">Nothing yet.</div>'; return; }
      list.innerHTML = rows.map((n) => `
        <a class="notif-row ${n.read ? '' : 'unread'}" href="view.html?id=${n.particle_id}">
          ${avatarHTML(n.actor_profile)}
          <span><b>${esc(n.actor_profile?.display_name || n.actor_profile?.username || 'someone')}</b>
            ${n.kind === 'like' ? 'liked' : 'commented on'}
            <b>${esc(n.particle?.title || 'your particle')}</b><br>
            <span class="when">${timeAgo(n.created_at)}</span></span>
        </a>`).join('');
    } catch {
      d.querySelector('#nf-list').textContent = 'Could not load notifications.';
    }
  });

  refreshBell();
}

async function refreshBell() {
  const badge = document.getElementById('bell-badge');
  if (!badge || !api.currentUser()) return;
  try {
    const n = await api.unreadCount();
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.toggle('hidden', n === 0);
  } catch { /* schema missing / offline */ }
}

// ─── setup banner ───────────────────────────────────────────────────────────

function showSetupBanner() {
  if (document.querySelector('.setup-banner')) return;
  const b = el(`<div class="setup-banner">⚠ The community backend isn't set up yet —
    run <b>supabase/schema.sql</b> once in your Supabase SQL editor.
    <a href="setup.html#backend">Setup guide ↗</a></div>`);
  const hdr = document.getElementById('site-header');
  if (hdr) hdr.after(b); else document.body.prepend(b);
}
window.addEventListener('pt:schema-missing', showSetupBanner);

// ─── particle cards + live hover preview ────────────────────────────────────

export function cardHTML(p, { showVisibility = false } = {}) {
  const badge = showVisibility && p.visibility === 'private'
    ? '<span class="vis-badge">private</span>' : '';
  return `
  <a class="card" href="view.html?id=${p.id}" data-card-id="${p.id}">
    <div class="thumb">
      ${p.thumb_url ? `<img loading="lazy" src="${esc(p.thumb_url)}" alt="">`
                    : '<div class="ph">✨</div>'}
      ${badge}
    </div>
    <div class="card-info">
      <div class="card-title">${esc(p.title)}</div>
      <div class="card-meta">
        <span class="by">by ${esc(authorName(p))}</span>
        <span title="likes">♥ ${fmtCount(p.likes)}</span>
        <span title="views">👁 ${fmtCount(p.views)}</span>
      </div>
    </div>
  </a>`;
}

export function renderCards(container, rows, opts) {
  container.innerHTML = rows.map((p) => cardHTML(p, opts)).join('');
  attachHoverPreviews(container);
}

// One roaming EffectPlayer shared by every card on the page: on hover the
// canvas is positioned over the card's thumbnail and plays the real effect.
let hoverPlayer = null;
let hoverToken = 0;
const dataCache = new Map();

function getHoverPlayer() {
  if (hoverPlayer && hoverPlayer.ok) return hoverPlayer;
  let cv = document.getElementById('hover-preview');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'hover-preview';
    document.body.appendChild(cv);
  }
  hoverPlayer = new EffectPlayer(cv, { interactive: false, maxDpr: 1 });
  return hoverPlayer.ok ? hoverPlayer : null;
}

export function attachHoverPreviews(container) {
  container.querySelectorAll('[data-card-id]').forEach((card) => {
    const thumb = card.querySelector('.thumb');
    if (!thumb) return;
    let timer = 0;
    card.addEventListener('mouseenter', () => {
      timer = setTimeout(() => startHover(card, thumb), 180);
    });
    card.addEventListener('mouseleave', () => {
      clearTimeout(timer);
      stopHover();
    });
  });
}

async function startHover(card, thumb) {
  const id = card.dataset.cardId;
  const token = ++hoverToken;
  let data = dataCache.get(id);
  if (data === undefined) {
    try { data = await api.getParticleData(id); } catch { data = null; }
    dataCache.set(id, data);
  }
  if (!data || token !== hoverToken || !card.matches(':hover')) return;
  const player = getHoverPlayer();
  if (!player) return;
  const cv = player.canvas;
  const r = thumb.getBoundingClientRect();
  cv.style.display = 'block';
  cv.style.left = `${r.left + scrollX}px`;
  cv.style.top = `${r.top + scrollY}px`;
  cv.style.width = `${r.width}px`;
  cv.style.height = `${r.height}px`;
  player.load(data);
  player.start();
}

function stopHover() {
  hoverToken++;
  if (hoverPlayer) {
    hoverPlayer.stop();
    hoverPlayer.canvas.style.display = 'none';
  }
}

// ─── footer ─────────────────────────────────────────────────────────────────

function renderFooter() {
  const f = document.querySelector('footer.site-footer .wrap');
  if (!f) return;
  f.innerHTML = `
    <span>particle<b style="color:var(--accent)">toy</b> — build, explore &amp; share particle effects</span>
    <a href="setup.html">self-hosting guide</a>
    <a href="dmca.html">copyright</a>
    ${linkReady(LINKS.github) ? `<a href="${esc(LINKS.github)}">source</a>` : ''}
    <span style="flex:1"></span>
    ${linkReady(LINKS.paypal) ? `<a href="${esc(LINKS.paypal)}">donate</a>` : ''}
    ${linkReady(LINKS.patreon) ? `<a href="${esc(LINKS.patreon)}">patreon</a>` : ''}`;
}

// ─── page bootstrap ─────────────────────────────────────────────────────────

/** Call at the top of every site page. Initializes auth, renders chrome.
 *  Returns after the session is restored (so pages can rely on currentUser). */
export async function initSite({ header = true } = {}) {
  await api.initBackend();
  if (header) {
    renderHeader();
    renderFooter();
    window.addEventListener('pt:auth', renderHeader);
  }
  return { user: api.currentUser(), profile: api.currentProfile() };
}
