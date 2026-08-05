// Inspector UI (emitters / materials / scene), shader editor panel,
// modals, toasts, and the shader API help text.

import { CurveEditor, GradientEditor, linToHex, hexToLin } from './widgets.js';
import { CodeEditor } from './editor.js';
import { defaultEmitterParams, MAX_CAPACITY } from './particles.js';
import { makeMaterial } from './materials.js';
import { PROPS_SIM_SRC, FIELD_TYPES } from './simlib.js';

// ---------------------------------------------------------------- primitives
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(label, ...controls) {
  const r = el('div', 'prop-row');
  const l = el('label', 'prop-label', label);
  r.appendChild(l);
  const c = el('div', 'prop-controls');
  for (const ctl of controls) c.appendChild(ctl);
  r.appendChild(c);
  return r;
}

function numIn(v, onCh, { step = 0.1, min, max, w } = {}) {
  const i = el('input', 'num-in');
  i.type = 'number';
  i.step = step;
  if (min !== undefined) i.min = min;
  if (max !== undefined) i.max = max;
  if (w) i.style.width = w + 'px';
  i.value = typeof v === 'number' ? +v.toFixed(4) : v;
  i.addEventListener('change', () => {
    let x = parseFloat(i.value);
    if (Number.isNaN(x)) x = 0;
    if (min !== undefined) x = Math.max(min, x);
    if (max !== undefined) x = Math.min(max, x);
    i.value = x;
    onCh(x);
  });
  return i;
}

function slider(v, onCh, { min = 0, max = 1, step = 0.01 } = {}) {
  const wrap = el('div', 'slider-wrap');
  const s = el('input');
  s.type = 'range';
  s.min = min; s.max = max; s.step = step; s.value = v;
  const n = numIn(v, (x) => { s.value = x; onCh(x); }, { step, min, max, w: 52 });
  s.addEventListener('input', () => { n.value = s.value; onCh(parseFloat(s.value)); });
  wrap.append(s, n);
  return wrap;
}

function vec3In(arr, onCh, opts = {}) {
  const wrap = el('div', 'vec-wrap');
  for (let i = 0; i < 3; i++) {
    wrap.appendChild(numIn(arr[i], (x) => { arr[i] = x; onCh(); }, { step: 0.1, w: 52, ...opts }));
  }
  return wrap;
}

function range2In(arr, onCh, opts = {}) {
  const wrap = el('div', 'vec-wrap');
  wrap.appendChild(numIn(arr[0], (x) => { arr[0] = x; onCh(); }, { step: 0.1, w: 60, ...opts }));
  wrap.appendChild(el('span', 'range-sep', '–'));
  wrap.appendChild(numIn(arr[1], (x) => { arr[1] = x; onCh(); }, { step: 0.1, w: 60, ...opts }));
  return wrap;
}

function check(v, onCh) {
  const i = el('input');
  i.type = 'checkbox';
  i.checked = !!v;
  i.addEventListener('change', () => onCh(i.checked));
  return i;
}

function selectIn(options, v, onCh) {
  const s = el('select', 'select-in');
  for (const [val, label] of options) {
    const o = el('option', null, label);
    o.value = val;
    s.appendChild(o);
  }
  s.value = v;
  s.addEventListener('change', () => onCh(s.value));
  return s;
}

function colorIn(arr, onCh) {
  const i = el('input', 'color-in');
  i.type = 'color';
  i.value = linToHex(arr);
  i.addEventListener('input', () => {
    const c = hexToLin(i.value);
    arr[0] = c[0]; arr[1] = c[1]; arr[2] = c[2];
    onCh();
  });
  return i;
}

function colorRGBAIn(arr, onCh) {
  const wrap = el('div', 'vec-wrap');
  wrap.appendChild(colorIn(arr, onCh));
  wrap.appendChild(numIn(arr[3], (x) => { arr[3] = x; onCh(); }, { step: 0.05, min: 0, max: 1, w: 48 }));
  return wrap;
}

function btn(label, onClick, cls = 'btn') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function section(parent, title, open = true) {
  const d = el('details', 'section');
  d.open = open;
  d.appendChild(el('summary', null, title));
  const body = el('div', 'section-body');
  d.appendChild(body);
  parent.appendChild(d);
  return body;
}

// ---------------------------------------------------------------- modal/toast
export function modal(title, contentNode, { wide } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal-box' + (wide ? ' modal-wide' : ''));
  const head = el('div', 'modal-head');
  head.appendChild(el('span', 'modal-title', title));
  const close = btn('✕', () => overlay.remove(), 'btn btn-icon');
  head.appendChild(close);
  box.appendChild(head);
  const body = el('div', 'modal-body');
  if (typeof contentNode === 'string') body.innerHTML = contentNode;
  else body.appendChild(contentNode);
  box.appendChild(body);
  overlay.appendChild(box);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.remove(); });
  root.appendChild(overlay);
  return { overlay, body };
}

