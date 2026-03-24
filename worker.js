/**
 * Cloudflare Worker — Pure Video Player backend proxy  (version 2025-f)
 *
 * Routes:
 *   GET /test                             → { ok, version }
 *   GET /extract?url=<vodplay_url>        → { streamUrl } or { error }
 *   GET /proxy?url=<encoded_url>          → transparent proxy (M3U8 / TS / Range)
 *   GET /api/page?path=<url_path>         → raw HTML with CORS
 *   GET /api/search?q=<kw>&page=<n>       → { items, hasMore }
 *
 * KEY FIX (2025-f): Range request passthrough for iOS native HLS.
 *   Safari sends  Range: bytes=X-Y  for every TS segment.
 *   We forward it upstream and relay Content-Range / Accept-Ranges back.
 *   Without this, iOS spins forever on "waiting for segment".
 */

const ORIGIN = 'https://huavod.net';

// Desktop Chrome UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) ' +
           'Chrome/124.0.0.0 Safari/537.36';

// MacCMS path variants to try on 404/403
const PATH_VARIANTS = ['/lay/', '/link/', '/play/', '/m3u8/', '/hls/'];

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

// ── Spoofed headers for huavod.net page requests ──────────────────────────────
function pageHeaders(extra = {}) {
  return {
    'User-Agent':      UA,
    'Referer':         ORIGIN + '/',
    'Origin':          ORIGIN,
    'Host':            'huavod.net',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    ...extra,
  };
}

// ── CDN fetch headers — spoofed Referer + optional Cookie + optional Range ────
function cdnHeaders(referer, cookies, rangeHeader) {
  const h = {
    'User-Agent': UA,
    'Referer':    referer || ORIGIN + '/',
    'Origin':     ORIGIN,
    'Accept':     '*/*',
  };
  if (cookies)     h['Cookie'] = cookies;
  if (rangeHeader) h['Range']  = rangeHeader;   // ← RANGE PASSTHROUGH
  return h;
}

// ── Fetch huavod.net page; capture Set-Cookie for session simulation ──────────
async function siteFetch(url, extra = {}) {
  const fullUrl = url.startsWith('http') ? url : ORIGIN + url;
  const res = await fetch(fullUrl, { headers: pageHeaders(extra) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${fullUrl}`);

  const rawCookie = res.headers.get('set-cookie') || '';
  const cookies   = rawCookie
    .split(/,(?=[^;]+=[^;])/)
    .map(c => c.trim().split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  return { text: await res.text(), cookies };
}

// ── Fetch URL with automatic path-variant fallback on 404/403 ────────────────
async function fetchWithPathFallback(url, referer, cookies, rangeHeader) {
  const headers = cdnHeaders(referer, cookies, rangeHeader);

  let res = await fetch(url, { headers });
  if (res.ok || res.status === 206) return { finalUrl: url, res };

  const firstStatus = res.status;

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

// ── Extract + verify stream URL from vodplay page ─────────────────────────────
async function extractStreamUrl(vodplayUrl) {
  const url = vodplayUrl.replace(/\/voddetail\/(\d+)\.html/, '/vodplay/$1-1-1.html');
  const { text: html, cookies: sessionCookies } = await siteFetch(url);

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
      { htmlPreview: html.substring(0, 500) }
    );
  }

  // Verify URL works (with session cookies + path-variant fallback)
  const { finalUrl, status: failStatus } = await fetchWithPathFallback(
    streamUrl, ORIGIN + '/', sessionCookies, null
  );

  if (failStatus) {
    throw Object.assign(
      new Error(`Stream URL returned ${failStatus} (tried path variants)`),
      { htmlPreview: `Attempted: ${streamUrl}\nCookies: ${sessionCookies ? 'yes' : 'no'}` }
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

// ── Infer Content-Type from URL extension ─────────────────────────────────────
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

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // ── HEAD /proxy ───────────────────────────────────────────────────────────
  if (req.method === 'HEAD' && path === '/proxy') {
    return new Response(null, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type':  'application/vnd.apple.mpegurl',
        'Accept-Ranges': 'bytes',
      },
    });
  }

  // ── /test ─────────────────────────────────────────────────────────────────
  if (path === '/test') {
    return jsonResp({ ok: true, version: '2025-f', origin: ORIGIN });
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
    const target      = u.searchParams.get('url');
    const referer     = u.searchParams.get('ref') || u.searchParams.get('referer') || ORIGIN + '/';
    // ↓ Forward Range header from Safari/iOS verbatim to the CDN
    const rangeHeader = req.headers.get('Range') || null;

    if (!target) return jsonResp({ error: 'Missing url param' }, 400);

    let upstream, finalTarget;
    try {
      const result = await fetchWithPathFallback(target, referer, null, rangeHeader);
      upstream    = result.res;
      finalTarget = result.finalUrl;
      if (!upstream) {
        return jsonResp({
          error:      `Upstream ${result.status}`,
          target,
          finalTarget,
          referer,
          rangeHeader,
          hint: result.status === 403
            ? 'CDN blocking Cloudflare IPs or Referer mismatch'
            : result.status === 404
            ? 'Segment not found — tried /lay/ /link/ /play/ variants'
            : 'Upstream error',
        }, result.status);
      }
    } catch (err) {
      return jsonResp({ error: `fetch failed: ${err.message}`, target }, 502);
    }

    const upstreamCt = upstream.headers.get('content-type') || '';
    const ct         = inferContentType(upstreamCt, finalTarget);

    // ── Collect headers to relay back (Range-related are mandatory for iOS) ─
    const relayHeaders = { 'Content-Type': ct };

    const contentRange  = upstream.headers.get('Content-Range');
    const acceptRanges  = upstream.headers.get('Accept-Ranges');
    const contentLength = upstream.headers.get('Content-Length');
    // Always advertise byte-range support even if CDN didn't send Accept-Ranges
    relayHeaders['Accept-Ranges'] = acceptRanges || 'bytes';
    if (contentRange)  relayHeaders['Content-Range']  = contentRange;
    if (contentLength) relayHeaders['Content-Length'] = contentLength;

    // Use the upstream's actual status: 200 for full, 206 for partial content
    const upstreamStatus = upstream.status;

    // ── Binary segments ───────────────────────────────────────────────────
    const isBinary = ct.startsWith('video/') || ct.startsWith('audio/') ||
                     upstreamCt.includes('octet-stream') ||
                     /\.(ts|mp4|m4s|m4v|aac|mp3|fmp4)(\?|$)/i.test(finalTarget);
    if (isBinary) {
      const body = await upstream.arrayBuffer();
      // Override Content-Length with actual body size (some CDNs lie)
      relayHeaders['Content-Length'] = String(body.byteLength);
      relayHeaders['Cache-Control']  = 'public, max-age=3600';
      return corsResponse(body, upstreamStatus, relayHeaders);
    }

    // ── Text — detect M3U8 ────────────────────────────────────────────────
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

    return corsResponse(text, upstreamStatus, {
      'Content-Type': upstreamCt || 'text/plain',
    });
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
        badge: '',
      })).filter(v => v.title && v.url);
      return jsonResp({ items, hasMore: Number(page) < (data.pagecount || 1) });
    } catch (err) {
      return jsonResp({ error: err.message }, 502);
    }
  }

  return jsonResp({ error: `Unknown route: ${path}` }, 404);
}
