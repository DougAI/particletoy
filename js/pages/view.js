// Project page: live player, metadata, like button, owner controls
// (visibility / edit / delete), admin curation, and the comment section.

import * as api from '../backend.js';
import {
  initSite, esc, el, toast, fmtDate, timeAgo, fmtCount, authorName,
  avatarHTML, ensureSignedIn, modal, closeModal,
} from '../site.js';
import { EffectPlayer } from '../player.js';
import { capturePreviewClip } from '../exportmedia.js';

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

/** Says what a shared link will actually embed right now — the one thing you
 *  can't tell by looking at the page. Deliberately specific about GIF: Discord
 *  plays an MP4 handed to it as og:video, but shows only the first frame of a
 *  GIF handed to it as og:image, and "animated GIF" would imply otherwise.
 *
 *  X is left out of all three: it runs the effect live in the card whatever is
 *  stored here, so saying anything about the clip would only confuse what the
 *  button in front of you actually changes. */
function previewStateText() {
  if (!row.preview_url) {
    return 'still thumbnail only. Render a clip and shared links start moving '
      + 'on Discord and the rest.';
  }
  return row.preview_type === 'image/gif'
    ? 'a GIF is attached. It animates on Slack and Telegram, but Discord shows '
      + 'its first frame and LinkedIn falls back to the still, which is under '
      + 'the GIF in the card — Video is the compatible choice.'
    : 'a video clip is attached — it plays in the card on Discord, '
      + 'and the still stands in everywhere else.';
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
      <button class="btn" id="btn-share" title="Copy a link that previews in Discord, Slack and Twitter">
        ↗ Share</button>
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
    </div>
    <div class="owner-box">
      <b>Link preview</b>
      <span class="muted" id="prev-state">${previewStateText()}</span>
      <span style="flex:1"></span>
      <select id="prev-format" class="btn small" title="What the shared link embeds">
        <option value="auto" ${row.preview_type === 'image/gif' ? '' : 'selected'}>Video</option>
        <option value="gif" ${row.preview_type === 'image/gif' ? 'selected' : ''}>GIF</option>
      </select>
      <button class="btn small" id="btn-preview">
        ${row.preview_url ? 'Re-render clip' : 'Render clip'}</button>
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
    frame.innerHTML = `<div class="empty" style="border:none">${esc(player.error || 'WebGPU unavailable')}</div>`;
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

/** The share dialog. The link points at the Open Graph endpoint rather than
 *  this page: a crawler asking a static host for view.html gets the same
 *  <head> whatever the id is, so the preview has to be rendered server-side.
 *  Clicking it lands right back here. */
async function showShare() {
  // Legacy prototype rows live in a different table the preview endpoint
  // doesn't read, so they only get the plain page link.
  const share = row.legacy ? api.pageLink(row.id) : api.shareLink(row.id);
  let copied = false;
  try {
    await navigator.clipboard.writeText(share);
    copied = true;
  } catch { /* no clipboard permission — the input below still works */ }

  // X is its own sentence everywhere below: it iframes the live player for any
  // particle, so what's stored here changes nothing about that card.
  const moving = !api.previewsConfigured()
    ? 'Right now it previews with the site card rather than this particle — '
      + 'per-particle previews need the preview endpoint deployed (see the setup guide).'
    : row.preview_url
      ? 'On X it runs the effect live; elsewhere it embeds the looping clip, '
        + 'so the card plays there too.'
      : 'On X it runs the effect live. Elsewhere the card shows the thumbnail — '
        + (api.currentUser()?.id === row.owner
          ? 'render a clip below to make those move as well.'
          : 'only the author can add a moving preview.');

  const div = el(`<div>
    <p>${copied ? 'Link copied to clipboard.' : 'Copy this link:'}</p>
    <input class="text-in share-url" readonly value="${esc(share)}"
      style="width:100%;font-family:var(--mono);font-size:12px;margin:8px 0">
    <p class="muted">Pastes into Discord, Slack, Twitter and the rest as a preview
      card, and opens this page for anyone who clicks it. ${esc(moving)}</p>

    <div class="share-embed">
      <div class="share-embed-head">
        <b>Embed on your own page</b>
        <button class="btn small" id="btn-embed-copy">Copy</button>
      </div>
      <textarea class="text-in embed-code" readonly rows="4"
        style="width:100%;font-family:var(--mono);font-size:11.5px;resize:vertical"></textarea>
      <p class="muted small">The player with none of the site around it. Runs the effect
        live where WebGPU is available, and falls back to this particle's clip or still
        where it isn't.</p>
    </div>

    <p class="muted small">Plain page link: <a href="${esc(api.pageLink(row.id))}">${esc(api.pageLink(row.id))}</a></p>
  </div>`);

  // Set as .value rather than in the markup above: the snippet is already
  // HTML, and putting it through the template would escape it a second time.
  const code = div.querySelector('.embed-code');
  code.value = embedSnippet();
  code.addEventListener('focus', () => code.select());
  div.querySelector('#btn-embed-copy').addEventListener('click', async (e) => {
    // Held onto before the await: currentTarget is only valid while the event
    // is being dispatched, and is null by the time the clipboard resolves.
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(code.value);
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    } catch {
      code.focus();                    // no clipboard permission — select it instead
      toast('Press ⌘/Ctrl+C to copy');
    }
  });

  modal('Share', div);
  const inp = div.querySelector('.share-url');
  inp.addEventListener('focus', () => inp.select());
  inp.focus();
}

