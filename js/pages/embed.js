// Embed page: the particle, and nothing else.
//
// Twitter's player card puts whatever `twitter:player` points at into an
// iframe on the timeline. That used to be view.html, so a shared particle
// previewed as the entire website — header, search box, sign-in button, the
// comment section scrolled out of sight below — squeezed into a 16:9 box.
// This page is the viewport on its own: canvas edge to edge, no site chrome.
//
// Two modes, and the plain ?id= URL — the one og/index.js hands X — is the
// careful one:
//
//   card (default)           The stage takes no pointer events: the orbit
//                            camera captures the pointer and preventDefaults
//                            the wheel, which inside a card means a drag or a
//                            scroll over it never reaches the timeline
//                            underneath. Play/pause, restart and the corner
//                            credit are all here — what a card must not do is
//                            steal the gesture going past it or navigate the
//                            page out from under someone, and a button does
//                            neither, nor does one target=_blank anchor.
//   ?interactive=1           Orbit and zoom on the stage itself. What Share
//                            hands out for an iframe in someone's own article,
//                            where the frame is the thing you came to touch.
//
// This page did briefly hold no anchor at all, on the theory that a frame
// which cannot navigate by construction beats one that merely behaves. It
// also left the effect's own name unclickable on a timeline, which is the
// one thing a card is for. So: exactly one anchor, opening in a new tab, so
// the frame navigates nowhere and neither does the page hosting it.
//
// Deliberately anonymous either way — no initBackend(), no session. Nothing
// here is owner-only, an embed of a private particle is not a thing (the
// crawler that built the card couldn't see it either), and a third-party
// iframe is exactly where localStorage is partitioned away or blocked
// outright. Skipping auth removes a round-trip and a class of failure from
// the fastest path we have.

import * as api from '../backend.js';
import { EffectPlayer } from '../player.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const params = new URLSearchParams(location.search);
const id = params.get('id');
const interactive = params.get('interactive') === '1';
const pageUrl = id ? `view.html?id=${encodeURIComponent(id)}` : 'index.html';

let player = null;
let statsTimer = 0;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Whatever went wrong, say so — a black rectangle explains nothing. No way
 *  out offered on the card: unlike the credit, this link would open a page
 *  that says the same thing back (the particle is gone, or private), and the
 *  post carrying the card already links there. */
function fail(text) {
  const out = interactive
    ? `<a href="${esc(pageUrl)}" target="_blank" rel="noopener">Open on particletoy →</a>`
    : '';
  stage.innerHTML = `<div id="msg"><div>${esc(text)}</div>${out}</div>`;
}

/** The effect's name in the corner, linking back to its page — in both modes.
 *  On a timeline it is the only route from the thing playing to the thing it
 *  came from: a card sitting in someone's feed is often the whole of what a
 *  reader sees, and a name they cannot click is a dead end. target=_blank, so
 *  the click opens a tab rather than steering either frame. */
function credit(row) {
  const author = row.author?.display_name || row.author?.username;
  const label = `<b>${esc(row.title)}</b>${author ? ` by ${esc(author)}` : ''}
    <span class="brand">· particletoy</span>`;
  $('credit').innerHTML =
    `<a href="${esc(new URL(pageUrl, location.href).href)}" target="_blank" rel="noopener">${label}</a>`;
}

/** No WebGPU (Safari, older Chrome, most in-app browsers), or nothing to draw
 *  with: show the same clip the link preview uses, or the still, rather than an
 *  apology. The embed is a picture of the effect either way. */
function fallback(row, why) {
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
  fail(why || player?.error || 'WebGPU is not supported by this browser.');
}

function mount(row) {
  const canvas = document.createElement('canvas');
  stage.appendChild(canvas);
  // maxDpr matches view.html: an embed is usually smaller than the page's
  // player, never bigger, so the sharper cap costs nothing. Handing the player
  // `interactive` also makes it drop pointer-events on its own canvas, which
  // is the same belt as the stylesheet's braces.
  player = new EffectPlayer(canvas, { interactive, maxDpr: 1.75 });
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
  // The effect went up without the compiled shaders this page renders from,
  // and there is no compiler here to make up the difference. Same answer as no
  // WebGPU: the clip is a picture of the effect, an empty stage is not.
  if (player.unrenderable) {
    canvas.remove();
    return fallback(row, `This effect was ${player.unrenderable}.`);
  }
  player.start();

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

  wireControls(row);
}

/** Play/pause, restart and a particle count — in both modes. Withholding them
 *  from the card was a step too far: neither button navigates, and they sit in
 *  a strip where only the buttons themselves take pointer events, so a wheel
 *  over one still scrolls the timeline behind it. Nothing that made the card
 *  decorative is spent here. The stage is what stays untouchable. */
function wireControls(row) {
  const toggle = $('pl-toggle');
  $('bar').hidden = false;

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
}

(async function boot() {
  if (interactive) document.body.classList.add('interactive');

  // Both modes, because both have controls now. Hover reveals them on a
  // desktop; there is no hover on a phone, so there they simply stay up —
  // which on a timeline is the only thing keeping them reachable at all.
  if (window.matchMedia?.('(hover: none)').matches) document.body.classList.add('touch');
  // Show them once on arrival regardless, then get out of the way: nobody
  // uses controls they don't know are there.
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