let toastTimer = null;
export function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- inspector
export function buildInspector(app) {
  const root = document.getElementById('inspector');
  root.innerHTML = '';

  // ---- emitter list
  const emBody = section(root, 'Emitters');
  const list = el('div', 'emitter-list');
  app.emitters.forEach((em, i) => {
    const item = el('div', 'emitter-item' + (i === app.selEmitter ? ' selected' : ''));
    const cb = check(em.p.enabled, (v) => { em.p.enabled = v; });
    cb.title = 'enabled';
    item.appendChild(cb);
    const name = el('span', 'emitter-name', em.p.name);
    name.addEventListener('click', () => app.selectEmitter(i));
    item.appendChild(name);
    item.appendChild(el('span', 'emitter-count', ''));
    list.appendChild(item);
  });
  emBody.appendChild(list);
  const emBtns = el('div', 'btn-row');
  emBtns.append(
    btn('+ Add', () => {
      const p = defaultEmitterParams();
      p.name = `Emitter ${app.emitters.length + 1}`;
      p.materialId = app.materials[0]?.id ?? null;
      app.addEmitter(p);
    }),
    btn('Duplicate', () => app.duplicateEmitter(app.selEmitter)),
    btn('Delete', () => app.removeEmitter(app.selEmitter)),
  );
  emBody.appendChild(emBtns);

  const em = app.emitters[app.selEmitter];
  if (em) buildEmitterSections(root, app, em);

  buildMaterialSections(root, app);
  buildSceneSection(root, app);
}

