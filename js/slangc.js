// Slang -> WGSL compile service.
//
// User-authored shader code is Slang; the engine speaks WebGPU, so every user
// shader passes through the vendored Slang compiler (js/vendor/slang) on its
// way to device.createShaderModule(). This module is the only thing that
// touches the wasm.
//
// IMPORTANT: loadSlang() fetches a 24 MB binary (9.75 MB gzipped) — roughly 25x
// the whole rest of the app. index.html, browse.html and view.html run live
// hover previews for casual visitors and must NEVER reach it; they render from
// the WGSL cached in each saved effect instead (see share.js / player.js).
//
// Importing this module is free — the wasm sits behind a dynamic import inside
// loadSlang() and nothing is fetched until that is called. So the rule to hold
// is "the gallery pages never call loadSlang()", not "they never import this".

const WASM_URL = './vendor/slang/slang-wasm.js';

// Slang stage IDs, as expected by Module.findAndCheckEntryPoint().
export const STAGE = { vertex: 1, fragment: 5, compute: 6 };

// The virtual path given to the compiler. Diagnostics quote it back
// ("--> /user.slang:12:5"), so the error parser anchors on this exact name.
const MODULE_PATH = '/user.slang';
const MODULE_NAME = 'user';

let slang = null;          // the emscripten module, once resolved
let globalSession = null;
let wgslTarget = -1;
let loadPromise = null;

/** True once the compiler is resident and compileSlang() can be called. */
export function slangReady() {
  return slang !== null;
}

/**
 * Downloads and initialises the compiler. Idempotent and safe to call
 * concurrently — every caller shares one in-flight load.
 */
export function loadSlang() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const factory = (await import(WASM_URL)).default;
    const mod = await factory();
    const targets = mod.getCompileTargets();
    // getCompileTargets() hands back either a JS array or an embind vector
    // depending on the build; normalise before searching.
    const list = typeof targets?.size === 'function'
      ? Array.from({ length: targets.size() }, (_, i) => targets.get(i))
      : targets;
    const wgsl = list.find((t) => t.name === 'WGSL');
    if (!wgsl) throw new Error('this Slang build has no WGSL target');
    wgslTarget = wgsl.value;
    globalSession = mod.createGlobalSession();
    if (!globalSession) throw new Error('could not create a Slang global session');
    slang = mod;
    return mod;
  })().catch((e) => {
    loadPromise = null;   // let a later attempt retry a failed download
    throw e;
  });
  return loadPromise;
}

/** Slang's version string, e.g. "2026.14". Null until loaded. */
export function slangVersion() {
  return slang ? slang.getVersionString() : null;
}

// ---------------------------------------------------------------- diagnostics
//
// getLastError().message is a human-formatted multi-error blob:
//
//   error[E30015]: undefined identifier
//    --> /user.slang:12:66
//     |
//  12 | s.albedo = nope;
//     |            ^^^^ undefined identifier 'nope'.
//   --'
//
// The headline is generic ("undefined identifier") and the useful text sits on
// the caret line, so we prefer the caret detail and fall back to the headline.

const RE_HEAD = /^(error|warning)(?:\[(E\d+)\])?:\s*(.*)$/;
const RE_LOC = /^\s*-->\s*\/\S*?:(\d+):(\d+)/;
const RE_CARET = /^\s*\|\s*[\^~]+\s*(.*)$/;

// Cascade noise: every failed compile ends with these, and they carry no
// location a user could act on.
const NOISE_CODES = new Set(['E39999', 'E40003']);

