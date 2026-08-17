// Application bootstrap: state, frame loop, toolbar wiring.

import { createGPU } from './gpu.js';
import { Renderer, defaultScene } from './renderer.js';
import { OrbitCamera } from './camera.js';
import { Emitter, defaultEmitterParams } from './particles.js';
import { makeMaterial, MaterialRuntime, serializeMaterial } from './materials.js';
import { PRESETS } from './presets.js';
import { buildInspector, EditorPanel, modal, toast, showHelp, setHistoryRecorder, isTextEditing } from './ui.js';
import { History } from './history.js';
import { buildCache } from './wgslcache.js';
import {
  serializeState, isPreSlang, encodeShareString, decodeShareString,
  loadLibrary, saveToLibrary, deleteFromLibrary, downloadJSON, downloadBlob, pickJSONFile,
} from './share.js';
import * as api from './backend.js';
import { captureCanvasJPEG } from './player.js';
import {
  exportVideo, exportGif, getVideoMimeType, capturePreviewClip, MAX_EXPORT_SECONDS,
} from './exportmedia.js';

const canvas = document.getElementById('gl');
const { device, context, format, error: gpuError } = await createGPU(canvas);
if (!device) {
  const e = document.getElementById('gl-error');
  e.classList.remove('hidden');
  e.textContent = gpuError;
  throw new Error(gpuError);
}