function buildEmitterSections(root, app, em) {
  const p = em.p;
  const lut = () => app.markLut(em);

  // ---- general
  const g = section(root, `Emitter — ${p.name}`);
  {
    const nameIn = el('input', 'text-in');
    nameIn.value = p.name;
    nameIn.addEventListener('change', () => { p.name = nameIn.value || 'Emitter'; buildInspector(app); });
    g.appendChild(row('Name', nameIn));
    g.appendChild(row('Position', vec3In(p.position, () => {})));
    g.appendChild(row('Duration (s)', numIn(p.duration, (x) => { p.duration = Math.max(0.05, x); }, { min: 0.05, step: 0.5 })));
    g.appendChild(row('Looping', check(p.looping, (v) => { p.looping = v; })));
  }

  // ---- simulation
  const sim = section(root, 'Simulation');
  {
    sim.appendChild(row('Mode', selectIn(
      [['props', 'Properties (CPU)'], ['shader', 'Compute shader (GPU)']],
      p.simMode, (v) => {
        p.simMode = v;
        if (v === 'shader' && !p.simSrc.trim()) p.simSrc = PROPS_SIM_SRC;
        app.markSim(em);
        buildInspector(app);
      },
    )));
    if (p.simMode === 'props') {
      const cv = btn('Convert to sim shader ▸', () => {
        if (!p.simSrc.trim()) p.simSrc = PROPS_SIM_SRC;
        p.simMode = 'shader';
        app.markSim(em);
        buildInspector(app);
        app.openSimInEditor?.();
      });
      cv.title = 'Switch this emitter to a GPU compute simulation you can edit — starts from the exact behavior the properties produce';
      sim.appendChild(cv);
    } else {
      sim.appendChild(btn('Edit sim shader ▸', () => app.openSimInEditor?.(), 'btn btn-small'));
      const fl = el('div', 'burst-list');
      p.fields.forEach((f, fi) => {
        const r = el('div', 'burst-row');
        const nameIn = el('input', 'text-in');
        nameIn.style.width = '110px';
        nameIn.value = f.name;
        nameIn.addEventListener('change', () => {
          const clean = nameIn.value.replace(/\W/g, '').replace(/^\d+/, '');
          if (clean) f.name = clean;
          app.markSim(em);
          buildInspector(app);
        });
        r.appendChild(nameIn);
        r.appendChild(selectIn(FIELD_TYPES.map((t) => [t, t]), f.type, (v) => {
          f.type = v;
          app.markSim(em);
        }));
        r.appendChild(btn('✕', () => {
          p.fields.splice(fi, 1);
          app.markSim(em);
          buildInspector(app);
        }, 'btn btn-icon'));
        fl.appendChild(r);
      });
      sim.appendChild(row('Fields', fl));
      sim.appendChild(btn('+ Add field', () => {
        p.fields.push({ name: `field${p.fields.length + 1}`, type: 'f32' });
        app.markSim(em);
        buildInspector(app);
      }));
      const note = el('p', null,
        'Custom fields become members of the sim\'s Particle struct. The sections below still feed sp.* uniforms — the default sim uses them; a custom sim may ignore them. '
        + 'Size / Color / Alpha over life are the exception: those are applied when the particle is drawn, so they keep working whatever the sim does.');
      note.className = 'muted';
      note.style.fontSize = '11px';
      sim.appendChild(note);
    }
  }

  // ---- spawn
  const sp = section(root, 'Spawn');
  {
    sp.appendChild(row('Rate (/s)', numIn(p.spawn.rate, (x) => { p.spawn.rate = Math.max(0, x); }, { min: 0, step: 1 })));
    sp.appendChild(row('Max particles', numIn(p.spawn.max, (x) => {
      p.spawn.max = Math.max(1, Math.round(x));
    }, { min: 1, max: MAX_CAPACITY, step: 50 })));
    const bl = el('div', 'burst-list');
    p.spawn.bursts.forEach((b, bi) => {
      const r = el('div', 'burst-row');
      r.appendChild(el('span', 'burst-label', 't='));
      r.appendChild(numIn(b.time, (x) => { b.time = Math.max(0, x); }, { min: 0, step: 0.1, w: 56 }));
      r.appendChild(el('span', 'burst-label', 'count'));
      r.appendChild(numIn(b.count, (x) => { b.count = Math.max(1, Math.round(x)); }, { min: 1, step: 10, w: 56 }));
      r.appendChild(btn('✕', () => { p.spawn.bursts.splice(bi, 1); buildInspector(app); }, 'btn btn-icon'));
      bl.appendChild(r);
    });
    sp.appendChild(row('Bursts', bl));
    sp.appendChild(btn('+ Add burst', () => { p.spawn.bursts.push({ time: 0, count: 30 }); buildInspector(app); }));
  }

  // ---- lifetime & shape
  const ls = section(root, 'Lifetime & Shape');
  {
    ls.appendChild(row('Lifetime (s)', range2In(p.lifetime, () => {}, { min: 0.01 })));
    ls.appendChild(row('Shape', selectIn(
      [['point', 'Point'], ['sphere', 'Sphere'], ['hemisphere', 'Hemisphere'], ['cone', 'Cone'], ['box', 'Box'], ['circle', 'Circle']],
      p.shape.type, (v) => { p.shape.type = v; buildInspector(app); },
    )));
    if (p.shape.type === 'sphere' || p.shape.type === 'hemisphere' || p.shape.type === 'cone' || p.shape.type === 'circle') {
      ls.appendChild(row('Radius', numIn(p.shape.radius, (x) => { p.shape.radius = Math.max(0, x); }, { min: 0, step: 0.05 })));
    }
    if (p.shape.type === 'cone') {
      ls.appendChild(row('Cone angle°', numIn(p.shape.angle, (x) => { p.shape.angle = x; }, { min: 0, max: 89, step: 1 })));
    }
    if (p.shape.type === 'box') {
      ls.appendChild(row('Box size', vec3In(p.shape.boxSize, () => {}, { min: 0 })));
    }
    ls.appendChild(row('Speed', range2In(p.speed, () => {})));
    ls.appendChild(row('Spread', slider(p.spread, (x) => { p.spread = x; })));
  }

  // ---- motion
  const mo = section(root, 'Velocity & Gravity');
  {
    mo.appendChild(row('Gravity', vec3In(p.gravity, () => {})));
    mo.appendChild(row('Drag', numIn(p.drag, (x) => { p.drag = Math.max(0, x); }, { min: 0, step: 0.1 })));
    const cw = el('div', 'curve-holder');
    // Must dirty the LUT: the CPU sim reads this curve object directly every
    // frame, but a compute sim samples the baked texture — without this, edits
    // are invisible in shader mode until some other curve triggers a re-bake.
    new CurveEditor(cw, { curve: p.speedOverLife, vMin: 0, vMax: 2, onChange: lut });
    mo.appendChild(row('Speed / life', cw));
  }

  // ---- size & rotation
  const sr = section(root, 'Size & Rotation');
  {
    sr.appendChild(row('Start size', range2In(p.sizeStart, () => {}, { min: 0.001 })));
    const cw = el('div', 'curve-holder');
    new CurveEditor(cw, { curve: p.sizeOverLife, vMin: 0, vMax: 3, onChange: lut });
    sr.appendChild(row('Size / life', cw));
    sr.appendChild(row('Start rot°', range2In(p.rotationStart, () => {}, { step: 15 })));
    sr.appendChild(row('Rot speed°/s', range2In(p.rotationSpeed, () => {}, { step: 15 })));
  }

  // ---- color
  const co = section(root, 'Color & Alpha');
  {
    co.appendChild(row('Start color A', colorRGBAIn(p.colorStartA, () => {})));
    co.appendChild(row('Start color B', colorRGBAIn(p.colorStartB, () => {})));
    const gw = el('div', 'curve-holder');
    new GradientEditor(gw, { gradient: p.colorOverLife, onChange: lut });
    co.appendChild(row('Color / life', gw));
    const aw = el('div', 'curve-holder');
    new CurveEditor(aw, { curve: p.alphaOverLife, vMin: 0, vMax: 1, onChange: lut });
    co.appendChild(row('Alpha / life', aw));
  }

  // ---- rendering
  const re = section(root, 'Rendering');
  {
    re.appendChild(row('Material', selectIn(
      app.materials.map((m) => [m.id, m.name]), p.materialId,
      (v) => { p.materialId = v; },
    )));
    re.appendChild(row('Mesh', selectIn(
      [['quad', 'Quad (billboard)'], ['sphere', 'Sphere'], ['cube', 'Cube'], ['custom', 'Custom (OBJ)']],
      p.meshType, (v) => { p.meshType = v; buildInspector(app); },
    )));
    if (p.meshType === 'custom') {
      const ta = el('textarea', 'obj-in');
      ta.placeholder = 'Paste Wavefront OBJ here (v / vn / vt / f)…';
      ta.value = p.customMeshObj;
      re.appendChild(ta);
      re.appendChild(btn('Apply mesh', () => { p.customMeshObj = ta.value; }));
    }
  }
}

