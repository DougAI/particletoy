// WebGL2 helpers: context creation, program compilation with error mapping,
// uniform caching, textures, and framebuffers.

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,          // we render into our own FBOs; canvas gets a blit
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) return { gl: null, error: 'WebGL2 is not supported by this browser.' };
  const extColorFloat = gl.getExtension('EXT_color_buffer_float');
  if (!extColorFloat) {
    return { gl: null, error: 'EXT_color_buffer_float is required (HDR render targets) but not available.' };
  }
  gl.getExtension('OES_texture_float_linear');
  return { gl, error: null };
}

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    return { shader: null, log };
  }
  return { shader: sh, log: null };
}

/**
 * Parse a GLSL info log into [{line, msg}], adjusting line numbers by
 * `lineOffset` so they refer to the user's portion of the source.
 */
export function parseShaderErrors(log, lineOffset = 0) {
  const errors = [];
  if (!log) return errors;
  for (const raw of log.split('\n')) {
    const m = raw.match(/ERROR:\s*\d+:(\d+):\s*(.*)/);
    if (m) {
      errors.push({ line: Math.max(1, parseInt(m[1], 10) - lineOffset), msg: m[2] });
    } else if (raw.trim() && !/^WARNING/i.test(raw)) {
      errors.push({ line: 0, msg: raw.trim() });
    }
  }
  return errors;
}

export class Program {
  constructor(gl, vsSource, fsSource, name = 'program') {
    this.gl = gl;
    this.name = name;
    this.handle = null;
    this.error = null;
    this.uniforms = new Map();

    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
    if (!vs.shader) { this.error = { stage: 'vertex', log: vs.log }; return; }
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!fs.shader) { gl.deleteShader(vs.shader); this.error = { stage: 'fragment', log: fs.log }; return; }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs.shader);
    gl.attachShader(prog, fs.shader);
    gl.linkProgram(prog);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.error = { stage: 'link', log: gl.getProgramInfoLog(prog) };
      gl.deleteProgram(prog);
      return;
    }
    this.handle = prog;
  }

  use() { this.gl.useProgram(this.handle); return this; }

  loc(name) {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.handle, name));
    }
    return this.uniforms.get(name);
  }

  set1i(n, x) { const l = this.loc(n); if (l) this.gl.uniform1i(l, x); return this; }
  set1f(n, x) { const l = this.loc(n); if (l) this.gl.uniform1f(l, x); return this; }
  set2f(n, x, y) { const l = this.loc(n); if (l) this.gl.uniform2f(l, x, y); return this; }
  set3f(n, x, y, z) { const l = this.loc(n); if (l) this.gl.uniform3f(l, x, y, z); return this; }
  set4f(n, x, y, z, w) { const l = this.loc(n); if (l) this.gl.uniform4f(l, x, y, z, w); return this; }
  set3fv(n, arr) { const l = this.loc(n); if (l) this.gl.uniform3fv(l, arr); return this; }
  setMat4(n, m) { const l = this.loc(n); if (l) this.gl.uniformMatrix4fv(l, false, m); return this; }

  bindTex(n, unit, tex, target) {
    const gl = this.gl;
    const l = this.loc(n);
    if (l) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target || gl.TEXTURE_2D, tex);
      gl.uniform1i(l, unit);
    }
    return this;
  }

  dispose() { if (this.handle) this.gl.deleteProgram(this.handle); this.handle = null; }
}

export function createTexture(gl, w, h, internalFormat, format, type, filter, data = null) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/**
 * Creates an FBO with the given color attachment descriptors and an optional
 * depth texture. colorDescs: [{internalFormat, format, type}]
 */
export function createRenderTarget(gl, w, h, colorDescs, withDepth) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const colors = [];
  const drawBuffers = [];
  colorDescs.forEach((d, i) => {
    const tex = createTexture(gl, w, h, d.internalFormat, d.format, d.type, d.filter || gl.LINEAR);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    colors.push(tex);
    drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
  });
  let depth = null;
  if (withDepth) {
    depth = createTexture(gl, w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  }
  if (drawBuffers.length) gl.drawBuffers(drawBuffers);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    fbo, colors, depth, width: w, height: h,
    complete: status === gl.FRAMEBUFFER_COMPLETE,
    dispose() {
      gl.deleteFramebuffer(fbo);
      colors.forEach((t) => gl.deleteTexture(t));
      if (depth) gl.deleteTexture(depth);
    },
  };
}

/** Fullscreen triangle drawn with gl_VertexID; no attributes needed. */
export function drawFullscreen(gl, emptyVao) {
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}