const renderer = new Renderer({ device, context, format, canvas });
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
  simErrors: new Map(),
  markLut(em) { em.lutDirty = true; },
  markMaterial(id) {
    const rt = app.materialRuntimes.get(id);
    if (rt) rt.dirty = true;
  },
  markSim(em) { em.simDirty = true; },
  openSimInEditor() { editorPanel.show(editorPanel.materialId, 'sim'); },
  selectEmitter(i) {
    app.selEmitter = i;
    buildInspector(app);
    editorPanel.onEmitterChanged();
  },
  addEmitter(p) {
    app.emitters.push(new Emitter(p));
    app.selEmitter = app.emitters.length - 1;
    app.refreshUI();
  },
  removeEmitter(i) {
    const em = app.emitters[i];
    if (!em) return;
    em.dispose();
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
window.__particletoy = { app, renderer, device, canvas }; // for curious consoles

// Cloud state: set when the effect was loaded from (or published to) the
// community gallery, so Publish knows whether to update-in-place or create.
const cloud = { id: null, owner: null, description: '', tags: [], visibility: 'public' };

function isCloudOwner() {
  const u = api.currentUser();
  return Boolean(cloud.id && u && cloud.owner === u.id);
}

function updatePublishButton() {
  const b = document.getElementById('btn-publish');
  b.textContent = isCloudOwner() ? 'Save ↑' : 'Publish';
  b.title = isCloudOwner()
    ? 'Save changes to your published particle' : 'Publish to the community gallery';
}

const editorPanel = new EditorPanel(app);

// GPU sim compiles resolve asynchronously inside the renderer; surface the
// structured errors in the editor's Sim tab like material errors.
renderer.onSimCompiled = (em, errors) => {
  app.simErrors.set(em.p.id, errors);
  editorPanel.onSimCompiled(em.p.id, errors);
};

// ---------------------------------------------------------------- state load
function mergeEmitterParams(p) {
  const d = defaultEmitterParams();
  const merged = { ...d, ...p };
  merged.spawn = { ...d.spawn, ...(p.spawn || {}) };
  merged.shape = { ...d.shape, ...(p.shape || {}) };
  return merged;
}

function applyData(obj) {
  // Whatever is on screen in the editor belongs to the effect being replaced —
  // drop it before the swap so it can't be flushed into the incoming one (e.g.
  // a half-edited sim shader landing on a preset's compute emitter).
  editorPanel.discardBuffer();
  for (const em of app.emitters) em.dispose();
  for (const rt of app.materialRuntimes.values()) rt.dispose();
  app.materialRuntimes.clear();
  app.materialErrors.clear();
  app.simErrors.clear();

  // Effects saved before the Slang cutover hold WGSL, which this engine can no
  // longer compile. Everything except the shaders still loads — emitters,
  // curves, materials, scene — so the setup is intact and the old source is
  // right there in the editor to port by hand. Saying so beats a black canvas
  // and a wall of syntax errors.
  const legacy = isPreSlang(obj) && (obj.materials?.length || obj.emitters?.length);
  if (legacy) {
    toast('This effect was made with the old WGSL shader language and its shaders can\'t run. Everything else loaded — the original source is in the editor to port.', 12000);
  }

  // The compiled-WGSL cache travels with the effect; hand it to the renderer
  // before anything compiles so cached shaders skip the compiler entirely.
  renderer.wgslCache = obj.wgslCache ?? null;

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

/**
 * The live effect as a saveable object.
 *
 * `withCache` attaches the WGSL every shader just compiled to, so the gallery
 * pages can render the effect without downloading the Slang compiler. It is
 * opt-in because it is bulky: share links skip it (they open in the editor
 * anyway) and so do undo snapshots, which are capped by total size.
 */
function currentData({ withCache = false } = {}) {
  const cache = withCache
    ? buildCache(app.materials, app.materialRuntimes, app.emitters)
    : null;
  return serializeState(app.name, app.emitters, app.materials.map(serializeMaterial), app.scene, cache);
}

// ---------------------------------------------------------------- undo/redo
// Whole-state snapshots round-tripped through the same applyData() used for
// presets/share links — the one path already trusted to fully replace the
// live effect. setHistoryRecorder() wires ui.js's widget factories (sliders,
// spinner arrows, checkboxes, buttons, and — via the curve/gradient editors'
// shared `lut` callback — curve points) to record into it.
const history = new History({
  getState: () => JSON.stringify(currentData()),
  setState: (snap) => applyData(JSON.parse(snap)),
});
setHistoryRecorder((source) => history.record(source));
window.__particletoy.history = history;

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  // A field being typed into keeps its native undo (Ctrl+Z mid-typing should
  // revert characters, not jump the whole effect back a step). Spinner clicks
  // and arrow keys on a number field are not typing — they are recorded state
  // changes, so they fall through to the app-level stack below.
  if (isTextEditing(document.activeElement)) return;
  e.preventDefault();
  const redo = key === 'y' || e.shiftKey;
  const did = redo ? history.redo() : history.undo();
  if (did) toast(redo ? 'Redo' : 'Undo');
});

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
      rt = new MaterialRuntime(renderer, m);
      app.materialRuntimes.set(m.id, rt);
    }
    rt.material = m;
    if (rt.dirty) {
      rt.compile(['gbuffer', 'forward']).then((errors) => {
        app.materialErrors.set(m.id, errors);
        editorPanel.onCompiled(m.id, errors);
      });
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
    // The effect rides in the fragment, which browsers never send to a server,
    // so nothing on the other end can render a preview card for this link.
    const note2 = document.createElement('p');
    note2.className = 'muted';
    note2.innerHTML = 'Chat apps show it as a plain link. <b>Publish</b> instead for a '
      + 'link that previews with a playing clip in Discord, Slack and Twitter.';
    div.appendChild(note2);
    modal('Share Effect', div);
    inp.focus();
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    downloadJSON(currentData({ withCache: true }), `${(app.name || 'effect').replace(/[^\w-]+/g, '_')}.particletoy.json`);
  });
  document.getElementById('btn-export-media').addEventListener('click', showExportMedia);
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
    saveToLibrary(app.name || 'Untitled', currentData({ withCache: true }));
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

// Minimal in-editor sign-in/sign-up (the site pages have the full dialog;
// this one reuses the editor's own modal styling).
function editorSignIn() {
  return new Promise((resolve) => {
    let mode = 'signin';
    const div = document.createElement('div');
    const render = () => {
      div.innerHTML = `
        <div class="prop-row"><label class="prop-label">Email</label>
          <input id="au-email" class="text-in" type="email" autocomplete="email"></div>
        <div class="prop-row"><label class="prop-label">Password</label>
          <input id="au-pass" class="text-in" type="password"
                 autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></div>
        ${mode === 'signup' ? `
        <div class="prop-row"><label class="prop-label">Username</label>
          <input id="au-user" class="text-in" maxlength="20" placeholder="a-z, 0-9, _"></div>` : ''}
        <p id="au-err" class="muted" style="color:var(--danger);min-height:16px"></p>
        <button id="au-go" class="btn btn-accent">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
        <p class="muted" style="margin-top:8px">
          ${mode === 'signup' ? 'Already have an account?' : 'No account yet?'}
          <a href="#" id="au-toggle">${mode === 'signup' ? 'Sign in' : 'Create one'}</a></p>`;
      div.querySelector('#au-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        mode = mode === 'signup' ? 'signin' : 'signup';
        render();
      });
      div.querySelector('#au-go').addEventListener('click', async () => {
        const err = div.querySelector('#au-err');
        try {
          const email = div.querySelector('#au-email').value.trim();
          const password = div.querySelector('#au-pass').value;
          if (mode === 'signup') {
            const username = div.querySelector('#au-user').value.trim().toLowerCase();
            if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Username: 3–20 chars, a-z 0-9 _');
            if (!(await api.usernameAvailable(username))) throw new Error('That username is taken');
            const r = await api.signUp({ email, password, username });
            if (!r.confirmed) {
              div.innerHTML = '<p>Check your email for a confirmation link, then sign in again.</p>';
              return;
            }
          } else {
            await api.signIn({ email, password });
          }
          document.getElementById('modal-root').innerHTML = '';
          resolve(true);
        } catch (ex) { err.textContent = ex.message; }
      });
    };
    render();
    modal('Sign in to publish', div);
  });
}

