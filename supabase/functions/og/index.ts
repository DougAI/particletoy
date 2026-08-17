// ═══════════════════════════════════════════════════════════════════════════
// particletoy — link previews (Open Graph) for Discord / Slack / Twitter / …
//
// Why this exists: the site is static. GitHub Pages serves the very same
// view.html for every particle, and link crawlers do not run JavaScript — so
// no amount of client-side <meta> writing can give a particle its own preview
// card. This function is the one dynamic piece of the whole project. It looks
// the particle up, renders a <head> of per-particle Open Graph tags, and sends
// real browsers straight on to the actual page.
//
// Deploy (Supabase CLI):
//     supabase functions deploy og --no-verify-jwt
//
// or Dashboard → Edge Functions → Deploy a new function → paste this file,
// then turn "Verify JWT" OFF. That switch is not optional: a crawler cannot
// send an API key, so with JWT verification on every preview 401s.
//
// Reads the database as `anon`, so row-level security applies and private
// particles stay invisible — the same rules the website itself plays by.
// ═══════════════════════════════════════════════════════════════════════════

// Where the static site lives. Set the SITE_URL secret if you host it
// somewhere else:  supabase secrets set SITE_URL=https://example.com
const SITE_URL = (Deno.env.get('SITE_URL') || 'https://dougai.github.io/particletoy')
  .replace(/\/+$/, '');

