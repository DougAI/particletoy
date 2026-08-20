// Tests for the compiled-WGSL cache an effect carries with it. No
// dependencies, no install:
//
//     node js/wgslcache.test.mjs
//
// The gallery pages render published effects from this cache and never load
// the Slang compiler, so a hole in it is a project page with no particles in
// it — and nothing on screen to say why. Everything here is the pure
// bookkeeping half of that: what a runtime stamps, what survives a save, and
// what buildCache refuses to write.
//
// The module is dependency-free, so it loads under plain node as-is.
import {
  buildCache, cacheGaps, materialEntry, materialFromCache, renderVariants,
  restoredEntry, simEntry, simFromCache,
} from './wgslcache.js';

function ok(name, cond, extra = '') {
  if (!cond) { console.error(`✗ ${name} ${extra}`); process.exitCode = 1; }
  else console.log(`✓ ${name}`);
}

const material = (o = {}) => ({
  id: 'mat1', name: 'Embers', blendMode: 'add', lit: false, softParticles: false,
  vertexSrc: 'VS SOURCE', fragmentSrc: 'FS SOURCE', ...o,
});
const emitter = (o = {}) => ({
  id: 'em1', name: 'Sparks', enabled: true, materialId: 'mat1',
  simMode: 'props', simSrc: '', fields: [], ...o,
});

// What the runtimes look like to buildCache: a compiled material holds the
// entry it stamped, an emitter reaches its sim's through simRt.
const compiled = (m, code) => new Map([[m.id, { cacheEntry: materialEntry(m, code) }]]);
const withSim = (p, code) => ({ p, simRt: { cacheEntry: simEntry(p, code) } });
const noSim = (p) => ({ p, simRt: null });

// The WGSL a material's compile produces: the vertex module plus one module
// per variant it is actually drawn with.
function fresh(m) {
  const code = { vs: `${m.vertexSrc}//vs`, locations: [{ name: 'pos', location: 0 }] };
  for (const v of renderVariants(m)) code[v] = `${m.fragmentSrc}//${v}`;
  return code;
}

const saved = (m, materialRuntimes, emitters) => ({
  materials: [m],
  emitters: emitters.map((e) => e.p),
  wgslCache: buildCache([m], materialRuntimes, emitters),
});

// ── 1. A compiled effect saves everything it needs ─────────────────────────
{
  const m = material();
  const em = noSim(emitter());
  const data = saved(m, compiled(m, fresh(m)), [em]);
  ok('a freshly compiled effect saves with no gaps', cacheGaps(data).length === 0,
     JSON.stringify(cacheGaps(data)));
  ok('the saved cache is what the gallery reads back',
     materialFromCache(data.wgslCache, m, renderVariants(m))?.forward.code === 'FS SOURCE//forward');
}

// ── 2. Reopening and saving again keeps the shaders ────────────────────────
// The bug this file exists for: an effect opened from a save renders entirely
// from its own cache, so the compiler never runs — and a runtime that doesn't
// hold on to what it built from writes an empty cache on the way out. The
// second save published the effect with its shaders stripped off, and the
// only way anyone found out was an empty page.
{
  const m = material();
  const em = noSim(emitter());
  const first = saved(m, compiled(m, fresh(m)), [em]);

  const variants = renderVariants(m);
  const hit = materialFromCache(first.wgslCache, m, variants);
  const reopened = new Map([[m.id, { cacheEntry: restoredEntry(hit, variants) }]]);
  const second = saved(m, reopened, [em]);

  ok('re-saving an effect that rendered from cache keeps its shaders',
     cacheGaps(second).length === 0, JSON.stringify(cacheGaps(second)));
  ok('and the WGSL is the same WGSL',
     JSON.stringify(second.wgslCache) === JSON.stringify(first.wgslCache));
}

