// Renderer: owns the GL context, render targets, and both graphics pipelines.
//
// Deferred (PBR):  G-buffer MRT -> depth copy -> sky -> fullscreen lighting ->
//                  blended particles (forward-lit) -> bloom -> tonemap
// Forward (PBR):   sky -> opaque (lit inline) -> depth copy ->
//                  blended particles -> bloom -> tonemap

import { Program, createTexture, createRenderTarget, drawFullscreen } from './glutil.js';
import {
  FULLSCREEN_VS, SKY_FS, DEFERRED_LIGHT_FS, BRIGHT_FS, BLUR_FS, POST_FS,
  FLOOR_VS, FLOOR_FS_GBUFFER, FLOOR_FS_FORWARD,
} from './shaderlib.js';
import { makePlane, uploadMesh } from './geometry.js';
import { isOpaqueMode } from './materials.js';
import { mat4Multiply, mat4Invert, degToRad } from './math3d.js';
import { MeshLibrary } from './particles.js';

export const CAM_NEAR = 0.1;
export const CAM_FAR = 120.0;

export function defaultScene() {
  return {
    sunAzimuth: 35, sunElevation: 42,
    sunColor: [1.0, 0.96, 0.88], sunIntensity: 2.6,
    skyTop: [0.09, 0.13, 0.22], skyBottom: [0.035, 0.04, 0.055],
    ambient: 1.0,
    showFloor: true, showGrid: true,
    exposure: 1.0,
    bloom: 0.55, bloomThreshold: 1.0,
    pointLights: [
      { enabled: false, pos: [2, 1.5, 2], color: [1, 0.5, 0.2], intensity: 4 },
      { enabled: false, pos: [-2, 1.5, -2], color: [0.2, 0.5, 1], intensity: 4 },
    ],
  };
}

