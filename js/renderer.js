// Renderer: owns the WebGPU device wiring, render targets, and both pipelines.
//
// Deferred (PBR):  G-buffer MRT -> depth copy -> sky -> fullscreen lighting ->
//                  blended particles (forward-lit) -> bloom -> tonemap
// Forward (PBR):   sky -> opaque (lit inline) -> depth copy ->
//                  blended particles -> bloom -> tonemap

import { UniformBlock, createTex, compileModule, uploadMesh, MESH_VERTEX_BUFFERS } from './gpu.js';
import {
  GBUF_FORMATS, SCENE_FORMAT, DEPTH_FORMAT,
  FRAME_FIELDS, LIGHTPASS_FIELDS, FLOOR_FIELDS, BRIGHT_FIELDS, BLUR_FIELDS, POST_FIELDS,
  SKY_WGSL, DEFERRED_LIGHT_WGSL, BRIGHT_WGSL, BLUR_WGSL, POST_WGSL,
  FLOOR_GBUFFER_WGSL, FLOOR_FORWARD_WGSL,
} from './shaderlib.js';
import { makePlane } from './geometry.js';
import { isOpaqueMode } from './materials.js';
import { mat4Multiply, mat4Invert, degToRad } from './math3d.js';
import { MeshLibrary } from './particles.js';
import { SimRuntime, ParticleSorter } from './gpusim.js';

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

const V = GPUShaderStage.VERTEX;
const F = GPUShaderStage.FRAGMENT;

