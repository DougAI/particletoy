// Front page: particle of the day (live player), featured + latest grids.

import * as api from '../backend.js';
import { initSite, renderCards, esc, fmtCount, authorName, LINKS, linkReady } from '../site.js';
import { EffectPlayer } from '../player.js';

const $ = (id) => document.getElementById(id);

async function loadPOTD() {
  const frame = $('potd-frame');
  const caption = $('potd-caption');
  let p = null;
  try { p = await api.getPOTD(); } catch { /* backend not ready */ }
  if (!p) {
    caption.innerHTML = '<span class="muted">No published particles yet — <a href="editor.html">be the first</a>.</span>';
    return;
  }

  caption.innerHTML = `
    <span class="potd-label" style="position:static">Particle of the day</span>
    <h2><a href="view.html?id=${p.id}">${esc(p.title)}</a></h2>
    <span class="muted">by <a href="user.html?u=${encodeURIComponent(p.author?.username || '')}">${esc(authorName(p))}</a></span>
    <span class="muted">♥ ${fmtCount(p.likes)} · 👁 ${fmtCount(p.views)}</span>`;

  // Live, interactive player front and center (fallback: static thumbnail).
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab';
  const player = new EffectPlayer(canvas, { interactive: true, maxDpr: 1.5 });
  if (player.ok && p.data) {
    frame.innerHTML = '';
    frame.appendChild(canvas);
    player.load(p.data);
    player.start();
    // pause when scrolled out of view — keeps laptops cool
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting) player.start(); else player.stop();
    }).observe(frame);
  } else if (p.thumb_url) {
    frame.innerHTML = `<img src="${esc(p.thumb_url)}" alt="">`;
  }
  const label = document.createElement('a');
  label.className = 'potd-label';
  label.href = `view.html?id=${p.id}`;
  label.textContent = '☀ Particle of the day';
  frame.appendChild(label);
}

async function loadGrid(id, promise, emptyMsg) {
  const grid = $(id);
  try {
    const rows = await promise;
    if (!rows.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${emptyMsg}</div>`;
      return;
    }
    renderCards(grid, rows);
  } catch {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${emptyMsg}</div>`;
  }
}

function wireSupportLinks() {
  const pp = linkReady(LINKS.paypal);
  const pt = linkReady(LINKS.patreon);
  $('link-paypal').href = LINKS.paypal;
  $('link-patreon').href = LINKS.patreon;
  $('link-paypal').classList.toggle('hidden', !pp);
  $('link-patreon').classList.toggle('hidden', !pt);
  // Nothing to ask for yet — hide the whole box rather than show dead buttons.
  if (!pp && !pt) document.querySelector('.support-box')?.classList.add('hidden');
}

(async function boot() {
  wireSupportLinks();
  await initSite();
  loadPOTD();
  loadGrid('featured-grid', api.getFeatured(8), 'Nothing featured yet.');
  loadGrid('latest-grid', api.getLatest(8), 'Nothing published yet — <a href="editor.html">create the first particle</a>.');
})();
