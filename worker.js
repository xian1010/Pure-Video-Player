/**
 * Cloudflare Worker — Pure Video Player backend proxy
 *
 * Routes:
 *   GET /test                             → { ok, version }          (deployment check)
 *   GET /extract?url=<vodplay_url>        → { streamUrl } or { error, htmlPreview }
 *   GET /proxy?url=<encoded_url>          → transparent proxy (M3U8 / TS segments)
 *   GET /api/page?path=<url_path>         → raw HTML with CORS
 *   GET /api/search?q=<kw>&page=<n>       → { items, hasMore }
 *
 * Deploy:  paste into Cloudflare Workers dashboard → Save & Deploy
 */

const ORIGIN = 'https://huavod.net';
const UA     = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
               'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ── CORS helper ───────────────────────────────────────────────────────────────
function addCors(headers) {
  headers.set('Access-Control-Allow-Origin',   '*');
  headers.set('Access-Control-Allow-Methods',  '*');
  headers.set('Access-Control-Allow-Headers',  '*');
  headers.set('Access-Control-Expose-Headers', '*');
  return headers;
}

function corsResponse(body, status, extraHeaders = {}) {
  const h = addCors(new Headers(extraHeaders));
  return new Response(body, { status, headers: h });
}

function jsonResp(obj, status = 200) {
  return corsResponse(
    JSON.stringify(obj),
    status,
    { 'Content-Type': 'application/json' }
  );
}

