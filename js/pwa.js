// Registration is deliberately tiny. The worker only handles same-origin static
// files; community and account requests continue to go straight to Supabase.

export function registerPwa({ serviceWorker = navigator.serviceWorker,
  protocol = location.protocol, url = new URL('../sw.js', import.meta.url) } = {}) {
  if (!serviceWorker || protocol === 'file:') return Promise.resolve(null);
  return serviceWorker.register(url).catch((error) => {
    console.warn('particletoy service worker registration failed', error);
    return null;
  });
}

