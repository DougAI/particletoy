const CACHE = 'particletoy-shell-v1';
const SHELL = [
  './', './index.html', './editor.html', './manifest.webmanifest',
  './css/site.css', './css/style.css', './js/main.js', './js/site.js',
  './js/mobile-layout.js', './js/quality.js', './img/icon-192.png', './img/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('particletoy-shell-') && key !== CACHE)
      .map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match('./index.html'));
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const update = fetch(request).then(async (response) => {
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || update;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (/\.(?:css|js|mjs|json|webmanifest|svg|png|jpe?g|wasm)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

