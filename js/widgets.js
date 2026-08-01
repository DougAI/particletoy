// Canvas widgets: curve editor (Hermite spline w/ tangent handles) and gradient editor.

import { sortCurve, sortGradient, evalCurve, evalGradient, tangentAt } from './curves.js';
import { clamp } from './math3d.js';

const PAD = 8;
const HIT_R = 9;
const HANDLE_LEN = 30;
const T_RANGE_MIN = 0.02, T_RANGE_MAX = 4;
const V_RANGE_MIN = 1e-3, V_RANGE_MAX = 1e6;

function linToHex(c) {
  const s = c.map((x) => Math.round(Math.pow(clamp(x, 0, 1), 1 / 2.2) * 255));
  return '#' + s.map((v) => v.toString(16).padStart(2, '0')).join('');
}
function hexToLin(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [
    Math.pow(((n >> 16) & 255) / 255, 2.2),
    Math.pow(((n >> 8) & 255) / 255, 2.2),
    Math.pow((n & 255) / 255, 2.2),
  ];
}
export { linToHex, hexToLin };

export class CurveEditor {
  constructor(container, { curve, vMin = 0, vMax = 1, onChange }) {
    this.curve = curve;
    this.onChange = onChange;
    this.defaultView = { tMin: 0, tMax: 1, vMin, vMax };
    this.view = { ...this.defaultView };
    this.selected = null;
    this.drag = null;
    this.pinch = null;
    this.activePointers = new Map();

    this.wrap = document.createElement('div');
    this.wrap.className = 'curve-wrap';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'curve-canvas';
    this.wrap.appendChild(this.canvas);

    const viewTools = document.createElement('div');
    viewTools.className = 'curve-viewtools';
    this.fitBtn = document.createElement('button');
    this.fitBtn.type = 'button';
    this.fitBtn.className = 'btn btn-small';
    this.fitBtn.title = 'Fit view to keys';
    this.fitBtn.textContent = '⤢';
    this.resetBtn = document.createElement('button');
    this.resetBtn.type = 'button';
    this.resetBtn.className = 'btn btn-small';
    this.resetBtn.title = 'Reset view';
    this.resetBtn.textContent = '↺';
    viewTools.append(this.fitBtn, this.resetBtn);
    this.wrap.appendChild(viewTools);
    this.fitBtn.addEventListener('click', () => this.fitView());
    this.resetBtn.addEventListener('click', () => { this.view = { ...this.defaultView }; this.draw(); });

    container.appendChild(this.wrap);

    // Selected-key tools: precise numeric edit + tangent reset + delete —
    // dragging a point is imprecise on touch, so typing a value matters.
    const tools = document.createElement('div');
    tools.className = 'curve-tools';
    this.tIn = document.createElement('input');
    this.tIn.type = 'number';
    this.tIn.step = '0.01';
    this.tIn.className = 'num-in curve-num-in';
    this.tIn.title = 'Key position (life 0–1)';
    this.vIn = document.createElement('input');
    this.vIn.type = 'number';
    this.vIn.step = '0.01';
    this.vIn.className = 'num-in curve-num-in';
    this.vIn.title = 'Key value';
    this.autoBtn = document.createElement('button');
    this.autoBtn.type = 'button';
    this.autoBtn.className = 'btn btn-small';
    this.autoBtn.textContent = 'Smooth';
    this.autoBtn.title = 'Reset tangents to auto-smoothed';
    this.delBtn = document.createElement('button');
    this.delBtn.type = 'button';
    this.delBtn.className = 'btn btn-small btn-danger';
    this.delBtn.textContent = 'Delete';
    this.hint = document.createElement('span');
    this.hint.className = 'curve-hint muted';
    this.hint.textContent = 'Double-click to add a point · drag handles for tangents';
    tools.append(this.tIn, this.vIn, this.autoBtn, this.delBtn, this.hint);
    container.appendChild(tools);

    this.tIn.addEventListener('change', () => this._applyNumericEdit());
    this.vIn.addEventListener('change', () => this._applyNumericEdit());
    this.autoBtn.addEventListener('click', () => {
      const k = this.curve.keys[this.selected];
      if (!k) return;
      delete k.tanIn;
      delete k.tanOut;
      this.draw();
      this.onChange?.();
    });
    this.delBtn.addEventListener('click', () => {
      if (this.selected === null || this.curve.keys.length <= 1) return;
      this.curve.keys.splice(this.selected, 1);
      this.selected = null;
      this._syncTools();
      this.draw();
      this.onChange?.();
    });

    this._bind();
    this._syncTools();
    // draw once laid out
    requestAnimationFrame(() => this.draw());
  }

