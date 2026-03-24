/**
 * Cloudflare Worker — Pure Video Player backend proxy  (version 2025-g)
 *
 * Routes:
 *   GET /test                             → { ok, version }
 *   GET /extract?url=<vodplay_url>        → { streamUrl } or { error, candidateUrl }
 *   GET /proxy?url=<encoded_url>          → transparent proxy + Range passthrough
 *   GET /api/page?path=<url_path>         → raw HTML with CORS
 *   GET /api/search?q=<kw>&page=<n>       → { items, hasMore }
 *
 * 2025-g fixes:
 *   • /lay/ → /link/ hard-fix for p.okokserver.com (path-variant priority)
 *   • Session cookies from vodplay page forwarded to CDN fetch
 *   • candidateUrl returned in error response so renderer can try direct iPad play
 *   • Range passthrough (from 2025-f, unchanged)
 */

const ORIGIN = 'https://huavod.net';

// Standard Windows desktop Chrome — CDNs often restrict or downgrade mobile UAs
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) ' +
           'Chrome/124.0.0.0 Safari/537.36';

// ── Hard-fix known bad paths before any fetch attempt ────────────────────────
// p.okokserver.com uses /link/ for real streams; /lay/ is the MacCMS preview alias.
function fixStreamPath(url) {
  if (url.includes('okokserver.com') && url.includes('/lay/')) {
    return url.replace('/lay/', '/link/');
  }
  return url;
}

// Generic path variants to rotate through on 404/403
const PATH_VARIANTS = ['/link/', '/lay/', '/play/', '/m3u8/', '/hls/'];

// ── CORS ──────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':  'Range, Content-Type, *',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type, *',
  'Access-Control-Max-Age':        '86400',
};

function corsResponse(body, status, extra = {}) {
  return new Response(body, { status, headers: { ...CORS, ...extra } });
}
function jsonResp(obj, status = 200) {
  return corsResponse(JSON.stringify(obj), status, { 'Content-Type': 'application/json' });
}

// ── Full-spoof headers for huavod.net page requests ───────────────────────────
function pageHeaders(extra = {}) {
  return {
    'User-Agent':        UA,
    'Referer':           ORIGIN + '/',
    'Origin':            ORIGIN,
    'Host':              'huavod.net',
    'Accept':            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':   'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding':   'gzip, deflate, br',
    'Connection':        'keep-alive',
    'Cache-Control':     'no-cache',
    'Pragma':            'no-cache',
    'Sec-Fetch-Dest':    'document',
    'Sec-Fetch-Mode':    'navigate',
    'Sec-Fetch-Site':    'same-origin',
    ...extra,
  };
}

// ── CDN segment/m3u8 fetch headers ────────────────────────────────────────────
function cdnHeaders(referer, cookies, rangeHeader) {
  const h = {
    'User-Agent':      UA,
    'Referer':         referer || ORIGIN + '/',
    'Origin':          ORIGIN,
    'Accept':          '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Connection':      'keep-alive',
  };
  if (cookies)     h['Cookie'] = cookies;
  if (rangeHeader) h['Range']  = rangeHeader;
  return h;
}

