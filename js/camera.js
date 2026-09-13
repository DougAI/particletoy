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
    this._pointers = new Map();
    this._gesture = null;
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
      const point = {
        x: e.clientX, y: e.clientY,
        mode: (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'rotate',
      };
      this._pointers.set(e.pointerId, point);
      this._drag = point;
      if (this._pointers.size >= 2) {
        this._gesture = gestureMetrics([...this._pointers.values()]);
        this._drag = null;
      }
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const point = this._pointers.get(e.pointerId);
      if (!point) return;
      const previousX = point.x;
      const previousY = point.y;
      point.x = e.clientX;
      point.y = e.clientY;
      if (this._pointers.size >= 2) {
        const next = gestureMetrics([...this._pointers.values()]);
        if (this._gesture) {
          this._pan(next.x - this._gesture.x, next.y - this._gesture.y);
          if (next.distance > 0 && this._gesture.distance > 0) {
            this._zoom(this._gesture.distance / next.distance);
          }
        }
        this._gesture = next;
      } else if (this._drag) {
        const dx = e.clientX - previousX;
        const dy = e.clientY - previousY;
        if (this._drag.mode === 'rotate') this._rotate(dx, dy);
        else this._pan(dx, dy);
        this._drag.x = e.clientX;
        this._drag.y = e.clientY;
      }
    });
    const pointerEnd = (e) => {
      this._pointers.delete(e.pointerId);
      this._gesture = this._pointers.size >= 2
        ? gestureMetrics([...this._pointers.values()]) : null;
      this._drag = this._pointers.size === 1 ? [...this._pointers.values()][0] : null;
    };
    c.addEventListener('pointerup', pointerEnd);
    c.addEventListener('pointercancel', pointerEnd);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoom(Math.exp(e.deltaY * 0.001));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _rotate(dx, dy) {
    this.yaw += dx * 0.35;
    this.pitch = clamp(this.pitch + dy * 0.3, -89, 89);
  }

  _pan(dx, dy) {
    // Camera sits at yaw around +Y, looking inward, so its horizontal
    // forward is -[cos(y), 0, sin(y)] and right = cross(forward, up)
    // = [sin(y), 0, -cos(y)]. Dragging right must push the target the
    // other way for the scene to travel with the cursor.
    const y = degToRad(this.yaw);
    const right = [Math.sin(y), 0, -Math.cos(y)];
    const k = this.dist * 0.0016;
    this.target[0] -= right[0] * dx * k;
    this.target[2] -= right[2] * dx * k;
    this.target[1] = clamp(this.target[1] + dy * k, -2, 8);
  }

  _zoom(factor) {
    this.dist = clamp(this.dist * factor, 0.6, 45);
  }
}

export function gestureMetrics(points) {
  const [a, b] = points;
  if (!a || !b) return { x: 0, y: 0, distance: 0 };
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    distance: Math.hypot(b.x - a.x, b.y - a.y),
  };
}