/** The iframe to paste into someone else's page. 640x360 is 16:9 at a size
 *  that fits an article column; the embed itself is fluid, so changing the
 *  numbers is all anyone has to do. */
function embedSnippet() {
  return `<iframe src="${esc(api.embedLink(row.id))}" width="640" height="360"`
    + ` style="border:0" loading="lazy" allowfullscreen`
    + ` title="${esc(row.title)} on particletoy"></iframe>`;
}

/** Re-renders the preview clip from this page, so particles published before
 *  previews existed (or edited since) can get one without a trip to the
 *  editor. Owner only — the storage path is keyed to the uploader. */
async function renderPreview(btn, state) {
  if (!player?.ok || !player.camera) {
    return toast('Needs WebGPU — this browser can\'t render the clip.');
  }
  btn.disabled = true;
  const wasPlaying = player.playing;
  player.stop();                       // free the GPU for the offscreen render
  try {
    const clip = await capturePreviewClip({
      data: row.data,
      camera: player.camera,
      // Not allowCompile: this is a gallery page, which must never fetch the
      // 24 MB Slang compiler. Published effects carry their WGSL — if this one
      // doesn't, the player above is already saying so.
      allowCompile: false,
      format: $('prev-format')?.value || 'auto',
      onProgress: (p) => {
        state.textContent = `rendering… ${Math.round(Math.min(1, p) * 100)}%`;
      },
    });
    if (!clip) return;
    state.textContent = 'uploading…';
    const url = await api.uploadPreview(row.id, clip);
    Object.assign(row, {
      preview_url: url, preview_type: clip.type,
      preview_w: clip.w, preview_h: clip.h,
    });

    // Refresh the still as well. It is the poster frame for the clip and the
    // og:image everywhere that won't play video, and anything published before
    // thumbnails moved to 1200x630 is under LinkedIn's minimum — which it
    // answers by declining to build a card at all. Failing here costs the
    // bigger still, not the clip that was just stored.
    try {
      state.textContent = 'refreshing thumbnail…';
      const thumb = await player.captureJPEG();
      if (thumb) row.thumb_url = await api.uploadThumb(row.id, thumb);
    } catch (e) {
      console.warn('thumbnail refresh failed', e);
    }

    btn.textContent = 'Re-render clip';
    toast('Preview updated');
  } catch (e) {
    toast(`Failed: ${e.message}`);
  } finally {
    // Reads from `row`, so it says the right thing whether or not that update
    // landed — no path leaves a stale "rendering… 100%" behind.
    state.textContent = previewStateText();
    btn.disabled = false;
    if (wasPlaying) player.start();
  }
}

function wireActions(isOwner, isAdmin) {
  $('btn-share').addEventListener('click', showShare);

  $('btn-preview')?.addEventListener('click', (e) =>
    renderPreview(e.currentTarget, $('prev-state')));

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
