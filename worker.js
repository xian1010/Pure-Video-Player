/**
 * Cloudflare Worker — Pure Video Player backend proxy
 *
 * Routes:
 *   GET /extract?url=<vodplay_url>        → { streamUrl } or { error, htmlPreview }
 *   GET /proxy?url=<encoded_url>          → transparent proxy (M3U8 / TS segments)
 *   GET /api/page?path=<url_path>         → raw HTML with CORS (client parses with DOMParser)
 *   GET /api/search?q=<kw>&page=<n>       → { items, hasMore }
 *
 * Deploy:  wrangler publish  (or paste into CF dashboard)
 */

const ORIGIN    = 'https://huavod.net';
const UA        = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CORS_HDRS = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Allow-Methods':  'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':  '*',
  'Access-Control-Expose-Headers': '*',
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

// ── Helpers: Buffer-free base64 decode (Cloudflare Workers) ─────────────────
// Returns a Uint8Array of raw bytes from a base64 string (standard or URL-safe).
function b64ToBytes(b64) {
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary   = atob(standard);
  const bytes    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Stream URL decryption (synced with main.js fast-extraction) ──────────────
const M3U8_RE = /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/;

function decrypt(rawUrl, encrypt) {
  if (encrypt === 0) return rawUrl;

  if (encrypt === 1) {
    return decodeURIComponent(rawUrl);
  }

  if (encrypt === 2) {
    // base64 → binary string → percent-escape → decodeURIComponent
    const bytes = atob(rawUrl);
    return decodeURIComponent(escape(bytes));
  }

  if (encrypt === 3 && !rawUrl.startsWith('http')) {
    // Translate main.js Buffer strategies to browser-compatible equivalents.
    // b64ToBytes gives us the raw byte array; binary is the latin-1 string.
    let bytes, binary;
    try {
      bytes  = b64ToBytes(rawUrl);
      binary = atob(rawUrl.replace(/-/g, '+').replace(/_/g, '/'));
    } catch (_) {
      return rawUrl; // malformed base64 — give up
    }

    const strategies = [
      // S0: plain utf-8 decode
      () => new TextDecoder('utf-8').decode(bytes),
      // S1: reverse binary (latin-1) string, then decodeURIComponent
      () => decodeURIComponent(binary.split('').reverse().join('')),
      // S2: reverse byte array, then utf-8 decode
      () => new TextDecoder('utf-8').decode(new Uint8Array([...bytes].reverse())),
      // S3: utf-8 decode, then reverse the resulting string
      () => new TextDecoder('utf-8').decode(bytes).split('').reverse().join(''),
      // S4: unescape(reversed binary latin-1 string)
      () => unescape(binary.split('').reverse().join('')),
      // S5: look for a bare path inside the decoded utf-8 string
      () => {
        const s = new TextDecoder('utf-8').decode(bytes);
        const m = s.match(/^[a-zA-Z0-9._\-]+(\/[a-zA-Z0-9._\-]+)+\.m3u8/);
        return m ? `https://p.okokserver.com/${m[0]}` : '';
      },
      // S6: search for m3u8 path in reversed binary or forward binary
      () => {
        const reversed = binary.split('').reverse().join('');
        let m = reversed.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
        if (m) return `https://p.okokserver.com/${m[0]}`;
        m = binary.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
        return m ? `https://p.okokserver.com/${m[0]}` : '';
      },
    ];

    for (const fn of strategies) {
      try {
        let candidate = fn();
        // Extract the first http(s) URL from the decoded string
        const httpMatch = candidate.match(/https?:\/\/[^\s"'<>\\]+/);
        if (httpMatch) {
          candidate = httpMatch[0]
            .replace(/[O0]{4,}$/, '')
            .replace(/[^a-zA-Z0-9._\-/:?=&%+#~@!$'()*,;]+$/, '');
        }
        if (M3U8_RE.test(candidate)) return candidate;
      } catch (_) {}
    }
  }

  return rawUrl; // give up — return as-is so hail-mary can still try
}

// ── Stream URL extraction (mirrors main.js fast-extraction) ─────────────────
async function extractStreamUrl(vodplayUrl) {
  // Normalise voddetail → vodplay
  const url = vodplayUrl.replace(/\/voddetail\/(\d+)\.html/, '/vodplay/$1-1-1.html');

  const html = await siteGet(url);

  // ── Parse mac_player_info block ───────────────────────────────────────────
  // Use single-line regex first (matches the compact script tag format)
  let blockMatch = html.match(/mac_player_info\s*=\s*(\{[^\r\n]+\})/);
  // Fallback to multiline regex (some templates span multiple lines)
  if (!blockMatch) blockMatch = html.match(/mac_player_info\s*=\s*(\{[\s\S]*?\})\s*;/);

  let rawUrl  = null;
  let encrypt = 0;

  if (blockMatch) {
    try {
      const info = JSON.parse(blockMatch[1]);
      if (info.url) { rawUrl = info.url; encrypt = parseInt(info.encrypt) || 0; }
    } catch (_) {
      const um = blockMatch[1].match(/"url"\s*:\s*"([^"]+)"/);
      const em = blockMatch[1].match(/"encrypt"\s*:\s*(\d+)/);
      if (um) rawUrl  = um[1];
      if (em) encrypt = parseInt(em[1]);
    }
  }

  // ── Attempt decryption ────────────────────────────────────────────────────
  let streamUrl = null;

  if (rawUrl) {
    // Unescape any JSON-escaped forward slashes
    const cleaned = rawUrl.replace(/\\\//g, '/');
    const candidate = decrypt(cleaned, encrypt);

    if (M3U8_RE.test(candidate)) {
      streamUrl = candidate;
    } else if (typeof candidate === 'string' && candidate.includes('url=')) {
      // Embedded URL pattern: ?url=<encoded_stream_url>
      const m = candidate.match(/[?&]url=([^&]+)/);
      if (m) {
        const inner = decodeURIComponent(m[1]);
        if (/^https?:\/\//.test(inner)) streamUrl = inner;
      }
    }
  }

  // ── Hail-mary: scan the raw HTML for any m3u8 URL ────────────────────────
  if (!streamUrl) {
    const rawM3u8 = html.match(/(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+(\.m3u8))/i);
    if (rawM3u8) {
      streamUrl = rawM3u8[1];
    } else {
      // Try plain base64 chunks that decode to m3u8 URLs
      const b64Chunk = html.match(/aHR0c[a-zA-Z0-9+/=]+/);
      if (b64Chunk) {
        try {
          const dec = atob(b64Chunk[0]);
          if (dec.includes('.m3u8')) streamUrl = dec;
        } catch (_) {}
      }
    }
  }

  if (!streamUrl || !M3U8_RE.test(streamUrl)) {
    // Return diagnostic info so the caller can debug
    throw Object.assign(
      new Error('No valid m3u8 found after decryption'),
      { htmlPreview: html.substring(0, 500) }
    );
  }

  return streamUrl;
}

// ── M3U8 rewriter: rewrites segment/playlist URLs to go through /proxy ──────
function rewriteM3u8(text, workerBase, referer) {
  return text.split('\n').map(line => {
    line = line.trimEnd();
    if (line.startsWith('#')) return line;
    if (!line) return line;
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
      return json({ error: err.message, htmlPreview: err.htmlPreview || null }, 502);
    }
  }

  // ── /proxy (transparent proxy + M3U8 rewriting) ───────────────────────────
  if (path === '/proxy') {
    const target  = u.searchParams.get('url');
    const referer = u.searchParams.get('referer') || ORIGIN;
    if (!target) return json({ error: 'Missing url param' }, 400);
    try {
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': UA,
          'Referer':    referer,
          'Origin':     ORIGIN,
        },
      });
      const ct = upstream.headers.get('content-type') || '';

      // Surface non-2xx upstream errors with diagnostics
      if (!upstream.ok) {
        return json({ error: `Upstream ${upstream.status} for ${target}` }, upstream.status);
      }

      const isM3u8 = ct.includes('mpegurl') || ct.includes('x-mpegurl') || /\.m3u8(\?|$)/i.test(target);

      if (isM3u8) {
        // Text playlist — rewrite all segment/sub-playlist URLs through /proxy
        const text = await upstream.text();
        const workerBase = `${u.protocol}//${u.host}`;
        const rewritten  = rewriteM3u8(text, workerBase, target);
        return cors(rewritten, {
          status: upstream.status,
          headers: { 'Content-Type': ct || 'application/vnd.apple.mpegurl' },
        });
      } else {
        // Binary content (TS segments, MP4 init, etc.) — MUST use arrayBuffer,
        // not text(), to avoid UTF-8 re-encoding corrupting the binary stream.
        const body = await upstream.arrayBuffer();
        return cors(body, {
          status: upstream.status,
          headers: {
            'Content-Type':  ct || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
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
