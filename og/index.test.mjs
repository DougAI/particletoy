// Smoke test for the link-preview endpoint. No dependencies, no install, no
// flags:
//
//     node og/index.test.mjs
//
// Drives the real handler with fetch stubbed out, checking the tags Discord
// actually keys off. Nothing here talks to the network. The module is plain
// JS and runtime-agnostic, so this exercises the exact code that ships.
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

let lastFetchUrl = null;
let nextRows = [ROW];

// The env a Worker would pass in. Exercising this path also proves the module
// doesn't depend on Deno being present.
const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  PT_ANON_KEY: 'anon-key',
};

globalThis.fetch = async (url) => {
  lastFetchUrl = url;
  return { ok: true, json: async () => nextRows };
};

const { handle } = await import('./index.js');
const mod = (await import('./index.js')).default;
assert(typeof mod.fetch === 'function', 'no default { fetch } export for Workers');

const call = (url, ua) =>
  handle(new Request(url, { headers: ua ? { 'user-agent': ua } : {} }), ENV);

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
    `<meta name="twitter:player" content="${SITE}/embed.html?id=${ID}">`,
    '<meta name="twitter:player:width" content="1280">',
    '<meta name="twitter:player:height" content="720">',
    '<meta name="twitter:player:stream:content_type" content="video/mp4">',
    '<meta property="og:image" content="https://cdn.example/thumb.jpg">',
    '<meta name="theme-color" content="#e8a33d">',
  ]) ok(`has ${tag.slice(0, 52)}…`, html.includes(tag), `\n  got:\n${html}`);

  ok('title carries author', html.includes('Campfire &lt;script&gt; — by Doug &amp; Co'));
  // Nothing from the database may show up unescaped, and the page carries no
  // script of its own any more.
  ok('escapes user text everywhere',
     !html.includes('Campfire <script>') && !/<script/i.test(html), '\n' + html);
  ok('stats in description', html.includes('♥ 42') && html.includes('👁 1.2k'));
  // A crawler is the only reader of this page; telling it the page moved
  // sends it to view.html and its generic tags instead.
  ok('no meta-refresh for crawlers', !/http-equiv=["']?refresh/i.test(html), '\n' + html);
  ok('no redirect script for crawlers', !html.includes('location.replace'), '\n' + html);
  ok('no raw newline inside an attribute',
     !/content="[^"]*\n/.test(html) && html.includes('&#10;'), '\n' + html);
  // The whole point of embed.html: Twitter iframes twitter:player, and
  // pointing it at view.html put the site header, search box and sign-in
  // button inside the card. The canonical link still goes to view.html.
  ok('player iframes the chrome-free embed, not the page',
     !html.includes(`<meta name="twitter:player" content="${SITE}/view.html`), '\n' + html);
  ok('canonical is still the real page',
     html.includes(`<link rel="canonical" href="${SITE}/view.html?id=${ID}">`), '\n' + html);
}

// ── 2. A GIF preview becomes the image, not a video ────────────────────────
{
  nextRows = [{ ...ROW, preview_type: 'image/gif', preview_url: 'https://cdn.example/clip.gif' }];
  const html = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('gif goes in og:image', html.includes('<meta property="og:image" content="https://cdn.example/clip.gif">'));
  ok('gif emits no og:video', !html.includes('og:video'));
  ok('gif still gets the live player', html.includes('<meta name="twitter:card" content="player">')
     && html.includes(`<meta name="twitter:player" content="${SITE}/embed.html?id=${ID}">`), '\n' + html);
  ok('gif hands over no stream', !html.includes('twitter:player:stream'), '\n' + html);
  ok('gif card is sized', html.includes('<meta property="og:image:width" content="960">')
     && html.includes('<meta property="og:image:height" content="540">'), '\n' + html);

  // preview_type without a preview_url — a half-written row, or a clip deleted
  // out from under it. A player card with no image is the one shape X won't
  // render, so the still has to win here.
  nextRows = [{ ...ROW, preview_type: 'image/gif', preview_url: null }];
  const stale = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('a gif type with no gif still has an image',
     stale.includes('<meta name="twitter:image" content="https://cdn.example/thumb.jpg">')
     && stale.includes('<meta property="og:image" content="https://cdn.example/thumb.jpg">'),
     '\n' + stale);
}