function buildMaterialSections(root, app) {
  const mb = section(root, 'Materials', true);
  for (const m of app.materials) {
    const box = el('div', 'material-box');
    const head = el('div', 'material-head');
    head.appendChild(el('span', 'material-name', m.name));
    head.appendChild(btn('Edit shaders ▸', () => app.openMaterialInEditor(m.id), 'btn btn-small'));
    box.appendChild(head);

    const nameIn = el('input', 'text-in');
    nameIn.value = m.name;
    nameIn.addEventListener('change', () => { m.name = nameIn.value || 'Material'; app.refreshUI(); });
    box.appendChild(row('Name', nameIn));
    box.appendChild(row('Blend', selectIn(
      [['opaque', 'Opaque'], ['cutout', 'Cutout'], ['blend', 'Alpha Blend'], ['add', 'Additive']],
      m.blendMode, (v) => { m.blendMode = v; app.markMaterial(m.id); },
    )));
    box.appendChild(row('Lit (PBR)', check(m.lit, (v) => { m.lit = v; app.markMaterial(m.id); })));
    box.appendChild(row('Double-sided', check(m.doubleSided, (v) => { m.doubleSided = v; })));
    box.appendChild(row('Soft particles', check(m.softParticles, (v) => { m.softParticles = v; app.markMaterial(m.id); })));
    if (m.softParticles) {
      box.appendChild(row('Soft distance', numIn(m.softDistance, (x) => { m.softDistance = Math.max(0.01, x); }, { min: 0.01, step: 0.1 })));
    }
    if (m.blendMode === 'cutout') {
      box.appendChild(row('Alpha cutoff', slider(m.alphaCutoff, (x) => { m.alphaCutoff = x; })));
    }
    box.appendChild(btn('Delete material', () => app.removeMaterial(m.id), 'btn btn-small btn-danger'));
    mb.appendChild(box);
  }
  mb.appendChild(btn('+ New material', () => {
    const m = makeMaterial({ name: `Material ${app.materials.length + 1}` });
    app.addMaterial(m);
  }));
}

