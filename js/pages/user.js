// Public user profile: avatar, display name, bio, and their public particles.

import * as api from '../backend.js';
import { initSite, renderCards, esc, fmtDate, avatarHTML } from '../site.js';

const page = document.getElementById('page');
const username = (new URLSearchParams(location.search).get('u') || '').toLowerCase();

(async function boot() {
  await initSite();
  if (!username) {
    page.innerHTML = '<div class="empty" style="margin-top:40px">No user specified.</div>';
    return;
  }
  const prof = await api.getProfileByUsername(username).catch(() => null);
  if (!prof) {
    page.innerHTML = `<div class="empty" style="margin-top:40px">
      No user called “${esc(username)}”.<br><br><a class="btn" href="browse.html">Browse the gallery</a></div>`;
    return;
  }

  const me = api.currentUser();
  document.title = `${prof.display_name || prof.username} — particletoy`;
  page.innerHTML = `
    <div class="page-head">
      ${avatarHTML(prof, 'lg')}
      <div>
        <h1>${esc(prof.display_name || prof.username)}</h1>
        <div class="muted">@${esc(prof.username)} · member since ${fmtDate(prof.created_at)}
          ${me?.id === prof.id ? '· <a href="account.html">manage your account ↗</a>' : ''}</div>
        ${prof.bio ? `<p style="margin-top:8px;max-width:640px;white-space:pre-wrap">${esc(prof.bio)}</p>` : ''}
      </div>
    </div>
    <div class="section-head"><h2>Particles</h2><span class="muted small" id="count"></span></div>
    <div class="grid" id="grid"><div class="spinner">Loading…</div></div>`;

  try {
    const rows = await api.listByOwner(prof.id);
    document.getElementById('count').textContent =
      `${rows.length} public particle${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      document.getElementById('grid').innerHTML =
        '<div class="empty" style="grid-column:1/-1">No public particles yet.</div>';
    } else {
      renderCards(document.getElementById('grid'), rows);
    }
  } catch {
    document.getElementById('grid').innerHTML =
      '<div class="empty" style="grid-column:1/-1">Could not load particles.</div>';
  }
})();