/** Parses a Slang diagnostic blob into [{line, col, msg}] (1-based lines). */
export function parseDiagnostics(text) {
  if (!text) return [];
  const lines = String(text).split('\n');
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && !NOISE_CODES.has(cur.code)) {
      out.push({ line: cur.line, col: cur.col, msg: cur.detail || cur.head });
    }
    cur = null;
  };
  for (const raw of lines) {
    const head = RE_HEAD.exec(raw);
    if (head) {
      flush();
      // "fatal error[E40003]" also matches once the leading word is stripped;
      // both live in NOISE_CODES so they drop out at flush time either way.
      cur = { code: head[2] || '', head: head[3].trim(), detail: '', line: 0, col: 0 };
      continue;
    }
    if (!cur) continue;
    const loc = RE_LOC.exec(raw);
    if (loc) {
      cur.line = parseInt(loc[1], 10);
      cur.col = parseInt(loc[2], 10);
      continue;
    }
    const caret = RE_CARET.exec(raw);
    if (caret && caret[1] && !cur.detail) cur.detail = caret[1].trim();
  }
  flush();
  // A failed compile often leads with a bare headline carrying neither a
  // location nor caret detail (e.g. "error[E30015]: undefined identifier"
  // sitting ahead of the real, located error). Once anything with a line
  // number survives, prefer those; otherwise keep what we have.
  const located = out.filter((e) => e.line > 0);
  const kept = located.length ? located : out;
  if (!kept.length && String(text).trim()) {
    // Unrecognised shape — surface it whole rather than swallowing it.
    return [{ line: 0, col: 0, msg: String(text).trim().split('\n')[0] }];
  }
  return kept;
}

// ---------------------------------------------------------------- vertex locations
//
// Slang assigns WGSL @location indices from HLSL semantics, ignoring both
// declaration order and [[vk::location(n)]], and its reflection data reports a
// *different* (declaration-order) numbering than it actually emits. The only
// trustworthy source is the generated code, so read the locations back off it.

const RE_VERTEX_STRUCT = /struct\s+vertexInput_\d+\s*\{([^}]*)\}/;
const RE_VERTEX_FIELD = /@location\((\d+)\)\s*([A-Za-z_]\w*?)_\d+\s*:/g;

/** { fieldName: location } for the vertex entry point's input struct. */
export function parseVertexLocations(wgsl) {
  const block = RE_VERTEX_STRUCT.exec(wgsl);
  if (!block) return null;
  const map = {};
  for (const m of block[1].matchAll(RE_VERTEX_FIELD)) map[m[2]] = parseInt(m[1], 10);
  return map;
}

// ---------------------------------------------------------------- compile

/**
 * Compiles Slang source to WGSL.
 *
 * @param {string} src           full module source (engine prelude + user code + entry points)
 * @param {{name: string, stage: number}[]} entryPoints
 * @returns {{wgsl: string|null, errors: {line, col, msg}[], vertexLocations: object|null}}
 *
 * Line numbers are 1-based against `src`; callers subtract their prelude's
 * lineOffset to map back onto user code, exactly as with WGSL compile info.
 *
 * Synchronous and blocking (~55 ms steady state) — call it behind the editor's
 * debounce, not from the frame loop.
 */
export function compileSlang(src, entryPoints) {
  if (!slang) throw new Error('compileSlang() called before loadSlang() resolved');
  const fail = (msg, line = 0) => ({ wgsl: null, errors: [{ line, col: 0, msg }], vertexLocations: null });

  let session = null;
  try {
    session = globalSession.createSession(wgslTarget);
    if (!session) return fail('could not create a Slang session');

    const module = session.loadModuleFromSource(src, MODULE_NAME, MODULE_PATH);
    if (!module) {
      return { wgsl: null, errors: parseDiagnostics(slang.getLastError().message), vertexLocations: null };
    }

    const components = [module];
    for (const { name, stage } of entryPoints) {
      const ep = module.findAndCheckEntryPoint(name, stage);
      if (!ep) {
        const diags = parseDiagnostics(slang.getLastError().message);
        return {
          wgsl: null,
          errors: diags.length ? diags : [{ line: 0, col: 0, msg: `entry point '${name}' not found` }],
          vertexLocations: null,
        };
      }
      components.push(ep);
    }

    const program = session.createCompositeComponentType(components).link();
    if (!program) {
      return { wgsl: null, errors: parseDiagnostics(slang.getLastError().message), vertexLocations: null };
    }

    const wgsl = program.getTargetCode(0);
    if (!wgsl || !wgsl.length) {
      return { wgsl: null, errors: parseDiagnostics(slang.getLastError().message), vertexLocations: null };
    }

    return { wgsl, errors: [], vertexLocations: parseVertexLocations(wgsl) };
  } catch (e) {
    return fail(e?.message || String(e));
  } finally {
    // The session owns every module and entry point created through it; without
    // this the wasm heap grows with each keystroke-triggered recompile.
    session?.delete();
  }
}
