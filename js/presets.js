// Built-in example effects. Each returns {name, emitters, materials, scene}
// as plain serializable data (same shape as a shared/exported effect).

import { defaultEmitterParams } from './particles.js';
import { makeMaterial } from './materials.js';
import { defaultScene } from './renderer.js';
import { makeCurve, makeGradient } from './curves.js';

function emitter(overrides) {
  const p = defaultEmitterParams();
  const merged = { ...p, ...overrides };
  merged.spawn = { ...p.spawn, ...(overrides.spawn || {}) };
  merged.shape = { ...p.shape, ...(overrides.shape || {}) };
  return merged;
}

function scene(overrides) {
  return { ...defaultScene(), ...overrides };
}

// ---------------------------------------------------------------- Campfire
function campfire() {
  const matFlame = makeMaterial({
    id: 'fire-flame', name: 'Flame', blendMode: 'add', lit: false,
    softParticles: true, softDistance: 0.4,
    fragmentSrc: `// Procedural flame: fbm erosion scrolling upward, hot core.
fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  var uv = i.uv - 0.5;
  uv.y += 0.06;
  let d = length(uv * vec2f(2.3, 1.8));
  let n = fbm2(uv * 4.0 + vec2f(i.seed * 19.0, -u.time * 2.4 - i.life * 3.0));
  let body = smoothstep(1.05, 0.25, d + n * 0.8);
  let core = smoothstep(0.6, 0.05, d + n * 0.45);
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 2.4 + vec3f(1.4, 1.0, 0.45) * core * 2.6;
  s.alpha = body * i.color.a;
}
`,
  });
  const matSmoke = makeMaterial({
    id: 'fire-smoke', name: 'Smoke', blendMode: 'blend', lit: true,
    softParticles: true, softDistance: 0.8,
    fragmentSrc: `// Lit smoke puff with noisy edges. PBR: rough, non-metallic.
fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let uv = i.uv - 0.5;
  let d = length(uv) * 2.0;
  let n = fbm2(uv * 3.5 + i.seed * 23.0 + vec2f(u.time * 0.1, i.life * 1.5));
  let a = smoothstep(1.0, 0.15, d + n * 0.9);
  s.albedo = i.color.rgb;
  s.roughness = 1.0;
  s.alpha = a * i.color.a;
}
`,
  });
  const matSpark = makeMaterial({
    id: 'fire-spark', name: 'Spark', blendMode: 'add', lit: false,
    vertexSrc: `// Stretch the billboard along the particle's velocity.
fn mainVertex(v: ptr<function, VertexData>, p: Particle) {
  v.positionWS += p.velocity * 0.06 * (v.uv.y - 0.5) * 2.0;
}
`,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 7.0;
  s.alpha = smoothstep(1.0, 0.0, d) * i.color.a;
}
`,
  });
  const matGlow = makeMaterial({
    id: 'fire-glow', name: 'Glow', blendMode: 'add', lit: false,
    softParticles: true, softDistance: 1.2,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;
  let a = pow(smoothstep(1.0, 0.0, d), 2.2);
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 0.7;
  s.alpha = a * i.color.a;
}
`,
  });

  return {
    name: 'Campfire',
    materials: [matFlame, matSmoke, matSpark, matGlow],
    emitters: [
      emitter({
        name: 'Flames', materialId: 'fire-flame',
        spawn: { rate: 26, max: 200 }, lifetime: [0.7, 1.2],
        shape: { type: 'cone', radius: 0.16, angle: 10 },
        speed: [0.7, 1.3], sizeStart: [0.4, 0.6],
        sizeOverLife: makeCurve([{ t: 0, v: 0.7 }, { t: 0.35, v: 1 }, { t: 1, v: 0.45 }]),
        colorOverLife: makeGradient([
          { t: 0, c: [1.0, 0.85, 0.35] }, { t: 0.45, c: [1.0, 0.42, 0.08] }, { t: 1, c: [0.55, 0.08, 0.02] },
        ]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.15, v: 1 }, { t: 0.75, v: 0.85 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Smoke', materialId: 'fire-smoke',
        position: [0, 0.5, 0],
        spawn: { rate: 8, max: 80 }, lifetime: [2.2, 3.4],
        shape: { type: 'cone', radius: 0.12, angle: 14 },
        speed: [0.45, 0.8], gravity: [0, 0.35, 0], drag: 0.25, spread: 0.15,
        sizeStart: [0.35, 0.5],
        sizeOverLife: makeCurve([{ t: 0, v: 0.6 }, { t: 1, v: 2.4 }]),
        rotationSpeed: [-25, 25],
        colorStartA: [0.28, 0.27, 0.26, 1], colorStartB: [0.2, 0.2, 0.22, 1],
        colorOverLife: makeGradient([{ t: 0, c: [1, 1, 1] }, { t: 1, c: [0.8, 0.8, 0.85] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.25, v: 0.5 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Sparks', materialId: 'fire-spark',
        spawn: { rate: 12, max: 100 }, lifetime: [0.5, 1.4],
        shape: { type: 'cone', radius: 0.1, angle: 16 },
        speed: [1.6, 3.2], gravity: [0, -2.8, 0], drag: 0.7, spread: 0.2,
        sizeStart: [0.02, 0.045],
        colorOverLife: makeGradient([{ t: 0, c: [1, 0.75, 0.3] }, { t: 1, c: [1, 0.3, 0.05] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 1 }, { t: 0.8, v: 1 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Base Glow', materialId: 'fire-glow',
        position: [0, 0.3, 0],
        spawn: { rate: 3, max: 8 }, lifetime: [1.2, 1.6],
        shape: { type: 'point' }, speed: [0, 0.05],
        sizeStart: [1.1, 1.4],
        colorOverLife: makeGradient([{ t: 0, c: [1, 0.5, 0.15] }, { t: 1, c: [1, 0.35, 0.1] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.4, v: 0.6 }, { t: 1, v: 0 }]),
      }),
    ],
    scene: scene({
      skyTop: [0.03, 0.045, 0.09], skyBottom: [0.015, 0.015, 0.02],
      sunIntensity: 0.5, sunElevation: 18, ambient: 0.55, bloom: 0.8,
      pointLights: [
        { enabled: true, pos: [0, 0.9, 0], color: [1, 0.55, 0.2], intensity: 5 },
        { enabled: false, pos: [-2, 1.5, -2], color: [0.2, 0.5, 1], intensity: 4 },
      ],
    }),
  };
}

// ---------------------------------------------------------------- Magic Orb
function magicOrb() {
  const matSwirl = makeMaterial({
    id: 'orb-swirl', name: 'Swirl Wisp', blendMode: 'add', lit: false,
    vertexSrc: `// Orbit around the emitter center; radius expands over life.
fn mainVertex(v: ptr<function, VertexData>, p: Particle) {
  let ang = p.seed * TAU + u.time * (1.6 + p.seed * 2.5);
  let r = 0.25 + 0.55 * p.life;
  v.positionWS += vec3f(cos(ang) * r, (p.seed - 0.5) * 1.1 * p.life, sin(ang) * r);
}
`,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 4.0;
  s.alpha = smoothstep(1.0, 0.0, d) * i.color.a;
}
`,
  });
  const matStone = makeMaterial({
    id: 'orb-stone', name: 'Orbit Stone', blendMode: 'opaque', lit: true, doubleSided: false,
    vertexSrc: `// Slow circular orbit for the PBR stones.
fn mainVertex(v: ptr<function, VertexData>, p: Particle) {
  let ang = p.seed * TAU + u.time * 0.9;
  let r = 0.85;
  let orbit = vec3f(cos(ang) * r, sin(ang * 2.0 + p.seed * 7.0) * 0.18, sin(ang) * r);
  v.positionWS += orbit;
}
`,
    fragmentSrc: `// Polished metal — best appreciated in the Deferred pipeline.
fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  s.albedo = mix(vec3f(0.9, 0.7, 0.3), vec3f(0.5, 0.6, 0.95), i.seed);
  s.metallic = 0.95;
  s.roughness = 0.22;
  s.alpha = 1.0;
}
`,
  });
  const matCore = makeMaterial({
    id: 'orb-core', name: 'Core Glow', blendMode: 'add', lit: false,
    softParticles: true, softDistance: 0.8,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;
  let n = fbm2(i.uv * 5.0 + u.time * 0.4 + i.seed * 11.0);
  let a = pow(smoothstep(1.0, 0.0, d), 1.6) * (0.75 + 0.25 * n);
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 2.0;
  s.alpha = a * i.color.a;
}
`,
  });

  return {
    name: 'Magic Orb',
    materials: [matSwirl, matStone, matCore],
    emitters: [
      emitter({
        name: 'Core', materialId: 'orb-core',
        position: [0, 1.3, 0],
        spawn: { rate: 4, max: 12 }, lifetime: [1.0, 1.5],
        shape: { type: 'point' }, speed: [0, 0.02],
        sizeStart: [0.75, 0.95],
        colorOverLife: makeGradient([{ t: 0, c: [0.45, 0.75, 1] }, { t: 1, c: [0.65, 0.4, 1] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.5, v: 0.8 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Swirl', materialId: 'orb-swirl',
        position: [0, 1.3, 0],
        spawn: { rate: 60, max: 400 }, lifetime: [0.8, 1.8],
        shape: { type: 'point' }, speed: [0, 0.02],
        sizeStart: [0.03, 0.08],
        colorOverLife: makeGradient([
          { t: 0, c: [0.35, 0.8, 1] }, { t: 0.6, c: [0.5, 0.45, 1] }, { t: 1, c: [0.85, 0.3, 0.9] },
        ]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.2, v: 1 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Stones', materialId: 'orb-stone', meshType: 'sphere',
        position: [0, 1.3, 0],
        spawn: { rate: 0, max: 8, bursts: [{ time: 0, count: 6 }] },
        duration: 4, looping: true, lifetime: [4, 4],
        shape: { type: 'point' }, speed: [0, 0],
        sizeStart: [0.12, 0.16],
        alphaOverLife: makeCurve([{ t: 0, v: 1 }, { t: 1, v: 1 }]),
      }),
      emitter({
        name: 'Rising Motes', materialId: 'orb-swirl',
        position: [0, 0.4, 0],
        spawn: { rate: 14, max: 80 }, lifetime: [1.6, 2.6],
        shape: { type: 'circle', radius: 0.9 }, speed: [0.05, 0.15],
        gravity: [0, 0.32, 0], spread: 0.25,
        sizeStart: [0.015, 0.04],
        colorOverLife: makeGradient([{ t: 0, c: [0.4, 0.7, 1] }, { t: 1, c: [0.7, 0.4, 1] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.3, v: 1 }, { t: 1, v: 0 }]),
      }),
    ],
    scene: scene({
      skyTop: [0.05, 0.06, 0.13], skyBottom: [0.02, 0.02, 0.035],
      sunIntensity: 1.2, ambient: 0.8, bloom: 0.85,
      pointLights: [
        { enabled: true, pos: [0, 1.3, 0], color: [0.45, 0.6, 1], intensity: 6 },
        { enabled: false, pos: [-2, 1.5, -2], color: [0.2, 0.5, 1], intensity: 4 },
      ],
    }),
  };
}

// ---------------------------------------------------------------- Fountain
function fountain() {
  const matDrop = makeMaterial({
    id: 'ftn-drop', name: 'Droplet', blendMode: 'blend', lit: true, doubleSided: false,
    fragmentSrc: `// Glossy water droplets — PBR spheres with low roughness.
fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  s.albedo = vec3f(0.5, 0.68, 0.85);
  s.roughness = 0.08;
  s.metallic = 0.0;
  s.alpha = 0.75 * i.color.a;
}
`,
  });
  const matMist = makeMaterial({
    id: 'ftn-mist', name: 'Mist', blendMode: 'blend', lit: true,
    softParticles: true, softDistance: 0.7,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let uv = i.uv - 0.5;
  let d = length(uv) * 2.0;
  let n = fbm2(uv * 3.0 + i.seed * 31.0 + vec2f(0.0, -i.life));
  let a = smoothstep(1.0, 0.2, d + n * 0.6);
  s.albedo = vec3f(0.75, 0.85, 0.95);
  s.roughness = 1.0;
  s.alpha = a * i.color.a * 0.35;
}
`,
  });

  return {
    name: 'Fountain',
    materials: [matDrop, matMist],
    emitters: [
      emitter({
        name: 'Jet', materialId: 'ftn-drop', meshType: 'sphere',
        spawn: { rate: 320, max: 1500 }, lifetime: [1.5, 1.8],
        shape: { type: 'cone', radius: 0.05, angle: 6 },
        speed: [5.2, 6.2], gravity: [0, -9.8, 0], spread: 0.02,
        sizeStart: [0.03, 0.06],
        alphaOverLife: makeCurve([{ t: 0, v: 1 }, { t: 0.85, v: 1 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Splash', materialId: 'ftn-drop', meshType: 'sphere',
        position: [0, 0.02, 0],
        spawn: { rate: 120, max: 500 }, lifetime: [0.5, 0.9],
        shape: { type: 'circle', radius: 0.55 },
        speed: [0.9, 2.0], gravity: [0, -9.8, 0], spread: 0.35,
        sizeStart: [0.02, 0.04],
        alphaOverLife: makeCurve([{ t: 0, v: 1 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Mist', materialId: 'ftn-mist',
        position: [0, 0.25, 0],
        spawn: { rate: 22, max: 120 }, lifetime: [0.9, 1.6],
        shape: { type: 'sphere', radius: 0.5 },
        speed: [0.1, 0.35], gravity: [0, 0.12, 0], spread: 0.5,
        sizeStart: [0.3, 0.6],
        sizeOverLife: makeCurve([{ t: 0, v: 0.6 }, { t: 1, v: 1.8 }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.3, v: 1 }, { t: 1, v: 0 }]),
      }),
    ],
    scene: scene({
      skyTop: [0.2, 0.34, 0.55], skyBottom: [0.1, 0.12, 0.14],
      sunIntensity: 3.4, sunElevation: 55, ambient: 1.25, bloom: 0.25,
    }),
  };
}

// ---------------------------------------------------------------- Confetti
function confetti() {
  const matFlake = makeMaterial({
    id: 'cf-flake', name: 'Confetti Flake', blendMode: 'opaque', lit: true, doubleSided: false,
    fragmentSrc: `// Rainbow from the per-particle seed.
fn hue(h: f32) -> vec3f {
  return clamp(abs(fmod3(h * 6.0 + vec3f(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}
fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  s.albedo = hue(i.seed) * 0.85 + 0.08;
  s.roughness = 0.35;
  s.metallic = 0.2;
  s.alpha = 1.0;
}
`,
  });
  const matTwinkle = makeMaterial({
    id: 'cf-twinkle', name: 'Twinkle', blendMode: 'add', lit: false,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;
  let tw = 0.5 + 0.5 * sin(u.time * 18.0 + i.seed * TAU * 4.0);
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 5.0 * tw;
  s.alpha = smoothstep(1.0, 0.0, d) * i.color.a;
}
`,
  });

  return {
    name: 'Confetti Burst',
    materials: [matFlake, matTwinkle],
    emitters: [
      emitter({
        name: 'Flakes', materialId: 'cf-flake', meshType: 'cube',
        position: [0, 2.2, 0],
        spawn: { rate: 0, max: 600, bursts: [{ time: 0, count: 320 }] },
        duration: 3.2, looping: true, lifetime: [2.2, 3.0],
        shape: { type: 'sphere', radius: 0.15 },
        speed: [2.4, 4.6], gravity: [0, -3.6, 0], drag: 1.15, spread: 0.9,
        sizeStart: [0.03, 0.055],
        rotationSpeed: [180, 720],
        alphaOverLife: makeCurve([{ t: 0, v: 1 }, { t: 1, v: 1 }]),
      }),
      emitter({
        name: 'Sparkles', materialId: 'cf-twinkle',
        position: [0, 2.2, 0],
        spawn: { rate: 0, max: 200, bursts: [{ time: 0, count: 90 }] },
        duration: 3.2, looping: true, lifetime: [1.2, 2.0],
        shape: { type: 'sphere', radius: 0.1 },
        speed: [1.8, 3.6], gravity: [0, -2.2, 0], drag: 1.0, spread: 0.9,
        sizeStart: [0.02, 0.04],
        colorOverLife: makeGradient([{ t: 0, c: [1, 0.95, 0.7] }, { t: 1, c: [1, 0.7, 0.9] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 1 }, { t: 0.7, v: 1 }, { t: 1, v: 0 }]),
      }),
    ],
    scene: scene({
      skyTop: [0.12, 0.16, 0.26], skyBottom: [0.05, 0.05, 0.07],
      sunIntensity: 2.8, ambient: 1.1, bloom: 0.5,
    }),
  };
}

// ---------------------------------------------------------------- Smoke Plume
function smokePlume() {
  const matPlume = makeMaterial({
    id: 'pl-smoke', name: 'Plume Smoke', blendMode: 'blend', lit: true,
    softParticles: true, softDistance: 1.0,
    fragmentSrc: `// Heavy lit smoke: fbm erosion + darker interior for depth.
fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let uv = i.uv - 0.5;
  let d = length(uv) * 2.0;
  let n = fbm2(uv * 3.0 + i.seed * 29.0 + vec2f(u.time * 0.06, i.life * 1.1));
  let a = smoothstep(1.05, 0.1, d + n * 1.0);
  s.albedo = i.color.rgb * (0.75 + 0.25 * n);
  s.roughness = 1.0;
  s.alpha = a * i.color.a;
}
`,
  });
  const matHeat = makeMaterial({
    id: 'pl-heat', name: 'Heat Glow', blendMode: 'add', lit: false,
    softParticles: true, softDistance: 0.6,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 2.0;
  s.alpha = pow(smoothstep(1.0, 0.0, d), 2.0) * i.color.a;
}
`,
  });

  return {
    name: 'Smoke Plume',
    materials: [matPlume, matHeat],
    emitters: [
      emitter({
        name: 'Plume', materialId: 'pl-smoke',
        spawn: { rate: 18, max: 220 }, lifetime: [2.6, 4.2],
        shape: { type: 'cone', radius: 0.22, angle: 7 },
        speed: [1.0, 1.7], gravity: [0, 0.22, 0], drag: 0.18, spread: 0.1,
        sizeStart: [0.45, 0.7],
        sizeOverLife: makeCurve([{ t: 0, v: 0.5 }, { t: 1, v: 2.6 }]),
        rotationSpeed: [-30, 30],
        colorStartA: [0.16, 0.15, 0.15, 1], colorStartB: [0.28, 0.26, 0.25, 1],
        colorOverLife: makeGradient([{ t: 0, c: [1.4, 0.9, 0.6] }, { t: 0.25, c: [1, 1, 1] }, { t: 1, c: [0.9, 0.9, 1] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.2, v: 0.85 }, { t: 0.8, v: 0.6 }, { t: 1, v: 0 }]),
      }),
      emitter({
        name: 'Fire Core', materialId: 'pl-heat',
        spawn: { rate: 10, max: 60 }, lifetime: [0.4, 0.8],
        shape: { type: 'cone', radius: 0.14, angle: 8 },
        speed: [0.5, 1.0],
        sizeStart: [0.25, 0.45],
        colorOverLife: makeGradient([{ t: 0, c: [1, 0.6, 0.2] }, { t: 1, c: [0.8, 0.2, 0.05] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.3, v: 0.9 }, { t: 1, v: 0 }]),
      }),
    ],
    scene: scene({
      skyTop: [0.1, 0.12, 0.17], skyBottom: [0.04, 0.045, 0.05],
      sunIntensity: 2.0, sunElevation: 30, ambient: 0.9, bloom: 0.45,
    }),
  };
}

// ---------------------------------------------------------------- Boids
//
// The compute-sim showcase: every boid reads every other boid through the
// read-only `neighbors` snapshot, which is the thing a CPU sim (or a
// property editor) fundamentally cannot express.
function boids() {
  const matBoid = makeMaterial({
    id: 'boid-dart', name: 'Boid', blendMode: 'add', lit: false,
    vertexSrc: `// Rebuild the billboard as a dart aligned with the boid's velocity.
// v.uv holds the quad corner (0..1), so local = uv - 0.5 gives its offset.

fn mainVertex(v: ptr<function, VertexData>, p: Particle) {
  let toCam = normalize(u.cameraPos - p.center);
  let speed = length(p.velocity);
  let fwd = select(vec3f(0.0, 1.0, 0.0), p.velocity / max(speed, 1e-5), speed > 1e-4);
  let cr = cross(fwd, toCam);
  let crLen = length(cr);
  let side = select(vec3f(1.0, 0.0, 0.0), cr / max(crLen, 1e-5), crLen > 1e-4);

  let local = v.uv - 0.5;
  v.positionWS = p.center + fwd * (local.y * p.size * 3.6) + side * (local.x * p.size * 1.3);
  v.normalWS = toCam;
}
`,
    fragmentSrc: `// Tapered dart: wide at the tail, sharp at the nose, brighter forward.

fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let along = i.uv.y;                        // 0 tail -> 1 nose
  let across = abs(i.uv.x - 0.5) * 2.0;
  let halfWidth = mix(0.95, 0.08, along);    // taper toward the nose
  let body = smoothstep(halfWidth, 0.0, across) * smoothstep(0.0, 0.35, along);
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * (1.2 + 3.4 * along);
  s.alpha = body * i.color.a;
}
`,
  });
  const matHalo = makeMaterial({
    id: 'boid-halo', name: 'Halo', blendMode: 'add', lit: false,
    softParticles: true, softDistance: 1.5,
    fragmentSrc: `fn mainSurface(s: ptr<function, Surface>, i: SurfaceInput) {
  let d = length(i.uv - 0.5) * 2.0;
  s.albedo = vec3f(0.0);
  s.emissive = i.color.rgb * 0.5;
  s.alpha = pow(smoothstep(1.0, 0.0, d), 2.5) * i.color.a;
}
`,
  });

  const BOID_SIM = `// Boids flocking, entirely on the GPU.
//
// \`neighbors\` is a read-only snapshot of every particle as of last frame, so
// this loop can look at the rest of the flock without racing the writes other
// invocations are doing right now. That shared-state read is what makes this a
// compute simulation rather than a per-particle formula.

const VIEW_RADIUS = 0.9;    // how far a boid can see
const SEP_RADIUS  = 0.32;   // personal space
const MIN_SPEED   = 0.8;
const MAX_SPEED   = 2.4;

fn spawn(p: ptr<function, Particle>, ctx: SpawnCtx) {
  p.position = ctx.emitterPos + vec3f(randRange(-2.5, 2.5), randRange(-0.9, 1.5), randRange(-2.5, 2.5));
  p.velocity = randUnitVec() * randRange(MIN_SPEED, MAX_SPEED);
  p.lifetime = 1.0e9;              // the flock is permanent — nothing recycles
  p.size = randRange(0.030, 0.055);
  p.phase = rand() * TAU;          // custom field: per-boid wander offset
  p.color = mix(vec4f(0.25, 0.75, 1.0, 1.0), vec4f(1.0, 0.42, 0.85, 1.0), rand());
}

fn simulate(p: ptr<function, Particle>, ctx: SimCtx) {
  var sepForce = vec3f(0.0);   // steer away from crowding
  var alignVel = vec3f(0.0);   // average heading of the neighbourhood
  var cohPos = vec3f(0.0);     // average position of the neighbourhood
  var seen = 0.0;

  // O(n²) across the slot table — a few hundred boids is nothing for a GPU.
  // The cap keeps it sane if Max particles gets cranked up.
  let scanCount = min(u32(sp.capacity), 1024u);
  for (var j = 0u; j < scanCount; j++) {
    if (j == ctx.index) { continue; }
    let other = neighbors[j];
    if (other.lifetime <= 0.0) { continue; }   // empty slot
    let delta = other.position - p.position;
    let d2 = dot(delta, delta);
    if (d2 > VIEW_RADIUS * VIEW_RADIUS || d2 < 1.0e-9) { continue; }

    alignVel += other.velocity;
    cohPos += other.position;
    let dist = sqrt(d2);
    if (dist < SEP_RADIUS) {
      sepForce -= (delta / dist) * (SEP_RADIUS - dist);
    }
    seen += 1.0;
  }

  var steer = sepForce * 11.0;
  if (seen > 0.0) {
    steer += (alignVel / seen - p.velocity) * 2.6;
    steer += (cohPos / seen - p.position) * 1.8;
  }

  // Keep the flock on stage: pull home, harden it into a wall past the cage
  // radius, then add a slow swirl and a per-boid wander.
  let fromHome = p.position - sp.emitterPos;
  let homeDist = length(fromHome);
  steer += -fromHome * 1.1;
  if (homeDist > 2.15) {
    steer += -(fromHome / homeDist) * (homeDist - 2.15) * 9.0;
  }
  steer += cross(fromHome, vec3f(0.0, 1.0, 0.0)) * 0.30;
  steer += vec3f(sin(sp.time * 0.7 + p.phase), 0.0, cos(sp.time * 0.9 + p.phase)) * 0.40;

  p.velocity += steer * ctx.dt;
  let speed = length(p.velocity);
  p.velocity = (p.velocity / max(speed, 1.0e-5)) * clamp(speed, MIN_SPEED, MAX_SPEED);
  p.position += p.velocity * ctx.dt;

  // bounce off the floor
  if (p.position.y < 0.3) {
    p.position.y = 0.3;
    p.velocity.y = abs(p.velocity.y) * 0.7;
  }
}
`;

  const flat = () => makeCurve([{ t: 0, v: 1 }, { t: 1, v: 1 }]);

  return {
    name: 'Boids (compute)',
    materials: [matBoid, matHalo],
    emitters: [
      emitter({
        name: 'Flock', materialId: 'boid-dart',
        simMode: 'shader', simSrc: BOID_SIM,
        fields: [{ name: 'phase', type: 'f32' }],
        position: [0, 1.25, 0],
        // One burst, no looping: the flock is created once and then persists.
        spawn: { rate: 0, max: 600, bursts: [{ time: 0, count: 600 }] },
        duration: 2, looping: false,
        lifetime: [1e9, 1e9],
        sizeStart: [0.03, 0.055],
        sizeOverLife: flat(), alphaOverLife: flat(),
      }),
      emitter({
        name: 'Halo', materialId: 'boid-halo',
        position: [0, 1.25, 0],
        spawn: { rate: 2, max: 8 }, lifetime: [2.4, 3.4],
        shape: { type: 'point' }, speed: [0, 0.03],
        sizeStart: [3.4, 4.2],
        colorOverLife: makeGradient([{ t: 0, c: [0.3, 0.55, 1] }, { t: 1, c: [0.75, 0.35, 1] }]),
        alphaOverLife: makeCurve([{ t: 0, v: 0 }, { t: 0.5, v: 0.35 }, { t: 1, v: 0 }]),
      }),
    ],
    scene: scene({
      skyTop: [0.035, 0.05, 0.11], skyBottom: [0.012, 0.015, 0.03],
      sunIntensity: 0.8, sunElevation: 25, ambient: 0.6, bloom: 0.7, bloomThreshold: 0.85,
      pointLights: [
        { enabled: true, pos: [0, 1.6, 0], color: [0.4, 0.6, 1], intensity: 3 },
        { enabled: false, pos: [-2, 1.5, -2], color: [0.2, 0.5, 1], intensity: 4 },
      ],
    }),
  };
}

// ---------------------------------------------------------------- Starter
function starter() {
  const mat = makeMaterial({ id: 'starter-mat', name: 'Basic Particle' });
  return {
    name: 'New Effect',
    materials: [mat],
    emitters: [emitter({ name: 'Emitter 1', materialId: 'starter-mat', speed: [1.2, 2.2], gravity: [0, -1, 0] })],
    scene: scene({}),
  };
}

export const PRESETS = {
  'Campfire': campfire,
  'Magic Orb': magicOrb,
  'Fountain': fountain,
  'Confetti Burst': confetti,
  'Smoke Plume': smokePlume,
  'Boids (compute)': boids,
  'Starter (blank)': starter,
};
