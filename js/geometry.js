// Mesh generation (quad / cube / sphere / plane) and a small OBJ parser.
// Meshes are {positions: Float32Array, normals, uvs, indices: Uint16/32Array}.

export function makeQuad() {
  return {
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

export function makeCube() {
  const p = [];
  const n = [];
  const uv = [];
  const idx = [];
  const faces = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  for (const f of faces) {
    const base = p.length / 3;
    for (let j = 0; j < 4; j++) {
      const su = (j === 1 || j === 2) ? 0.5 : -0.5;
      const sv = (j >= 2) ? 0.5 : -0.5;
      p.push(
        f.n[0] * 0.5 + f.u[0] * su + f.v[0] * sv,
        f.n[1] * 0.5 + f.u[1] * su + f.v[1] * sv,
        f.n[2] * 0.5 + f.u[2] * su + f.v[2] * sv,
      );
      n.push(...f.n);
      uv.push(su + 0.5, sv + 0.5);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: new Float32Array(p),
    normals: new Float32Array(n),
    uvs: new Float32Array(uv),
    indices: new Uint16Array(idx),
  };
}

export function makeSphere(slices = 16, stacks = 12) {
  const p = [];
  const n = [];
  const uv = [];
  const idx = [];
  for (let st = 0; st <= stacks; st++) {
    const phi = (st / stacks) * Math.PI;
    for (let sl = 0; sl <= slices; sl++) {
      const theta = (sl / slices) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      p.push(x * 0.5, y * 0.5, z * 0.5);
      n.push(x, y, z);
      uv.push(sl / slices, 1 - st / stacks);
    }
  }
  const cols = slices + 1;
  for (let st = 0; st < stacks; st++) {
    for (let sl = 0; sl < slices; sl++) {
      const a = st * cols + sl;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    positions: new Float32Array(p),
    normals: new Float32Array(n),
    uvs: new Float32Array(uv),
    indices: new Uint16Array(idx),
  };
}

export function makePlane(size = 40) {
  const s = size / 2;
  return {
    positions: new Float32Array([-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
  };
}

/**
 * Minimal Wavefront OBJ parser. Supports v / vn / vt / f with triangulation
 * of polygon fans. Returns null on failure or empty input.
 */
export function parseOBJ(text) {
  try {
    const vs = [];
    const vns = [];
    const vts = [];
    const outP = [];
    const outN = [];
    const outUV = [];
    const outIdx = [];
    const cache = new Map();

    const resolve = (spec) => {
      if (cache.has(spec)) return cache.get(spec);
      const parts = spec.split('/');
      const vi = parseInt(parts[0], 10);
      const ti = parts[1] ? parseInt(parts[1], 10) : 0;
      const ni = parts[2] ? parseInt(parts[2], 10) : 0;
      const v = vs[(vi > 0 ? vi - 1 : vs.length + vi)] || [0, 0, 0];
      const t = ti ? (vts[(ti > 0 ? ti - 1 : vts.length + ti)] || [0, 0]) : [0, 0];
      const nrm = ni ? (vns[(ni > 0 ? ni - 1 : vns.length + ni)] || [0, 1, 0]) : [0, 1, 0];
      const index = outP.length / 3;
      outP.push(v[0], v[1], v[2]);
      outUV.push(t[0], t[1]);
      outN.push(nrm[0], nrm[1], nrm[2]);
      cache.set(spec, index);
      return index;
    };

    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('v ')) {
        const c = t.slice(2).trim().split(/\s+/).map(Number);
        vs.push(c);
      } else if (t.startsWith('vn ')) {
        vns.push(t.slice(3).trim().split(/\s+/).map(Number));
      } else if (t.startsWith('vt ')) {
        vts.push(t.slice(3).trim().split(/\s+/).map(Number));
      } else if (t.startsWith('f ')) {
        const specs = t.slice(2).trim().split(/\s+/);
        for (let i = 1; i + 1 < specs.length; i++) {
          outIdx.push(resolve(specs[0]), resolve(specs[i]), resolve(specs[i + 1]));
        }
      }
    }
    if (!outIdx.length) return null;

    // Generate flat normals when the file has none.
    if (!vns.length) {
      for (let i = 0; i < outIdx.length; i += 3) {
        const ia = outIdx[i] * 3, ib = outIdx[i + 1] * 3, ic = outIdx[i + 2] * 3;
        const e1 = [outP[ib] - outP[ia], outP[ib + 1] - outP[ia + 1], outP[ib + 2] - outP[ia + 2]];
        const e2 = [outP[ic] - outP[ia], outP[ic + 1] - outP[ia + 1], outP[ic + 2] - outP[ia + 2]];
        const nx = e1[1] * e2[2] - e1[2] * e2[1];
        const ny = e1[2] * e2[0] - e1[0] * e2[2];
        const nz = e1[0] * e2[1] - e1[1] * e2[0];
        for (const ii of [ia, ib, ic]) {
          outN[ii] += nx; outN[ii + 1] += ny; outN[ii + 2] += nz;
        }
      }
      for (let i = 0; i < outN.length; i += 3) {
        const l = Math.hypot(outN[i], outN[i + 1], outN[i + 2]) || 1;
        outN[i] /= l; outN[i + 1] /= l; outN[i + 2] /= l;
      }
    }

    const IndexArray = outP.length / 3 > 65535 ? Uint32Array : Uint16Array;
    return {
      positions: new Float32Array(outP),
      normals: new Float32Array(outN),
      uvs: new Float32Array(outUV),
      indices: new IndexArray(outIdx),
    };
  } catch (e) {
    return null;
  }
}

/** Uploads a mesh to GPU buffers. Returns {vboPos, vboNrm, vboUV, ibo, count, indexType}. */
export function uploadMesh(gl, mesh) {
  const mk = (data, target = gl.ARRAY_BUFFER) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  };
  const vboPos = mk(mesh.positions);
  const vboNrm = mk(mesh.normals);
  const vboUV = mk(mesh.uvs);
  const ibo = mk(mesh.indices, gl.ELEMENT_ARRAY_BUFFER);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  return {
    vboPos, vboNrm, vboUV, ibo,
    count: mesh.indices.length,
    indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    dispose() {
      gl.deleteBuffer(vboPos); gl.deleteBuffer(vboNrm);
      gl.deleteBuffer(vboUV); gl.deleteBuffer(ibo);
    },
  };
}