export class Renderer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.width = 0;
    this.height = 0;
    this.meshLib = new MeshLibrary();
    this.emptyVao = gl.createVertexArray();
    this.blackTex = createTexture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST,
      new Uint8Array([0, 0, 0, 255]));

    const mk = (fs, name) => {
      const p = new Program(gl, FULLSCREEN_VS, fs, name);
      if (p.error) console.error(`[particletoy] internal shader '${name}' failed:`, p.error.log);
      return p;
    };
    this.progSky = mk(SKY_FS, 'sky');
    this.progLight = mk(DEFERRED_LIGHT_FS, 'deferred-light');
    this.progBright = mk(BRIGHT_FS, 'bright');
    this.progBlur = mk(BLUR_FS, 'blur');
    this.progPost = mk(POST_FS, 'post');

    this.progFloorG = new Program(gl, FLOOR_VS, FLOOR_FS_GBUFFER, 'floor-gbuffer');
    if (this.progFloorG.error) console.error('[particletoy] floor gbuffer:', this.progFloorG.error.log);
    this.progFloorF = new Program(gl, FLOOR_VS, FLOOR_FS_FORWARD, 'floor-forward');
    if (this.progFloorF.error) console.error('[particletoy] floor forward:', this.progFloorF.error.log);

    this.floorMesh = uploadMesh(gl, makePlane(44));
    this.targets = null;
  }

  resize(w, h) {
    if (w === this.width && h === this.height && this.targets) return;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    if (this.targets) {
      for (const t of Object.values(this.targets)) t.dispose?.();
      for (const tex of [this.depthA, this.depthB, this.gbufA, this.gbufB, this.gbufC, this.sceneColor]) {
        gl.deleteTexture(tex);
      }
      for (const fbo of [this.gbufFbo, this.sceneFbo, this.depthBFbo]) {
        gl.deleteFramebuffer(fbo);
      }
    }
    const F = { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.FLOAT };
    const F8 = { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };

    // Shared depth texture used as the depth attachment for gbuffer + scene FBOs.
    this.depthA = createTexture(gl, w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
    // Sampled copy (soft particles / deferred reconstruction) to avoid feedback loops.
    this.depthB = createTexture(gl, w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);

    // G-buffer: RT0 albedo+metallic (RGBA8), RT1 normal+roughness (RGBA8), RT2 emissive+AO (RGBA16F)
    this.gbufA = createTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.gbufB = createTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.gbufC = createTexture(gl, w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    this.gbufFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.gbufA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.gbufB, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.gbufC, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthA, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    // HDR scene color, sharing depthA
    this.sceneColor = createTexture(gl, w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.LINEAR);
    this.sceneFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthA, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    // Depth copy destination
    this.depthBFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthBFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthB, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.targets = {
      halfA: createRenderTarget(gl, hw, hh, [F], false),
      halfB: createRenderTarget(gl, hw, hh, [F], false),
      quarterA: createRenderTarget(gl, qw, qh, [F], false),
      quarterB: createRenderTarget(gl, qw, qh, [F], false),
    };
  }

  sunDir(scene) {
    const az = degToRad(scene.sunAzimuth);
    const el = degToRad(scene.sunElevation);
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  }

  setLightUniforms(prog, scene) {
    const sd = this.sunDir(scene);
    const sc = scene.sunColor;
    const si = scene.sunIntensity;
    prog.set3f('uSunDir', sd[0], sd[1], sd[2]);
    prog.set3f('uSunColor', sc[0] * si, sc[1] * si, sc[2] * si);
    prog.set3f('uSkyTop', ...scene.skyTop);
    prog.set3f('uSkyBottom', ...scene.skyBottom);
    prog.set1f('uAmbient', scene.ambient);
    const pos = [], col = [];
    let n = 0;
    for (const l of scene.pointLights) {
      if (!l.enabled || n >= 4) continue;
      pos.push(...l.pos);
      col.push(l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity);
      n++;
    }
    while (pos.length < 12) { pos.push(0); col.push(0); }
    prog.set3fv('uPointPos', pos);
    prog.set3fv('uPointColor', col);
    prog.set1i('uNumPoints', n);
  }

  setCommonUniforms(prog, frame) {
    prog.set1f('uTime', frame.time);
    prog.set2f('uResolution', this.width, this.height);
    prog.set4f('uMouse', ...frame.mouse);
    prog.set3f('uCameraPos', ...frame.camera.pos);
  }

  /**
   * frame = { camera: {view, proj, pos}, scene, effect, materials: Map<id, MaterialRuntime>,
   *           pipeline: 'deferred'|'forward', debugMode, time, mouse: [x,y,down,0] }
   */
  render(frame) {
    const gl = this.gl;
    const { camera, scene, effect, materials, pipeline } = frame;
    const debug = pipeline === 'deferred' ? frame.debugMode : 0;
    const viewProj = mat4Multiply(camera.proj, camera.view);
    const invViewProj = mat4Invert(viewProj);
    const viewDir = [-camera.view[2], -camera.view[6], -camera.view[10]];
    // Stashed for drawEmitter: materials reconstruct world position from the
    // sampled scene depth with this.
    this.invViewProj = invViewProj;

    // ---- classify draws
    const opaque = [], blended = [];
    for (const em of effect.emitters) {
      if (!em.p.enabled) continue;
      const mr = materials.get(em.p.materialId);
      if (!mr) continue;
      em.ensureGL(gl, this.meshLib);
      const item = { em, mr };
      (isOpaqueMode(mr.material) ? opaque : blended).push(item);
    }
    // inter-emitter back-to-front for blended
    for (const it of blended) {
      const p = it.em.p.position;
      it.key = (p[0] - camera.pos[0]) * viewDir[0] + (p[1] - camera.pos[1]) * viewDir[1] + (p[2] - camera.pos[2]) * viewDir[2];
    }
    blended.sort((a, b) => b.key - a.key);

    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);

    if (pipeline === 'deferred') {
      // ---- G-buffer pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (scene.showFloor && this.progFloorG.handle) {
        this.drawFloor(this.progFloorG, camera, scene);
      }
      for (const { em, mr } of opaque) {
        this.drawEmitter(em, mr, 'gbuffer', frame, null);
      }
      this.copyDepth(this.gbufFbo);

      // ---- sky + lighting into HDR scene
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT); // depth is shared with gbuffer: keep it
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      if (this.progSky.handle && debug === 0) {
        this.progSky.use();
        this.progSky.setMat4('uInvViewProj', invViewProj);
        this.progSky.set3f('uCameraPos', ...camera.pos);
        this.setLightUniforms(this.progSky, scene);
        drawFullscreen(gl, this.emptyVao);
      }
      if (this.progLight.handle) {
        const p = this.progLight.use();
        p.bindTex('uGA', 0, this.gbufA);
        p.bindTex('uGB', 1, this.gbufB);
        p.bindTex('uGC', 2, this.gbufC);
        p.bindTex('uDepth', 3, this.depthB);
        p.setMat4('uInvViewProj', invViewProj);
        p.set3f('uCameraPos', ...camera.pos);
        p.set2f('uCamNearFar', CAM_NEAR, CAM_FAR);
        p.set1i('uDebugMode', debug);
        this.setLightUniforms(p, scene);
        drawFullscreen(gl, this.emptyVao);
      }
      gl.enable(gl.DEPTH_TEST);
    } else {
      // ---- forward: sky, floor, opaque
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      if (this.progSky.handle) {
        this.progSky.use();
        this.progSky.setMat4('uInvViewProj', invViewProj);
        this.progSky.set3f('uCameraPos', ...camera.pos);
        this.setLightUniforms(this.progSky, scene);
        drawFullscreen(gl, this.emptyVao);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      if (scene.showFloor && this.progFloorF.handle) {
        const p = this.progFloorF;
        this.drawFloor(p, camera, scene, true);
      }
      for (const { em, mr } of opaque) {
        this.drawEmitter(em, mr, 'forward', frame, null);
      }
      this.copyDepth(this.sceneFbo);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    }

    // ---- blended particles (both pipelines; skipped in debug views)
    if (debug === 0) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      const sortCam = { pos: camera.pos, dir: viewDir };
      for (const { em, mr } of blended) {
        if (mr.material.blendMode === 'add') {
          gl.blendFunc(gl.ONE, gl.ONE);
          this.drawEmitter(em, mr, 'forward', frame, null);
        } else {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          this.drawEmitter(em, mr, 'forward', frame, sortCam);
        }
      }
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    // ---- bloom
    const t = this.targets;
    const doBloom = scene.bloom > 0.001 && debug === 0;
    if (doBloom) {
      gl.disable(gl.DEPTH_TEST);
      this.fsPass(t.halfA, this.progBright, (p) => {
        p.bindTex('uSrc', 0, this.sceneColor);
        p.set1f('uThreshold', scene.bloomThreshold);
      });
      this.blur(t.halfA, t.halfB);
      this.fsPass(t.quarterA, this.progBlur, (p) => {
        p.bindTex('uSrc', 0, t.halfA.colors[0]);
        p.set2f('uDir', 1 / t.halfA.width, 0);
      });
      this.blur(t.quarterA, t.quarterB);
      this.blur(t.quarterA, t.quarterB);
    }

    // ---- tonemap to canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    if (this.progPost.handle) {
      const p = this.progPost.use();
      p.bindTex('uScene', 0, this.sceneColor);
      p.bindTex('uBloomA', 1, doBloom ? t.halfA.colors[0] : this.blackTex);
      p.bindTex('uBloomB', 2, doBloom ? t.quarterA.colors[0] : this.blackTex);
      p.set1f('uExposure', scene.exposure);
      p.set1f('uBloomIntensity', scene.bloom);
      p.set1i('uMode', debug !== 0 ? 1 : 0);
      drawFullscreen(gl, this.emptyVao);
    }
    gl.enable(gl.DEPTH_TEST);
  }

  drawFloor(prog, camera, scene) {
    const gl = this.gl;
    prog.use();
    prog.setMat4('uView', camera.view);
    prog.setMat4('uProj', camera.proj);
    prog.set1f('uGridEnabled', scene.showGrid ? 1 : 0);
    if (prog === this.progFloorF) {
      prog.set3f('uCameraPos', ...camera.pos);
      this.setLightUniforms(prog, scene);
    }
    gl.bindVertexArray(this.floorVao || this._buildFloorVao());
    gl.drawElements(gl.TRIANGLES, this.floorMesh.count, this.floorMesh.indexType, 0);
    gl.bindVertexArray(null);
  }

  _buildFloorVao() {
    const gl = this.gl;
    this.floorVao = gl.createVertexArray();
    gl.bindVertexArray(this.floorVao);
    const m = this.floorMesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboNrm);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboUV);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
    gl.bindVertexArray(null);
    return this.floorVao;
  }

  drawEmitter(em, mr, variant, frame, sortCam) {
    const gl = this.gl;
    const prog = mr.programs[variant];
    if (!prog || !prog.handle) return;
    const n = em.fillInstances(sortCam);
    if (!n) return;
    em.uploadInstances(gl, n);

    const m = mr.material;
    if (m.doubleSided) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }

    prog.use();
    prog.setMat4('uView', frame.camera.view);
    prog.setMat4('uProj', frame.camera.proj);
    this.setCommonUniforms(prog, frame);
    prog.set1i('uMeshMode', em.p.meshType === 'quad' ? 0 : 1);
    prog.set1f('uAlphaCutoff', m.alphaCutoff);
    prog.bindTex('uCurveTex', 0, em.lutTex);
    if (variant === 'forward') {
      this.setLightUniforms(prog, frame.scene);
      prog.set2f('uCamNearFar', CAM_NEAR, CAM_FAR);
      prog.bindTex('uSceneDepth', 1, this.depthB);
      prog.set1f('uSoftDistance', m.softDistance);
      // Scene reads. The G-buffer only holds meaningful data in the deferred
      // pipeline, where this pass runs after the lighting pass; sampling it is
      // safe because the G-buffer textures are not attached to the scene FBO.
      const hasGBuffer = frame.pipeline === 'deferred';
      prog.set1i('uHasGBuffer', hasGBuffer ? 1 : 0);
      prog.setMat4('uInvViewProj', this.invViewProj);
      prog.bindTex('uGBufA', 2, hasGBuffer ? this.gbufA : this.blackTex);
      prog.bindTex('uGBufB', 3, hasGBuffer ? this.gbufB : this.blackTex);
      prog.bindTex('uGBufC', 4, hasGBuffer ? this.gbufC : this.blackTex);
    }
    gl.bindVertexArray(em.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, em.mesh.count, em.mesh.indexType, 0, n);
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
  }

  copyDepth(srcFbo) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthBFbo);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height,
      gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  fsPass(target, prog, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    prog.use();
    setup(prog);
    drawFullscreen(gl, this.emptyVao);
  }

  blur(target, temp) {
    this.fsPass(temp, this.progBlur, (p) => {
      p.bindTex('uSrc', 0, target.colors[0]);
      p.set2f('uDir', 1 / target.width, 0);
    });
    this.fsPass(target, this.progBlur, (p) => {
      p.bindTex('uSrc', 0, temp.colors[0]);
      p.set2f('uDir', 0, 1 / target.height);
    });
  }
}