// ── 3. Code is never re-keyed onto source it didn't come from ──────────────
// A compile in flight, or one that failed, leaves a runtime holding the
// previous shader. Publishing that under the current source's key would put
// the wrong module on the page rather than an honest hole.
{
  const m = material();
  const stale = compiled(m, fresh(m));            // stamped against 'FS SOURCE'
  const edited = material({ fragmentSrc: 'FS SOURCE v2' });
  const data = saved(edited, stale, [noSim(emitter())]);

  ok('an edit since the last compile drops the module it outdated',
     data.wgslCache.materials.mat1?.forward === undefined,
     JSON.stringify(data.wgslCache.materials));
  ok('and the gap is reported by name', cacheGaps(data).join() === 'material “Embers”',
     JSON.stringify(cacheGaps(data)));
  // The vertex module is keyed on its own source, which this edit left alone.
  ok('the stage the edit didn\u2019t touch is kept',
     data.wgslCache.materials.mat1?.vs.code === 'VS SOURCE//vs');

  // Blend mode and lighting are compiled into the fragment module, so they
  // move its key as surely as an edit does.
  const relit = material({ lit: true });
  ok('a material setting changed since the compile drops it too',
     buildCache([relit], stale, []).materials.mat1?.forward === undefined);
}

// ── 4. Only the variants a material is drawn with are required ─────────────
{
  const blended = material({ blendMode: 'blend' });
  ok('a blended material needs the forward variant only',
     renderVariants(blended).join() === 'forward');
  ok('and saves clean without a gbuffer module',
     cacheGaps(saved(blended, compiled(blended, fresh(blended)), [noSim(emitter())])).length === 0);

  const opaque = material({ blendMode: 'opaque' });
  ok('an opaque material needs both', renderVariants(opaque).join() === 'gbuffer,forward');

  // A variant whose compile failed leaves no module behind — which is a gap,
  // not something to paper over with the last good one.
  const half = fresh(opaque);
  delete half.gbuffer;
  ok('an opaque material missing its gbuffer module is a gap',
     cacheGaps(saved(opaque, compiled(opaque, half), [noSim(emitter())])).length === 1);
}

// ── 5. Emitters nobody draws can't leave a visible hole ────────────────────
{
  const m = material();
  const empty = new Map();
  ok('a disabled emitter is not a gap',
     cacheGaps(saved(m, empty, [noSim(emitter({ enabled: false }))])).length === 0);
  ok('an emitter with no material is not a gap',
     cacheGaps(saved(m, empty, [noSim(emitter({ materialId: null }))])).length === 0);
  ok('but an emitter that is drawn is', cacheGaps(saved(m, empty, [noSim(emitter())])).length === 1);
}

// ── 6. Compute sims are cached per emitter, keyed by source and fields ─────
{
  const m = material();
  const mats = compiled(m, fresh(m));
  const p = emitter({ simMode: 'shader', simSrc: 'SIM SOURCE' });
  const data = saved(m, mats, [withSim(p, 'SIM WGSL')]);

  ok('a sim shader saves with the emitter', simFromCache(data.wgslCache, p) === 'SIM WGSL');
  ok('and leaves no gap', cacheGaps(data).length === 0, JSON.stringify(cacheGaps(data)));

  ok('an uncompiled sim is a gap',
     cacheGaps(saved(m, mats, [noSim(p)])).join() === 'sim shader on “Sparks”');

  // The Particle struct is generated from the field list, so a field rename
  // changes the module even though the source text doesn't.
  const renamed = { ...p, fields: [{ name: 'phase', type: 'f32' }] };
  ok('a field change since the compile drops the sim',
     buildCache([m], mats, [{ p: renamed, simRt: { cacheEntry: simEntry(p, 'SIM WGSL') } }])
       .sims.em1 === undefined);

  // Property-driven emitters don't run a sim module at all.
  ok('a props-mode emitter needs no sim entry',
     cacheGaps(saved(m, mats, [noSim(emitter())])).length === 0);
}

// ── 7. An effect with no cache at all is all gaps ──────────────────────────
{
  const m = material();
  ok('a share link (no cache) reports its shaders missing',
     cacheGaps({ materials: [m], emitters: [emitter()] }).length === 1);
  ok('an empty effect reports nothing', cacheGaps({}).length === 0);
}

console.log(process.exitCode ? '\nFAILED' : '\nall good');
