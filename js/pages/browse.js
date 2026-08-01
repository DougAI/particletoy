// Browse / search page. State lives in the URL (?q=&tag=&sort=&page=).

import * as api from '../backend.js';
import { initSite, renderCards, esc } from '../site.js';

const PER_PAGE = 24;
const $ = (id) => document.getElementById(id);

const state = {
  q: '', tag: '', sort: 'newest', page: 0,
  read() {
    const p = new URLSearchParams(location.search);
    this.q = p.get('q') || '';
    this.tag = p.get('tag') || '';
    this.sort = ['newest', 'popular', 'loved', 'updated'].includes(p.get('sort')) ? p.get('sort') : 'newest';
    this.page = Math.max(0, parseInt(p.get('page') || '0', 10) || 0);
  },
  write() {
    const p = new URLSearchParams();
    if (this.q) p.set('q', this.q);
    if (this.tag) p.set('tag', this.tag);
    if (this.sort !== 'newest') p.set('sort', this.sort);
    if (this.page) p.set('page', String(this.page));
    const qs = p.toString();
    history.pushState(null, '', qs ? `?${qs}` : location.pathname);
  },
};

let total = 0;

async function refresh() {
  const grid = $('grid');
  grid.innerHTML = '<div class="spinner">Loading…</div>';

  // sort segment
  document.querySelectorAll('#sort-seg button').forEach((b) =>
    b.classList.toggle('active', b.dataset.sort === state.sort));

  // active filter chips
  const chips = [];
  if (state.q) chips.push(`<span class="tag-chip">“${esc(state.q)}” <button data-clear="q">✕</button></span>`);
  if (state.tag) chips.push(`<span class="tag-chip">#${esc(state.tag)} <button data-clear="tag">✕</button></span>`);
  $('active-filters').innerHTML = chips.join(' ');
  $('active-filters').querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', () => {
      state[b.dataset.clear] = '';
      state.page = 0;
      state.write();
      refresh();
    }));

  try {
    const rows = await api.listParticles({
      q: state.q, tag: state.tag, sort: state.sort, page: state.page, perPage: PER_PAGE,
    });
    total = rows.total ?? rows.length;
    $('result-count').textContent = `${total.toLocaleString()} result${total === 1 ? '' : 's'}`;
    if (!rows.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
        ${state.q || state.tag ? 'No particles match that search.' : 'Nothing published yet.'}</div>`;
    } else {
      renderCards(grid, rows);
    }
  } catch {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Could not load the gallery — is the backend set up?</div>';
    total = 0;
  }

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  $('pg-info').textContent = `page ${Math.min(state.page + 1, pages)} of ${pages}`;
  $('pg-prev').disabled = state.page <= 0;
  $('pg-next').disabled = state.page >= pages - 1;
}

(async function boot() {
  await initSite();
  state.read();

  document.querySelectorAll('#sort-seg button').forEach((b) =>
    b.addEventListener('click', () => {
      state.sort = b.dataset.sort;
      state.page = 0;
      state.write();
      refresh();
    }));

  $('pg-prev').addEventListener('click', () => {
    state.page = Math.max(0, state.page - 1);
    state.write();
    refresh();
    scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('pg-next').addEventListener('click', () => {
    state.page += 1;
    state.write();
    refresh();
    scrollTo({ top: 0, behavior: 'smooth' });
  });

  window.addEventListener('popstate', () => { state.read(); refresh(); });
  refresh();
})();
