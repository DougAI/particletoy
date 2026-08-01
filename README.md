# particletoy ✨

A [shadertoy](https://shadertoy.com)-inspired playground for **particle effects** — a
game-engine-style particle editor with programmable PBR materials, two selectable graphics
pipelines, and zero-infrastructure sharing.

Built as a fully static web app: plain ES modules, WebGL2, no dependencies, no build step.

## Run it

```bash
python serve.py     # → http://localhost:8917
```

Any static file server works (see the note about Windows MIME types in
[setup.html](setup.html)). Requires WebGL2 + `EXT_color_buffer_float` (all current browsers).

## Features

**Particle system** (per emitter, composable — an effect is any number of emitters):

- Spawn: continuous rate, timed bursts, max-particle cap
- Looping with configurable duration; play / pause / restart / time scale
- Lifetime ranges, emission shapes (point / sphere / hemisphere / cone / box / circle)
- Velocity: initial speed + direction spread, speed-over-life curve, gravity, drag
- Color over life (gradient), alpha over life (curve), random start-color blending
- Size over life, rotation + angular velocity
- Mesh per emitter: camera-facing quad, sphere, cube, or **custom OBJ** (paste into inspector)
- Per-emitter material selection

**Materials & shaders** (the shadertoy part):

- Every material has a **programmable vertex and fragment stage** with live compilation,
  inline error markers, and shadertoy-style behavior (broken code keeps the last good shader
  running)
- The fragment stage fills a **PBR `Surface`** (albedo / metallic / roughness / normal /
  emissive / occlusion / alpha); the vertex stage can displace particle geometry
  (velocity stretching, orbits, …)
- Blend modes: opaque, alpha-cutout, alpha blend (depth-sorted), additive
- Lit (PBR) or unlit shading, soft particles (depth fade), double-sided toggle
- Built-in noise library (`hash11/21/33`, `noise2/3`, `fbm2/3`), shadertoy-style uniforms
  (`iTime`, `iResolution`, `iMouse`) — press **?** in the app for the full API reference

**Two premade PBR pipelines**, switchable live from the toolbar:

- **PBR · Deferred** — G-buffer MRT (albedo+metallic, normal+roughness, emissive+AO, depth) →
  fullscreen lighting pass → forward-lit blended particles. Includes G-buffer debug views
  (albedo / normals / roughness-metallic / emissive / depth).
- **PBR · Forward** — everything lit inline, back-to-front transparency.

Both share the same lighting model (GGX specular, hemisphere ambient + procedural sky
environment, directional sun + up to 4 point lights) plus HDR rendering, bloom, and ACES
tonemapping.

**Explore, test, share:**

- **Share** — the entire effect (emitters, curves, shaders, scene) is deflate-compressed into
  the URL fragment: a ~2 KB link that needs no server
- **Save / Library** — browser localStorage
- **Export / Import** — portable `.particletoy.json` files
- **Presets** — Campfire, Magic Orb, Fountain, Confetti Burst, Smoke Plume, blank starter
- **Publish** — optional community gallery backed by Supabase; dormant until configured
  (see [setup.html](setup.html), ~5 minutes)

## Controls

- **Orbit** left-drag · **pan** right/shift-drag · **zoom** wheel · **Space** play/pause
- **Ctrl+Enter** in the shader editor compiles immediately (auto-compile is on by default)
- Curve editors: drag keys, double-click to add, right-click to remove.
  Gradient editor: double-click a stop to recolor, double-click empty space to add.

## Hosting & the community gallery

See **[setup.html](setup.html)** — it walks through local serving, free static hosting
(GitHub Pages / Netlify / Cloudflare), and enabling the publish/gallery backend
(SQL + RLS policies included; you only paste two constants into `js/backend.js`).

## Code map

See the "Where things live" section of [setup.html](setup.html). Headline modules:
`js/renderer.js` (both pipelines), `js/shaderlib.js` (GLSL + the material API wrappers),
`js/particles.js` (simulation), `js/ui.js` (inspector + editor panel).
