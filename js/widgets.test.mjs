import assert from 'node:assert/strict';
import { nudgePoint, widestGapPosition } from './widgets.js';

assert.equal(widestGapPosition([]), 0.5);
assert.equal(widestGapPosition([{ t: 0 }, { t: 1 }]), 0.5);
assert.equal(widestGapPosition([{ t: 0 }, { t: 0.25 }, { t: 1 }]), 0.625);

const points = [{ t: 0 }, { t: 0.5 }, { t: 1 }];
let selected = nudgePoint(points, 1, 0.6);
assert.equal(points[selected].t, 1);
assert.equal(points[selected], points[1]);
selected = nudgePoint(points, selected, -0.25);
assert.equal(points[selected].t, 0.75);
assert.equal(nudgePoint(points, 99, 0.1), 99);

console.log('curve and gradient precision helpers: ok');