// ── Fetch helper (spoofed UA + Referer) ───────────────────────────────────────
async function siteGet(url, extraHeaders = {}) {
  const fullUrl = url.startsWith('http') ? url : ORIGIN + url;
  const res = await fetch(fullUrl, {
    headers: {
      'User-Agent':      UA,
      'Referer':         ORIGIN + '/',
      'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${fullUrl}`);
  return res.text();
}

// ── Base64 decode → Uint8Array (no Node Buffer needed) ───────────────────────
function b64ToBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Decrypt mac_player_info.url (mirrors main.js) ────────────────────────────
const M3U8_RE = /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/;

function decrypt(raw, enc) {
  if (enc === 0) return raw;
  if (enc === 1) return decodeURIComponent(raw);
  if (enc === 2) return decodeURIComponent(escape(atob(raw)));

  if (enc === 3 && !raw.startsWith('http')) {
    let bytes, binary;
    try {
      bytes  = b64ToBytes(raw);
      binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    } catch (_) { return raw; }

    const strategies = [
      () => new TextDecoder('utf-8').decode(bytes),
      () => decodeURIComponent(binary.split('').reverse().join('')),
      () => new TextDecoder('utf-8').decode(new Uint8Array([...bytes].reverse())),
      () => new TextDecoder('utf-8').decode(bytes).split('').reverse().join(''),
      () => unescape(binary.split('').reverse().join('')),
      () => {
        const s = new TextDecoder('utf-8').decode(bytes);
        const m = s.match(/^[a-zA-Z0-9._\-]+(\/[a-zA-Z0-9._\-]+)+\.m3u8/);
        return m ? `https://p.okokserver.com/${m[0]}` : '';
      },
      () => {
        const rev = binary.split('').reverse().join('');
        let m = rev.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
        if (m) return `https://p.okokserver.com/${m[0]}`;
        m = binary.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
        return m ? `https://p.okokserver.com/${m[0]}` : '';
      },
    ];

    for (const fn of strategies) {
      try {
        let c = fn();
        const hm = c.match(/https?:\/\/[^\s"'<>\\]+/);
        if (hm) c = hm[0].replace(/[O0]{4,}$/, '').replace(/[^a-zA-Z0-9._\-/:?=&%+#~@!$'()*,;]+$/, '');
        if (M3U8_RE.test(c)) return c;
      } catch (_) {}
    }
  }
  return raw;
}

// ── Extract stream URL from vodplay page ─────────────────────────────────────
async function extractStreamUrl(vodplayUrl) {
  const url = vodplayUrl.replace(/\/voddetail\/(\d+)\.html/, '/vodplay/$1-1-1.html');
  const html = await siteGet(url);

  let blockMatch = html.match(/mac_player_info\s*=\s*(\{[^\r\n]+\})/);
  if (!blockMatch) blockMatch = html.match(/mac_player_info\s*=\s*(\{[\s\S]*?\})\s*;/);

  let rawUrl = null, encryptType = 0;
  if (blockMatch) {
    try {
      const info = JSON.parse(blockMatch[1]);
      if (info.url) { rawUrl = info.url; encryptType = parseInt(info.encrypt) || 0; }
    } catch (_) {
      const um = blockMatch[1].match(/"url"\s*:\s*"([^"]+)"/);
      const em = blockMatch[1].match(/"encrypt"\s*:\s*(\d+)/);
      if (um) rawUrl = um[1];
      if (em) encryptType = parseInt(em[1]);
    }
  }

  let streamUrl = null;
  if (rawUrl) {
    const cleaned   = rawUrl.replace(/\\\//g, '/');
    const candidate = decrypt(cleaned, encryptType);
    if (M3U8_RE.test(candidate)) {
      streamUrl = candidate;
    } else if (candidate.includes('url=')) {
      const m = candidate.match(/[?&]url=([^&]+)/);
      if (m) {
        const inner = decodeURIComponent(m[1]);
        if (/^https?:\/\//.test(inner)) streamUrl = inner;
      }
    }
  }

  // Hail-mary: scan raw HTML for any m3u8 URL
  if (!streamUrl) {
    const rm = html.match(/(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+(\.m3u8))/i);
    if (rm) {
      streamUrl = rm[1];
    } else {
      const b64m = html.match(/aHR0c[a-zA-Z0-9+/=]+/);
      if (b64m) {
        try { const d = atob(b64m[0]); if (d.includes('.m3u8')) streamUrl = d; } catch (_) {}
      }
    }
  }

  if (!streamUrl || !M3U8_RE.test(streamUrl)) {
    throw Object.assign(
      new Error('No valid m3u8 found after decryption'),
      { htmlPreview: html.substring(0, 500) }
    );
  }
  return streamUrl;
}

// ── M3U8 rewriter ─────────────────────────────────────────────────────────────
// Segment referer is always ORIGIN — CDN validates the DOMAIN, not the m3u8 path.
// Previously we used the m3u8 CDN URL as referer which caused 404 on every segment.
function rewriteM3u8(text, workerBase, m3u8Url) {
  return text.split('\n').map(line => {
    const l = line.trimEnd();
    if (!l || l.startsWith('#')) return l;
    const abs = l.startsWith('http') ? l : new URL(l, m3u8Url).href;
    return `${workerBase}/proxy?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(ORIGIN + '/')}`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
addEventListener('fetch', event => event.respondWith(handle(event.request)));

async function handle(req) {
  const u    = new URL(req.url);
  const path = u.pathname;

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return corsResponse('', 204);
  }

  // ── HEAD /proxy — some HLS clients probe before GET ──────────────────────
  if (req.method === 'HEAD' && path === '/proxy') {
    return corsResponse(null, 200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
  }

  // ── /test — paste this URL in browser to verify deployment ───────────────
  if (path === '/test') {
    return jsonResp({ ok: true, version: '2025-c', origin: ORIGIN });
  }

  // ── /extract ──────────────────────────────────────────────────────────────
  if (path === '/extract') {
    const vodUrl = u.searchParams.get('url');
    if (!vodUrl) return jsonResp({ error: 'Missing url param' }, 400);
    try {
      const streamUrl = await extractStreamUrl(vodUrl);
      return jsonResp({ streamUrl });
    } catch (err) {
      return jsonResp({ error: err.message, htmlPreview: err.htmlPreview || null }, 502);
    }
  }

  // ── /proxy ────────────────────────────────────────────────────────────────
  if (path === '/proxy') {
    // Support both ?ref= (new) and ?referer= (legacy) parameter names
    const target  = u.searchParams.get('url');
    const referer = u.searchParams.get('ref') || u.searchParams.get('referer') || ORIGIN + '/';
    if (!target) return jsonResp({ error: 'Missing url param' }, 400);

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          'User-Agent': UA,
          'Referer':    referer,
          'Origin':     ORIGIN,
          'Accept':     '*/*',
        },
      });
    } catch (err) {
      return jsonResp({ error: `fetch failed: ${err.message}`, target }, 502);
    }

    const ct = upstream.headers.get('content-type') || '';

    // Return non-2xx as JSON diagnostic (visible in debug console)
    if (!upstream.ok) {
      return jsonResp({ error: `Upstream ${upstream.status}`, target, referer }, upstream.status);
    }

    // Binary segments — stream directly without text conversion
    const isBinary = ct.includes('video/') || ct.includes('audio/') ||
                     ct.includes('octet-stream') ||
                     /\.(ts|mp4|m4s|m4v|aac|mp3|fmp4)(\?|$)/i.test(target);
    if (isBinary) {
      const body = await upstream.arrayBuffer();
      return corsResponse(body, upstream.status, {
        'Content-Type':  ct || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      });
    }

    // Text — detect M3U8 by content-type, URL extension, or body prefix
    const text   = await upstream.text();
    const isM3u8 = ct.includes('mpegurl') || ct.includes('x-mpegurl') ||
                   /\.m3u8(\?|$)/i.test(target) ||
                   text.trimStart().startsWith('#EXTM3U');

    if (isM3u8) {
      const workerBase = `${u.protocol}//${u.host}`;
      const rewritten  = rewriteM3u8(text, workerBase, target);
      return corsResponse(rewritten, upstream.status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
      });
    }

    return corsResponse(text, upstream.status, {
      'Content-Type': ct || 'text/plain',
    });
  }

  // ── /api/page ─────────────────────────────────────────────────────────────
  if (path === '/api/page') {
    const sitePath = u.searchParams.get('path');
    if (!sitePath) return jsonResp({ error: 'Missing path param' }, 400);
    try {
      const html = await siteGet(sitePath);
      return corsResponse(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
    } catch (err) {
      return jsonResp({ error: err.message }, 502);
    }
  }

  // ── /api/search ───────────────────────────────────────────────────────────
  if (path === '/api/search') {
    const kw   = u.searchParams.get('q')    || '';
    const page = u.searchParams.get('page') || '1';
    if (!kw) return jsonResp({ items: [], hasMore: false });
    try {
      const apiUrl = `${ORIGIN}/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(kw)}&pg=${page}`;
      const raw    = await siteGet(apiUrl, { Accept: 'application/json' });
      const data   = JSON.parse(raw);
      if (!data || data.code !== 1 || !Array.isArray(data.list))
        return jsonResp({ items: [], hasMore: false });
      const items = data.list.map(v => ({
        title:  v.name || '',
        url:    `${ORIGIN}/voddetail/${v.id}.html`,
        poster: (v.vod_pic || v.pic || '').startsWith('http')
          ? (v.vod_pic || v.pic)
          : (v.vod_pic || v.pic ? ORIGIN + (v.vod_pic || v.pic) : ''),
        badge: '',
      })).filter(v => v.title && v.url);
      return jsonResp({ items, hasMore: Number(page) < (data.pagecount || 1) });
    } catch (err) {
      return jsonResp({ error: err.message }, 502);
    }
  }

  return jsonResp({ error: `Unknown route: ${path}` }, 404);
}
