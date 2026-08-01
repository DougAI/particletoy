// Account page: my particles (all/public/private subtabs), profile
// (avatar / display name / bio), and settings (email, password,
// notifications, sign-out-everywhere, delete account).
// Also the landing page for password-recovery emails (#reset flow).

import * as api from '../backend.js';
import {
  initSite, esc, el, toast, fmtDate, fmtCount, avatarHTML,
  showAuthDialog, modal, closeModal,
} from '../site.js';

const $ = (id) => document.getElementById(id);
const page = document.getElementById('page');

let tab = location.hash === '#settings' ? 'settings' : 'particles';
let subtab = 'all';
let mine = null;   // cached list of my particles

function requireSignIn() {
  page.innerHTML = `<div class="empty" style="margin-top:50px">
    Sign in to manage your particles and account.<br><br>
    <button class="btn accent" id="acc-signin">Sign in / Create account</button></div>`;
  $('acc-signin').addEventListener('click', async () => {
    if (await showAuthDialog('signin')) boot();
  });
}

function shell() {
  const p = api.currentProfile();
  page.innerHTML = `
    <div class="page-head">
      ${avatarHTML(p, 'lg')}
      <div>
        <h1>${esc(p?.display_name || p?.username || 'account')}</h1>
        <div class="muted">@${esc(p?.username || '?')} · member since ${fmtDate(p?.created_at)}
          · <a href="user.html?u=${encodeURIComponent(p?.username || '')}">public profile ↗</a></div>
      </div>
    </div>
    <div class="tabs">
      <button class="tab ${tab === 'particles' ? 'active' : ''}" data-tab="particles">My particles</button>
      <button class="tab ${tab === 'profile' ? 'active' : ''}" data-tab="profile">Profile</button>
      <button class="tab ${tab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
    </div>
    <div id="tab-body"></div>`;
  page.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      history.replaceState(null, '', tab === 'settings' ? '#settings' : location.pathname);
      shell();
    }));
  ({ particles: renderParticles, profile: renderProfile, settings: renderSettings }[tab])();
}

// ─── my particles ───────────────────────────────────────────────────────────

async function renderParticles() {
  const body = $('tab-body');
  body.innerHTML = '<div class="spinner">Loading…</div>';
  if (!mine) {
    try {
      mine = await api.listByOwner(api.currentUser().id, { includePrivate: true });
    } catch {
      body.innerHTML = '<div class="empty">Could not load — is the backend set up?</div>';
      return;
    }
  }
  const pub = mine.filter((p) => p.visibility === 'public');
  const priv = mine.filter((p) => p.visibility === 'private');
  const shown = subtab === 'public' ? pub : subtab === 'private' ? priv : mine;

  body.innerHTML = `
    <div class="subtabs">
      <button class="btn small ${subtab === 'all' ? 'blue' : ''}" data-st="all">All (${mine.length})</button>
      <button class="btn small ${subtab === 'public' ? 'blue' : ''}" data-st="public">Public (${pub.length})</button>
      <button class="btn small ${subtab === 'private' ? 'blue' : ''}" data-st="private">Private (${priv.length})</button>
      <span style="flex:1"></span>
      <a class="btn small accent" href="editor.html">+ New particle</a>
    </div>
    <div id="mine-list"></div>`;
  body.querySelectorAll('[data-st]').forEach((b) =>
    b.addEventListener('click', () => { subtab = b.dataset.st; renderParticles(); }));

  const list = $('mine-list');
  if (!shown.length) {
    list.innerHTML = `<div class="empty">Nothing here yet — <a href="editor.html">make something sparkly</a>.</div>`;
    return;
  }
  for (const p of shown) {
    const node = el(`<div class="mine-row">
      <a class="mini" href="view.html?id=${p.id}"
         style="${p.thumb_url ? `background-image:url('${esc(p.thumb_url)}')` : ''}"></a>
      <div class="t">
        <div class="name"><a href="view.html?id=${p.id}" style="color:inherit">${esc(p.title)}</a>
          ${p.visibility === 'private' ? '<span class="vis-badge" style="position:static;margin-left:6px">private</span>' : ''}</div>
        <div class="sub">♥ ${fmtCount(p.likes)} · 👁 ${fmtCount(p.views)} · 💬 ${fmtCount(p.comment_count)}
          · created ${fmtDate(p.created_at)} · edited ${fmtDate(p.updated_at)}</div>
      </div>
      <div class="actions">
        <a class="btn small" href="editor.html?id=${p.id}">Edit</a>
        <button class="btn small" data-act="vis">${p.visibility === 'public' ? 'Make private' : 'Make public'}</button>
        <button class="btn small danger" data-act="del">Delete</button>
      </div></div>`);
    node.querySelector('[data-act="vis"]').addEventListener('click', async (e) => {
      const to = p.visibility === 'public' ? 'private' : 'public';
      try {
        await api.updateParticle(p.id, { visibility: to });
        p.visibility = to;
        renderParticles();
        toast(to === 'public' ? 'Now public' : 'Now private');
      } catch (ex) { toast(`Failed: ${ex.message}`); }
    });
    node.querySelector('[data-act="del"]').addEventListener('click', () => {
      const div = el(`<div><p>Delete “<b>${esc(p.title)}</b>” forever?</p>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn danger" id="dy">Delete forever</button>
          <button class="btn" id="dn">Cancel</button></div></div>`);
      modal('Delete particle', div);
      div.querySelector('#dn').addEventListener('click', closeModal);
      div.querySelector('#dy').addEventListener('click', async () => {
        try {
          await api.deleteParticle(p.id);
          mine = mine.filter((x) => x.id !== p.id);
          closeModal();
          renderParticles();
          toast('Deleted');
        } catch (ex) { toast(`Failed: ${ex.message}`); }
      });
    });
    list.appendChild(node);
  }
}