async function showPublish() {
  if (!api.backendConfigured()) {
    modal('Publish — backend not configured', `
      <p>Publishing needs the community backend — see the setup guide.</p>
      <p><a href="setup.html#backend" target="_blank">Open the setup guide ↗</a></p>
      <p class="muted">Until then, <b>Share</b> links carry the entire effect in the URL.</p>`);
    return;
  }
  if (!api.currentUser() && !(await editorSignIn())) return;

  const owner = isCloudOwner();
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="prop-row"><label class="prop-label">Title</label>
      <input id="pub-title" class="text-in" maxlength="80"></div>
    <div class="prop-row"><label class="prop-label">Description</label></div>
    <textarea id="pub-desc" class="text-in" rows="4" maxlength="2000"
      style="width:100%;resize:vertical" placeholder="What is it? Any controls? Techniques worth noting?"></textarea>
    <div class="prop-row"><label class="prop-label">Tags</label>
      <input id="pub-tags" class="text-in" placeholder="fire, magic, fountain (comma-separated)"></div>
    <div class="prop-row"><label class="prop-label">Visibility</label>
      <select id="pub-vis" class="select-in">
        <option value="public">Public — in the gallery</option>
        <option value="private">Private — only you</option>
      </select></div>
    ${owner ? `<label class="prop-row" style="gap:6px;cursor:pointer">
      <input type="checkbox" id="pub-copy"> <span>Publish as a new copy instead of updating</span></label>` : ''}
    <p id="pub-err" class="muted" style="color:var(--danger);min-height:16px"></p>
    <button id="pub-go" class="btn btn-accent">${owner ? 'Save changes' : 'Publish'}</button>
    <span class="muted"> A thumbnail and a short preview clip are captured from the current view.</span>
    <p id="pub-status" class="muted" style="min-height:16px"></p>
    <div id="pub-done" style="margin-top:10px"></div>`;
  modal(owner ? 'Save to gallery' : 'Publish to gallery', div, { wide: true });

  div.querySelector('#pub-title').value = app.name || 'Untitled';
  div.querySelector('#pub-desc').value = cloud.description || '';
  div.querySelector('#pub-tags').value = (cloud.tags || []).join(', ');
  div.querySelector('#pub-vis').value = cloud.visibility || 'public';

  div.querySelector('#pub-go').addEventListener('click', async () => {
    const err = div.querySelector('#pub-err');
    const go = div.querySelector('#pub-go');
    const status = div.querySelector('#pub-status');
    go.disabled = true;
    err.textContent = '';
    try {
      const title = div.querySelector('#pub-title').value.trim() || 'Untitled';
      const description = div.querySelector('#pub-desc').value.trim();
      const visibility = div.querySelector('#pub-vis').value;
      const tags = div.querySelector('#pub-tags').value
        .split(',').map((t) => t.trim().toLowerCase().replace(/[^a-z0-9\-_ ]/g, '').replace(/\s+/g, '-'))
        .filter(Boolean).slice(0, 12);
      const asCopy = div.querySelector('#pub-copy')?.checked;
      const payload = { title, description, tags, visibility, data: currentData({ withCache: true }) };

      let id = cloud.id;
      if (isCloudOwner() && !asCopy) {
        await api.updateParticle(id, payload);
      } else {
        ({ id } = await api.createParticle(payload));
      }
      status.textContent = 'Capturing thumbnail…';
      const thumb = await captureCanvasJPEG(canvas, () => frame(performance.now()));
      if (thumb) await api.uploadThumb(id, thumb).catch(() => {});

      // The looping clip link previews embed. It renders offscreen and takes a
      // few seconds, and the particle is already saved by now — so a failure
      // here costs the rich preview, never the publish.
      status.textContent = 'Rendering link preview… 0%';
      let clipOk = false;
      try {
        const clip = await capturePreviewClip({
          data: payload.data,
          camera,
          pipeline: app.pipeline,
          onProgress: (p) => {
            status.textContent = `Rendering link preview… ${Math.round(Math.min(1, p) * 100)}%`;
          },
        });
        if (clip) {
          status.textContent = 'Uploading link preview…';
          await api.uploadPreview(id, clip);
          clipOk = true;
        }
      } catch (ex) {
        console.warn('preview clip failed', ex);
      }
      status.textContent = '';

      app.name = title;
      document.getElementById('fx-name').value = title;
      Object.assign(cloud, { id, owner: api.currentUser().id, description, tags, visibility });
      updatePublishButton();

      const url = api.pageLink(id);
      const share = api.shareLink(id);
      div.querySelector('#pub-done').innerHTML =
        `<p>✔ ${owner && !asCopy ? 'Saved' : 'Published'} — <a href="${url}">open its page ↗</a></p>
         <p class="muted">Share link — pastes into Discord, Slack or Twitter as a
           ${clipOk ? 'playable preview card' : 'preview card'}, and opens the page for
           anyone who clicks it:</p>
         <input class="text-in share-url" readonly value="${share}">
         ${clipOk ? '' : `<p class="muted">The preview clip didn't render, so the card
           will show the still thumbnail. You can retry from the particle's page
           (<b>Link preview → Render clip</b>).</p>`}`;
      div.querySelector('.share-url').addEventListener('focus', (e) => e.target.select());
      toast(owner && !asCopy ? 'Saved to gallery' : 'Published!');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      go.disabled = false;
      status.textContent = '';
    }
  });
}

// ---------------------------------------------------------------- export media (video/GIF)
function showExportMedia() {
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="prop-row"><label class="prop-label">Format</label>
      <div class="seg" id="xm-format">
        <button type="button" class="seg-btn active" data-fmt="video">Video</button>
        <button type="button" class="seg-btn" data-fmt="gif">GIF</button>
      </div></div>
    <div class="prop-row"><label class="prop-label">Size</label>
      <select id="xm-size" class="select-in">
        <option value="1080x1080">Square · 1080×1080 (Instagram/TikTok)</option>
        <option value="1080x1920">Vertical · 1080×1920 (Stories/Reels)</option>
        <option value="1920x1080">Landscape · 1920×1080</option>
        <option value="720x720">Square · 720×720 (faster)</option>
      </select></div>
    <div class="prop-row"><label class="prop-label">Duration (s)</label>
      <input id="xm-seconds" class="num-in" type="number" min="1" max="${MAX_EXPORT_SECONDS}" step="0.5" value="4"></div>
    <div class="prop-row"><label class="prop-label">Frame rate</label>
      <select id="xm-fps" class="select-in"></select></div>
    <p class="muted">Uses the current camera angle and the ${app.pipeline === 'deferred' ? 'PBR · Deferred' : 'PBR · Forward'} pipeline. Renders in the background — the viewport keeps playing.</p>
    <div id="xm-progress-wrap" class="xm-progress-wrap hidden">
      <div class="xm-progress-bar"><div id="xm-progress-fill" class="xm-progress-fill"></div></div>
      <span id="xm-progress-text" class="muted"></span>
    </div>
    <p id="xm-err" class="muted" style="color:var(--danger);min-height:16px"></p>
    <div class="btn-row">
      <button id="xm-go" class="btn btn-accent">Start Export</button>
      <button id="xm-cancel" class="btn hidden">Cancel</button>
    </div>
    <div id="xm-result"></div>`;
  const { overlay } = modal('Export Video / GIF', div);

  const fpsSel = div.querySelector('#xm-fps');
  const fmtBtns = [...div.querySelectorAll('#xm-format .seg-btn')];
  let format = 'video';
  const setFps = () => {
    const opts = format === 'gif'
      ? [['10', '10 fps'], ['15', '15 fps'], ['20', '20 fps']]
      : [['24', '24 fps'], ['30', '30 fps'], ['60', '60 fps']];
    fpsSel.innerHTML = '';
    for (const [v, label] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      fpsSel.appendChild(o);
    }
    fpsSel.value = format === 'gif' ? '15' : '30';
  };
  setFps();
  fmtBtns.forEach((b) => b.addEventListener('click', () => {
    format = b.dataset.fmt;
    fmtBtns.forEach((x) => x.classList.toggle('active', x === b));
    setFps();
  }));

  const signal = { cancelled: false };
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) signal.cancelled = true; });

  div.querySelector('#xm-go').addEventListener('click', async () => {
    const err = div.querySelector('#xm-err');
    const go = div.querySelector('#xm-go');
    const cancelBtn = div.querySelector('#xm-cancel');
    const progWrap = div.querySelector('#xm-progress-wrap');
    const progFill = div.querySelector('#xm-progress-fill');
    const progText = div.querySelector('#xm-progress-text');
    err.textContent = '';
    div.querySelector('#xm-result').innerHTML = '';
    signal.cancelled = false;

    if (format === 'video' && !getVideoMimeType()) {
      err.textContent = 'Video recording is not supported in this browser — try GIF instead.';
      return;
    }

    const [w, h] = div.querySelector('#xm-size').value.split('x').map(Number);
    const seconds = Math.max(1, Math.min(MAX_EXPORT_SECONDS, parseFloat(div.querySelector('#xm-seconds').value) || 4));
    const fps = parseInt(fpsSel.value, 10);

    go.disabled = true;
    go.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    progWrap.classList.remove('hidden');
    progFill.style.width = '0%';
    // Setup — a second device, the shader compiles, the compute sims warming
    // up — runs before the first frame, and on a compute-heavy effect it is
    // long enough that a stuck "Rendering… 0%" would read as a hang. The first
    // onProgress call overwrites this.
    progText.textContent = 'Preparing…';

    const onProgress = (p) => {
      progFill.style.width = `${Math.round(Math.min(1, p) * 100)}%`;
      progText.textContent = p >= 1 ? 'Encoding…' : `Rendering… ${Math.round(p * 100)}%`;
    };
    cancelBtn.addEventListener('click', () => { signal.cancelled = true; }, { once: true });

    try {
      // withCache: the export renders on its own device through EffectPlayer,
      // which builds its pipelines from the WGSL travelling with the effect.
      // Handing it what the editor already compiled keeps every shader out of
      // Slang on the way to the first frame; without it the export falls back
      // to recompiling all of them from source.
      const result = await (format === 'video' ? exportVideo : exportGif)({
        data: currentData({ withCache: true }),
        camera, w, h, fps, seconds, pipeline: app.pipeline, onProgress, signal,
      });
      if (!result) {
        toast('Export cancelled');
      } else {
        const filename = `${(app.name || 'effect').replace(/[^\w-]+/g, '_')}.${result.ext}`;
        downloadBlob(result.blob, filename);
        const url = URL.createObjectURL(result.blob);
        const preview = result.ext === 'gif'
          ? `<img src="${url}" style="max-width:100%;border-radius:8px">`
          : `<video src="${url}" controls autoplay loop muted style="max-width:100%;border-radius:8px"></video>`;
        div.querySelector('#xm-result').innerHTML =
          `<p>✔ Exported (${(result.blob.size / 1024 / 1024).toFixed(1)} MB) — downloaded as ${filename}</p>${preview}`;
        toast('Export ready');
      }
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      go.disabled = false;
      go.classList.remove('hidden');
      cancelBtn.classList.add('hidden');
      progWrap.classList.add('hidden');
    }
  });
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
  await api.initBackend().catch(() => {});

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
  if (!loaded && id && api.backendConfigured()) {
    try {
      const row = await api.getParticle(id);
      if (row) {
        applyData(row.data);
        app.name = row.title || app.name;
        document.getElementById('fx-name').value = app.name;
        if (!row.legacy) {
          Object.assign(cloud, {
            id: row.id,
            owner: row.owner,
            description: row.description || '',
            tags: row.tags || [],
            visibility: row.visibility || 'public',
          });
        }
        loaded = true;
        toast(isCloudOwner()
          ? 'Editing your published particle — Save ↑ updates it'
          : `Loaded “${row.title}” — Publish saves your own remix`);
      }
    } catch { /* fall through to default preset */ }
  }
  if (!loaded) applyData(PRESETS['Campfire']());

  updatePublishButton();
  window.addEventListener('pt:auth', updatePublishButton);
  requestAnimationFrame((t) => { last = t; tick(t); });
}

boot();
