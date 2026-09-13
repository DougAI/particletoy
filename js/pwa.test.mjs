import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { registerPwa } from './pwa.js';

const manifest = JSON.parse(await fs.readFile(new URL('../manifest.webmanifest', import.meta.url)));
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, './editor.html');
assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);

let registered = null;
const result = await registerPwa({
  serviceWorker: { register(url) { registered = String(url); return Promise.resolve('ok'); } },
  protocol: 'https:',
  url: new URL('https://particletoy.com/sw.js'),
});
assert.equal(result, 'ok');
assert.equal(registered, 'https://particletoy.com/sw.js');
assert.equal(await registerPwa({ serviceWorker: null, protocol: 'https:' }), null);

const worker = await fs.readFile(new URL('../sw.js', import.meta.url), 'utf8');
assert.match(worker, /url\.origin !== self\.location\.origin/);
assert.match(worker, /request\.mode === 'navigate'/);
assert.match(worker, /wasm/);

console.log('installable offline shell: ok');