// ── 3. No preview clip → the player anyway, with the still as its poster ───
// There is nothing to pre-render: the embed runs the effect in the reader's
// own browser, so a particle with no stored clip plays on X exactly like one
// that has one. Everywhere that can't run a player still gets the thumbnail.
{
  nextRows = [{ ...ROW, preview_url: null, preview_type: null }];
  const html = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('falls back to thumb', html.includes('<meta property="og:image" content="https://cdn.example/thumb.jpg">'));
  ok('no video tags', !html.includes('og:video'));
  ok('clipless particle still gets the player',
     html.includes('<meta name="twitter:card" content="player">')
     && html.includes(`<meta name="twitter:player" content="${SITE}/embed.html?id=${ID}">`), '\n' + html);
  ok('player card carries its fallback image',
     html.includes('<meta name="twitter:image" content="https://cdn.example/thumb.jpg">'), '\n' + html);
  ok('nothing to stream', !html.includes('twitter:player:stream'), '\n' + html);
  ok('no summary_large_image left over',
     !html.includes('summary_large_image'), '\n' + html);

  // No thumbnail either: the site card stands in, so the player still has the
  // image X requires of it.
  nextRows = [{ ...ROW, preview_url: null, preview_type: null, thumb_url: null }];
  const bare = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('thumbless particle falls back to the site card image',
     bare.includes(`<meta name="twitter:image" content="${SITE}/img/og-card.jpg">`), '\n' + bare);
  ok('…and still gets the player', bare.includes('<meta name="twitter:card" content="player">'));
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
  ok('unknown id still embeds (200, not 404)', res.status === 200, String(res.status));
  ok('…but still a valid card', html.includes('<meta property="og:site_name" content="particletoy">'));

  const bare = await call('https://proj.supabase.co/og', DISCORD);
  ok('bare /og → site card', bare.status === 200 &&
     (await bare.text()).includes(`${SITE}/img/og-card.jpg`));
}

// ── 8. A backend hiccup must not 500 the crawler ───────────────────────────
{
  globalThis.fetch = async () => { throw new Error('network down'); };
  const res = await call(`https://proj.supabase.co/og/${ID}`, DISCORD);
  ok('backend failure → site card, still 200', res.status === 200, String(res.status));
}

// ── 9. ?debug=1 explains itself without leaking the key ────────────────────
{
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  const res = await call(`https://proj.supabase.co/og/${ID}?debug=1`, CHROME);
  const j = await res.json();
  ok('debug reports not-found', j.particleFound === false && /private/.test(j.note), JSON.stringify(j));
  ok('debug says what the card shows', j.cardWouldShow.includes('generic'), j.cardWouldShow);
  ok('debug reports the key as a boolean', j.anonKeySet === true);
  ok('debug reports no schema drift', j.previewColumns === 'present', j.previewColumns);
  ok('debug never echoes the key', !JSON.stringify(j).includes('anon-key'), JSON.stringify(j));

  globalThis.fetch = async () => ({ ok: true, json: async () => [ROW] });
  const j2 = await (await call(`https://proj.supabase.co/og/${ID}?debug=1`, CHROME)).json();
  ok('debug names the video clip', j2.cardWouldShow.includes('playing clip'), j2.cardWouldShow);
  ok('debug names the live player', j2.livePlayerOnX === `${SITE}/embed.html?id=${ID}`, j2.livePlayerOnX);

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'no key' });
  const j3 = await (await call(`https://proj.supabase.co/og/${ID}?debug=1`, CHROME)).json();
  ok('debug surfaces a 401', j3.restStatus === 401 && j3.note.includes('401'), j3.note);
}