function buildSceneSection(root, app) {
  const s = app.scene;
  const sc = section(root, 'Scene & Lighting', false);
  sc.appendChild(row('Sun azimuth°', slider(s.sunAzimuth, (x) => { s.sunAzimuth = x; }, { min: 0, max: 360, step: 1 })));
  sc.appendChild(row('Sun elevation°', slider(s.sunElevation, (x) => { s.sunElevation = x; }, { min: 2, max: 89, step: 1 })));
  sc.appendChild(row('Sun color', colorIn(s.sunColor, () => {})));
  sc.appendChild(row('Sun intensity', slider(s.sunIntensity, (x) => { s.sunIntensity = x; }, { min: 0, max: 8, step: 0.1 })));
  sc.appendChild(row('Ambient', slider(s.ambient, (x) => { s.ambient = x; }, { min: 0, max: 3, step: 0.05 })));
  sc.appendChild(row('Sky top', colorIn(s.skyTop, () => {})));
  sc.appendChild(row('Sky bottom', colorIn(s.skyBottom, () => {})));
  s.pointLights.forEach((l, i) => {
    const box = el('div', 'material-box');
    box.appendChild(row(`Point light ${i + 1}`, check(l.enabled, (v) => { l.enabled = v; })));
    box.appendChild(row('Position', vec3In(l.pos, () => {})));
    box.appendChild(row('Color', colorIn(l.color, () => {})));
    box.appendChild(row('Intensity', slider(l.intensity, (x) => { l.intensity = x; }, { min: 0, max: 12, step: 0.1 })));
    sc.appendChild(box);
  });
  sc.appendChild(row('Floor', check(s.showFloor, (v) => { s.showFloor = v; })));
  sc.appendChild(row('Grid', check(s.showGrid, (v) => { s.showGrid = v; })));
  sc.appendChild(row('Exposure', slider(s.exposure, (x) => { s.exposure = x; }, { min: 0.1, max: 3, step: 0.05 })));
  sc.appendChild(row('Bloom', slider(s.bloom, (x) => { s.bloom = x; }, { min: 0, max: 2, step: 0.05 })));
  sc.appendChild(row('Bloom threshold', slider(s.bloomThreshold, (x) => { s.bloomThreshold = x; }, { min: 0, max: 3, step: 0.05 })));
}

// ---------------------------------------------------------------- editor panel
export class EditorPanel {
  constructor(app) {
    this.app = app;
    this.materialId = null;
    this.tab = 'fs';
    this.autoApply = true;
    this._debounce = null;
    // What the visible text was loaded from: {tab, id, src}. The buffer is
    // written back to *this* target, not to whatever happens to be selected
    // when it is flushed — the selected emitter, and the whole document, can
    // change out from under it. `src` is the text as loaded, so an untouched
    // buffer never overwrites edits made elsewhere.
    this.buf = null;

    this.toolbar = document.getElementById('editor-toolbar');
    this.errorsEl = document.getElementById('editor-errors');
    this.editor = new CodeEditor(document.getElementById('editor-host'), {
      onChange: () => this._scheduleApply(),
      onSubmit: () => this.commit(),
    });
    this._buildToolbar();
  }

  _buildToolbar() {
    const t = this.toolbar;
    t.innerHTML = '';
    this.matSelect = selectIn(this.app.materials.map((m) => [m.id, m.name]), this.materialId ?? '', (v) => this.show(v, this.tab));
    this.matSelect.classList.add('editor-mat-select');
    t.appendChild(this.matSelect);

    this.tabVS = btn('Vertex', () => this.show(this.materialId, 'vs'), 'btn tab-btn');
    this.tabFS = btn('Fragment', () => this.show(this.materialId, 'fs'), 'btn tab-btn');
    this.tabSim = btn('Sim', () => this.show(this.materialId, 'sim'), 'btn tab-btn');
    this.tabSim.title = 'Compute simulation of the selected emitter';
    t.append(this.tabVS, this.tabFS, this.tabSim);

    const spacer = el('div', 'flex-spacer');
    t.appendChild(spacer);

    const autoLabel = el('label', 'auto-label');
    const autoCb = check(this.autoApply, (v) => { this.autoApply = v; });
    autoLabel.append(autoCb, document.createTextNode(' auto'));
    t.appendChild(autoLabel);
    t.appendChild(btn('▶ Compile', () => this.commit(), 'btn btn-accent'));
    t.appendChild(btn('?', () => showHelp(), 'btn btn-icon'));
  }

  refreshMaterials() {
    const cur = this.materialId;
    this._buildToolbar();
    const exists = this.app.materials.some((m) => m.id === cur);
    this.show(exists ? cur : this.app.materials[0]?.id, this.tab);
  }

