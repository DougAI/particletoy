// ═══════════════════════════════════════════════════════════════════════════
// particletoy — link previews (Open Graph) for Discord / Slack / Twitter / …
//
// Why this exists: the site is static. GitHub Pages serves the very same
// view.html for every particle, and link crawlers do not run JavaScript — so
// no amount of client-side <meta> writing can give a particle its own preview
// card. This is the one dynamic piece of the whole project. It looks the
// particle up, renders a <head> of per-particle Open Graph tags, and sends
// real browsers straight on to the actual page.
//
// Plain JavaScript, one file, no build step and no dependencies — so it can be
// pasted straight into whichever host's editor you land on. It runs on:
//
//   Cloudflare Workers  — free, and the dashboard has an editor you can paste
//                         into. Uses the `export default { fetch }` below.
//   Deno / Deno Deploy  — uses the Deno.serve at the bottom.
//   Supabase Edge Fns   — same Deno.serve, BUT see the warning below.
//
// ⚠ NOT on a default *.supabase.co/functions/v1/ URL. Supabase rewrites a GET
// response of text/html to text/plain, deliberately, so its function domain
// can't serve web pages. The tags arrive perfectly intact and every crawler
// ignores them, because nothing parses meta tags out of plain text. The
// symptom is a link that previews as nothing at all, from a function that
// looks completely healthy in curl — 200, right body, right title — and the
// giveaway is `Content-Type: text/plain` next to `Content-Security-Policy:
// default-src 'none'; sandbox` in the response headers. Do not try to dodge it
// by mislabelling the response; it is an anti-phishing control. Supabase's Pro
// plan with the Edge Functions custom domain add-on lifts the restriction.
//
// Configuration: none required. The constants below mirror js/backend.js and
// work as-is; environment variables (SUPABASE_URL, PT_ANON_KEY, SITE_URL)
// override them, which is how a fork points at its own project without
// editing the file. ?debug=1 reports which of the two it is using.
//
// Then point js/backend.js's SHARE_BASE at wherever this ends up. Anything
// answering <base>/<particle-id> with these tags will do.
//
// Reads the database as `anon`, so row-level security applies and private
// particles stay invisible — the same rules the website itself plays by.
// ═══════════════════════════════════════════════════════════════════════════

// ─── project constants (the same two as the top of js/backend.js) ───────────
// Baked in rather than required as configuration, for the same reason they sit
// in js/backend.js in the clear: the publishable key is designed to be public,
// and row-level security is what limits what it can do — this endpoint reads
// as `anon`, exactly like a signed-out visitor. Making them mandatory
// environment variables bought no secrecy and cost a setup step that, when
// missed, silently degrades every card to the generic one.
//
// Change these for your own project, or set SUPABASE_URL / PT_ANON_KEY in your
// host's dashboard to override without editing the file.
const SUPABASE_URL = 'https://kqbbghyfpxxowwhdtjnj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JsVww6ububer-Yi-s0AG4A_0Di7CjOh';
const SITE_URL = 'https://dougai.github.io/particletoy';
// ────────────────────────────────────────────────────────────────────────────

const BRAND_COLOR = '#e8a33d';          // Discord paints the embed's edge with it
const CARD_W = 1200;
const CARD_H = 630;
// The twitter:player box. The embed itself is fluid, so this is only an aspect
// ratio as far as X is concerned — 16:9, the shape the player frame has been
// on the site since there was one.
const PLAYER_W = 1280;
const PLAYER_H = 720;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Who gets the card, and who gets sent on to the real page.
//
// This used to be a list of crawler names, and that list is never finished.
// Bluesky's fetcher announces itself as "Mozilla/5.0 (compatible; Bluesky
// Cardyb/1.1; +mailto:…)" — no "bot", no "crawl", nothing any such list would
// think to include — so it was quietly handed a redirect instead of a card,
// and Bluesky posts previewed as the generic site card or not at all.
//
// So the question is inverted. Only something that positively looks like a
// browser gets redirected; everything else — known crawler, unknown crawler,
// curl, a runtime nobody has heard of yet — gets the card. The failure mode
// for a stranger is now a working preview rather than a silent redirect.
const BROWSER_ENGINE = /Chrome\/|Safari\/|Firefox\/|Edg\/|OPR\/|Trident\//;
// Anything self-identifying as automation, however much Mozilla it wears.
const AUTOMATION = /bot\b|bot\/|crawl|spider|slurp|fetcher|cardyb|preview|embed|curl|wget|python-|java\/|go-http|okhttp|libwww|headless/i;

