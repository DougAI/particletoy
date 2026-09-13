import assert from 'node:assert/strict';

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage = new Proxy({}, { get: () => 1 });
globalThis.GPUTextureUsage = new Proxy({}, { get: () => 1 });
globalThis.GPUMapMode = new Proxy({}, { get: () => 1 });

const { OrbitCamera, gestureMetrics } = await import('./camera.js');

assert.deepEqual(gestureMetrics([{ x: 0, y: 2 }, { x: 6, y: 2 }]), {
  x: 3, y: 2, distance: 6,
});

const listeners = new Map();
const canvas = {
  addEventListener(name, handler) { listeners.set(name, handler); },
  setPointerCapture() {},
};
const emit = (name, props) => listeners.get(name)?.({
  button: 0, shiftKey: false, preventDefault() {}, ...props,
});
const camera = new OrbitCamera(canvas);

emit('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
emit('pointermove', { pointerId: 1, clientX: 20, clientY: 20 });
assert.equal(camera.yaw, 58.5);
assert.equal(camera.pitch, 15);

const beforePinch = camera.dist;
const beforeTarget = [...camera.target];
emit('pointerdown', { pointerId: 2, clientX: 40, clientY: 20 });
emit('pointermove', { pointerId: 2, clientX: 60, clientY: 30 });
assert.ok(camera.dist < beforePinch, 'pinching outward zooms in');
assert.notDeepEqual(camera.target, beforeTarget, 'moving the pinch centroid pans');

emit('pointercancel', { pointerId: 2 });
const resumedYaw = camera.yaw;
emit('pointermove', { pointerId: 1, clientX: 25, clientY: 20 });
assert.ok(camera.yaw > resumedYaw, 'one-pointer orbit resumes after a pinch');
emit('pointerup', { pointerId: 1 });

camera.dist = 44;
emit('wheel', { deltaY: 1000 });
assert.equal(camera.dist, 45, 'wheel zoom remains clamped');

console.log('camera touch gestures: ok');