  show(materialId, tab = 'fs') {
    // save pending edits of the previous buffer first
    this._commitBuffer();
    this.materialId = materialId;
    this.tab = tab;
    const m = this.app.materials.find((x) => x.id === materialId);
    this.matSelect.value = materialId ?? '';
    this.matSelect.disabled = tab === 'sim';
    this.tabVS.classList.toggle('active', tab === 'vs');
    this.tabFS.classList.toggle('active', tab === 'fs');
    this.tabSim.classList.toggle('active', tab === 'sim');
    if (tab === 'sim') {
      const em = this.app.emitters[this.app.selEmitter];
      this._load(em ? { tab, id: em.p.id } : null, em ? em.p.simSrc : '');
      this._showErrors(em ? (this.app.simErrors?.get(em.p.id) ?? []) : []);
      if (em && em.p.simMode !== 'shader') {
        const note = el('div', 'compile-err',
          'ℹ Sim shader is inactive — set the emitter\'s Simulation mode to "Compute shader (GPU)".');
        this.errorsEl.prepend(note);
      }
    } else {
      this._load(m ? { tab, id: m.id } : null, m ? (tab === 'vs' ? m.vertexSrc : m.fragmentSrc) : '');
      this._showErrors(this.app.materialErrors?.get(materialId) ?? []);
    }
  }

  // The Sim tab always shows the selected emitter, so re-point the buffer when
  // the selection moves — otherwise it keeps showing the previous emitter's code.
  onEmitterChanged() {
    if (this.tab === 'sim') this.show(this.materialId, 'sim');
  }

  /**
   * Drop the pending buffer without writing it back, and cancel any queued
   * auto-apply. Call before the document is swapped out (preset load, import,
   * share link): the text on screen belongs to the outgoing effect and must
   * not land in whatever occupies that slot in the incoming one.
   */
  discardBuffer() {
    clearTimeout(this._debounce);
    this.buf = null;
  }

  _load(target, src) {
    this.buf = target ? { ...target, src: src ?? '' } : null;
    this.editor.setValue(src);
  }

  _scheduleApply() {
    if (!this.autoApply) return;
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.commit(), 800);
  }

  _commitBuffer() {
    const buf = this.buf;
    if (!buf) return false;
    const v = this.editor.getValue();
    if (v === buf.src) return false; // untouched — nothing of the user's to save
    buf.src = v;
    if (buf.tab === 'sim') {
      const em = this.app.emitters.find((x) => x.p.id === buf.id);
      if (!em) return false; // emitter is gone (deleted, or a new effect loaded)
      em.p.simSrc = v;
      return true;
    }
    const m = this.app.materials.find((x) => x.id === buf.id);
    if (!m) return false;
    m[buf.tab === 'vs' ? 'vertexSrc' : 'fragmentSrc'] = v;
    return true;
  }

  commit() {
    clearTimeout(this._debounce);
    const buf = this.buf;
    if (!buf) return;
    this._commitBuffer();
    if (buf.tab === 'sim') {
      const em = this.app.emitters.find((x) => x.p.id === buf.id);
      if (em) this.app.markSim(em);
      return;
    }
    this.app.markMaterial(buf.id); // always recompile, so errors resurface
  }

  onCompiled(materialId, errors) {
    if (this.tab === 'sim' || materialId !== this.materialId) return;
    this._showErrors(errors);
  }

  onSimCompiled(emitterId, errors) {
    if (this.tab !== 'sim' || this.buf?.id !== emitterId) return;
    this._showErrors(errors);
  }

  _showErrors(errors) {
    const stage = this.tab === 'vs' ? 'vertex' : this.tab === 'sim' ? 'sim' : 'fragment';
    this.editor.setErrors(errors.filter((e) => e.stage === stage));
    this.errorsEl.innerHTML = '';
    if (!errors.length) {
      this.errorsEl.appendChild(el('div', 'compile-ok', '✓ compiled'));
      return;
    }
    const label = { vertex: 'VS', fragment: 'FS', sim: 'SIM' };
    for (const e of errors.slice(0, 12)) {
      const d = el('div', 'compile-err', `${label[e.stage] || e.stage}${e.variant ? ` · ${e.variant}` : ''} — line ${e.line}: ${e.msg}`);
      this.errorsEl.appendChild(d);
    }
  }
}

// ---------------------------------------------------------------- help
export function showHelp() {
  modal('Shader API Reference', HELP_HTML, { wide: true });
}