function looksLikeBrowser(req) {
  const ua = req.headers.get('user-agent') || '';
  if (!ua) return false;                 // several crawlers send none; browsers always do
  if (AUTOMATION.test(ua)) return false;
  // Browsers set Sec-Fetch-Mode on a top-level navigation; no server-side
  // fetcher bothers. When it's present it is the most reliable signal there is.
  const mode = req.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return BROWSER_ENGINE.test(ua);
}

// Everything the card needs that has always existed. A project that has not
// re-run schema.sql since previews landed still answers this.
const SELECT_BASE = [
  'id', 'title', 'description', 'thumb_url', 'tags',
  'views', 'likes', 'comment_count', 'created_at',
  'author:profiles!owner(username,display_name)',
].join(',');

// The clip columns, asked for separately on purpose. PostgREST rejects the
// whole query if one column is unknown, so folding these into the base list
// makes a card that could have rendered fine — title, author, thumbnail —
// fail outright on a database that is merely out of date.
const PREVIEW_COLS = 'preview_url,preview_type,preview_w,preview_h';
const SELECT_FULL = `${SELECT_BASE},${PREVIEW_COLS}`;

/** Every runtime hands over its environment differently: Workers pass an
 *  object into fetch(), Deno keeps it behind Deno.env.get(). Normalize once,
 *  here, so nothing below has to care which one it woke up in. */
function readEnv(passed) {
  if (passed && typeof passed === 'object' && passed.SUPABASE_URL) return passed;
  const D = globalThis.Deno;
  if (D && D.env) {
    return {
      SITE_URL: D.env.get('SITE_URL'),
      SUPABASE_URL: D.env.get('SUPABASE_URL'),
      SUPABASE_ANON_KEY: D.env.get('SUPABASE_ANON_KEY'),
      PT_ANON_KEY: D.env.get('PT_ANON_KEY'),
    };
  }
  return passed || {};
}

