// Project page: live player, metadata, like button, owner controls
// (visibility / edit / delete), admin curation, and the comment section.

import * as api from '../backend.js';
import {
  initSite, esc, el, toast, fmtDate, timeAgo, fmtCount, authorName,
  avatarHTML, ensureSignedIn, modal, closeModal,
} from '../site.js';
import { EffectPlayer } from '../player.js';
import {
  capturePreviewClip, prerollFor, CLIP_LIMITS, PREVIEW_DEFAULT_SECONDS,
} from '../exportmedia.js';

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
      <button class="btn small" id="btn-preview">
        ${row.preview_url ? 'Re-render clip…' : 'Render clip…'}</button>
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

  mountPlayer(isOwner);
  wireActions(isOwner, isAdmin);
  loadComments();
}

function mountPlayer(isOwner) {
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

  // This page has no compiler: it draws an effect from the WGSL published
  // alongside it, and if a piece of that is missing the emitters using it draw
  // nothing at all. An empty stage with no explanation looks like a bug in the
  // site, so name it — and tell the one person who can fix it how.
  if (player.unrenderable) {
    const note = document.createElement('div');
    note.className = 'player-note';
    note.textContent = `This effect was ${player.unrenderable}, so its particles can’t be drawn here.`
      + (isOwner ? ' Open it in the editor and save it again to fix that.' : '');
    frame.appendChild(note);
  }

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
 *  numbers is all anyone has to do. Interactive, unlike the card X gets: an
 *  embed you placed yourself is one you want people to orbit. */
function embedSnippet() {
  return `<iframe src="${esc(api.embedLink(row.id, { interactive: true }))}" width="640" height="360"`
    + ` style="border:0" loading="lazy" allowfullscreen`
    + ` title="${esc(row.title)} on particletoy"></iframe>`;
}

/** The owner's clip settings, for as long as this page is open.
 *
 *  Not stored on the particle: re-rendering is a thing you do once and look
 *  at, and three columns on `particles` to remember it would outlive their
 *  usefulness. The cost of that choice is honest and worth knowing — leave
 *  this page, or republish from the editor, and the next clip is the
 *  automatic one again.
 *
 *  Null until the first open, because the default start time isn't a constant:
 *  prerollFor() reads it off this particular effect. */
let clip = null;

function clipDefaults() {
  return {
    format: row.preview_type === 'image/gif' ? 'gif' : 'auto',
    start: prerollFor(row.data),
    speed: 1,
    seconds: PREVIEW_DEFAULT_SECONDS.video,
  };
}

/** Opens the clip dialog. Everything about what gets recorded lives here; the
 *  owner box below just says what is currently attached. */
function showClipDialog() {
  if (!player?.ok || !player.camera) {
    return toast('Needs WebGPU — this browser can\'t render the clip.');
  }
  clip ||= clipDefaults();
  const opt = (v, label, sel) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${label}</option>`;
  const div = el(`<div>
    <div class="clip-grid">
      <div class="field"><label for="clip-format">Format</label>
        <select id="clip-format">
          ${opt('auto', 'Video', clip.format)}${opt('gif', 'GIF', clip.format)}
        </select>
        <div class="hint">What the shared link embeds.</div></div>
      <div class="field"><label for="clip-speed">Speed</label>
        <select id="clip-speed">
          ${CLIP_LIMITS.speeds.map((v) => opt(v, `${v}×`, clip.speed)).join('')}
        </select>
        <div class="hint">Below 1× records in slow motion.</div></div>
      <div class="field"><label for="clip-start">Start at (s)</label>
        <input type="number" id="clip-start" value="${clip.start}"
          min="${CLIP_LIMITS.start.min}" max="${CLIP_LIMITS.start.max}" step="${CLIP_LIMITS.start.step}">
        <div class="hint">Skips ahead, by running the effect — a long skip takes a moment.</div></div>
      <div class="field"><label for="clip-seconds">Length (s)</label>
        <input type="number" id="clip-seconds" value="${clip.seconds}"
          min="${CLIP_LIMITS.seconds.min}" max="${CLIP_LIMITS.seconds.max}" step="${CLIP_LIMITS.seconds.step}">
        <div class="hint">How long the card plays before it loops.</div></div>
    </div>
    <p class="muted" id="clip-summary"></p>
    <p class="muted">Right now it embeds ${previewStateText()}</p>
    <div class="btn-row" style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <button class="btn accent" id="clip-go">Render clip</button>
      <span class="muted" id="clip-status"></span>
    </div></div>`);
  modal('Link preview clip', div);

  // One description of the two number fields, shared by the read and the
  // clamp, so what the summary says and what the field shows can't drift.
  const nums = [
    ['start', '#clip-start', CLIP_LIMITS.start, 0],
    ['seconds', '#clip-seconds', CLIP_LIMITS.seconds, PREVIEW_DEFAULT_SECONDS.video],
  ];
  const value = ([, id, { min, max }, fallback]) => {
    const v = parseFloat(div.querySelector(id).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const read = () => {
    clip = {
      format: div.querySelector('#clip-format').value,
      speed: parseFloat(div.querySelector('#clip-speed').value) || 1,
      ...Object.fromEntries(nums.map((f) => [f[0], value(f)])),
    };
    return clip;
  };

  // The one number nobody can do in their head while choosing: speed changes
  // how much of the effect is in the clip, not how long the clip runs.
  const summary = div.querySelector('#clip-summary');
  const sync = () => {
    const c = read();
    const covered = c.seconds * c.speed;
    summary.textContent = `A ${c.seconds}s clip covering ${covered.toFixed(1)}s of the effect`
      + `${c.start > 0 ? `, from ${c.start}s in` : ', from the start'}.`
      + (c.format === 'gif' ? ' GIFs cost far more per second than video.' : '');
  };
  div.querySelectorAll('select, input').forEach((n) => n.addEventListener('input', sync));
  // Clamped on commit rather than on every keystroke, so typing "12" doesn't
  // fight the cursor at "1" — but once focus leaves, the field shows the
  // number that will actually be recorded rather than the one that was typed.
  nums.forEach((f) => div.querySelector(f[1]).addEventListener('change', (e) => {
    e.target.value = value(f);
    sync();
  }));
  // The two formats want different lengths — a GIF second costs several times
  // what a video second does. Swap the prefill when the field is still showing
  // the other format's default; a number the owner typed is theirs and stays.
  const lenIn = div.querySelector('#clip-seconds');
  div.querySelector('#clip-format').addEventListener('change', (e) => {
    const [mine, theirs] = e.target.value === 'gif'
      ? [PREVIEW_DEFAULT_SECONDS.gif, PREVIEW_DEFAULT_SECONDS.video]
      : [PREVIEW_DEFAULT_SECONDS.video, PREVIEW_DEFAULT_SECONDS.gif];
    if (parseFloat(lenIn.value) === theirs) {
      lenIn.value = mine;
      sync();
    }
  });
  sync();

  div.querySelector('#clip-go').addEventListener('click', (e) =>
    renderPreview(e.currentTarget, div.querySelector('#clip-status'), read()));
}

/** Re-renders the preview clip from this page, so particles published before
 *  previews existed (or edited since) can get one without a trip to the
 *  editor. Owner only — the storage path is keyed to the uploader. */
async function renderPreview(btn, state, settings) {
  btn.disabled = true;
  const wasPlaying = player.playing;
  player.stop();                       // free the GPU for the offscreen render
  try {
    const made = await capturePreviewClip({
      data: row.data,
      camera: player.camera,
      // Not allowCompile: this is a gallery page, which must never fetch the
      // 24 MB Slang compiler. Published effects carry their WGSL — if this one
      // doesn't, the player above is already saying so.
      allowCompile: false,
      ...settings,
      onProgress: (p) => {
        state.textContent = `rendering… ${Math.round(Math.min(1, p) * 100)}%`;
      },
    });
    if (!made) return;
    state.textContent = 'uploading…';
    const url = await api.uploadPreview(row.id, made);
    Object.assign(row, {
      preview_url: url, preview_type: made.type,
      preview_w: made.w, preview_h: made.h,
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

    toast('Preview updated');
  } catch (e) {
    toast(`Failed: ${e.message}`);
  } finally {
    // Both read from `row`, so they say the right thing whether or not that
    // update landed — no path leaves a stale "rendering… 100%" behind.
    state.textContent = '';
    const box = $('prev-state');
    if (box) box.textContent = previewStateText();
    const again = $('btn-preview');
    if (again) again.textContent = row.preview_url ? 'Re-render clip…' : 'Render clip…';
    btn.disabled = false;
    if (wasPlaying) player.start();
  }
}

function wireActions(isOwner, isAdmin) {
  $('btn-share').addEventListener('click', showShare);

  $('btn-preview')?.addEventListener('click', showClipDialog);

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