// ── Fetch huavod.net page; capture Set-Cookie for session passthrough ─────────
async function siteFetch(url, extra = {}) {
  const fullUrl = url.startsWith('http') ? url : ORIGIN + url;
  const res = await fetch(fullUrl, { headers: pageHeaders(extra) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${fullUrl}`);

  // Collapse multiple Set-Cookie values into a single Cookie string
  const rawCookie = res.headers.get('set-cookie') || '';
  const cookies   = rawCookie
    .split(/,(?=[^;]+=[^;])/)
    .map(c => c.trim().split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  return { text: await res.text(), cookies };
}

// ── Fetch URL; hard-fix path then rotate variants on 404/403 ─────────────────
async function fetchWithFallback(rawUrl, referer, cookies, rangeHeader) {
  // Apply hard-fix first so we always try the corrected URL before anything else
  const url     = fixStreamPath(rawUrl);
  const headers = cdnHeaders(referer, cookies, rangeHeader);

  let res = await fetch(url, { headers });
  if (res.ok || res.status === 206) return { finalUrl: url, res };

  const firstStatus = res.status;

  // Path-variant rotation — only on 404/403
  if (firstStatus === 404 || firstStatus === 403) {
    for (const from of PATH_VARIANTS) {
      if (!url.includes(from)) continue;
      for (const to of PATH_VARIANTS) {
        if (to === from) continue;
        const alt = url.replace(from, to);
        const r2  = await fetch(alt, { headers });
        if (r2.ok || r2.status === 206) return { finalUrl: alt, res: r2 };
      }
    }
  }

  return { finalUrl: url, res: null, status: firstStatus };
}

// ── Base64 → Uint8Array ───────────────────────────────────────────────────────
function b64ToBytes(b64) {
  const s   = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Decrypt mac_player_info.url ───────────────────────────────────────────────
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
        const m = s.match(/^[a-zA-Z0-9._\-]+\/[a-zA-Z0-9._\-/]+\.m3u8/);
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
        if (hm) c = hm[0]
          .replace(/[O0]{4,}$/, '')
          .replace(/[^a-zA-Z0-9._\-/:?=&%+#~@!$'()*,;]+$/, '');
        if (M3U8_RE.test(c)) return c;
      } catch (_) {}
    }
  }
  return raw;
}

// ── Extract stream URL from vodplay page ──────────────────────────────────────
async function extractStreamUrl(vodplayUrl) {
  const url = vodplayUrl.replace(/\/voddetail\/(\d+)\.html/, '/vodplay/$1-1-1.html');

  // Fetch page + capture session cookies
  const { text: html, cookies: sessionCookies } = await siteFetch(url);

  // Parse mac_player_info block
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

  // Hail-mary: scan HTML for bare m3u8 URL
  if (!streamUrl) {
    const rm = html.match(/(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+\.m3u8)/i);
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
      { htmlPreview: html.substring(0, 500), candidateUrl: null }
    );
  }

  // Apply hard-fix before verification
  const fixedUrl = fixStreamPath(streamUrl);

  // Verify the URL actually responds (with session cookies + path fallback)
  const { finalUrl, status: failStatus } = await fetchWithFallback(
    fixedUrl, ORIGIN + '/', sessionCookies, null
  );

  if (failStatus) {
    // Return the best-guess URL as candidateUrl so the client can attempt
    // a direct iPad play (bypassing Cloudflare IPs entirely).
    throw Object.assign(
      new Error(`Stream URL returned ${failStatus} (tried all path variants)`),
      {
        htmlPreview:  `Original: ${streamUrl}\nFixed: ${fixedUrl}\nCookies: ${sessionCookies ? 'yes' : 'no'}`,
        candidateUrl: fixedUrl,   // ← renderer uses this for direct iPad fallback
      }
    );
  }

  return finalUrl;
}

// ── M3U8 rewriter ─────────────────────────────────────────────────────────────
function rewriteM3u8(text, workerBase, m3u8Url) {
  return text.split('\n').map(line => {
    const l = line.trimEnd();
    if (!l || l.startsWith('#')) return l;
    const abs = l.startsWith('http') ? l : new URL(l, m3u8Url).href;
    return `${workerBase}/proxy?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(ORIGIN + '/')}`;
  }).join('\n');
}

// ── Content-Type inference ────────────────────────────────────────────────────
function inferContentType(upstreamCt, targetUrl) {
  if (/\.(ts)(\?|$)/i.test(targetUrl))                return 'video/mp2t';
  if (/\.m3u8(\?|$)/i.test(targetUrl))               return 'application/vnd.apple.mpegurl';
  if (/\.(mp4|m4s|m4v|fmp4)(\?|$)/i.test(targetUrl)) return 'video/mp4';
  if (/\.aac(\?|$)/i.test(targetUrl))                return 'audio/aac';
  if (/\.mp3(\?|$)/i.test(targetUrl))                return 'audio/mpeg';
  return upstreamCt || 'application/octet-stream';
}

// ═══════════════════════════════════════════════════════════════════════════════
addEventListener('fetch', event => event.respondWith(handle(event.request)));

async function handle(req) {
  const u    = new URL(req.url);
  const path = u.pathname;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method === 'HEAD' && path === '/proxy') {
    return new Response(null, {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Accept-Ranges': 'bytes' },
    });
  }

  // ── /test ─────────────────────────────────────────────────────────────────
  if (path === '/test') {
    return jsonResp({ ok: true, version: '2025-g', origin: ORIGIN });
  }

  // ── /extract ──────────────────────────────────────────────────────────────
  if (path === '/extract') {
    const vodUrl = u.searchParams.get('url');
    if (!vodUrl) return jsonResp({ error: 'Missing url param' }, 400);
    try {
      const streamUrl = await extractStreamUrl(vodUrl);
      return jsonResp({ streamUrl });
    } catch (err) {
      // Include candidateUrl so renderer.js can attempt a direct iPad play
      return jsonResp({
        error:        err.message,
        htmlPreview:  err.htmlPreview  || null,
        candidateUrl: err.candidateUrl || null,
      }, 502);
    }
  }

  // ── /proxy ────────────────────────────────────────────────────────────────
  if (path === '/proxy') {
    const target      = u.searchParams.get('url');
    const referer     = u.searchParams.get('ref') || u.searchParams.get('referer') || ORIGIN + '/';
    const rangeHeader = req.headers.get('Range') || null;

    if (!target) return jsonResp({ error: 'Missing url param' }, 400);

    let upstream, finalTarget;
    try {
      const result = await fetchWithFallback(target, referer, null, rangeHeader);
      upstream    = result.res;
      finalTarget = result.finalUrl;
      if (!upstream) {
        return jsonResp({
          error:      `Upstream ${result.status}`,
          target,
          finalTarget,
          referer,
          hint: result.status === 403
            ? 'CDN blocking Cloudflare IPs — use direct iPad fallback'
            : 'Segment not found after path variants',
        }, result.status);
      }
    } catch (err) {
      return jsonResp({ error: `fetch failed: ${err.message}`, target }, 502);
    }

    const upstreamCt = upstream.headers.get('content-type') || '';
    const ct         = inferContentType(upstreamCt, finalTarget);
    const upstreamStatus = upstream.status; // relay 200 or 206

    // Relay Range-related headers (mandatory for iOS native HLS)
    const relay = { 'Content-Type': ct };
    relay['Accept-Ranges'] = upstream.headers.get('Accept-Ranges') || 'bytes';
    const cr = upstream.headers.get('Content-Range');
    const cl = upstream.headers.get('Content-Length');
    if (cr) relay['Content-Range'] = cr;
    if (cl) relay['Content-Length'] = cl;

    // Binary segments
    const isBinary = ct.startsWith('video/') || ct.startsWith('audio/') ||
                     upstreamCt.includes('octet-stream') ||
                     /\.(ts|mp4|m4s|m4v|aac|mp3|fmp4)(\?|$)/i.test(finalTarget);
    if (isBinary) {
      const body = await upstream.arrayBuffer();
      relay['Content-Length'] = String(body.byteLength);
      relay['Cache-Control']  = 'public, max-age=3600';
      return corsResponse(body, upstreamStatus, relay);
    }

    // M3U8 detection
    const text   = await upstream.text();
    const isM3u8 = upstreamCt.includes('mpegurl') || upstreamCt.includes('x-mpegurl') ||
                   /\.m3u8(\?|$)/i.test(finalTarget) ||
                   text.trimStart().startsWith('#EXTM3U');

    if (isM3u8) {
      const workerBase = `${u.protocol}//${u.host}`;
      const rewritten  = rewriteM3u8(text, workerBase, finalTarget);
      return corsResponse(rewritten, 200, {
        'Content-Type':  'application/vnd.apple.mpegurl',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
    }

    return corsResponse(text, upstreamStatus, { 'Content-Type': upstreamCt || 'text/plain' });
  }

  // ── /api/page ─────────────────────────────────────────────────────────────
  if (path === '/api/page') {
    const sitePath = u.searchParams.get('path');
    if (!sitePath) return jsonResp({ error: 'Missing path param' }, 400);
    try {
      const { text: html } = await siteFetch(sitePath);
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
      const { text: raw } = await siteFetch(apiUrl, { Accept: 'application/json' });
      const data = JSON.parse(raw);
      if (!data || data.code !== 1 || !Array.isArray(data.list))
        return jsonResp({ items: [], hasMore: false });
      const items = data.list.map(v => ({
        title:  v.name || '',
        url:    `${ORIGIN}/voddetail/${v.id}.html`,
        poster: (v.vod_pic || v.pic || '').startsWith('http')
          ? (v.vod_pic || v.pic)
          : (v.vod_pic || v.pic ? ORIGIN + (v.vod_pic || v.pic) : ''),
        badge:  '',
      })).filter(v => v.title && v.url);
      return jsonResp({ items, hasMore: Number(page) < (data.pagecount || 1) });
    } catch (err) {
      return jsonResp({ error: err.message }, 502);
    }
  }

  return jsonResp({ error: `Unknown route: ${path}` }, 404);
}