const HELP_HTML = `
<div class="help">
<p>Materials have a <b>programmable vertex and fragment stage</b> written in
<b>WGSL</b> (the WebGPU shading language), wrapped shadertoy-style. The engine
handles instancing, billboarding, curves and lighting — you write two small functions.
The first parameter is a pointer: write through it directly (<code>s.albedo = ...</code>).</p>

<h3>Vertex stage</h3>
<pre>fn mainVertex(v: ptr&lt;function, VertexData&gt;, p: Particle)</pre>
<pre>struct VertexData { positionWS: vec3f, normalWS: vec3f, uv: vec2f }
struct Particle {
  center: vec3f,    // particle center (world)
  velocity: vec3f,  // world-space velocity
  color: vec4f,     // start color × color/alpha-over-life
  size: f32,        // after size-over-life
  rotation: f32,    // radians
  life: f32,        // normalized 0..1
  seed: f32,        // stable per-particle random 0..1
}</pre>
<p>Example — stretch billboards along velocity:</p>
<pre>v.positionWS += p.velocity * 0.06 * (v.uv.y - 0.5) * 2.0;</pre>

<h3>Fragment stage — PBR surface</h3>
<pre>fn mainSurface(s: ptr&lt;function, Surface&gt;, i: SurfaceInput)</pre>
<pre>struct Surface {
  albedo: vec3f,    // base color
  metallic: f32,    // 0..1
  roughness: f32,   // 0..1
  normal: vec3f,    // world space (defaults to geometric normal)
  emissive: vec3f,  // HDR glow, added after lighting (drives bloom)
  occlusion: f32,   // ambient occlusion 0..1
  alpha: f32,
}
struct SurfaceInput {
  uv: vec2f,  color: vec4f,  life: f32,  seed: f32,
  positionWS: vec3f,  normalWS: vec3f,  viewDirWS: vec3f,
}</pre>
<p>In the <b>Deferred</b> pipeline, opaque/cutout surfaces are written to the G-buffer and lit
in a fullscreen pass; blended particles are forward-lit. In the <b>Forward</b> pipeline
everything is lit inline. Unlit materials skip lighting: output = albedo + emissive.</p>

<h3>Reading the scene &amp; G-buffer</h3>
<p>A fragment stage can sample what is already behind the particle. In the
<b>Deferred</b> pipeline the blended pass runs after the G-buffer and lighting passes,
so the whole G-buffer is readable — this is what makes refraction, distortion and
scene-aware tinting possible.</p>
<pre>fn screenUV() -> vec2f           // this fragment's screen UV, 0..1
fn gbufferAvailable() -> bool    // true only in Deferred, on a blended material
fn sampleGBuffer(uv: vec2f) -> GBuffer

fn sceneDepth(uv: vec2f) -> f32        // raw 0..1 (1.0 = sky / nothing)
fn sceneLinearDepth(uv: vec2f) -> f32  // world units from the camera
fn sceneWorldPos(uv: vec2f) -> vec3f   // reconstructed world position</pre>
<pre>struct GBuffer {
  albedo: vec3f,     metallic: f32,
  normal: vec3f,     roughness: f32,   // normal is world space
  emissive: vec3f,   occlusion: f32,
  depth: f32,        linearDepth: f32,
  positionWS: vec3f,
  valid: bool,       // false on sky, or when no G-buffer is bound
}</pre>
<p>Example — refract the scene behind an additive/blended particle:</p>
<pre>let uv = screenUV();
let offset = i.normalWS.xy * 0.03 * i.color.a;
let g = sampleGBuffer(uv + offset);
s.emissive = g.albedo * 2.0;      // pick up what's behind
s.alpha = i.color.a;</pre>
<p>Example — fade out where the particle meets solid geometry:</p>
<pre>let d = sceneLinearDepth(screenUV()) - distance(u.cameraPos, i.positionWS);
s.alpha *= clamp(d / 0.4, 0.0, 1.0);</pre>
<p class="muted">The same functions exist in every variant so a material never fails to
compile, but an <b>opaque</b> surface is what <i>writes</i> the G-buffer and so cannot read
it, and the <b>Forward</b> pipeline has no G-buffer at all. In both cases
<code>gbufferAvailable()</code> is false and the material channels read as neutral
defaults — depth still works in Forward. Always branch on it, or on <code>g.valid</code>,
if your effect must survive a pipeline switch.</p>

<h3>Compute simulation (Sim tab)</h3>
<p>Each emitter can switch from the <b>Properties</b> sim (CPU) to a <b>compute
shader</b> sim (GPU) that scales to ~100k particles. You write two hooks; the
engine handles spawning budgets, slot recycling, culling dead particles and
(for alpha-blend) depth sorting — all on the GPU:</p>
<pre>fn spawn(p: ptr&lt;function, Particle&gt;, ctx: SpawnCtx)     // initialize a particle
fn simulate(p: ptr&lt;function, Particle&gt;, ctx: SimCtx)    // step it each frame</pre>
<pre>struct Particle {
  position: vec3f,  age: f32,
  velocity: vec3f,  lifetime: f32,   // spawn() must set lifetime
  color: vec4f,
  seed: f32,  size: f32,  rotation: f32,  rotVel: f32,
  // ...plus any custom fields you add in the Simulation section
}
struct SpawnCtx { index: u32, emitterPos: vec3f, time: f32 }
struct SimCtx   { index: u32, dt: f32, time: f32 }</pre>
<pre>rand() -> f32                   // fresh 0..1 each call, deterministic per particle
randRange(lo, hi) -> f32
randUnitVec() -> vec3f
curveSpeed(life01) -> f32       // the Speed/life curve — apply this yourself
curveSize(life01)  -> f32       // Size/life  ┐ already applied at draw time;
curveColor(life01) -> vec3f     // Color/life ├ read them, don't re-multiply
curveAlpha(life01) -> f32       // Alpha/life ┘
sp.*                            // every emitter property as a uniform:
   emitterPos gravity drag boxSize colorA colorB speedRange lifetimeRange
   sizeRange rotationRange rotSpeedRange spread shapeRadius shapeAngle
   shapeType capacity dt time</pre>

<h4>Over-lifetime curves</h4>
<p>The emitter's <b>/ life</b> curves are baked into one small lookup texture that the
sim and the renderer share. <b>Speed/life</b> is the sim's to apply — that's the
<code>curveSpeed()</code> call in the default <code>simulate()</code>, and deleting it
switches the curve off. <b>Size</b>, <b>Color</b> and <b>Alpha</b> over life are applied
when the particle is drawn instead, identically in both sim modes: <code>p.size</code> and
<code>p.color</code> are the values at birth and the curves scale them each frame. Those
three keep working whatever your sim does, so read them if you need the drawn size
(<code>p.size * curveSize(life01)</code>) but don't multiply them into the particle.</p>

<h4>Reading the other particles</h4>
<p><code>neighbors</code> is a read-only snapshot of the whole particle array as of
<i>last</i> frame — this is what a property editor fundamentally can't express, and
the reason flocking, trails and contact effects need a compute sim. Reading the live
array instead would race the writes other invocations are making right now, so the
engine copies it aside first (and only when your code actually mentions
<code>neighbors</code>, since the copy costs bandwidth).</p>
<pre>neighbors[j]          // a Particle; j in 0 .. sp.capacity-1
neighbors[j].lifetime &lt;= 0.0   // empty slot — skip it</pre>
<pre>// separation / alignment / cohesion over the neighbourhood
for (var j = 0u; j &lt; u32(sp.capacity); j++) {
  if (j == ctx.index) { continue; }
  let other = neighbors[j];
  if (other.lifetime &lt;= 0.0) { continue; }
  let delta = other.position - p.position;
  ...
}</pre>
<p class="muted">That loop is O(n²) — fine for a few hundred particles, but cap the
scan (<code>min(u32(sp.capacity), 1024u)</code>) so raising <b>Max particles</b> can't
lock the GPU. See the <b>Boids (compute)</b> preset for a complete example.</p>
<p>"Convert to sim shader" seeds the editor with the exact WGSL that reproduces
the property-editor behavior — sliders keep working through <code>sp.*</code>
until you replace them. Custom fields (e.g. a <code>home: vec3f</code> anchor or
a <code>phase: f32</code>) persist per particle across frames.</p>

<h3>Built-in uniforms (struct <code>u</code>)</h3>
<pre>u.time          effect time, seconds
u.resolution    canvas size in pixels
u.mouse         xy pixels (y-up), z = button down
u.cameraPos     world-space camera position</pre>

<h3>Built-in functions</h3>
<pre>hash11(f) hash21(v2) hash33(v3)   // fast hashes → 0..1
noise2(v2) noise3(v3)             // value noise
fbm2(v2) fbm3(v3)                 // 4-octave fbm
fmod(x, y) fmod3(v3, y)           // GLSL-style floor mod
PI, TAU</pre>

<h3>WGSL crib sheet (coming from GLSL)</h3>
<pre>vec3(...)  →  vec3f(...)          float x = 1.0;  →  let x = 1.0;   (or var)
mix / clamp: min/max args must match the vector type: clamp(v, vec3f(0.0), vec3f(1.0))
mod(x, y)  →  fmod(x, y)          statements need no forward declarations</pre>

<h3>Tips</h3>
<ul>
<li><b>Ctrl+Enter</b> compiles. Broken code keeps the last working shader running.</li>
<li>Use <code>s.emissive</code> with values &gt; 1 for glow — bloom picks it up.</li>
<li><code>i.color</code> already includes the color-over-life gradient and alpha-over-life curve.</li>
<li>Vary per particle with <code>i.seed</code> (e.g. <code>fbm2(uv + i.seed * 19.0)</code>).</li>
<li>Additive materials: alpha scales brightness; albedo is usually vec3f(0.0).</li>
</ul>
</div>`;
