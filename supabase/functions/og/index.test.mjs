// Smoke test for the link-preview endpoint. No dependencies, no install:
//
//     node --experimental-strip-types supabase/functions/og/index.test.mjs
//
// Runs the real module under Node with Deno and fetch stubbed out, and checks
// the tags Discord actually keys off. Nothing here talks to the network.
import assert from 'node:assert';

const ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  title: 'Campfire <script>',
  description: 'A cosy fire with "embers" & smoke.',
  thumb_url: 'https://cdn.example/thumb.jpg',
  tags: ['fire'],
  preview_url: 'https://cdn.example/clip.mp4',
  preview_type: 'video/mp4',
  preview_w: 960,
  preview_h: 540,
  views: 1234,
  likes: 42,
  comment_count: 7,
  created_at: '2026-08-01T00:00:00Z',
  author: { username: 'doug', display_name: 'Doug & Co' },
};

let handler = null;
let lastFetchUrl = null;
let nextRows = [ROW];

globalThis.Deno = {
  env: {
    get: (k) => ({
      SUPABASE_URL: 'https://proj.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
    })[k],
  },
  serve: (h) => { handler = h; },
};

globalThis.fetch = async (url) => {
  lastFetchUrl = url;
  return { ok: true, json: async () => nextRows };
};

await import('./index.ts');
assert(handler, 'Deno.serve was never called');

const call = (url, ua) => handler(new Request(url, { headers: ua ? { 'user-agent': ua } : {} }));

const SITE = 'https://dougai.github.io/particletoy';
const ID = ROW.id;
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';

function ok(name, cond, extra = '') {
  if (!cond) { console.error(`✗ ${name} ${extra}`); process.exitCode = 1; }
  else console.log(`✓ ${name}`);
}

// ── 1. Discord gets the video card ─────────────────────────────────────────
{
  const res = await call(`https://proj.supabase.co/og/${ID}`, DISCORD);
  const html = await res.text();
  ok('crawler gets 200 HTML', res.status === 200 &&
     res.headers.get('content-type').startsWith('text/html'));
  ok('queries by id', String(lastFetchUrl).includes(`id=eq.${ID}`), lastFetchUrl);
  for (const tag of [
    '<meta property="og:site_name" content="particletoy">',
    `<meta property="og:url" content="${SITE}/view.html?id=${ID}">`,
    '<meta property="og:type" content="video.other">',
    '<meta property="og:video" content="https://cdn.example/clip.mp4">',
    '<meta property="og:video:type" content="video/mp4">',
    '<meta property="og:video:width" content="960">',
    '<meta name="twitter:card" content="player">',
    '<meta name="twitter:player:stream:content_type" content="video/mp4">',
    '<meta property="og:image" content="https://cdn.example/thumb.jpg">',
    '<meta name="theme-color" content="#e8a33d">',
  ]) ok(`has ${tag.slice(0, 52)}…`, html.includes(tag), `\n  got:\n${html}`);

  ok('title carries author', html.includes('Campfire &lt;script&gt; — by Doug &amp; Co'));
  // The only <script> in the page must be the redirect the template writes;
  // nothing from the database may show up unescaped.
  ok('escapes user text everywhere',
     !html.includes('Campfire <script>') && html.match(/<script>/g).length === 1,
     '\n' + html);
  ok('stats in description', html.includes('♥ 42') && html.includes('👁 1.2k'));
}

// ── 2. A GIF preview becomes the image, not a video ────────────────────────
{
  nextRows = [{ ...ROW, preview_type: 'image/gif', preview_url: 'https://cdn.example/clip.gif' }];
  const html = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('gif goes in og:image', html.includes('<meta property="og:image" content="https://cdn.example/clip.gif">'));
  ok('gif emits no og:video', !html.includes('og:video'));
  ok('gif uses summary_large_image', html.includes('<meta name="twitter:card" content="summary_large_image">'));
}

// ── 3. No preview clip → still image card ──────────────────────────────────
{
  nextRows = [{ ...ROW, preview_url: null, preview_type: null }];
  const html = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('falls back to thumb', html.includes('<meta property="og:image" content="https://cdn.example/thumb.jpg">'));
  ok('no video tags', !html.includes('og:video'));
}

// ── 4. Humans are redirected ───────────────────────────────────────────────
{
  nextRows = [ROW];
  const res = await call(`https://proj.supabase.co/og/${ID}`, CHROME);
  ok('browser gets 302', res.status === 302);
  ok('to the real page', res.headers.get('location') === `${SITE}/view.html?id=${ID}`,
     res.headers.get('location'));
}

// ── 5. ?card=1 lets a human see the card ───────────────────────────────────
{
  const res = await call(`https://proj.supabase.co/og/${ID}?card=1`, CHROME);
  ok('?card=1 renders HTML', res.status === 200);
}

// ── 6. id forms: query param, and a slug in the path ───────────────────────
{
  const a = await call(`https://proj.supabase.co/og?id=${ID}`, DISCORD);
  ok('?id= works', a.status === 200);
  const b = await call(`https://proj.supabase.co/og/campfire-${ID}`, DISCORD);
  ok('slug-prefixed path works', b.status === 200);
}

// ── 7. Missing / private particle → site card, not a crash ─────────────────
{
  nextRows = [];
  const res = await call(`https://proj.supabase.co/og/${ID}`, DISCORD);
  const html = await res.text();
  ok('unknown id → 404', res.status === 404);
  ok('…but still a valid card', html.includes('<meta property="og:site_name" content="particletoy">'));

  const bare = await call('https://proj.supabase.co/og', DISCORD);
  ok('bare /og → site card', bare.status === 404 &&
     (await bare.text()).includes(`${SITE}/img/og-card.jpg`));
}

// ── 8. A backend hiccup must not 500 the crawler ───────────────────────────
{
  globalThis.fetch = async () => { throw new Error('network down'); };
  const res = await call(`https://proj.supabase.co/og/${ID}`, DISCORD);
  ok('backend failure → site card', res.status === 404);
}

console.log(process.exitCode ? '\nFAILED' : '\nall good');