// ── 10. A database that predates the preview columns still gets a card ─────
// PostgREST fails the whole query on one unknown column, so the endpoint has
// to retry without them rather than lose the card entirely.
{
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('preview_url')) {
      return { ok: false, status: 400, text: async () => JSON.stringify({
        code: '42703', message: 'column particles.preview_url does not exist' }) };
    }
    const { preview_url, preview_type, preview_w, preview_h, ...base } = ROW;
    return { ok: true, json: async () => [base] };
  };
  const html = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('retries without the preview columns', seen.length === 2 && !seen[1].includes('preview_url'),
     JSON.stringify(seen));
  ok('still renders the particle card', html.includes('Campfire &lt;script&gt; — by Doug &amp; Co'));
  ok('still shows the thumbnail',
     html.includes('<meta property="og:image" content="https://cdn.example/thumb.jpg">'));
  ok('no video tags without the columns', !html.includes('og:video'));
  ok('the player survives a database that predates the clips',
     html.includes('<meta name="twitter:card" content="player">')
     && html.includes(`<meta name="twitter:player" content="${SITE}/embed.html?id=${ID}">`), '\n' + html);

  const j = await (await call(`https://proj.supabase.co/og/${ID}?debug=1`, CHROME)).json();
  ok('debug flags the missing columns', j.previewColumns === 'missing', JSON.stringify(j));
  ok('debug says to re-run schema.sql', /schema\.sql/.test(j.note), j.note);
}

// ── 11. Who gets a card vs a redirect, by real user agent ──────────────────
// The old crawler-name list silently redirected Bluesky, whose fetcher calls
// itself "Cardyb" and matches no such list. The rule is inverted now: only a
// positively browser-shaped request is redirected.
{
  globalThis.fetch = async () => ({ ok: true, json: async () => [ROW] });
  const agents = [
    ['Discordbot',  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'card'],
    ['Bluesky',     'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)', 'card'],
    ['LinkedInBot', 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 'card'],
    ['Slackbot',    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'card'],
    ['Twitterbot',  'Twitterbot/1.0', 'card'],
    ['WhatsApp',    'WhatsApp/2.23.20.0', 'card'],
    ['Telegram',    'TelegramBot (like TwitterBot)', 'card'],
    ['Mastodon',    'http.rb/5.1.1 (Mastodon/4.2.1; +https://mastodon.social/)', 'card'],
    ['no UA',       '', 'card'],
    ['curl',        'curl/8.21.0', 'card'],
    ['some new one','Mozilla/5.0 (compatible; SomeFutureCardService/2.0)', 'card'],
  ];
  for (const [name, ua, want] of agents) {
    const res = await call(`https://proj.supabase.co/og/${ID}`, ua);
    const got = res.status === 200 ? 'card' : 'redirect';
    ok(`${name} gets the ${want}`, got === want, `${got} (${res.status})`);
  }

  // Real browsers must still be sent on to the page.
  const chrome = new Request(`https://proj.supabase.co/og/${ID}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'sec-fetch-mode': 'navigate',
    },
  });
  const r1 = await handle(chrome, ENV);
  ok('Chrome is redirected to the page', r1.status === 302, String(r1.status));

  // …including one too old to send Sec-Fetch-Mode.
  const older = await call(`https://proj.supabase.co/og/${ID}`,
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15');
  ok('an older browser is redirected too', older.status === 302, String(older.status));
}

// ── 12. The poster is card-sized, not thumbnail-sized ──────────────────────
// LinkedIn declines to build a card at all below 1200x627.
{
  globalThis.fetch = async () => ({ ok: true, json: async () => [ROW] });
  const html = await (await call(`https://proj.supabase.co/og/${ID}`, DISCORD)).text();
  ok('og:image is declared at card size',
     html.includes('<meta property="og:image:width" content="1200">')
     && html.includes('<meta property="og:image:height" content="630">'), '\n' + html);
}

console.log(process.exitCode ? '\nFAILED' : '\nall good');