  _dims() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 220;
    const h = this.canvas.clientHeight || 116;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    return { w, h, dpr };
  }

  _toPx(t, v, w, h) {
    const { tMin, tMax, vMin, vMax } = this.view;
    return [
      PAD + ((t - tMin) / (tMax - tMin)) * (w - PAD * 2),
      h - PAD - ((v - vMin) / (vMax - vMin)) * (h - PAD * 2),
    ];
  }

  /** Inverse of _toPx with no clamping — used for tangent handles & pan/zoom
   * anchors, which may legitimately sit outside the current key/view. */
  _fromPxFree(x, y, w, h) {
    const { tMin, tMax, vMin, vMax } = this.view;
    return [
      tMin + ((x - PAD) / (w - PAD * 2)) * (tMax - tMin),
      vMin + ((h - PAD - y) / (h - PAD * 2)) * (vMax - vMin),
    ];
  }

  /** Inverse of _toPx for dragging a key point: t is a life-fraction so it
   * stays clamped to [0,1]; v is left free so a drag can carry a value
   * outside the current view (the view no longer hard-limits the range). */
  _fromPx(x, y, w, h) {
    const [t, v] = this._fromPxFree(x, y, w, h);
    return [clamp(t, 0, 1), v];
  }

  _keyAt(x, y, w, h) {
    for (let i = 0; i < this.curve.keys.length; i++) {
      const k = this.curve.keys[i];
      const [px, py] = this._toPx(k.t, k.v, w, h);
      if (Math.abs(px - x) < HIT_R && Math.abs(py - y) < HIT_R) return i;
    }
    return -1;
  }

  /** Pixel position of key i's tangent handle on the given side. */
  _handlePx(i, side, w, h) {
    const k = this.curve.keys[i];
    const m = tangentAt(this.curve.keys, i, side);
    const pxPerT = (w - PAD * 2) / (this.view.tMax - this.view.tMin);
    const pxPerV = (h - PAD * 2) / (this.view.vMax - this.view.vMin);
    const dirT = side === 'out' ? 1 : -1;
    const dx = dirT * pxPerT;
    const dy = -dirT * m * pxPerV;
    const len = Math.hypot(dx, dy) || 1;
    const [kx, ky] = this._toPx(k.t, k.v, w, h);
    return [kx + (dx / len) * HANDLE_LEN, ky + (dy / len) * HANDLE_LEN];
  }

  /** Which handle of the selected key (if any) is under x,y — 'in', 'out', or null. */
  _handleAt(x, y, w, h) {
    if (this.selected === null) return null;
    const i = this.selected;
    const keys = this.curve.keys;
    if (i < keys.length - 1) {
      const [hx, hy] = this._handlePx(i, 'out', w, h);
      if (Math.abs(hx - x) < HIT_R && Math.abs(hy - y) < HIT_R) return 'out';
    }
    if (i > 0) {
      const [hx, hy] = this._handlePx(i, 'in', w, h);
      if (Math.abs(hx - x) < HIT_R && Math.abs(hy - y) < HIT_R) return 'in';
    }
    return null;
  }

  /** Zoom by `scale` (>1 zooms out) keeping the data point under `anchorPx`
   * fixed at `targetPx` — used for wheel-zoom (anchor==target) and pinch/pan
   * (anchor = last frame's centroid, target = this frame's). */
  _applyViewTransform(anchorPx, targetPx, scale, w, h) {
    const v = this.view;
    const pxPerT = (w - PAD * 2) / (v.tMax - v.tMin);
    const pxPerV = (h - PAD * 2) / (v.vMax - v.vMin);
    const anchorT = v.tMin + (anchorPx.x - PAD) / pxPerT;
    const anchorV = v.vMin + (h - PAD - anchorPx.y) / pxPerV;
    const tRange = clamp((v.tMax - v.tMin) * scale, T_RANGE_MIN, T_RANGE_MAX);
    const vRange = clamp((v.vMax - v.vMin) * scale, V_RANGE_MIN, V_RANGE_MAX);
    const newPxPerT = (w - PAD * 2) / tRange;
    const newPxPerV = (h - PAD * 2) / vRange;
    const tMin = anchorT - (targetPx.x - PAD) / newPxPerT;
    const vMin = anchorV - (h - PAD - targetPx.y) / newPxPerV;
    this.view = { tMin, tMax: tMin + tRange, vMin, vMax: vMin + vRange };
  }

  fitView() {
    const keys = this.curve.keys;
    if (!keys.length) return;
    let tMin = keys[0].t, tMax = keys[0].t, vMin = keys[0].v, vMax = keys[0].v;
    for (const k of keys) {
      tMin = Math.min(tMin, k.t); tMax = Math.max(tMax, k.t);
      vMin = Math.min(vMin, k.v); vMax = Math.max(vMax, k.v);
    }
    const tPad = Math.max((tMax - tMin) * 0.15, 0.05);
    const vPad = Math.max((vMax - vMin) * 0.15, 0.1);
    this.view = { tMin: tMin - tPad, tMax: tMax + tPad, vMin: vMin - vPad, vMax: vMax + vPad };
    this.draw();
  }

  _syncTools() {
    const k = this.selected !== null ? this.curve.keys[this.selected] : null;
    const has = !!k;
    this.tIn.disabled = this.vIn.disabled = this.autoBtn.disabled = !has;
    this.delBtn.disabled = !has || this.curve.keys.length <= 1;
    this.hint.classList.toggle('hidden', has);
    this.tIn.classList.toggle('hidden', !has);
    this.vIn.classList.toggle('hidden', !has);
    this.autoBtn.classList.toggle('hidden', !has);
    this.delBtn.classList.toggle('hidden', !has);
    if (has && document.activeElement !== this.tIn && document.activeElement !== this.vIn) {
      this.tIn.value = +k.t.toFixed(3);
      this.vIn.value = +k.v.toFixed(3);
    }
  }

  _applyNumericEdit() {
    const k = this.selected !== null ? this.curve.keys[this.selected] : null;
    if (!k) return;
    k.t = clamp(+this.tIn.value || 0, 0, 1);
    k.v = +this.vIn.value || 0;
    sortCurve(this.curve);
    this.selected = this.curve.keys.indexOf(k);
    this._syncTools();
    this.draw();
    this.onChange?.();
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pinchCentroid = () => {
      const pts = [...this.activePointers.values()].slice(0, 2);
      return {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        center: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      };
    };

    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' && e.button !== 0) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.activePointers.set(e.pointerId, p);
      if (this.activePointers.size >= 2) {
        this.drag = null;
        this.pinch = pinchCentroid();
        return;
      }
      const { w, h } = this._dims();
      this._downPos = p;
      this._moved = false;
      const side = this._handleAt(p.x, p.y, w, h);
      if (side) {
        this._lastTap = null;
        this.drag = { type: side };
        return;
      }
      const i = this._keyAt(p.x, p.y, w, h);
      if (i >= 0) {
        this._lastTap = null;
        this.selected = i;
        this.drag = { type: 'point', index: i };
        this._syncTools();
        this.draw();
        return;
      }
      // Manual double-tap detection: touch doesn't reliably fire 'dblclick'
      // (especially with touch-action: none), so this is the primary way to
      // add a point on mobile. Desktop keeps using the native 'dblclick'
      // listener below — gated to touch so the two paths never both fire.
      const now = performance.now();
      if (e.pointerType === 'touch' && this._lastTap && now - this._lastTap.time < 500 && Math.hypot(p.x - this._lastTap.x, p.y - this._lastTap.y) < 20) {
        const [t, v] = this._fromPx(p.x, p.y, w, h);
        this.curve.keys.push({ t, v });
        sortCurve(this.curve);
        this.selected = this.curve.keys.findIndex((k) => k.t === t && k.v === v);
        this._lastTap = null;
        // let the finger keep dragging the just-added point without lifting
        this.drag = { type: 'point', index: this.selected };
        this._syncTools();
        this.draw();
        this.onChange?.();
        return;
      }
      if (e.pointerType === 'touch') this._lastTap = { time: now, x: p.x, y: p.y };
      this._panLast = p;
      this.drag = { type: 'pan' };
    });

    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (this.activePointers.has(e.pointerId)) this.activePointers.set(e.pointerId, p);
      const { w, h } = this._dims();
      if (this.pinch && this.activePointers.size >= 2) {
        const cur = pinchCentroid();
        const scale = this.pinch.dist / Math.max(cur.dist, 1e-3);
        this._applyViewTransform(this.pinch.center, cur.center, scale, w, h);
        this.pinch = cur;
        this.draw();
        return;
      }
      if (!this.drag) return;
      if (Math.hypot(p.x - this._downPos.x, p.y - this._downPos.y) > 3) this._moved = true;
      if (this.drag.type === 'pan') {
        this._applyViewTransform(this._panLast, p, 1, w, h);
        this._panLast = p;
        this.draw();
        return;
      }
      if (this.drag.type === 'point') {
        const [t, v] = this._fromPx(p.x, p.y, w, h);
        const k = this.curve.keys[this.drag.index];
        k.t = t;
        k.v = v;
        this._syncTools();
        this.draw();
        this.onChange?.();
        return;
      }
      // tangent handle drag: slope is purely (Δv/Δt) toward the pointer —
      // handle length on screen stays fixed (non-weighted tangent).
      const k = this.curve.keys[this.selected];
      const [tm, vm] = this._fromPxFree(p.x, p.y, w, h);
      const EPS = 1e-4;
      if (this.drag.type === 'out') {
        const dt = Math.max(tm - k.t, EPS);
        k.tanOut = (vm - k.v) / dt;
      } else {
        const dt = Math.max(k.t - tm, EPS);
        k.tanIn = (k.v - vm) / dt;
      }
      this.draw();
      this.onChange?.();
    });

    const end = (e) => {
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) this.pinch = null;
      if (!this.drag) return;
      if (this.drag.type === 'point') {
        const k = this.curve.keys[this.drag.index];
        sortCurve(this.curve);
        this.selected = this.curve.keys.indexOf(k);
      } else if (this.drag.type === 'pan' && !this._moved) {
        this.selected = null;
      }
      this.drag = null;
      this._panLast = null;
      this._syncTools();
      this.draw();
      this.onChange?.();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { w, h } = this._dims();
      const p = pos(e);
      const scale = Math.exp(e.deltaY * 0.001);
      this._applyViewTransform(p, p, scale, w, h);
      this.draw();
    }, { passive: false });

    c.addEventListener('dblclick', (e) => {
      const { w, h } = this._dims();
      const p = pos(e);
      if (this._keyAt(p.x, p.y, w, h) >= 0) return;
      const [t, v] = this._fromPx(p.x, p.y, w, h);
      this.curve.keys.push({ t, v });
      sortCurve(this.curve);
      this.selected = this.curve.keys.findIndex((k) => k.t === t && k.v === v);
      this._syncTools();
      this.draw();
      this.onChange?.();
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { w, h } = this._dims();
      const p = pos(e);
      const i = this._keyAt(p.x, p.y, w, h);
      if (i >= 0 && this.curve.keys.length > 1) {
        this.curve.keys.splice(i, 1);
        this.selected = null;
        this._syncTools();
        this.draw();
        this.onChange?.();
      }
    });
  }

  draw() {
    const { w, h, dpr } = this._dims();
    const g = this.canvas.getContext('2d');
    g.save();
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#16181d';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#252830';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = PAD + (i / 4) * (w - PAD * 2);
      g.beginPath(); g.moveTo(x, PAD); g.lineTo(x, h - PAD); g.stroke();
    }
    for (let i = 0; i <= 4; i++) {
      const y = PAD + (i / 4) * (h - PAD * 2);
      g.beginPath(); g.moveTo(PAD, y); g.lineTo(w - PAD, y); g.stroke();
    }
    // value range labels — the extra height leaves room to read the axis
    g.fillStyle = '#6d727e';
    g.font = '10px ui-monospace, Consolas, monospace';
    g.textBaseline = 'top';
    g.fillText(String(+this.view.vMax.toFixed(2)), PAD + 3, PAD + 2);
    g.textBaseline = 'bottom';
    g.fillText(String(+this.view.vMin.toFixed(2)), PAD + 3, h - PAD - 2);
    g.strokeStyle = '#e8a33d';
    g.lineWidth = 1.5;
    g.beginPath();
    const { tMin, tMax } = this.view;
    for (let i = 0; i <= 48; i++) {
      const t = tMin + (i / 48) * (tMax - tMin);
      const [x, y] = this._toPx(t, evalCurve(this.curve, t), w, h);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    // tangent handles for the selected key, drawn under the key markers
    if (this.selected !== null && this.curve.keys[this.selected]) {
      const i = this.selected;
      const k = this.curve.keys[i];
      const [kx, ky] = this._toPx(k.t, k.v, w, h);
      const drawHandle = (side) => {
        const [hx, hy] = this._handlePx(i, side, w, h);
        g.beginPath(); g.moveTo(kx, ky); g.lineTo(hx, hy); g.stroke();
        g.beginPath(); g.arc(hx, hy, 3.5, 0, Math.PI * 2); g.fill();
      };
      g.strokeStyle = '#4d9fff';
      g.lineWidth = 1;
      g.fillStyle = '#4d9fff';
      if (i < this.curve.keys.length - 1) drawHandle('out');
      if (i > 0) drawHandle('in');
    }
    this.curve.keys.forEach((k, i) => {
      const [x, y] = this._toPx(k.t, k.v, w, h);
      g.fillStyle = i === this.selected ? '#fff6df' : '#f5f6f8';
      g.fillRect(x - 3, y - 3, 6, 6);
      g.strokeStyle = i === this.selected ? '#4d9fff' : '#e8a33d';
      g.lineWidth = i === this.selected ? 1.5 : 1;
      g.strokeRect(x - 3.5, y - 3.5, 7, 7);
    });
    g.restore();
  }
}

