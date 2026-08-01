// Curve (Hermite-spline keyframes, tangent per key) and Gradient (color
// stops) models, plus LUT baking used by the GPU (life-indexed lookup texture).

export const LUT_SIZE = 64;

/** curve: {keys: [{t, v, tanIn?, tanOut?}]} sorted by t. tanIn/tanOut are
 * explicit slopes (dv/dt) for that key's handle; when omitted they're
 * derived on the fly from neighbouring keys (Catmull-Rom), so old data
 * without tangents still evaluates (and draws) as a smooth curve. */
export function makeCurve(keys) {
  return { keys: keys.map((k) => ({ t: k.t, v: k.v, tanIn: k.tanIn, tanOut: k.tanOut })) };
}

/** Effective slope at keys[i] for the given side ('in' or 'out'): the
 * key's own explicit tangent if set, else a Catmull-Rom estimate from
 * its neighbours (one-sided at the ends). */
export function tangentAt(keys, i, side) {
  const k = keys[i];
  const explicit = side === 'in' ? k.tanIn : k.tanOut;
  if (explicit !== undefined && explicit !== null) return explicit;
  const prev = keys[i - 1];
  const next = keys[i + 1];
  if (prev && next) {
    const dt = next.t - prev.t;
    return dt > 0 ? (next.v - prev.v) / dt : 0;
  }
  if (next) {
    const dt = next.t - k.t;
    return dt > 0 ? (next.v - k.v) / dt : 0;
  }
  if (prev) {
    const dt = k.t - prev.t;
    return dt > 0 ? (k.v - prev.v) / dt : 0;
  }
  return 0;
}

export function evalCurve(curve, t) {
  const keys = curve.keys;
  if (!keys.length) return 1;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const dt = b.t - a.t;
      if (dt <= 0) return a.v;
      // Cubic Hermite spline: matches value + tangent at both keys, so
      // per-key handles (or their auto-smoothed default) bend the curve
      // instead of just lerping in a straight line between keys.
      const s = (t - a.t) / dt;
      const s2 = s * s, s3 = s2 * s;
      const m0 = tangentAt(keys, i, 'out') * dt;
      const m1 = tangentAt(keys, i + 1, 'in') * dt;
      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = s3 - 2 * s2 + s;
      const h01 = -2 * s3 + 3 * s2;
      const h11 = s3 - s2;
      return h00 * a.v + h10 * m0 + h01 * b.v + h11 * m1;
    }
  }
  return keys[keys.length - 1].v;
}

export function sortCurve(curve) {
  curve.keys.sort((a, b) => a.t - b.t);
}

/** gradient: {stops: [{t, c: [r,g,b]}]} colors in linear-ish 0..N (HDR ok). */
export function makeGradient(stops) {
  return { stops: stops.map((s) => ({ t: s.t, c: [...s.c] })) };
}

export function evalGradient(grad, t) {
  const stops = grad.stops;
  if (!stops.length) return [1, 1, 1];
  if (t <= stops[0].t) return [...stops[0].c];
  if (t >= stops[stops.length - 1].t) return [...stops[stops.length - 1].c];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return [
        a.c[0] + (b.c[0] - a.c[0]) * f,
        a.c[1] + (b.c[1] - a.c[1]) * f,
        a.c[2] + (b.c[2] - a.c[2]) * f,
      ];
    }
  }
  return [...stops[stops.length - 1].c];
}

export function sortGradient(grad) {
  grad.stops.sort((a, b) => a.t - b.t);
}

/**
 * Bakes an emitter's over-lifetime curves into a LUT_SIZE x 2 RGBA float image.
 * Row 0 (v=0.25): rgb = colorOverLife, a = alphaOverLife
 * Row 1 (v=0.75): r = sizeOverLife multiplier, gba unused
 */
export function bakeEmitterLUT(emitter) {
  const data = new Float32Array(LUT_SIZE * 2 * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const c = evalGradient(emitter.colorOverLife, t);
    const a = evalCurve(emitter.alphaOverLife, t);
    const s = evalCurve(emitter.sizeOverLife, t);
    const o0 = i * 4;
    data[o0] = c[0]; data[o0 + 1] = c[1]; data[o0 + 2] = c[2]; data[o0 + 3] = a;
    const o1 = (LUT_SIZE + i) * 4;
    data[o1] = s; data[o1 + 1] = 1; data[o1 + 2] = 1; data[o1 + 3] = 1;
  }
  return data;
}

export function uploadLUT(gl, tex, data) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 2, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
}
