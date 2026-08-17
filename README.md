# particletoy ✨

A [shadertoy](https://shadertoy.com)-inspired playground for **particle effects** — a
game-engine-style particle editor with programmable PBR materials, two selectable graphics
pipelines, and zero-infrastructure sharing.

Built as a fully static web app: plain ES modules, WebGPU, no build step. Shaders are
written in [Slang](https://shader-slang.org) and compiled to WGSL in the browser by a
vendored copy of the Slang compiler (`js/vendor/slang`, 24 MB — the app's one dependency).

## AI disclosure

This project was made entirely with AI prompting. Every line of code — editor, renderer,
shader library, compute simulation, and community backend alike — was generated through
prompting an AI assistant. No code in this repository was handwritten.

The **DougAI** account hosting this repo is used exclusively for AI-generated projects.
My non-AI, handwritten work lives at [github.com/douglaspotesta](https://github.com/douglaspotesta).

## Run it
 
```bash
python serve.py     # → http://localhost:8917
```

Any static file server works (see the note about Windows MIME types in
[setup.html](setup.html)). Requires WebGPU (current Chrome / Edge / Safari / Firefox).

## Shaders are Slang

Everything you write — vertex stage, fragment stage, compute sim — is
[Slang](https://shader-slang.org), an HLSL-family language with generics, `inout`
parameters and a real module system. The engine compiles it to WGSL in your browser, so
it still runs natively on WebGPU; press **?** in the app for the full API reference and a
crib sheet.

The compiler is a 24 MB WebAssembly binary (9.75 MB over the wire). Only the editor loads
it. The community pages render published effects from WGSL saved alongside them, so
browsing and hover previews cost nothing extra.

> **Effects published before the Slang cutover no longer render.** Their shaders are WGSL,
> which this engine can't compile, and there is no WGSL → Slang translator. Opening one in
> the editor still loads everything else — emitters, curves, materials, scene — and shows
> the original source so it can be ported by hand.

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

**Programmable GPU simulation** (the compute part):

- Each emitter can switch from the property-driven sim to a **Slang compute shader** you edit
  live: `spawn()` initializes a particle, `simulate()` steps it — spawning budgets, slot
  recycling, dead-particle culling (indirect draws) and back-to-front sorting for alpha
  blending all run on the GPU, scaling to ~100k particles
- **Convert to sim shader** seeds the editor with the exact Slang that reproduces the
  property-editor behavior; every property keeps working through `sp.*` uniforms until you
  replace it
- **Custom per-particle fields** (float/float2/float3/float4) — add state like a `home` anchor
  or a `phase`, and it persists in the particle struct across frames
- **`neighbors[]`** — a race-free, read-only snapshot of the whole particle array from last
  frame, so particles can react to *each other* (flocking, contact forces). See the
  **Boids (compute)** preset: 600 boids doing separation / alignment / cohesion entirely
  on the GPU

**Materials & shaders** (the shadertoy part):

- Every material has a **programmable vertex and fragment stage** (Slang) with live compilation,
  inline error markers, and shadertoy-style behavior (broken code keeps the last good shader
  running)
- The fragment stage fills a **PBR `Surface`** (albedo / metallic / roughness / normal /
  emissive / occlusion / alpha); the vertex stage can displace particle geometry
  (velocity stretching, orbits, …)
- Blend modes: opaque, alpha-cutout, alpha blend (depth-sorted), additive
- Lit (PBR) or unlit shading, soft particles (depth fade), double-sided toggle
- Built-in noise library (`hash11/21/33`, `noise2/3`, `fbm2/3`), frame uniforms
  (`u.time`, `u.resolution`, `u.mouse`, `u.cameraPos`) — press **?** in the app for the full
  API reference

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
- **Presets** — Campfire, Magic Orb, Fountain, Confetti Burst, Smoke Plume,
  Boids (compute), blank starter

**The community site** (accounts + gallery, backed by a free Supabase project):

- Front page ([index.html](index.html)) — **particle of the day** rendered live front and
  center, featured + latest grids with **live hover previews**, search, donate links
- **Accounts** — email/password sign-up, password reset, email change, avatars,
  display names, bios, notification preferences, in-app notifications
- **Project pages** ([view.html](view.html)) — live player, description, tags, author,
  created/edited dates, view counter, **likes** and a **comment section**;
  owners can flip particles **public/private**, edit, or delete
- **Browse** ([browse.html](browse.html)) — full-text search, tag filters,
  newest/popular/loved sorting, pagination
- **Publish from the editor** — captures a thumbnail and a short preview clip and saves
  to your account; re-publishing your own particle updates it in place
- **Link previews** — paste a particle link into Discord, Slack or Twitter and the card
  shows the title, author, stats and the effect *playing*. Crawlers don't run JavaScript
  and a static host can't vary `<head>` per particle, so one small function
  ([og/index.js](og/index.js)) renders the Open Graph tags and redirects humans to the
  real page. Dependency-free, build-step-free plain JS that detects its runtime, so the
  one file runs on Cloudflare Workers or Deno Deploy — *not* on a default
  `*.supabase.co` function URL, which rewrites HTML responses to `text/plain`
- Admin curation (★ feature / ☀ particle of the day) straight from particle pages

Setup for all of it is one SQL file + a few dashboard toggles — see
[setup.html](setup.html) / [supabase/schema.sql](supabase/schema.sql). Link previews are
the one part that needs a deploy step (still no build step); they're optional, and
everything else works without them.

## Controls

- **Orbit** left-drag · **pan** right/shift-drag · **zoom** wheel · **Space** play/pause
- **Ctrl+Enter** in the shader editor compiles immediately (auto-compile is on by default)
- Curve editors: drag keys, double-click to add, right-click to remove.
  Gradient editor: double-click a stop to recolor, double-click empty space to add.

## Hosting & the community backend

See **[setup.html](setup.html)** — local serving, free static hosting (GitHub Pages /
Netlify / Cloudflare), and standing up the community backend on Supabase:
run [supabase/schema.sql](supabase/schema.sql) once in the SQL editor, set the Site URL
in Auth settings, done. Row-level security enforces public/private server-side; clients
can't touch counters or admin flags.

## Code map

Site: `index.html` / `browse.html` / `view.html` / `account.html` / `user.html` +
`js/pages/*` and shared chrome in `js/site.js`; `js/backend.js` is the whole REST client
(auth, particles, likes, comments, notifications, storage); `js/player.js` is the
embeddable renderer used for the front page, hover previews, and view pages.
Editor: `editor.html` + `js/main.js`, with `js/renderer.js` (both pipelines),
`js/gpu.js` (WebGPU device + uniform-block/layout helpers), `js/shaderlib.js` (Slang +
material API wrappers), `js/particles.js` (CPU simulation), `js/simlib.js` +
`js/gpusim.js` (compute simulation: codegen, runtime, bitonic sort),
`js/slangc.js` (the Slang → WGSL compile service, sole owner of the wasm),
`js/wgslcache.js` (compiled WGSL saved with each effect), `js/ui.js` (inspector +
editor panel). `js/exportmedia.js` renders clips on a detached canvas — both the
Export Media downloads and the link-preview clips. `og/index.js` is the only
server-side code in the project (and `og/index.test.mjs` its only test:
`node og/index.test.mjs`, no install, no flags).