export class GradientEditor {
  constructor(container, { gradient, onChange }) {
    this.gradient = gradient;
    this.onChange = onChange;
    this.selected = 0;
    this.drag = null;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gradient-canvas';
    container.appendChild(this.canvas);

    // Controls for the selected stop. The swatch is always visible so setting
    // a colour is a single obvious click, rather than relying on a hidden
    // input that browsers refuse to open a picker for.
    const tools = document.createElement('div');
    tools.className = 'gradient-tools';
    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.className = 'gradient-color-input';
    this.colorInput.title = 'Colour of the selected stop';
    this.info = document.createElement('span');
    this.info.className = 'gradient-stop-info';
    this.delBtn = document.createElement('button');
    this.delBtn.type = 'button';
    this.delBtn.className = 'btn btn-small';
    this.delBtn.textContent = 'Remove stop';
    tools.append(this.colorInput, this.info, this.delBtn);
    container.appendChild(tools);

    const applyColor = () => {
      const s = this.gradient.stops[this.selected];
      if (!s) return;
      s.c = hexToLin(this.colorInput.value);
      this.draw();
      this.onChange?.();
    };
    this.colorInput.addEventListener('input', applyColor);
    this.colorInput.addEventListener('change', applyColor);

    this.delBtn.addEventListener('click', () => {
      if (this.gradient.stops.length <= 1) return;
      this.gradient.stops.splice(this.selected, 1);
      this.selected = Math.max(0, this.selected - 1);
      this.draw();
      this.onChange?.();
    });

    this._bind();
    requestAnimationFrame(() => this.draw());
  }

