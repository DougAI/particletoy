// Canvas widgets: curve editor (piecewise-linear keys) and gradient editor.

import { sortCurve, sortGradient, evalCurve, evalGradient } from './curves.js';
import { clamp } from './math3d.js';

const PAD = 8;

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
    this.vMin = vMin;
    this.vMax = vMax;
    this.onChange = onChange;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'curve-canvas';
    container.appendChild(this.canvas);
    this.drag = null;
    this._bind();
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
    return [
      PAD + t * (w - PAD * 2),
      h - PAD - ((v - this.vMin) / (this.vMax - this.vMin)) * (h - PAD * 2),
    ];
  }

  _fromPx(x, y, w, h) {
    return [
      clamp((x - PAD) / (w - PAD * 2), 0, 1),
      clamp(this.vMin + ((h - PAD - y) / (h - PAD * 2)) * (this.vMax - this.vMin), this.vMin, this.vMax),
    ];
  }

  _keyAt(x, y, w, h) {
    for (let i = 0; i < this.curve.keys.length; i++) {
      const k = this.curve.keys[i];
      const [px, py] = this._toPx(k.t, k.v, w, h);
      if (Math.abs(px - x) < 7 && Math.abs(py - y) < 7) return i;
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
      if (e.button !== 0) return;
      const { w, h } = this._dims();
      const [x, y] = pos(e);
      const i = this._keyAt(x, y, w, h);
      if (i >= 0) {
        this.drag = i;
        c.setPointerCapture(e.pointerId);
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag === null) return;
      const { w, h } = this._dims();
      const [x, y] = pos(e);
      const [t, v] = this._fromPx(x, y, w, h);
      const k = this.curve.keys[this.drag];
      k.t = t;
      k.v = v;
      this.draw();
      this.onChange?.();
    });
    c.addEventListener('pointerup', () => {
      if (this.drag !== null) {
        sortCurve(this.curve);
        this.drag = null;
        this.draw();
        this.onChange?.();
      }
    });
    c.addEventListener('dblclick', (e) => {
      const { w, h } = this._dims();
      const [x, y] = pos(e);
      if (this._keyAt(x, y, w, h) >= 0) return;
      const [t, v] = this._fromPx(x, y, w, h);
      this.curve.keys.push({ t, v });
      sortCurve(this.curve);
      this.draw();
      this.onChange?.();
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { w, h } = this._dims();
      const [x, y] = pos(e);
      const i = this._keyAt(x, y, w, h);
      if (i >= 0 && this.curve.keys.length > 1) {
        this.curve.keys.splice(i, 1);
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
    g.fillText(String(+this.vMax.toFixed(2)), PAD + 3, PAD + 2);
    g.textBaseline = 'bottom';
    g.fillText(String(+this.vMin.toFixed(2)), PAD + 3, h - PAD - 2);
    g.strokeStyle = '#e8a33d';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const [x, y] = this._toPx(t, evalCurve(this.curve, t), w, h);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    for (const k of this.curve.keys) {
      const [x, y] = this._toPx(k.t, k.v, w, h);
      g.fillStyle = '#f5f6f8';
      g.fillRect(x - 3, y - 3, 6, 6);
      g.strokeStyle = '#e8a33d';
      g.strokeRect(x - 3.5, y - 3.5, 7, 7);
    }
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
      if (Math.abs(sx - x) < 7) return i;
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
      if (e.button !== 0) return;
      const { w } = this._dims();
      const [x] = pos(e);
      const i = this._stopAt(x, w);
      if (i >= 0) {
        this.selected = i;
        this.drag = i;
        c.setPointerCapture(e.pointerId);
        this.draw();
      }
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