export class Renderer {
  /** @param gpu {device, context, format, canvas} from createGPU */
  constructor(gpu) {
    const { device, context, format, canvas } = gpu;
    this.device = device;
    this.context = context;
    this.canvasFormat = format;
    this.canvas = canvas;
    this.width = 0;
    this.height = 0;
    this.targetsVersion = 0;
    this.meshLib = new MeshLibrary();

    this.linearClamp = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });

    // 1x1 zero texture (WebGPU textures are zero-initialized) for "no bloom".
    this.blackTex = createTex(device, 1, 1, SCENE_FORMAT, GPUTextureUsage.TEXTURE_BINDING, 'black');

    // ---- uniform blocks
    this.frameUB = new UniformBlock(device, FRAME_FIELDS, 'frame');
    this.lightUB = new UniformBlock(device, LIGHTPASS_FIELDS, 'light-pass');
    this.floorUB = new UniformBlock(device, FLOOR_FIELDS, 'floor');
    this.brightUB = new UniformBlock(device, BRIGHT_FIELDS, 'bright');
    this.postUB = new UniformBlock(device, POST_FIELDS, 'post');
    this.blurHalfH = new UniformBlock(device, BLUR_FIELDS, 'blur-half-h');
    this.blurHalfV = new UniformBlock(device, BLUR_FIELDS, 'blur-half-v');
    this.blurQuarterH = new UniformBlock(device, BLUR_FIELDS, 'blur-quarter-h');
    this.blurQuarterV = new UniformBlock(device, BLUR_FIELDS, 'blur-quarter-v');

    // ---- bind group layouts
    const bgl = (label, entries) => device.createBindGroupLayout({ label, entries });
    // Particle materials, group 0. The gbuffer variant has no scene reads.
    this.particleBGL = {
      gbuffer: bgl('particle-gbuffer', [
        { binding: 0, visibility: V | F, buffer: {} },
        { binding: 1, visibility: V | F, buffer: {} },
        { binding: 2, visibility: V, sampler: {} },
        { binding: 3, visibility: V, texture: {} },
      ]),
      forward: bgl('particle-forward', [
        { binding: 0, visibility: V | F, buffer: {} },
        { binding: 1, visibility: V | F, buffer: {} },
        { binding: 2, visibility: V, sampler: {} },
        { binding: 3, visibility: V, texture: {} },
        { binding: 4, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 5, visibility: F, texture: {} },
        { binding: 6, visibility: F, texture: {} },
        { binding: 7, visibility: F, texture: {} },
      ]),
    };
    this.particleLayout = {
      gbuffer: device.createPipelineLayout({ bindGroupLayouts: [this.particleBGL.gbuffer] }),
      forward: device.createPipelineLayout({ bindGroupLayouts: [this.particleBGL.forward] }),
    };

    this.skyBGL = bgl('sky', [{ binding: 0, visibility: V | F, buffer: {} }]);
    this.lightBGL = bgl('deferred-light', [
      { binding: 0, visibility: V | F, buffer: {} },
      { binding: 1, visibility: F, buffer: {} },
      { binding: 2, visibility: F, texture: {} },
      { binding: 3, visibility: F, texture: {} },
      { binding: 4, visibility: F, texture: {} },
      { binding: 5, visibility: F, texture: { sampleType: 'depth' } },
    ]);
    this.floorBGL = bgl('floor', [
      { binding: 0, visibility: V | F, buffer: {} },
      { binding: 1, visibility: F, buffer: {} },
    ]);
    this.fsqBGL = bgl('fsq', [
      { binding: 0, visibility: F, buffer: {} },
      { binding: 1, visibility: F, sampler: {} },
      { binding: 2, visibility: F, texture: {} },
    ]);
    this.postBGL = bgl('post', [
      { binding: 0, visibility: F, buffer: {} },
      { binding: 1, visibility: F, sampler: {} },
      { binding: 2, visibility: F, texture: {} },
      { binding: 3, visibility: F, texture: {} },
      { binding: 4, visibility: F, texture: {} },
    ]);

    // ---- internal pipelines
    const mod = (code, label) => {
      const m = device.createShaderModule({ code, label });
      // async sanity log: internal shaders should never fail
      compileModule(device, code, label).then(({ errors }) => {
        if (errors.length) console.error(`[particletoy] internal shader '${label}' failed:`, errors);
      });
      return m;
    };
    const layout = (b) => device.createPipelineLayout({ bindGroupLayouts: [b] });
    const fsqPipeline = (module, targetFormat, bglObj, depth) => device.createRenderPipeline({
      layout: layout(bglObj),
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: targetFormat }] },
      primitive: { topology: 'triangle-list' },
      ...(depth ? { depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' } } : {}),
    });

    this.progSky = fsqPipeline(mod(SKY_WGSL, 'sky'), SCENE_FORMAT, this.skyBGL, true);
    this.progLight = fsqPipeline(mod(DEFERRED_LIGHT_WGSL, 'deferred-light'), SCENE_FORMAT, this.lightBGL, true);
    this.progBright = fsqPipeline(mod(BRIGHT_WGSL, 'bright'), SCENE_FORMAT, this.fsqBGL, false);
    this.progBlur = fsqPipeline(mod(BLUR_WGSL, 'blur'), SCENE_FORMAT, this.fsqBGL, false);
    const postMod = mod(POST_WGSL, 'post');
    this.progPost = device.createRenderPipeline({
      layout: layout(this.postBGL),
      vertex: { module: postMod, entryPoint: 'vsMain' },
      fragment: { module: postMod, entryPoint: 'fsMain', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });

    const floorPipeline = (code, label, targets) => {
      const floorMod = mod(code, label);
      return device.createRenderPipeline({
        layout: layout(this.floorBGL),
        vertex: { module: floorMod, entryPoint: 'vsMain', buffers: MESH_VERTEX_BUFFERS },
        fragment: { module: floorMod, entryPoint: 'fsMain', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
    };
    this.progFloorG = floorPipeline(FLOOR_GBUFFER_WGSL, 'floor-gbuffer', GBUF_FORMATS.map((f) => ({ format: f })));
    this.progFloorF = floorPipeline(FLOOR_FORWARD_WGSL, 'floor-forward', [{ format: SCENE_FORMAT }]);

    this.floorMesh = uploadMesh(device, makePlane(44));
    this.targets = null;
    this.sorter = new ParticleSorter(device);
  }

  resize(w, h) {
    if (w === this.width && h === this.height && this.targets) return;
    const device = this.device;
    this.width = w;
    this.height = h;
    if (this.targets) for (const t of Object.values(this.targets)) t.destroy();

    const RA_TB = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.targets = {
      gbufA: createTex(device, w, h, GBUF_FORMATS[0], RA_TB, 'gbufA'),
      gbufB: createTex(device, w, h, GBUF_FORMATS[1], RA_TB, 'gbufB'),
      gbufC: createTex(device, w, h, GBUF_FORMATS[2], RA_TB, 'gbufC'),
      // depthA is the live attachment; depthB the sampled copy (soft
      // particles / reconstruction) to avoid readback feedback loops.
      depthA: createTex(device, w, h, DEPTH_FORMAT,
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, 'depthA'),
      depthB: createTex(device, w, h, DEPTH_FORMAT,
        GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING, 'depthB'),
      sceneColor: createTex(device, w, h, SCENE_FORMAT, RA_TB, 'sceneColor'),
      halfA: createTex(device, hw, hh, SCENE_FORMAT, RA_TB, 'halfA'),
      halfB: createTex(device, hw, hh, SCENE_FORMAT, RA_TB, 'halfB'),
      quarterA: createTex(device, qw, qh, SCENE_FORMAT, RA_TB, 'quarterA'),
      quarterB: createTex(device, qw, qh, SCENE_FORMAT, RA_TB, 'quarterB'),
    };
    this.views = {};
    for (const [k, t] of Object.entries(this.targets)) this.views[k] = t.createView();

    this.blurHalfH.set('dir', [1 / hw, 0]).upload();
    this.blurHalfV.set('dir', [0, 1 / hh]).upload();
    this.blurQuarterH.set('dir', [1 / qw, 0]).upload();
    this.blurQuarterV.set('dir', [0, 1 / qh]).upload();

    // ---- static bind groups referencing the new targets
    const bg = (layoutObj, resources, label) => this.device.createBindGroup({
      label, layout: layoutObj,
      entries: resources.map((r, i) => ({ binding: i, resource: r })),
    });
    const v = this.views;
    const samp = this.linearClamp;
    this.bgSky = bg(this.skyBGL, [{ buffer: this.frameUB.buffer }], 'sky');
    this.bgLight = bg(this.lightBGL, [
      { buffer: this.frameUB.buffer }, { buffer: this.lightUB.buffer },
      v.gbufA, v.gbufB, v.gbufC, v.depthB,
    ], 'light');
    this.bgFloor = bg(this.floorBGL, [{ buffer: this.frameUB.buffer }, { buffer: this.floorUB.buffer }], 'floor');
    this.bgBright = bg(this.fsqBGL, [{ buffer: this.brightUB.buffer }, samp, v.sceneColor], 'bright');
    this.bgBlurHalfA_H = bg(this.fsqBGL, [{ buffer: this.blurHalfH.buffer }, samp, v.halfA], 'blur-halfA-h');
    this.bgBlurHalfB_V = bg(this.fsqBGL, [{ buffer: this.blurHalfV.buffer }, samp, v.halfB], 'blur-halfB-v');
    this.bgBlurQuarterA_H = bg(this.fsqBGL, [{ buffer: this.blurQuarterH.buffer }, samp, v.quarterA], 'blur-quarterA-h');
    this.bgBlurQuarterB_V = bg(this.fsqBGL, [{ buffer: this.blurQuarterV.buffer }, samp, v.quarterB], 'blur-quarterB-v');
    this.bgPost = bg(this.postBGL, [{ buffer: this.postUB.buffer }, samp, v.sceneColor, v.halfA, v.quarterA], 'post');
    const black = this.blackTex.createView();
    this.bgPostNoBloom = bg(this.postBGL, [{ buffer: this.postUB.buffer }, samp, v.sceneColor, black, black], 'post-nobloom');

    this.targetsVersion++;
  }

  /** Per-emitter bind groups (called from Emitter.ensureGPU; rebuilt when
   *  targetsVersion changes because forward references renderer textures). */
  makeEmitterBindGroups(em) {
    const mk = (layoutObj, entries, label) => this.device.createBindGroup({
      label, layout: layoutObj,
      entries: entries.map((r, i) => ({ binding: i, resource: r })),
    });
    const base = [
      { buffer: this.frameUB.buffer },
      { buffer: em.drawUB.buffer },
      this.linearClamp,
      em.lutView,
    ];
    const v = this.views;
    return {
      gbuffer: mk(this.particleBGL.gbuffer, base, 'em-gbuffer'),
      forward: mk(this.particleBGL.forward, [...base, v.depthB, v.gbufA, v.gbufB, v.gbufC], 'em-forward'),
    };
  }

  sunDir(scene) {
    const az = degToRad(scene.sunAzimuth);
    const el = degToRad(scene.sunElevation);
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  }

  _updateFrameUB(frame, invViewProj) {
    const { camera, scene } = frame;
    const fu = this.frameUB;
    fu.set('view', camera.view).set('proj', camera.proj).set('invViewProj', invViewProj);
    fu.set('cameraPos', camera.pos).set('time', frame.time);
    fu.set('resolution', [this.width, this.height]).set('nearFar', [CAM_NEAR, CAM_FAR]);
    fu.set('mouse', frame.mouse);
    const sd = this.sunDir(scene);
    const si = scene.sunIntensity;
    fu.set('sunDir', sd).set('ambient', scene.ambient);
    fu.set('sunColor', [scene.sunColor[0] * si, scene.sunColor[1] * si, scene.sunColor[2] * si]);
    fu.set('skyTop', scene.skyTop).set('skyBottom', scene.skyBottom);
    const pos = new Float32Array(16), col = new Float32Array(16);
    let n = 0;
    for (const l of scene.pointLights) {
      if (!l.enabled || n >= 4) continue;
      pos.set(l.pos, n * 4);
      col.set([l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity], n * 4);
      n++;
    }
    fu.set('numPoints', n).set('pointPos', pos).set('pointColor', col);
    fu.upload();
  }

  /**
   * frame = { camera: {view, proj, pos}, scene, effect, materials: Map<id, MaterialRuntime>,
   *           pipeline: 'deferred'|'forward', debugMode, time, mouse: [x,y,down,0] }
   */
  render(frame) {
    const device = this.device;
    const { camera, scene, effect, materials, pipeline } = frame;
    const debug = pipeline === 'deferred' ? frame.debugMode : 0;
    const viewProj = mat4Multiply(camera.proj, camera.view);
    const invViewProj = mat4Invert(viewProj);
    const viewDir = [-camera.view[2], -camera.view[6], -camera.view[10]];

    this._updateFrameUB(frame, invViewProj);
    this.lightUB.set('debugMode', debug).upload();
    this.floorUB.set('gridEnabled', scene.showGrid ? 1 : 0).upload();
    this.brightUB.set('threshold', scene.bloomThreshold).upload();
    this.postUB.set('exposure', scene.exposure).set('bloomIntensity', scene.bloom)
      .set('mode', debug !== 0 ? 1 : 0).upload();

    // ---- classify draws
    const opaque = [], blended = [];
    for (const em of effect.emitters) {
      if (!em.p.enabled) continue;
      const mr = materials.get(em.p.materialId);
      if (!mr) continue;
      em.ensureGPU(this);
      const item = { em, mr };
      (isOpaqueMode(mr.material) ? opaque : blended).push(item);
    }
    // inter-emitter back-to-front for blended
    for (const it of blended) {
      const p = it.em.p.position;
      it.key = (p[0] - camera.pos[0]) * viewDir[0] + (p[1] - camera.pos[1]) * viewDir[1] + (p[2] - camera.pos[2]) * viewDir[2];
    }
    blended.sort((a, b) => b.key - a.key);

    const v = this.views;
    const sortCam = { pos: camera.pos, dir: viewDir };
    const enc = device.createCommandEncoder();

    // ---- GPU sims: attach/detach runtimes, then one compute pass for all
    const simEmitters = [];
    for (const { em } of [...opaque, ...blended]) {
      if (em.p.simMode === 'shader') {
        if (!em.simRt) em.simRt = new SimRuntime(this, em);
        if (em.simDirty) { em.simRt.dirty = true; em.simDirty = false; }
        simEmitters.push(em);
      } else if (em.simRt) {
        em.simRt.dispose();
        em.simRt = null;
      }
    }
    if (simEmitters.length) {
      for (const em of simEmitters) em.simRt.sorted = false;
      for (const em of simEmitters) em.simRt.prepare(frame);
      for (const em of simEmitters) em.simRt.preEncode(enc);
      const cpass = enc.beginComputePass({ label: 'particle-sim' });
      for (const em of simEmitters) em.simRt.dispatch(cpass);
      // back-to-front sort for alpha-blended sim emitters
      for (const { em, mr } of blended) {
        if (em.simRt && mr.material.blendMode !== 'add') {
          em.simRt.encodeSort(cpass, camera.pos, viewDir);
        }
      }
      cpass.end();
    }

    const depthAttach = (loadOp) => ({
      view: v.depthA, depthClearValue: 1,
      depthLoadOp: loadOp, depthStoreOp: 'store',
    });

    if (pipeline === 'deferred') {
      // ---- G-buffer pass
      const gpass = enc.beginRenderPass({
        colorAttachments: [v.gbufA, v.gbufB, v.gbufC].map((view) => ({
          view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
        })),
        depthStencilAttachment: depthAttach('clear'),
      });
      if (scene.showFloor) this.drawFloor(gpass, this.progFloorG);
      for (const { em, mr } of opaque) this.drawEmitter(gpass, em, mr, 'gbuffer', frame, null);
      gpass.end();
      this.copyDepth(enc);

      // ---- sky + lighting + blended into HDR scene (depth kept from G-buffer)
      const spass = enc.beginRenderPass({
        colorAttachments: [{ view: v.sceneColor, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: depthAttach('load'),
      });
      if (debug === 0) {
        spass.setPipeline(this.progSky);
        spass.setBindGroup(0, this.bgSky);
        spass.draw(3);
      }
      spass.setPipeline(this.progLight);
      spass.setBindGroup(0, this.bgLight);
      spass.draw(3);
      if (debug === 0) {
        for (const { em, mr } of blended) {
          this.drawEmitter(spass, em, mr, 'forward', frame,
            mr.material.blendMode === 'add' ? null : sortCam);
        }
      }
      spass.end();
    } else {
      // ---- forward: sky, floor, opaque
      const fpass = enc.beginRenderPass({
        colorAttachments: [{ view: v.sceneColor, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: depthAttach('clear'),
      });
      fpass.setPipeline(this.progSky);
      fpass.setBindGroup(0, this.bgSky);
      fpass.draw(3);
      if (scene.showFloor) this.drawFloor(fpass, this.progFloorF);
      for (const { em, mr } of opaque) this.drawEmitter(fpass, em, mr, 'forward', frame, null);
      fpass.end();
      this.copyDepth(enc);

      // ---- blended particles
      const bpass = enc.beginRenderPass({
        colorAttachments: [{ view: v.sceneColor, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: depthAttach('load'),
      });
      for (const { em, mr } of blended) {
        this.drawEmitter(bpass, em, mr, 'forward', frame,
          mr.material.blendMode === 'add' ? null : sortCam);
      }
      bpass.end();
    }

    // ---- bloom
    const doBloom = scene.bloom > 0.001 && debug === 0;
    if (doBloom) {
      this.fsPass(enc, v.halfA, this.progBright, this.bgBright);
      // blur half: H halfA->halfB, V halfB->halfA
      this.fsPass(enc, v.halfB, this.progBlur, this.bgBlurHalfA_H);
      this.fsPass(enc, v.halfA, this.progBlur, this.bgBlurHalfB_V);
      // downsample half -> quarter (horizontal taps at half-res spacing)
      this.fsPass(enc, v.quarterA, this.progBlur, this.bgBlurHalfA_H);
      for (let i = 0; i < 2; i++) {
        this.fsPass(enc, v.quarterB, this.progBlur, this.bgBlurQuarterA_H);
        this.fsPass(enc, v.quarterA, this.progBlur, this.bgBlurQuarterB_V);
      }
    }

    // ---- tonemap to canvas
    const canvasView = this.context.getCurrentTexture().createView();
    const post = enc.beginRenderPass({
      colorAttachments: [{ view: canvasView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    post.setPipeline(this.progPost);
    post.setBindGroup(0, doBloom ? this.bgPost : this.bgPostNoBloom);
    post.draw(3);
    post.end();

    for (const em of simEmitters) em.simRt.encodeStats(enc);
    device.queue.submit([enc.finish()]);
    for (const em of simEmitters) em.simRt.readStats();
  }

  drawFloor(pass, pipeline) {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bgFloor);
    const m = this.floorMesh;
    pass.setVertexBuffer(0, m.vboPos);
    pass.setVertexBuffer(1, m.vboNrm);
    pass.setVertexBuffer(2, m.vboUV);
    pass.setIndexBuffer(m.ibo, m.indexFormat);
    pass.drawIndexed(m.count);
  }

  drawEmitter(pass, em, mr, variant, frame, sortCam) {
    const pipe = mr.pipelines[variant];
    if (!pipe) return;
    const gpuSim = !!em.simRt;
    let n = 0;
    if (!gpuSim) {
      n = em.fillInstances(sortCam);
      if (!n) return;
      em.uploadInstances(this.device, n);
    } else if (!em.simRt.pipeUpdate) {
      return; // sim not compiled yet
    }

    const m = mr.material;
    em.drawUB
      .set('meshMode', em.p.meshType === 'quad' ? 0 : 1)
      .set('alphaCutoff', m.alphaCutoff)
      .set('softDistance', m.softDistance)
      .set('hasGBuffer', variant === 'forward' && frame.pipeline === 'deferred' ? 1 : 0);
    em.drawUB.upload();

    pass.setPipeline(pipe);
    pass.setBindGroup(0, em.bindGroups[variant]);
    pass.setVertexBuffer(0, em.mesh.vboPos);
    pass.setVertexBuffer(1, em.mesh.vboNrm);
    pass.setVertexBuffer(2, em.mesh.vboUV);
    pass.setIndexBuffer(em.mesh.ibo, em.mesh.indexFormat);
    if (gpuSim) {
      const rt = em.simRt;
      pass.setVertexBuffer(3, sortCam && rt.sorted ? rt.sortedBuf : rt.instanceBuf);
      pass.drawIndexedIndirect(rt.argsBuf, 0);
    } else {
      pass.setVertexBuffer(3, em.instanceBuf);
      pass.drawIndexed(em.mesh.count, n);
    }
  }

  copyDepth(enc) {
    enc.copyTextureToTexture(
      { texture: this.targets.depthA }, { texture: this.targets.depthB },
      { width: this.width, height: this.height },
    );
  }

  fsPass(enc, targetView, pipeline, bindGroup) {
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  dispose() {
    if (this.targets) for (const t of Object.values(this.targets)) t.destroy();
    this.targets = null;
    this.floorMesh.dispose();
    for (const ub of [this.frameUB, this.lightUB, this.floorUB, this.brightUB, this.postUB,
      this.blurHalfH, this.blurHalfV, this.blurQuarterH, this.blurQuarterV]) ub.dispose();
    this.blackTex.destroy();
  }
}