function config(env) {
  const site = (env.SITE_URL || SITE_URL).replace(/\/+$/, '');
  return {
    site,
    cardImage: `${site}/img/og-card.jpg`,
    supabaseUrl: (env.SUPABASE_URL || SUPABASE_URL).replace(/\/+$/, ''),
    // PT_ANON_KEY wins: on Supabase it is the escape hatch for projects using
    // the newer publishable keys with the legacy anon key disabled.
    anonKey: env.PT_ANON_KEY || env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY,
    // Which of the two the values came from — the first thing worth knowing
    // when a card is wrong and the host's dashboard says otherwise.
    from: {
      supabaseUrl: env.SUPABASE_URL ? 'env' : 'built-in',
      anonKey: (env.PT_ANON_KEY || env.SUPABASE_ANON_KEY) ? 'env' : 'built-in',
      site: env.SITE_URL ? 'env' : 'built-in',
    },
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clamp(s, max) {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function fmtCount(n) {
  n = n || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

async function query(cfg, id, select) {
  const url = `${cfg.supabaseUrl}/rest/v1/particles?id=eq.${id}&select=${encodeURIComponent(select)}`;
  const res = await fetch(url, {
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` },
  });
  return { res, body: res.ok ? null : await res.text() };
}

/** Also reports how the lookup went, because "no row" has several very
 *  different causes — wrong key, RLS hiding a private particle, an
 *  out-of-date database, a bad id — and the card alone can't tell them
 *  apart. See ?debug=1.
 *  @returns {{ row: object|null, status: number, note: string,
 *              previewColumns: 'present'|'missing'|'unknown' }} */
async function fetchParticle(cfg, id) {
  // Off Supabase these aren't injected, and forgetting them looks exactly like
  // every other lookup failure. Say which one it is.
  if (!cfg.supabaseUrl || !cfg.anonKey) {
    return {
      row: null,
      status: 0,
      previewColumns: 'unknown',
      note: `not configured: ${!cfg.supabaseUrl ? 'SUPABASE_URL' : 'the anon key'} is unset. `
        + 'Outside Supabase these must be set by hand — same two values as the top '
        + 'of js/backend.js.',
    };
  }

  let { res, body } = await query(cfg, id, SELECT_FULL);
  let previewColumns = 'present';

  // 42703 = undefined_column: this project hasn't re-run schema.sql since
  // previews landed. Everything else about the card still works, so drop the
  // clip columns and render it rather than failing the whole preview.
  if (!res.ok && /42703|does not exist/.test(body || '')) {
    console.warn('preview columns missing — re-run supabase/schema.sql. Falling back.');
    previewColumns = 'missing';
    ({ res, body } = await query(cfg, id, SELECT_BASE));
  }

  if (!res.ok) {
    // Shows up in your host's logs. A 401 here means the anon key didn't work.
    console.error(`particle lookup failed: ${res.status} ${body}`);
    return {
      row: null,
      status: res.status,
      note: `REST said ${res.status}: ${(body || '').slice(0, 200)}`,
      previewColumns: 'unknown',
    };
  }

  const rows = await res.json();
  if (!rows || !rows.length) {
    return {
      row: null,
      status: res.status,
      previewColumns,
      note: 'no row — either no particle has that id, or it is private '
        + '(this reads the database as `anon`, so row-level security hides it)',
    };
  }
  return {
    row: rows[0],
    status: res.status,
    previewColumns,
    note: previewColumns === 'missing'
      ? 'ok, but the preview_* columns are missing — re-run supabase/schema.sql '
        + 'or the card can never show a clip'
      : 'ok',
  };
}

function meta(tags) {
  return tags
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      // Open Graph uses property=, Twitter and friends use name=.
      const attr = k.startsWith('og:') ? 'property' : 'name';
      // A raw newline inside an attribute is legal HTML, and the description
      // deliberately carries two. Entity-encode them anyway: parsers that read
      // meta tags with a regex rather than a real parser are common, and a
      // line break mid-attribute is exactly what trips them.
      const content = esc(v).replace(/\r?\n/g, '&#10;');
      return `  <meta ${attr}="${k}" content="${content}">`;
    })
    .join('\n');
}

/** The URL this card is for: the one that was actually requested, with the
 *  diagnostic switches taken back off. og:url and the canonical link have to
 *  be exactly this — see the note in particleCard. */
function shareUrl(url) {
  const u = new URL(url);
  u.searchParams.delete('card');
  u.searchParams.delete('debug');
  u.hash = '';
  return u.toString();
}

/** @param canonical  what this page calls itself — og:url's twin.
 *  @param link       where a reader is actually going, if it differs. */
function page({ title, canonical, link = canonical, tags }) {
  // No meta-refresh and no redirect script, deliberately. A browser never
  // reaches this page — it gets a 302 further down — so a crawler is the only
  // thing that ever reads this HTML, and telling a crawler the page has moved
  // is the last thing we want: it re-crawls view.html, whose tags are the
  // generic site ones, and some drop the embed rather than follow. The plain
  // link is for a human running ?card=1 to inspect the tags.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="canonical" href="${esc(canonical)}">
${tags}
<style>
  body { background:#0d0e11; color:#d7dae0; font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  a { color:#4d9fff; }
</style>
</head>
<body>
<p><a href="${esc(link)}">${esc(title)}</a></p>
</body>
</html>
`;
}

/** The generic site card — for a bad id, a private particle, or a bare /og. */
function siteCard(cfg) {
  const title = 'particletoy — build, explore & share particle effects';
  const description = 'A shadertoy-style playground for realtime particle effects: '
    + 'programmable PBR materials, WebGPU, and a community gallery.';
  return page({
    title,
    canonical: `${cfg.site}/`,
    tags: meta([
      ['og:site_name', 'particletoy'],
      ['og:type', 'website'],
      ['og:url', `${cfg.site}/`],
      ['og:title', title],
      ['og:description', description],
      ['og:image', cfg.cardImage],
      ['og:image:width', CARD_W],
      ['og:image:height', CARD_H],
      ['twitter:card', 'summary_large_image'],
      ['twitter:title', title],
      ['twitter:description', description],
      ['twitter:image', cfg.cardImage],
      ['description', description],
      ['theme-color', BRAND_COLOR],
    ]),
  });
}

/** @param self  the URL that was requested — the one somebody pasted. */
function particleCard(cfg, p, self) {
  const pageUrl = `${cfg.site}/view.html?id=${p.id}`;
  // What Twitter loads inside the player card's iframe. Not the page itself:
  // an iframe of view.html renders the whole website — header, search box,
  // sign-in button, comments below the fold — inside a 16:9 box on someone's
  // timeline. embed.html is the viewport on its own.
  const embed = `${cfg.site}/embed.html?id=${p.id}`;
  const author = (p.author && (p.author.display_name || p.author.username)) || 'anonymous';
  const title = `${p.title} — by ${author}`;

  // Discord renders newlines in og:description, so the stats get their own
  // line instead of being crammed onto the end of the author's blurb.
  const stats = `♥ ${fmtCount(p.likes)}  ·  👁 ${fmtCount(p.views)}  ·  💬 ${fmtCount(p.comment_count)}`;
  const blurb = clamp(p.description || 'A realtime particle effect made with particletoy.', 240);
  const description = `${blurb}\n\n${stats}`;

  const poster = p.thumb_url || cfg.cardImage;
  const isVideo = (p.preview_type || '').startsWith('video/');
  const isGif = p.preview_type === 'image/gif';
  const vw = p.preview_w || 960;
  const vh = p.preview_h || 540;
  // An animated GIF preview goes in as the image itself; otherwise the still
  // thumbnail is the poster frame. Either way this is the card's image, and
  // the player's poster while the iframe loads — so it must never come out
  // empty, which is why this checks the URL is actually there rather than
  // trusting preview_type on its own.
  const gif = (isGif && p.preview_url) ? p.preview_url : null;
  const image = gif || poster;

  /** One image and the properties describing it. Open Graph attaches
   *  og:image:* to the og:image immediately above them, so a card can offer
   *  several and each keeps its own size and type. */
  const imageTags = (url, w, h, type) => [
    ['og:image', url],
    ['og:image:secure_url', url],
    ['og:image:type', type],
    ['og:image:width', w],
    ['og:image:height', h],
    ['og:image:alt', `${p.title}, a particle effect by ${author}`],
  ];

  const tags = [
    ['og:site_name', 'particletoy'],
    // Not view.html — this endpoint's own URL. See the note below.
    ['og:url', self],
    ['og:title', title],
    ['og:description', description],
    ['description', description],
    ['theme-color', BRAND_COLOR],

    // The GIF first where there is one, since Slack and Telegram animate it,
    // and the still — always card-sized — behind it. A scraper that turns the
    // first image down moves on to the next, and LinkedIn turns down anything
    // under 1200x627: a preview GIF is 640x360, so with nothing behind it a
    // GIF particle offers LinkedIn no usable image, and no image is no card.
    ...(gif ? imageTags(gif, vw, vh, p.preview_type) : []),
    ...imageTags(poster, CARD_W, CARD_H, 'image/jpeg'),

    ['article:author', author],

    // Every particle gets the player, clip or no clip. X iframes
    // twitter:player, and embed.html runs the effect live in whoever's
    // browser is looking at the timeline — there is nothing to pre-render and
    // no reason to hold it back for the particles that happen to have an MP4
    // stored. The ones that don't used to fall back to a still image here;
    // now they play too.
    //
    // twitter:image is not optional on a player card. It is what X shows
    // before the iframe loads and what it falls back to if the player can't
    // run, and `image` above guarantees one — the particle's thumbnail, or
    // the site card if it somehow has none.
    ['twitter:card', 'player'],
    ['twitter:player', embed],
    // The embed is fluid; these describe the 16:9 box to lay the card out in,
    // not any stored file. (og:video:width/height below do describe the clip.)
    ['twitter:player:width', PLAYER_W],
    ['twitter:player:height', PLAYER_H],
    ['twitter:image', image],
  ];

  if (isVideo && p.preview_url) {
    // The recipe every "fix broken embeds" service converges on: og:type
    // video.other plus a *direct* file URL. Discord will not touch an iframe
    // from a domain it doesn't know — the live player is X's alone — but it
    // will play a bare MP4.
    tags.push(
      ['og:type', 'video.other'],
      ['og:video', p.preview_url],
      ['og:video:url', p.preview_url],
      ['og:video:secure_url', p.preview_url],
      ['og:video:type', p.preview_type],
      ['og:video:width', vw],
      ['og:video:height', vh],
      // Handed over as well as the iframe: X plays the stream directly on
      // clients that won't run a player, and it costs nothing where it does.
      ['twitter:player:stream', p.preview_url],
      ['twitter:player:stream:content_type', p.preview_type],
    );
  } else {
    tags.push(['og:type', 'website']);
  }

  tags.push(['twitter:title', title], ['twitter:description', description]);

  // og:url and the canonical link are this endpoint's own URL rather than
  // view.html's, which reads backwards until you look at what og:url is for.
  // It is not "where to send the reader" to every crawler: LinkedIn treats it
  // as the identity of the thing being shared — it reads og:url, fetches
  // *that*, and builds the card out of whatever it finds there. Pointed at
  // view.html, what it found was a static file carrying the generic site tags,
  // whose own og:url drops the ?id — so every particle on LinkedIn resolved to
  // one URL with one generic card, which is the shape "no preview" takes
  // there. Self-referential, the hop has nowhere to go and the particle's own
  // tags are the ones that count.
  //
  // Nothing else notices: Discord, Slack, Telegram and X key off the URL that
  // was pasted and label the card from og:site_name. And a reader still ends
  // up on view.html — the 302 below takes them there, and so does the link in
  // the body of this page.
  return page({ title, canonical: self, link: pageUrl, tags: meta(tags) });
}

/** The whole endpoint. Exported so the test can drive it without a server. */
export async function handle(req, passedEnv) {
  const cfg = config(readEnv(passedEnv));
  const url = new URL(req.url);
  const idMatch = (url.searchParams.get('id') || url.pathname).match(UUID);
  const id = idMatch ? idMatch[0] : null;
  const ua = req.headers.get('user-agent') || '';
  // ?card=1 renders the HTML for a human too — handy for checking a card
  // without pretending to be a crawler.
  const isCrawler = !looksLikeBrowser(req) || url.searchParams.has('card');

  const headers = {
    'content-type': 'text/html; charset=utf-8',
    // Long enough that Discord's re-fetches are cheap, short enough that a
    // renamed particle fixes itself the same day.
    'cache-control': 'public, max-age=600, s-maxage=600',
    'access-control-allow-origin': '*',
  };

  // Always 200 on the card paths. A crawler is not a browser: Discord renders
  // no embed at all for a non-2xx, so answering a private or unknown particle
  // with 404 turns every lookup problem into the same silent nothing. The
  // generic site card is a far better answer — the link still previews, and
  // seeing the generic one instead of the particle's says where to look.
  if (!id) return new Response(siteCard(cfg), { status: 200, headers });

  let found;
  try {
    found = await fetchParticle(cfg, id);
  } catch (ex) {
    found = {
      row: null, status: 0, previewColumns: 'unknown',
      note: `lookup threw: ${ex.message}`,
    };
  }

  // ?debug=1 — what the endpoint saw, in the order worth checking. No secrets:
  // the key is reported as present/absent, never echoed.
  if (url.searchParams.has('debug')) {
    const row = found.row;
    // Hand-rolled rather than Response.json(): this is the tool you reach for
    // when the endpoint is misbehaving, so it should not itself depend on a
    // newer runtime API. Pretty-printed because it is read in a terminal.
    const report = {
      id,
      particleFound: Boolean(row),
      restStatus: found.status,
      note: found.note,
      // What everything *except* X shows. X iframes twitter:player and runs
      // the effect live for any particle that resolves, which is why it is
      // reported separately rather than folded in here.
      cardWouldShow: !row ? 'the generic particletoy card'
        : (row.preview_type || '').startsWith('video/') ? `a playing clip (${row.preview_type})`
        : row.preview_type === 'image/gif' ? 'a GIF (first frame only in Discord)'
        : row.thumb_url ? 'the still thumbnail — no preview clip rendered yet'
        : 'the generic card image — this particle has no thumbnail either',
      livePlayerOnX: row ? `${cfg.site}/embed.html?id=${row.id}` : null,
      title: row ? row.title : null,
      previewColumns: found.previewColumns,
      anonKeySet: Boolean(cfg.anonKey),
      configFrom: cfg.from,
      supabaseUrl: cfg.supabaseUrl,
      siteUrl: cfg.site,
      youLookLikeACrawler: isCrawler,
      userAgent: ua,
    };
    return new Response(`${JSON.stringify(report, null, 2)}\n`, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  }

  if (!isCrawler) {
    // Humans never see the card. Unknown ids still go to view.html, which
    // shows its own "doesn't exist, or it's private" state.
    const to = `${cfg.site}/view.html?id=${encodeURIComponent(id)}`;
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
  }

  if (!found.row) return new Response(siteCard(cfg), { status: 200, headers });
  return new Response(particleCard(cfg, found.row, shareUrl(url)), { status: 200, headers });
}

// Cloudflare Workers (and anything else module-worker shaped) uses this.
export default { fetch: handle };

// Deno — Deno Deploy, Supabase Edge Functions, `deno run` locally. Skipped on
// Workers, where Deno is undefined and the default export is the entry point.
if (globalThis.Deno && globalThis.Deno.serve) {
  globalThis.Deno.serve((req) => handle(req));
}
