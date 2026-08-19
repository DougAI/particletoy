// Embed page: the particle, and nothing else.
//
// Twitter's player card puts whatever `twitter:player` points at into an
// iframe on the timeline. That used to be view.html, so a shared particle
// previewed as the entire website — header, search box, sign-in button, the
// comment section scrolled out of sight below — squeezed into a 16:9 box.
// This page is the viewport on its own: canvas edge to edge, controls floating
// over it, no site chrome. og/index.js points the card here; anyone embedding
// a particle in their own page can point an <iframe> at the same URL.
//
// Deliberately anonymous — no initBackend(), no session. Nothing here is
// owner-only, an embed of a private particle is not a thing (the crawler that
// built the card couldn't see it either), and a third-party iframe is exactly
// where localStorage is partitioned away or blocked outright. Skipping auth
// removes a round-trip and a class of failure from the fastest path we have.

import * as api from '../backend.js';
import { EffectPlayer } from '../player.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const id = new URLSearchParams(location.search).get('id');
const pageUrl = id ? `view.html?id=${encodeURIComponent(id)}` : 'index.html';

let player = null;
let statsTimer = 0;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Whatever went wrong, the way out is the same: the real page, in the top
 *  window rather than inside whoever's iframe this is. */
function fail(text) {
  stage.innerHTML = `<div id="msg"><div>${esc(text)}</div>
    <a href="${esc(pageUrl)}" target="_blank" rel="noopener">Open on particletoy →</a></div>`;
}

/** Who made it, linking out to the particle's own page. The only piece of
 *  site identity the embed keeps — an effect on someone else's timeline
 *  should still say whose it is and where it came from. */
function credit(row) {
  const a = $('credit');
  const author = row.author?.display_name || row.author?.username;
  a.href = new URL(pageUrl, location.href).href;
  a.innerHTML = `<b>${esc(row.title)}</b>${author ? ` by ${esc(author)}` : ''}
    <span class="brand">· particletoy</span>`;
}

/** No WebGPU (Safari, older Chrome, most in-app browsers): show the same clip
 *  the link preview uses, or the still, rather than an apology. The embed is
 *  a picture of the effect either way. */
function fallback(row) {
  if (row.preview_url && (row.preview_type || '').startsWith('video/')) {
    const v = document.createElement('video');
    Object.assign(v, {
      src: row.preview_url, poster: row.thumb_url || '', autoplay: true,
      loop: true, muted: true, playsInline: true, controls: false,
    });
    v.setAttribute('muted', '');          // iOS honours the attribute, not the property
    stage.appendChild(v);
    return;
  }
  const still = row.preview_type === 'image/gif' ? row.preview_url : row.thumb_url;
  if (still) {
    const img = document.createElement('img');
    img.src = still;
    img.alt = row.title || 'particle effect';
    stage.appendChild(img);
    return;
  }
  fail(player?.error || 'WebGPU is not supported by this browser.');
}

function mount(row) {
  const canvas = document.createElement('canvas');
  stage.appendChild(canvas);
  // maxDpr matches view.html: an embed is usually smaller than the page's
  // player, never bigger, so the sharper cap costs nothing.
  player = new EffectPlayer(canvas, { interactive: true, maxDpr: 1.75 });
  if (!player.ok) {
    canvas.remove();
    return fallback(row);
  }
  // player.ok is a synchronous navigator.gpu presence check; the device coming
  // up is async and can still fail — a lost adapter, an in-app browser that
  // advertises WebGPU and can't deliver one. A black rectangle on someone's
  // timeline is the worst outcome available, so wait for the real answer and
  // fall back to the clip if it's no.
  player.ready.then((up) => {
    if (up) return;
    clearInterval(statsTimer);
    canvas.remove();
    $('bar').hidden = true;
    fallback(row);
  });
  player.load(row.data);
  player.start();

  const bar = $('bar');
  const toggle = $('pl-toggle');
  bar.hidden = false;

  statsTimer = setInterval(() => {
    if (!player.playing) return;
    let n = 0;
    for (const em of player.emitters) n += em.count;
    $('pl-stats').textContent = `${n.toLocaleString()} particles`;
  }, 500);

  toggle.addEventListener('click', () => {
    if (player.playing) { player.stop(); toggle.textContent = '⏵'; }
    else { player.start(); toggle.textContent = '⏸'; }
  });
  $('pl-restart').addEventListener('click', () => {
    player.load(row.data);
    if (!player.playing) player.start();
    toggle.textContent = '⏸';
  });

  // A card scrolled off the timeline is still running a GPU simulation.
  // Nobody is watching it, so stop until it comes back.
  if (typeof IntersectionObserver === 'function') {
    let pausedByScroll = false;
    new IntersectionObserver(([e]) => {
      if (!e.isIntersecting && player.playing) { player.stop(); pausedByScroll = true; }
      else if (e.isIntersecting && pausedByScroll) { player.start(); pausedByScroll = false; }
    }, { threshold: 0 }).observe(canvas);
  }
  let pausedByHide = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && player.playing) { player.stop(); pausedByHide = true; }
    else if (!document.hidden && pausedByHide) { player.start(); pausedByHide = false; }
  });
}

(async function boot() {
  // Hover reveals the controls on a desktop; there is no hover on a phone, so
  // there they simply stay up.
  if (window.matchMedia?.('(hover: none)').matches) document.body.classList.add('touch');
  // Show them once on arrival regardless, then get out of the way: a card on a
  // timeline gets one glance, and controls nobody knows about aren't controls.
  document.body.classList.add('reveal');
  setTimeout(() => document.body.classList.remove('reveal'), 2600);

  if (!id) return fail('No particle to show.');
  let row = null;
  try {
    row = await api.getParticle(id);
  } catch { /* offline, or the backend isn't set up — same dead end */ }
  if (!row) return fail("This particle doesn't exist, or it's private.");

  credit(row);
  mount(row);
})();

// A host putting the iframe away — bfcache, a navigation it might come back
// from — shouldn't leave a GPU simulation running behind it. Coming back
// restores what was on screen: a player someone had paused stays paused. (The
// stats interval is left alone: it does nothing while the player is stopped,
// and restarting it here would be one more thing to get wrong.)
let pausedByUnload = false;
window.addEventListener('pagehide', () => {
  if (player?.playing) { player.stop(); pausedByUnload = true; }
});
window.addEventListener('pageshow', (e) => {
  if (!e.persisted || !pausedByUnload) return;
  pausedByUnload = false;
  player.start();
});