// ─── profile tab ────────────────────────────────────────────────────────────

function renderProfile() {
  const p = api.currentProfile();
  const body = $('tab-body');
  body.innerHTML = `
    <div class="panel">
      <h3>Profile picture</h3>
      <div style="display:flex;align-items:center;gap:16px">
        <span id="av-preview">${avatarHTML(p, 'lg')}</span>
        <div>
          <input type="file" id="av-file" accept="image/*" class="hidden">
          <button class="btn" id="av-pick">Upload image…</button>
          <div class="hint muted small" style="margin-top:6px">Square works best — auto-resized to 256×256 JPEG.</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <h3>About you</h3>
      <div class="field"><label>Username (permanent — used in your page URL)</label>
        <input type="text" value="${esc(p?.username || '')}" disabled></div>
      <div class="field"><label>Display name</label>
        <input type="text" id="pf-name" maxlength="40" value="${esc(p?.display_name || '')}"></div>
      <div class="field"><label>Bio</label>
        <textarea id="pf-bio" maxlength="500">${esc(p?.bio || '')}</textarea></div>
      <div class="form-error" id="pf-err"></div>
      <button class="btn accent" id="pf-save">Save profile</button>
    </div>`;

  $('av-pick').addEventListener('click', () => $('av-file').click());
  $('av-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const blob = await resizeImage(f, 256);
      await api.uploadAvatar(blob);
      $('av-preview').innerHTML = avatarHTML(api.currentProfile(), 'lg');
      toast('Avatar updated');
    } catch (ex) { toast(`Upload failed: ${ex.message}`); }
  });

  $('pf-save').addEventListener('click', async () => {
    try {
      await api.updateProfile({
        display_name: $('pf-name').value.trim().slice(0, 40),
        bio: $('pf-bio').value.slice(0, 500),
      });
      toast('Profile saved');
      shell();
    } catch (ex) { $('pf-err').textContent = ex.message; }
  });
}

function resizeImage(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.max(size / img.width, size / img.height);
      ctx.drawImage(img, (size - img.width * s) / 2, (size - img.height * s) / 2,
        img.width * s, img.height * s);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.88);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('not an image'));
    img.src = URL.createObjectURL(file);
  });
}

// ─── settings tab ───────────────────────────────────────────────────────────