  /** Opens the native colour picker for the selected stop. */
  _openPicker() {
    const s = this.gradient.stops[this.selected];
    if (!s) return;
    this.colorInput.value = linToHex(s.c);
    // showPicker() is the reliable path; click() is the older fallback.
    try { this.colorInput.showPicker(); } catch { this.colorInput.click(); }
  }

  _syncTools() {
    const s = this.gradient.stops[this.selected];
    if (!s) return;
    this.colorInput.value = linToHex(s.c);
    this.info.textContent =
      `stop ${this.selected + 1}/${this.gradient.stops.length} · pos ${s.t.toFixed(2)}`;
    this.delBtn.disabled = this.gradient.stops.length <= 1;
  }

  _dims() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 220;
    const h = this.canvas.clientHeight || 44;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    return { w, h, dpr };
  }

  _stopAt(x, w) {
    for (let i = 0; i < this.gradient.stops.length; i++) {
      const sx = PAD + this.gradient.stops[i].t * (w - PAD * 2);
      if (Math.abs(sx - x) < HIT_R) return i;
    }
    return -1;
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' && e.button !== 0) return;
      const { w } = this._dims();
      const [x] = pos(e);
      const i = this._stopAt(x, w);
      if (i >= 0) {
        e.preventDefault();
        this._lastTap = null;
        this.selected = i;
        this.drag = i;
        c.setPointerCapture(e.pointerId);
        this.draw();
        return;
      }
      // Manual double-tap detection: touch doesn't reliably fire 'dblclick'.
      // Desktop keeps using the native 'dblclick' listener below — gated to
      // touch so the two paths never both fire (avoids e.g. popping the
      // colour picker right after a desktop double-click adds a stop).
      if (e.pointerType === 'touch') e.preventDefault();
      const now = performance.now();
      if (e.pointerType === 'touch' && this._lastTap && now - this._lastTap.time < 500 && Math.abs(x - this._lastTap.x) < 20) {
        const t = clamp((x - PAD) / (w - PAD * 2), 0, 1);
        this.gradient.stops.push({ t, c: evalGradient(this.gradient, t) });
        sortGradient(this.gradient);
        this.selected = this.gradient.stops.findIndex((s) => s.t === t);
        this._lastTap = null;
        c.setPointerCapture(e.pointerId);
        this.drag = this.selected;
        this.draw();
        this.onChange?.();
        return;
      }
      if (e.pointerType === 'touch') this._lastTap = { time: now, x };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag === null) return;
      const { w } = this._dims();
      const [x] = pos(e);
      this.gradient.stops[this.drag].t = clamp((x - PAD) / (w - PAD * 2), 0, 1);
      this.draw();
      this.onChange?.();
    });
    c.addEventListener('pointerup', () => {
      if (this.drag !== null) {
        const s = this.gradient.stops[this.drag];
        sortGradient(this.gradient);
        this.selected = this.gradient.stops.indexOf(s);
        this.drag = null;
        this.draw();
        this.onChange?.();
      }
    });
    c.addEventListener('dblclick', (e) => {
      const { w } = this._dims();
      const [x] = pos(e);
      const i = this._stopAt(x, w);
      if (i >= 0) {
        // edit existing stop colour
        this.selected = i;
        this.draw();
        this._openPicker();
      } else {
        const t = clamp((x - PAD) / (w - PAD * 2), 0, 1);
        this.gradient.stops.push({ t, c: evalGradient(this.gradient, t) });
        sortGradient(this.gradient);
        this.selected = this.gradient.stops.findIndex((s) => s.t === t);
        this.draw();
        this.onChange?.();
      }
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { w } = this._dims();
      const [x] = pos(e);
      const i = this._stopAt(x, w);
      if (i >= 0 && this.gradient.stops.length > 1) {
        this.gradient.stops.splice(i, 1);
        this.selected = Math.max(0, this.selected - 1);
        this.draw();
        this.onChange?.();
      }
    });
  }

  draw() {
    this._syncTools();
    const { w, h, dpr } = this._dims();
    const g = this.canvas.getContext('2d');
    g.save();
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const barH = h - 14;
    const grad = g.createLinearGradient(PAD, 0, w - PAD, 0);
    for (const s of this.gradient.stops) grad.addColorStop(clamp(s.t, 0, 1), linToHex(s.c));
    g.fillStyle = '#16181d';
    g.fillRect(0, 0, w, h);
    g.fillStyle = grad;
    g.fillRect(PAD, 2, w - PAD * 2, barH - 2);
    g.strokeStyle = '#2c2f38';
    g.strokeRect(PAD + 0.5, 2.5, w - PAD * 2 - 1, barH - 3);
    this.gradient.stops.forEach((s, i) => {
      const x = PAD + s.t * (w - PAD * 2);
      g.beginPath();
      g.moveTo(x, barH + 1);
      g.lineTo(x - 5, h - 3);
      g.lineTo(x + 5, h - 3);
      g.closePath();
      g.fillStyle = linToHex(s.c);
      g.fill();
      g.strokeStyle = i === this.selected ? '#e8a33d' : '#666a75';
      g.stroke();
    });
    g.restore();
  }
}
