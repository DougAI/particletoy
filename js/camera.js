// Orbit camera: left-drag rotate, wheel zoom, shift/right/middle-drag pan.

import { mat4LookAt, mat4Perspective, clamp, degToRad } from './math3d.js';
import { CAM_NEAR, CAM_FAR } from './renderer.js';

export class OrbitCamera {
  constructor(canvas) {
    this.canvas = canvas;
    this.target = [0, 0.9, 0];
    this.yaw = 55;
    this.pitch = 12;
    this.dist = 5.5;
    this._drag = null;
    this._bind();
  }

  reset() {
    this.target = [0, 0.9, 0];
    this.yaw = 55;
    this.pitch = 12;
    this.dist = 5.5;
  }

  pos() {
    const y = degToRad(this.yaw);
    const p = degToRad(this.pitch);
    return [
      this.target[0] + this.dist * Math.cos(p) * Math.cos(y),
      this.target[1] + this.dist * Math.sin(p),
      this.target[2] + this.dist * Math.cos(p) * Math.sin(y),
    ];
  }

  matrices(aspect) {
    const pos = this.pos();
    return {
      view: mat4LookAt(pos, this.target, [0, 1, 0]),
      proj: mat4Perspective(degToRad(50), aspect, CAM_NEAR, CAM_FAR),
      pos,
    };
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this._drag = {
        x: e.clientX, y: e.clientY,
        mode: (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'rotate',
      };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX;
      this._drag.y = e.clientY;
      if (this._drag.mode === 'rotate') {
        this.yaw += dx * 0.35;
        this.pitch = clamp(this.pitch + dy * 0.3, -89, 89);
      } else {
        const y = degToRad(this.yaw);
        const right = [-Math.sin(y), 0, Math.cos(y)];
        const k = this.dist * 0.0016;
        this.target[0] -= right[0] * dx * k;
        this.target[2] -= right[2] * dx * k;
        this.target[1] = clamp(this.target[1] + dy * k, -2, 8);
      }
    });
    c.addEventListener('pointerup', () => { this._drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.001), 0.6, 45);
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