function renderSettings() {
  const p = api.currentProfile();
  const user = api.currentUser();
  const body = $('tab-body');
  body.innerHTML = `
    ${api.isRecoveryMode() ? `
    <div class="panel" style="border-color:var(--accent)">
      <h3>🔑 Set a new password</h3>
      <p class="muted small" style="margin-bottom:10px">You arrived from a password-reset email — choose a new password now.</p>
    </div>` : ''}

    <div class="panel">
      <h3>Change password</h3>
      <div class="field"><label>New password (min 6 characters)</label>
        <input type="password" id="st-pass" autocomplete="new-password"></div>
      <div class="form-error" id="st-pass-err"></div>
      <button class="btn accent" id="st-pass-save">Update password</button>
    </div>

    <div class="panel">
      <h3>Change email</h3>
      <div class="field"><label>Current email</label>
        <input type="email" value="${esc(user?.email || '')}" disabled></div>
      <div class="field"><label>New email</label>
        <input type="email" id="st-email"></div>
      <div class="form-error" id="st-email-err"></div>
      <button class="btn accent" id="st-email-save">Send confirmation</button>
      <div class="hint muted small" style="margin-top:8px">You'll get a confirmation link at the new address.</div>
    </div>

    <div class="panel">
      <h3>Notifications</h3>
      <label class="check-row"><input type="checkbox" id="st-nc" ${p?.notify_comments ? 'checked' : ''}>
        Notify me when someone comments on my particles</label>
      <label class="check-row"><input type="checkbox" id="st-nl" ${p?.notify_likes ? 'checked' : ''}>
        Notify me when someone likes my particles</label>
    </div>

    <div class="panel">
      <h3>Sessions</h3>
      <button class="btn" id="st-signout-all">Sign out on all devices</button>
    </div>

    <div class="panel" style="border-color:rgba(224,82,82,.4)">
      <h3 style="color:var(--danger)">Danger zone</h3>
      <p class="muted small" style="margin-bottom:10px">Deletes your account, all your particles, likes and comments. There is no undo.</p>
      <button class="btn danger" id="st-delete">Delete my account…</button>
    </div>`;

  $('st-pass-save').addEventListener('click', async () => {
    const v = $('st-pass').value;
    if (v.length < 6) { $('st-pass-err').textContent = 'At least 6 characters.'; return; }
    try {
      await api.updatePassword(v);
      $('st-pass').value = '';
      $('st-pass-err').textContent = '';
      toast('Password updated');
      if (api.isRecoveryMode()) api.clearRecoveryMode();
      renderSettings();
    } catch (ex) { $('st-pass-err').textContent = ex.message; }
  });

  $('st-email-save').addEventListener('click', async () => {
    const v = $('st-email').value.trim();
    if (!v) return;
    try {
      await api.updateEmail(v);
      $('st-email-err').textContent = '';
      toast('Confirmation sent — check the new inbox');
    } catch (ex) { $('st-email-err').textContent = ex.message; }
  });

  const saveNotify = async () => {
    try {
      await api.updateProfile({
        notify_comments: $('st-nc').checked,
        notify_likes: $('st-nl').checked,
      });
      toast('Notification settings saved');
    } catch (ex) { toast(`Failed: ${ex.message}`); }
  };
  $('st-nc').addEventListener('change', saveNotify);
  $('st-nl').addEventListener('change', saveNotify);

  $('st-signout-all').addEventListener('click', async () => {
    await api.signOut({ everywhere: true });
    location.href = 'index.html';
  });

  $('st-delete').addEventListener('click', () => {
    const div = el(`<div>
      <p>This permanently deletes <b>@${esc(p?.username)}</b> and every particle,
      like and comment attached to it.</p>
      <div class="field" style="margin-top:12px"><label>Type your username to confirm</label>
        <input type="text" id="del-confirm"></div>
      <div style="display:flex;gap:10px">
        <button class="btn danger" id="del-go" disabled>Delete everything</button>
        <button class="btn" id="del-cancel">Cancel</button>
      </div></div>`);
    modal('Delete account', div);
    const go = div.querySelector('#del-go');
    div.querySelector('#del-confirm').addEventListener('input', (e) => {
      go.disabled = e.target.value !== p?.username;
    });
    div.querySelector('#del-cancel').addEventListener('click', closeModal);
    go.addEventListener('click', async () => {
      try {
        await api.deleteAccount();
        location.href = 'index.html';
      } catch (ex) { toast(`Failed: ${ex.message}`); }
    });
  });
}

// ─── boot ───────────────────────────────────────────────────────────────────

async function boot() {
  const { user } = await initSite();
  if (!user) return requireSignIn();
  if (api.isRecoveryMode()) tab = 'settings';
  shell();
}
boot();
