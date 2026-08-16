// Serialization + sharing: URL hash (deflate + base64url), JSON file
// export/import, and a localStorage library.

const STORAGE_KEY = 'particletoy.library.v1';

// v2 marks the Slang cutover. v1 effects hold WGSL in vertexSrc/fragmentSrc/
// simSrc and cannot be compiled by this engine — main.js detects them on load
// and says so rather than showing a black canvas.
export const SCHEMA_VERSION = 2;

export function serializeState(effectName, emitters, materials, scene, wgslCache) {
  const out = {
    v: SCHEMA_VERSION,
    shaderLang: 'slang',
    name: effectName,
    emitters: emitters.map((e) => structuredClone(e.p)),
    materials: materials.map((m) => structuredClone(m)),
    scene: structuredClone(scene),
  };
  // Only where the bytes are free. Share links deliberately go without: they
  // open in the editor, which has the compiler, and carrying compiled WGSL
  // would bloat a ~2 KB link several-fold.
  if (wgslCache) out.wgslCache = wgslCache;
  return out;
}

/** True for effects saved before the Slang cutover, whose shaders are WGSL. */
export function isPreSlang(data) {
  return (data?.shaderLang ?? 'wgsl') !== 'slang';
}

function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeThrough(bytes, stream) {
  const blob = new Blob([bytes]);
  const out = blob.stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeShareString(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== 'undefined') {
    const packed = await pipeThrough(json, new CompressionStream('deflate-raw'));
    return 'c' + b64urlEncode(packed);
  }
  return 'j' + b64urlEncode(json);
}

export async function decodeShareString(str) {
  const kind = str[0];
  const bytes = b64urlDecode(str.slice(1));
  let json;
  if (kind === 'c') {
    json = await pipeThrough(bytes, new DecompressionStream('deflate-raw'));
  } else {
    json = bytes;
  }
  return JSON.parse(new TextDecoder().decode(json));
}

export function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveToLibrary(name, obj) {
  const lib = loadLibrary();
  lib[name] = { savedAt: Date.now(), data: obj };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
}

export function deleteFromLibrary(name) {
  const lib = loadLibrary();
  delete lib[name];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function downloadJSON(obj, filename) {
  downloadBlob(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), filename);
}

export function pickJSONFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => {
        try { resolve(JSON.parse(r.result)); } catch { resolve(null); }
      };
      r.readAsText(f);
    };
    input.click();
  });
}
