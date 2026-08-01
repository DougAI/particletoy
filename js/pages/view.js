// Project page: live player, metadata, like button, owner controls
// (visibility / edit / delete), admin curation, and the comment section.

import * as api from '../backend.js';
import {
  initSite, esc, el, toast, fmtDate, timeAgo, fmtCount, authorName,
  avatarHTML, ensureSignedIn, modal, closeModal,
} from '../site.js';
import { EffectPlayer } from '../player.js';

const $ = (id) => document.getElementById(id);
const page = document.getElementById('page');
const id = new URLSearchParams(location.search).get('id');

let row = null;
let player = null;
let liked = false;

function notFound() {
  page.innerHTML = `<div class="empty" style="margin-top:40px">
    This particle doesn't exist, or it's private.<br><br>
    <a class="btn" href="browse.html">Browse the gallery</a></div>`;
}

function render() {
  const user = api.currentUser();
  const profile = api.currentProfile();
  const isOwner = user && row.owner === user.id;
  const isAdmin = Boolean(profile?.is_admin);
  const authorUrl = row.author?.username
    ? `user.html?u=${encodeURIComponent(row.author.username)}` : null;
  const edited = new Date(row.updated_at) - new Date(row.created_at) > 60000;

  document.title = `${row.title} — particletoy`;
  page.innerHTML = `
    <div class="player-frame" id="player-frame"></div>
    <div class="player-bar">
      <button class="btn small" id="pl-toggle" title="Play/Pause">⏸</button>
      <button class="btn small" id="pl-restart" title="Restart">⟲</button>
      <span id="pl-stats"></span>
      <span style="flex:1"></span>
      <span class="muted small">drag to orbit · wheel to zoom</span>
    </div>

    <div class="view-title-row">
      <h1>${esc(row.title)}</h1>
      <button class="btn ${liked ? 'liked' : ''}" id="btn-like" title="${liked ? 'Unlike' : 'Like'}">
        ♥ <span id="like-count">${fmtCount(row.likes)}</span></button>
      <a class="btn" href="editor.html?id=${row.id}" title="Open in the editor — publish your changes as your own remix">
        ${isOwner ? '✎ Edit' : '⑂ Open in editor'}</a>
      ${isAdmin ? `
        <button class="btn small" id="btn-feat" title="Toggle featured">★ Feature</button>
        <button class="btn small" id="btn-potd" title="Make particle of the day">☀ POTD</button>` : ''}
    </div>

    <div class="view-meta">
      by ${authorUrl ? `<a href="${authorUrl}">${esc(authorName(row))}</a>` : esc(authorName(row))}
      · created ${fmtDate(row.created_at)}
      ${edited ? `· edited ${timeAgo(row.updated_at)}` : ''}
      · 👁 ${fmtCount(row.views)} views
      · 💬 ${fmtCount(row.comment_count)}
    </div>

    ${isOwner ? `
    <div class="owner-box">
      <b>Your particle</b>
      <label class="muted">Visibility:</label>
      <select id="vis-select" class="btn small">
        <option value="public" ${row.visibility === 'public' ? 'selected' : ''}>Public</option>
        <option value="private" ${row.visibility === 'private' ? 'selected' : ''}>Private (only you)</option>
      </select>
      <span style="flex:1"></span>
      <button class="btn small danger" id="btn-delete">Delete…</button>
    </div>` : ''}

    ${row.description ? `<div class="view-desc">${esc(row.description)}</div>` : ''}

    ${row.tags?.length ? `<div class="tag-row">${row.tags.map((t) =>
      `<span class="tag-chip"><a href="browse.html?tag=${encodeURIComponent(t)}">#${esc(t)}</a></span>`).join('')}</div>` : ''}

    <section class="comments">
      <h2>Comments (<span id="cm-count">${row.comment_count || 0}</span>)</h2>
      <div class="comment-form">
        ${avatarHTML(profile)}
        <textarea id="cm-body" class="field" style="flex:1;min-height:64px" maxlength="1000"
          placeholder="${user ? 'Leave a comment…' : 'Sign in to comment…'}"></textarea>
        <button class="btn accent" id="cm-post" style="align-self:flex-end">Post</button>
      </div>
      <div id="cm-list"><div class="spinner">Loading comments…</div></div>
    </section>`;

  mountPlayer();
  wireActions(isOwner, isAdmin);
  loadComments();
}

function mountPlayer() {
  const frame = $('player-frame');
  const canvas = document.createElement('canvas');
  frame.appendChild(canvas);
  player = new EffectPlayer(canvas, { interactive: true, maxDpr: 1.75 });
  if (!player.ok) {
    frame.innerHTML = `<div class="empty" style="border:none">${esc(player.error || 'WebGL2 unavailable')}</div>`;
    return;
  }
  player.load(row.data);
  player.start();

  let particles = 0;
  setInterval(() => {
    if (!player.playing) return;
    particles = 0;
    for (const em of player.emitters) particles += em.count;
    $('pl-stats').textContent = `${particles.toLocaleString()} particles`;
  }, 500);

  $('pl-toggle').addEventListener('click', () => {
    if (player.playing) { player.stop(); $('pl-toggle').textContent = '⏵'; }
    else { player.start(); $('pl-toggle').textContent = '⏸'; }
  });
  $('pl-restart').addEventListener('click', () => {
    player.load(row.data);
    if (!player.playing) player.start();
    $('pl-toggle').textContent = '⏸';
  });
}

