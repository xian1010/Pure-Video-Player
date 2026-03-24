/**
 * Cloudflare Worker — Pure Video Player backend proxy
 *
 * Routes:
 *   GET /extract?url=<vodplay_url>        → { streamUrl } or { error }
 *   GET /proxy?url=<encoded_url>          → transparent proxy (M3U8 / TS segments)
 *   GET /api/page?path=<url_path>         → raw HTML with CORS (client parses with DOMParser)
 *   GET /api/search?q=<kw>&page=<n>       → { items, hasMore }
 *
 * Deploy:  wrangler publish  (or paste into CF dashboard)
 */

const ORIGIN    = 'https://huavod.net';
const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CORS_HDRS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function cors(body, init = {}) {
  const res = new Response(body, init);
  Object.entries(CORS_HDRS).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}
function json(obj, status = 200) {
  return cors(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Fetch helper: inject spoofed headers ────────────────────────────────────
async function siteGet(path, extraHeaders = {}) {
  const url = path.startsWith('http') ? path : ORIGIN + path;
  const res = await fetch(url, {
    headers: {
      'User-Agent':      UA,
      'Referer':         ORIGIN + '/',
      'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ── Stream URL extraction (mirrors main.js fast-extraction) ─────────────────
function decrypt(url, encrypt) {
  if (encrypt === 0) return url;
  if (encrypt === 1) return decodeURIComponent(url);
  if (encrypt === 2) {
    const bytes = atob(url);
    return decodeURIComponent(escape(bytes));
  }
  if (encrypt === 3) {
    // Strategy S0: plain base64 decode (huavod.net)
    try {
      const s0 = atob(url);
      if (/^https?:\/\/.+\.m3u8/.test(s0)) return s0;
    } catch (_) {}
    // S1: reverse then decode
    try {
      const s1 = decodeURIComponent(atob(url.split('').reverse().join('')));
      if (/^https?:\/\/.+\.m3u8/.test(s1)) return s1;
    } catch (_) {}
    // S2: decode then reverse
    try {
      const s2 = decodeURIComponent(url).split('').reverse().join('');
      if (/^https?:\/\/.+\.m3u8/.test(s2)) return s2;
    } catch (_) {}
  }
  return url;
}

const M3U8_RE = /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/;

async function extractStreamUrl(vodplayUrl) {
  // Normalise voddetail → vodplay
  let url = vodplayUrl.replace(/\/voddetail\/(\d+)\.html/, '/vodplay/$1-1-1.html');

  const html = await siteGet(url);

  // Extract mac_player_info block
  const blockMatch = html.match(/mac_player_info\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!blockMatch) throw new Error('mac_player_info not found');

  let info;
  try { info = JSON.parse(blockMatch[1]); } catch (_) {
    // Try relaxed parse
    const u = (blockMatch[1].match(/"url"\s*:\s*"([^"]+)"/) || [])[1];
    const e = parseInt((blockMatch[1].match(/"encrypt"\s*:\s*(\d)/) || [])[1] || '0');
    if (!u) throw new Error('Could not parse mac_player_info');
    info = { url: u, encrypt: e };
  }

  const raw = info.url || '';
  const enc = typeof info.encrypt === 'number' ? info.encrypt : 0;
  const candidate = decrypt(raw, enc);

  if (!M3U8_RE.test(candidate)) throw new Error('No valid m3u8 found after decryption');
  return candidate;
}

// ── M3U8 rewriter: rewrites segment/playlist URLs to go through /proxy ──────
function rewriteM3u8(text, workerBase, referer) {
  return text.split('\n').map(line => {
    line = line.trimEnd();
    if (line.startsWith('#')) return line;
    if (!line) return line;
    // Absolute or relative TS / m3u8 segment
    const absUrl = line.startsWith('http') ? line : (referer ? new URL(line, referer).href : line);
    return `${workerBase}/proxy?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer || ORIGIN)}`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  if (request.method === 'OPTIONS') return cors('', { status: 204 });

  const u    = new URL(request.url);
  const path = u.pathname;

  // ── /extract ──────────────────────────────────────────────────────────────
  if (path === '/extract') {
    const vodUrl = u.searchParams.get('url');
    if (!vodUrl) return json({ error: 'Missing url param' }, 400);
    try {
      const streamUrl = await extractStreamUrl(vodUrl);
      return json({ streamUrl });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  // ── /proxy (transparent proxy + M3U8 rewriting) ───────────────────────────
  if (path === '/proxy') {
    const target  = u.searchParams.get('url');
    const referer = u.searchParams.get('referer') || ORIGIN;
    if (!target) return json({ error: 'Missing url param' }, 400);
    try {
      const upstream = await fetch(target, {
        headers: { 'User-Agent': UA, 'Referer': referer },
      });
      const ct = upstream.headers.get('content-type') || '';
      const body = await upstream.text();

      let responseBody = body;
      if (ct.includes('mpegurl') || target.includes('.m3u8')) {
        const workerBase = `${u.protocol}//${u.host}`;
        responseBody = rewriteM3u8(body, workerBase, target);
      }

      return cors(responseBody, {
        status: upstream.status,
        headers: { 'Content-Type': ct || 'application/octet-stream' },
      });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  // ── /api/page (proxy raw HTML for client-side DOMParser parsing) ──────────
  if (path === '/api/page') {
    const sitePath = u.searchParams.get('path');
    if (!sitePath) return json({ error: 'Missing path param' }, 400);
    try {
      const html = await siteGet(sitePath);
      return cors(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  // ── /api/search ───────────────────────────────────────────────────────────
  if (path === '/api/search') {
    const kw   = u.searchParams.get('q')    || '';
    const page = u.searchParams.get('page') || '1';
    if (!kw) return json({ items: [], hasMore: false });
    try {
      const apiUrl = `${ORIGIN}/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(kw)}&pg=${page}`;
      const raw    = await siteGet(apiUrl, { Accept: 'application/json' });
      const data   = JSON.parse(raw);
      if (!data || data.code !== 1 || !Array.isArray(data.list)) return json({ items: [], hasMore: false });
      const items = data.list.map(v => ({
        title:  v.name || '',
        url:    `${ORIGIN}/voddetail/${v.id}.html`,
        poster: (v.vod_pic || v.pic || '').startsWith('http') ? (v.vod_pic || v.pic) : (v.vod_pic || v.pic ? ORIGIN + (v.vod_pic || v.pic) : ''),
        badge:  '',
      })).filter(v => v.title && v.url);
      return json({ items, hasMore: Number(page) < (data.pagecount || 1) });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  return json({ error: 'Unknown route' }, 404);
}
