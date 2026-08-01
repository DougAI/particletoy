// Application bootstrap: state, frame loop, toolbar wiring.

import { createGL } from './glutil.js';
import { Renderer, defaultScene } from './renderer.js';
import { OrbitCamera } from './camera.js';
import { Emitter, defaultEmitterParams } from './particles.js';
import { makeMaterial, MaterialRuntime, serializeMaterial } from './materials.js';
import { PRESETS } from './presets.js';
import { buildInspector, EditorPanel, modal, toast, showHelp } from './ui.js';
import {
  serializeState, encodeShareString, decodeShareString,
  loadLibrary, saveToLibrary, deleteFromLibrary, downloadJSON, pickJSONFile,
} from './share.js';
import { backendConfigured, publishEffect, browseEffects, loadEffect } from './backend.js';

const canvas = document.getElementById('gl');
const { gl, error: glError } = createGL(canvas);
if (!gl) {
  const e = document.getElementById('gl-error');
  e.classList.remove('hidden');
  e.textContent = glError;
  throw new Error(glError);
}

const renderer = new Renderer(gl, canvas);
const camera = new OrbitCamera(canvas);

// ---------------------------------------------------------------- app state
const app = {
  name: 'Untitled',
  emitters: [],
  materials: [],
  scene: defaultScene(),
  selEmitter: 0,
  pipeline: 'deferred',
  debugMode: 0,
  playing: true,
  timeScale: 1,
  time: 0,
  materialRuntimes: new Map(),
  markLut(em) { em.lutDirty = true; },
  markMaterial(id) {
    const rt = app.materialRuntimes.get(id);
    if (rt) rt.dirty = true;
  },
  addEmitter(p) {
    app.emitters.push(new Emitter(p));
    app.selEmitter = app.emitters.length - 1;
    app.refreshUI();
  },
  removeEmitter(i) {
    const em = app.emitters[i];
    if (!em) return;
    em.dispose(gl);
    app.emitters.splice(i, 1);
    app.selEmitter = Math.max(0, Math.min(app.selEmitter, app.emitters.length - 1));
    app.refreshUI();
  },
  duplicateEmitter(i) {
    const em = app.emitters[i];
    if (!em) return;
    const p = structuredClone(em.p);
    p.id = `em${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    p.name += ' copy';
    app.emitters.splice(i + 1, 0, new Emitter(p));
    app.selEmitter = i + 1;
    app.refreshUI();
  },
  addMaterial(m) {
    app.materials.push(m);
    app.refreshUI();
    editorPanel.show(m.id, 'fs');
  },
  removeMaterial(id) {
    if (app.materials.length <= 1) { toast('At least one material is required'); return; }
    app.materials = app.materials.filter((m) => m.id !== id);
    const fallback = app.materials[0].id;
    for (const em of app.emitters) if (em.p.materialId === id) em.p.materialId = fallback;
    const rt = app.materialRuntimes.get(id);
    if (rt) { rt.dispose(); app.materialRuntimes.delete(id); }
    app.refreshUI();
  },
  openMaterialInEditor(id) { editorPanel.show(id, 'fs'); },
  materialErrors: new Map(),
  refreshUI() {
    buildInspector(app);
    editorPanel.refreshMaterials();
  },
};
window.__particletoy = { app, renderer, gl, canvas }; // for curious consoles

const editorPanel = new EditorPanel(app);

// ---------------------------------------------------------------- state load
function mergeEmitterParams(p) {
  const d = defaultEmitterParams();
  const merged = { ...d, ...p };
  merged.spawn = { ...d.spawn, ...(p.spawn || {}) };
  merged.shape = { ...d.shape, ...(p.shape || {}) };
  return merged;
}

function applyData(obj) {
  for (const em of app.emitters) em.dispose(gl);
  for (const rt of app.materialRuntimes.values()) rt.dispose();
  app.materialRuntimes.clear();
  app.materialErrors.clear();

  app.name = obj.name || 'Untitled';
  app.materials = (obj.materials || []).map((m) => ({ ...makeMaterial({}), ...m }));
  if (!app.materials.length) app.materials = [makeMaterial({ name: 'Default' })];
  app.emitters = (obj.emitters || []).map((p) => new Emitter(mergeEmitterParams(structuredClone(p))));
  if (obj.scene) app.scene = { ...defaultScene(), ...structuredClone(obj.scene) };
  app.selEmitter = 0;
  document.getElementById('fx-name').value = app.name;
  restart();
  app.refreshUI();
  const first = app.materials[0];
  if (first) editorPanel.show(first.id, 'fs');
}

function currentData() {
  return serializeState(app.name, app.emitters, app.materials.map(serializeMaterial), app.scene);
}

function restart() {
  app.time = 0;
  for (const em of app.emitters) em.restart();
}

// ---------------------------------------------------------------- materials
function syncMaterials() {
  for (const [id, rt] of app.materialRuntimes) {
    if (!app.materials.some((m) => m.id === id)) {
      rt.dispose();
      app.materialRuntimes.delete(id);
    }
  }
  for (const m of app.materials) {
    let rt = app.materialRuntimes.get(m.id);
    if (!rt) {
      rt = new MaterialRuntime(gl, m);
      app.materialRuntimes.set(m.id, rt);
    }
    rt.material = m;
    if (rt.dirty) {
      const errors = rt.compile(['gbuffer', 'forward']);
      app.materialErrors.set(m.id, errors);
      editorPanel.onCompiled(m.id, errors);
    }
  }
}

// ---------------------------------------------------------------- input
const mouse = [0, 0, 0, 0];
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, r.width);
  mouse[0] = (e.clientX - r.left) * sx;
  mouse[1] = canvas.height - (e.clientY - r.top) * sx;
});
canvas.addEventListener('pointerdown', () => { mouse[2] = 1; });
window.addEventListener('pointerup', () => { mouse[2] = 0; });

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  }
});

// ---------------------------------------------------------------- toolbar
function togglePlay() {
  app.playing = !app.playing;
  document.getElementById('btn-play').textContent = app.playing ? '⏸' : '⏵';
}

function wireToolbar() {
  const presetSel = document.getElementById('preset-select');
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = 'Presets…';
  presetSel.appendChild(ph);
  for (const name of Object.keys(PRESETS)) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    presetSel.appendChild(o);
  }
  presetSel.addEventListener('change', () => {
    if (!presetSel.value) return;
    applyData(PRESETS[presetSel.value]());
    toast(`Loaded preset: ${presetSel.value}`);
    presetSel.value = '';
  });

  const pd = document.getElementById('pipe-deferred');
  const pf = document.getElementById('pipe-forward');
  const dbg = document.getElementById('debug-select');
  const setPipe = (p) => {
    app.pipeline = p;
    pd.classList.toggle('active', p === 'deferred');
    pf.classList.toggle('active', p === 'forward');
    dbg.disabled = p !== 'deferred';
    if (p !== 'deferred') { dbg.value = '0'; app.debugMode = 0; }
  };
  pd.addEventListener('click', () => setPipe('deferred'));
  pf.addEventListener('click', () => setPipe('forward'));
  dbg.addEventListener('change', () => { app.debugMode = parseInt(dbg.value, 10); });

  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-restart').addEventListener('click', restart);
  document.getElementById('speed-select').addEventListener('change', (e) => {
    app.timeScale = parseFloat(e.target.value);
  });
  document.getElementById('fx-name').addEventListener('change', (e) => {
    app.name = e.target.value || 'Untitled';
  });
  document.getElementById('btn-cam-reset').addEventListener('click', () => camera.reset());
  document.getElementById('btn-help').addEventListener('click', showHelp);

  document.getElementById('btn-share').addEventListener('click', async () => {
    const str = await encodeShareString(currentData());
    const url = `${location.origin}${location.pathname}#s=${str}`;
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch { /* clipboard unavailable — show the modal only */ }
    const div = document.createElement('div');
    div.innerHTML = `<p>${copied ? 'Link copied to clipboard.' : 'Copy this link:'}</p>`;
    const inp = document.createElement('input');
    inp.className = 'text-in share-url';
    inp.value = url;
    inp.readOnly = true;
    inp.addEventListener('focus', () => inp.select());
    div.appendChild(inp);
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = `The whole effect (${Math.round(str.length / 1024 * 10) / 10} KB) lives in the URL — no server involved.`;
    div.appendChild(note);
    modal('Share Effect', div);
    inp.focus();
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    downloadJSON(currentData(), `${(app.name || 'effect').replace(/[^\w-]+/g, '_')}.particletoy.json`);
  });
  document.getElementById('btn-import').addEventListener('click', async () => {
    const obj = await pickJSONFile();
    if (obj && obj.emitters && obj.materials) {
      applyData(obj);
      toast('Effect imported');
    } else if (obj) {
      toast('Not a particletoy effect file');
    }
  });

  document.getElementById('btn-save').addEventListener('click', () => {
    saveToLibrary(app.name || 'Untitled', currentData());
    toast(`Saved “${app.name}” to library`);
  });
  document.getElementById('btn-library').addEventListener('click', showLibrary);
  document.getElementById('btn-publish').addEventListener('click', showPublish);
}