function wireActions(isOwner, isAdmin) {
  $('btn-like').addEventListener('click', async () => {
    if (row.legacy) return toast('Legacy effect — likes unavailable');
    if (!(await ensureSignedIn())) return;
    try {
      if (liked) {
        await api.unlike(row.id);
        row.likes = Math.max(0, row.likes - 1);
      } else {
        await api.like(row.id);
        row.likes += 1;
      }
      liked = !liked;
      $('btn-like').classList.toggle('liked', liked);
      $('like-count').textContent = fmtCount(row.likes);
    } catch (e) { toast(`Failed: ${e.message}`); }
  });

  $('vis-select')?.addEventListener('change', async (e) => {
    try {
      await api.updateParticle(row.id, { visibility: e.target.value });
      row.visibility = e.target.value;
      toast(e.target.value === 'public' ? 'Now public' : 'Now private — only you can see it');
    } catch (ex) { toast(`Failed: ${ex.message}`); }
  });

  $('btn-delete')?.addEventListener('click', () => {
    const div = el(`<div>
      <p>Delete “<b>${esc(row.title)}</b>” forever? Likes and comments go with it.</p>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn danger" id="del-yes">Delete forever</button>
        <button class="btn" id="del-no">Cancel</button>
      </div></div>`);
    modal('Delete particle', div);
    div.querySelector('#del-no').addEventListener('click', closeModal);
    div.querySelector('#del-yes').addEventListener('click', async () => {
      try {
        await api.deleteParticle(row.id);
        location.href = 'account.html';
      } catch (e) { toast(`Failed: ${e.message}`); }
    });
  });

  if (isAdmin) {
    $('btn-feat').addEventListener('click', async () => {
      try { await api.setFeatured(row.id, 'featured'); toast('★ Featured on the front page'); }
      catch (e) { toast(`Failed: ${e.message}`); }
    });
    $('btn-potd').addEventListener('click', async () => {
      try { await api.setFeatured(row.id, 'potd'); toast('☀ This is now the particle of the day'); }
      catch (e) { toast(`Failed: ${e.message}`); }
    });
  }

  $('cm-post').addEventListener('click', postComment);
  $('cm-body').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postComment();
  });
}

async function postComment() {
  if (row.legacy) return toast('Legacy effect — comments unavailable');
  const body = $('cm-body').value.trim();
  if (!body) return;
  if (!(await ensureSignedIn())) return;
  $('cm-post').disabled = true;
  try {
    await api.addComment(row.id, body);
    $('cm-body').value = '';
    row.comment_count += 1;
    $('cm-count').textContent = row.comment_count;
    await loadComments();
  } catch (e) {
    toast(`Failed: ${e.message}`);
  } finally {
    $('cm-post').disabled = false;
  }
}

async function loadComments() {
  const list = $('cm-list');
  if (row.legacy) { list.innerHTML = ''; return; }
  const user = api.currentUser();
  try {
    const rows = await api.listComments(row.id);
    if (!rows.length) {
      list.innerHTML = '<p class="muted" style="padding:14px 0">No comments yet — say something nice.</p>';
      return;
    }
    list.innerHTML = '';
    for (const c of rows) {
      const canDelete = user && (c.user_id === user.id || row.owner === user.id);
      const url = c.author?.username ? `user.html?u=${encodeURIComponent(c.author.username)}` : '#';
      const node = el(`<div class="comment">
        ${avatarHTML(c.author)}
        <div class="body">
          <div class="head">
            <a href="${url}">${esc(c.author?.display_name || c.author?.username || 'user')}</a>
            <span class="when">${timeAgo(c.created_at)}</span>
            ${canDelete ? '<button class="btn small del">✕</button>' : ''}
          </div>
          <p>${esc(c.body)}</p>
        </div></div>`);
      node.querySelector('.del')?.addEventListener('click', async () => {
        try {
          await api.deleteComment(c.id);
          row.comment_count = Math.max(0, row.comment_count - 1);
          $('cm-count').textContent = row.comment_count;
          loadComments();
        } catch (e) { toast(`Failed: ${e.message}`); }
      });
      list.appendChild(node);
    }
  } catch {
    list.innerHTML = '<p class="muted">Could not load comments.</p>';
  }
}

(async function boot() {
  await initSite();
  if (!id) return notFound();
  row = await api.getParticle(id).catch(() => null);
  if (!row) return notFound();

  const user = api.currentUser();
  if (!row.legacy) {
    if (!user || user.id !== row.owner) api.bumpViews(row.id);
    liked = await api.myLike(row.id).catch(() => false);
  }
  render();
})();