// Supabase injects SUPABASE_URL and SUPABASE_ANON_KEY into every function, so
// there is normally nothing to configure. PT_ANON_KEY is the escape hatch for
// projects on the newer publishable keys that have the legacy anon key
// disabled — set it to the same key js/backend.js uses:
//     supabase secrets set PT_ANON_KEY=sb_publishable_...
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('PT_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';

const BRAND_COLOR = '#e8a33d';          // Discord paints the embed's edge with it
const CARD_IMAGE = `${SITE_URL}/img/og-card.jpg`;
const CARD_W = 1200;
const CARD_H = 630;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Crawlers announce themselves; anything that looks like one gets the HTML,
// everyone else gets redirected to the real page. An empty user-agent counts
// as a crawler — several of them send none, and a browser always does.
const CRAWLER = /bot|crawl|spider|discord|slack|telegram|twitter|facebook|whatsapp|linkedin|mastodon|pinterest|skype|vkshare|embed|preview|curl|wget|http-client|iframely|opengraph|metainspector/i;

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

type Particle = {
  id: string;
  title: string;
  description: string;
  thumb_url: string | null;
  tags: string[] | null;
  preview_url: string | null;
  preview_type: string | null;
  preview_w: number | null;
  preview_h: number | null;
  views: number;
  likes: number;
  comment_count: number;
  created_at: string;
  author: { username: string | null; display_name: string | null } | null;
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function fmtCount(n: number): string {
  n = n || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

type Lookup = {
  row: Particle | null;
  status: number;
  note: string;
  previewColumns: 'present' | 'missing' | 'unknown';
};

async function query(id: string, select: string) {
  const url = `${SUPABASE_URL}/rest/v1/particles?id=eq.${id}&select=${encodeURIComponent(select)}`;
  const res = await fetch(url, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  return { res, body: res.ok ? null : await res.text() };
}

/** Also reports how the lookup went, because "no row" has several very
 *  different causes — wrong key, RLS hiding a private particle, an
 *  out-of-date database, a bad id — and the card alone can't tell them
 *  apart. See ?debug=1. */
async function fetchParticle(id: string): Promise<Lookup> {
  let { res, body } = await query(id, SELECT_FULL);
  let previewColumns: Lookup['previewColumns'] = 'present';

  // 42703 = undefined_column: this project hasn't re-run schema.sql since
  // previews landed. Everything else about the card still works, so drop the
  // clip columns and render it rather than failing the whole preview.
  if (!res.ok && /42703|does not exist/.test(body || '')) {
    console.warn('preview columns missing — re-run supabase/schema.sql. Falling back.');
    previewColumns = 'missing';
    ({ res, body } = await query(id, SELECT_BASE));
  }

  if (!res.ok) {
    // Shows up in the function's dashboard logs. A 401 here means the anon key
    // didn't work — see PT_ANON_KEY above.
    console.error(`particle lookup failed: ${res.status} ${body}`);
    return {
      row: null,
      status: res.status,
      note: `REST said ${res.status}: ${(body || '').slice(0, 200)}`,
      previewColumns: 'unknown',
    };
  }

  const rows = await res.json();
  if (!rows?.length) {
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

function meta(tags: Array<[string, string | number | null | undefined]>): string {
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

function page(
  { title, description, canonical, tags }:
  { title: string; description: string; canonical: string; tags: string },
): string {
  // No meta-refresh and no redirect script, deliberately. A browser never
  // reaches this page — it gets a 302 several lines below — so a crawler is
  // the only thing that ever reads this HTML, and telling a crawler the page
  // has moved is the last thing we want: it re-crawls view.html, whose tags
  // are the generic site ones, and some drop the embed rather than follow.
  // The plain link is for a human running ?card=1 to inspect the tags.
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
<p><a href="${esc(canonical)}">${esc(title)}</a></p>
</body>
</html>
`;
}

/** The generic site card — for a bad id, a private particle, or a bare /og. */
function siteCard(): string {
  const title = 'particletoy — build, explore & share particle effects';
  const description = 'A shadertoy-style playground for realtime particle effects: '
    + 'programmable PBR materials, WebGPU, and a community gallery.';
  return page({
    title,
    description,
    canonical: `${SITE_URL}/`,
    tags: meta([
      ['og:site_name', 'particletoy'],
      ['og:type', 'website'],
      ['og:url', `${SITE_URL}/`],
      ['og:title', title],
      ['og:description', description],
      ['og:image', CARD_IMAGE],
      ['og:image:width', CARD_W],
      ['og:image:height', CARD_H],
      ['twitter:card', 'summary_large_image'],
      ['twitter:title', title],
      ['twitter:description', description],
      ['twitter:image', CARD_IMAGE],
      ['description', description],
      ['theme-color', BRAND_COLOR],
    ]),
  });
}

function particleCard(p: Particle): string {
  const canonical = `${SITE_URL}/view.html?id=${p.id}`;
  const author = p.author?.display_name || p.author?.username || 'anonymous';
  const title = `${p.title} — by ${author}`;

  // Discord renders newlines in og:description, so the stats get their own
  // line instead of being crammed onto the end of the author's blurb.
  const stats = `♥ ${fmtCount(p.likes)}  ·  👁 ${fmtCount(p.views)}  ·  💬 ${fmtCount(p.comment_count)}`;
  const blurb = clamp(p.description || 'A realtime particle effect made with particletoy.', 240);
  const description = `${blurb}\n\n${stats}`;

  const poster = p.thumb_url || CARD_IMAGE;
  const isVideo = (p.preview_type || '').startsWith('video/');
  const isGif = p.preview_type === 'image/gif';
  const vw = p.preview_w || 960;
  const vh = p.preview_h || 540;

  const tags: Array<[string, string | number | null | undefined]> = [
    ['og:site_name', 'particletoy'],
    ['og:url', canonical],
    ['og:title', title],
    ['og:description', description],
    ['description', description],
    ['theme-color', BRAND_COLOR],
    // An animated GIF preview goes in as the image itself; otherwise the
    // still thumbnail is the poster frame.
    ['og:image', isGif ? p.preview_url : poster],
    ['og:image:alt', `${p.title}, a particle effect by ${author}`],
    ['article:author', author],
  ];

  if (isVideo && p.preview_url) {
    // The recipe every "fix broken embeds" service converges on: og:type
    // video.other plus a *direct* file URL. Discord will not touch an iframe
    // from a domain it doesn't know, but it will play a bare MP4.
    tags.push(
      ['og:type', 'video.other'],
      ['og:video', p.preview_url],
      ['og:video:url', p.preview_url],
      ['og:video:secure_url', p.preview_url],
      ['og:video:type', p.preview_type],
      ['og:video:width', vw],
      ['og:video:height', vh],
      ['og:image:width', 640],
      ['og:image:height', 360],
      // Discord wants the Twitter card set too before it will show a player.
      ['twitter:card', 'player'],
      ['twitter:player', canonical],
      ['twitter:player:width', vw],
      ['twitter:player:height', vh],
      ['twitter:player:stream', p.preview_url],
      ['twitter:player:stream:content_type', p.preview_type],
    );
  } else {
    tags.push(
      ['og:type', 'website'],
      ['twitter:card', 'summary_large_image'],
      ['twitter:image', isGif ? p.preview_url : poster],
    );
    // Sizing the GIF stops the card being laid out for the 640×360 thumbnail
    // it isn't. (Whether it animates is up to the reader: Discord shows frame
    // one, Slack and Telegram play it.)
    if (isGif) tags.push(['og:image:width', vw], ['og:image:height', vh]);
  }

  tags.push(['twitter:title', title], ['twitter:description', description]);

  return page({ title, description, canonical, tags: meta(tags) });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || url.pathname).match(UUID)?.[0] ?? null;
  const ua = req.headers.get('user-agent') || '';
  // ?card=1 renders the HTML for a human too — handy for checking a card
  // without pretending to be Discordbot.
  const isCrawler = !ua || CRAWLER.test(ua) || url.searchParams.has('card');

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
  if (!id) return new Response(siteCard(), { status: 200, headers });

  let found: Lookup;
  try {
    found = await fetchParticle(id);
  } catch (ex) {
    found = {
      row: null, status: 0, previewColumns: 'unknown',
      note: `lookup threw: ${(ex as Error).message}`,
    };
  }

  // ?debug=1 — what the endpoint saw, in the order worth checking. No secrets:
  // the key is reported as present/absent, never echoed.
  if (url.searchParams.has('debug')) {
    return Response.json({
      id,
      particleFound: Boolean(found.row),
      restStatus: found.status,
      note: found.note,
      cardWouldShow: !found.row ? 'the generic particletoy card'
        : found.row.preview_type?.startsWith('video/') ? `a playing clip (${found.row.preview_type})`
        : found.row.preview_type === 'image/gif' ? 'a GIF (first frame only in Discord)'
        : found.row.thumb_url ? 'the still thumbnail — no preview clip rendered yet'
        : 'the generic card image — this particle has no thumbnail either',
      title: found.row?.title ?? null,
      previewColumns: found.previewColumns,
      anonKeySet: Boolean(ANON_KEY),
      usingPtAnonKey: Boolean(Deno.env.get('PT_ANON_KEY')),
      siteUrl: SITE_URL,
      youLookLikeACrawler: isCrawler,
      userAgent: ua,
    }, { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  }

  if (!isCrawler) {
    // Humans never see the card. Unknown ids still go to view.html, which
    // shows its own "doesn't exist, or it's private" state.
    const to = `${SITE_URL}/view.html?id=${encodeURIComponent(id)}`;
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
  }

  if (!found.row) return new Response(siteCard(), { status: 200, headers });
  return new Response(particleCard(found.row), { status: 200, headers });
});