function showLibrary() {
  const lib = loadLibrary();
  const names = Object.keys(lib).sort();
  const div = document.createElement('div');
  if (!names.length) {
    div.innerHTML = '<p class="muted">Nothing saved yet. Use <b>Save</b> to keep effects in this browser.</p>';
  }
  for (const name of names) {
    const rowEl = document.createElement('div');
    rowEl.className = 'lib-row';
    const label = document.createElement('span');
    label.className = 'lib-name';
    label.textContent = name;
    const load = document.createElement('button');
    load.className = 'btn btn-small';
    load.textContent = 'Load';
    load.addEventListener('click', () => {
      applyData(lib[name].data);
      document.getElementById('modal-root').innerHTML = '';
      toast(`Loaded “${name}”`);
    });
    const del = document.createElement('button');
    del.className = 'btn btn-small btn-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      deleteFromLibrary(name);
      showLibrary();
    });
    rowEl.append(label, load, del);
    div.appendChild(rowEl);
  }
  modal('Browser Library', div);
}

async function showPublish() {
  if (!backendConfigured()) {
    modal('Publish — backend not configured', `
      <p>Publishing to a public community gallery needs a tiny backend
      (everything else — editing, URL sharing, export — is 100% serverless).</p>
      <p>A complete Supabase implementation is already wired up in
      <code>js/backend.js</code>; you only need to create a free project and
      paste two values.</p>
      <p><a href="setup.html#gallery" target="_blank">Open the setup guide ↗</a></p>
      <p class="muted">Until then, <b>Share</b> links carry the entire effect in the URL.</p>`);
    return;
  }
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="prop-row"><label class="prop-label">Author</label>
      <input id="pub-author" class="text-in" placeholder="anonymous"></div>
    <div id="pub-list" class="muted" style="margin-top:10px">Loading gallery…</div>`;
  const { body } = modal('Community Gallery', div, { wide: true });
  const publishBtn = document.createElement('button');
  publishBtn.className = 'btn btn-accent';
  publishBtn.textContent = `Publish “${app.name}”`;
  publishBtn.addEventListener('click', async () => {
    try {
      const author = body.querySelector('#pub-author').value || 'anonymous';
      const { id } = await publishEffect(app.name, author, currentData());
      toast('Published!');
      const url = `${location.origin}${location.pathname}?id=${id}`;
      body.querySelector('#pub-list').innerHTML =
        `<p>Published — direct link:</p><input class="text-in share-url" readonly value="${url}">`;
    } catch (e) {
      toast(`Publish failed: ${e.message}`);
    }
  });
  div.prepend(publishBtn);
  try {
    const rows = await browseEffects();
    const listEl = body.querySelector('#pub-list');
    listEl.classList.remove('muted');
    listEl.innerHTML = '';
    for (const r of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'lib-row';
      rowEl.innerHTML = `<span class="lib-name">${r.name} <span class="muted">by ${r.author}</span></span>`;
      const load = document.createElement('button');
      load.className = 'btn btn-small';
      load.textContent = 'Load';
      load.addEventListener('click', async () => {
        const row = await loadEffect(r.id);
        if (row) {
          applyData(row.data);
          document.getElementById('modal-root').innerHTML = '';
        }
      });
      rowEl.appendChild(load);
      listEl.appendChild(rowEl);
    }
  } catch { /* gallery list is best-effort */ }
}

// ---------------------------------------------------------------- splitter
function wireSplitter() {
  const splitter = document.getElementById('splitter');
  const main = document.getElementById('main');
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const r = main.getBoundingClientRect();
      const frac = Math.min(0.7, Math.max(0.25, 1 - (ev.clientX - r.left) / r.width));
      main.style.setProperty('--editor-w', `${frac * 100}%`);
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });
}

// ---------------------------------------------------------------- stats
let frames = 0;
let statTimer = 0;
function updateStats(dt) {
  frames++;
  statTimer += dt;
  if (statTimer >= 0.5) {
    const fps = Math.round(frames / statTimer);
    let particles = 0;
    for (const em of app.emitters) particles += em.count;
    document.getElementById('stats').textContent =
      `${fps} fps · ${particles.toLocaleString()} particles · ${app.pipeline}`;
    const items = document.querySelectorAll('.emitter-item .emitter-count');
    app.emitters.forEach((em, i) => { if (items[i]) items[i].textContent = em.count; });
    frames = 0;
    statTimer = 0;
  }
}

// ---------------------------------------------------------------- frame loop
let last = performance.now();
function tick(now) {
  frame(now);
  requestAnimationFrame(tick);
}

function frame(now) {
  const rawDt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;

  const holder = document.getElementById('viewport');
  const dpr = Math.min(1.75, window.devicePixelRatio || 1);
  const w = Math.max(2, Math.floor(holder.clientWidth * dpr));
  const h = Math.max(2, Math.floor(holder.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  renderer.resize(w, h);

  if (app.playing) {
    const dt = rawDt * app.timeScale;
    app.time += dt;
    for (const em of app.emitters) em.step(dt);
  }

  syncMaterials();

  const cam = camera.matrices(w / h);
  renderer.render({
    camera: cam,
    scene: app.scene,
    effect: { emitters: app.emitters },
    materials: app.materialRuntimes,
    pipeline: app.pipeline,
    debugMode: app.debugMode,
    time: app.time,
    mouse,
  });

  updateStats(rawDt);
}
window.__particletoy.frame = frame;
window.__particletoy.camera = camera;

// ---------------------------------------------------------------- boot
async function boot() {
  wireToolbar();
  wireSplitter();

  let loaded = false;
  const hash = location.hash;
  if (hash.startsWith('#s=')) {
    try {
      applyData(await decodeShareString(hash.slice(3)));
      loaded = true;
      toast('Loaded shared effect');
    } catch {
      toast('Could not read the shared link');
    }
  }
  const id = new URLSearchParams(location.search).get('id');
  if (!loaded && id && backendConfigured()) {
    try {
      const row = await loadEffect(id);
      if (row) {
        applyData(row.data);
        loaded = true;
      }
    } catch { /* fall through to default preset */ }
  }
  if (!loaded) applyData(PRESETS['Campfire']());

  requestAnimationFrame((t) => { last = t; tick(t); });
}

boot();
