'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  protocol,
  net
} = require('electron');

const path    = require('path');
const axios   = require('axios');
const cheerio = require('cheerio');
const https   = require('https');
const vm      = require('vm');
const fs      = require('fs');

// electron-updater is only present in packaged builds; fail silently in dev
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}

app.commandLine.appendSwitch('ignore-certificate-errors', 'true');

// ─── Constants ─────────────────────────────────────────────────────────────────
const SNIFF_TIMEOUT_MS = 25_000;
const BASE_URL         = 'https://huavod.net';
const CHROME_UA        =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/122.0.0.0 Safari/537.36';

// Ad-stream denylist — any m3u8 URL matching these patterns is an ad, not content.
const AD_DENYLIST = [
  'doubleclick', 'googlesyndication', 'adservice', 'adserver',
  '/ad/', '/ads/', 'advert', 'commercial', 'trackid', 'prebid',
  'yieldmanager', 'pubmatic', 'openx.net', 'rubiconproject',
  'moatads', 'scorecardresearch', 'omtrdc', 'demdex',
];

function isAdUrl(url) {
  const low = url.toLowerCase();
  return AD_DENYLIST.some(kw => low.includes(kw));
}

// ─── Remote logic (hot-patchable site parsing) ────────────────────────────────
// On startup, main.js fetches remote-logic.js from your GitHub repo and runs it
// in a vm sandbox. If unavailable (no network / first run), built-in logic is
// used instead. Edit remote-logic.js in your repo to fix parsing without a
// full release — the new version is picked up on next app launch.
//
// ⚠  Replace the URL with your own repo path before publishing.
// ⚠  vm.Script has full Node.js trust — only load from a URL you control.
const REMOTE_LOGIC_URL = 'https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME/main/remote-logic.js';

let remoteLogic = null;

async function loadRemoteLogic() {
  const cachePath = path.join(app.getPath('userData'), 'logic-cache.js');
  const CACHE_TTL = 60 * 60 * 1000; // 1 hour
  let code = null;

  // 1. Use in-date on-disk cache
  try {
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs < CACHE_TTL) {
      code = fs.readFileSync(cachePath, 'utf8');
      console.log('[RemoteLogic] Using cached copy');
    }
  } catch (_) {}

  // 2. Fetch a fresh copy when cache is missing / expired
  if (!code) {
    try {
      const { data } = await axios.get(REMOTE_LOGIC_URL, {
        baseURL: '', timeout: 8000, responseType: 'text',
        headers: { 'User-Agent': CHROME_UA },
      });
      code = data;
      try { fs.writeFileSync(cachePath, code, 'utf8'); } catch (_) {}
      console.log('[RemoteLogic] Fetched fresh copy from GitHub');
    } catch (e) {
      // 3. Fall back to stale cache rather than nothing
      try {
        code = fs.readFileSync(cachePath, 'utf8');
        console.log('[RemoteLogic] Fetch failed — using stale cache:', e.message);
      } catch (_) {
        console.log('[RemoteLogic] No remote logic available — using built-in:', e.message);
        return;
      }
    }
  }

  // Execute in a sandboxed VM context with injected dependencies.
  // Injected: ax (axios instance), cheerio, BASE_URL, CHROME_UA, console, Promise.
  // ECMAScript builtins (Set, Array, encodeURIComponent, etc.) are available natively.
  try {
    const mod = { exports: {} };
    const ctx = vm.createContext({
      module: mod, exports: mod.exports,
      ax, cheerio, BASE_URL, CHROME_UA, console, Promise,
    });
    new vm.Script(code).runInContext(ctx);
    const exp = mod.exports;
    if (typeof exp.parseCards === 'function' && typeof exp.scrapeCategory === 'function') {
      remoteLogic = exp;
      console.log('[RemoteLogic] Loaded successfully ✓');
    } else {
      console.warn('[RemoteLogic] Missing expected exports — skipping');
    }
  } catch (e) {
    console.error('[RemoteLogic] Execution error:', e.message);
  }
}

// ─── Axios instance (spoofed headers) ─────────────────────────────────────────
const ax = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: {
    'User-Agent': CHROME_UA,
    'Referer':    BASE_URL + '/',
    'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
});

// ─── Scraping Helpers ──────────────────────────────────────────────────────────
/**
 * Parse a standard card listing page (category or search result).
 * Returns an array of { title, url, poster, badge }.
 */
function parseCards(html) {
  if (remoteLogic?.parseCards) return remoteLogic.parseCards(html);
  const $ = cheerio.load(html);
  const items = [];

  // Primary card selector — handles both div and li variants across listing/search pages
  $('div.public-list-box, li.public-list-box').each((_i, el) => {
    const $el = $(el);

    // Poster
    const imgEl = $el.find('img').first();
    let poster = imgEl.attr('data-src') || imgEl.attr('src') || '';
    if (poster && !poster.startsWith('http')) poster = BASE_URL + poster;

    // Detail URL
    const aEl = $el.find('a.public-list-exp').first();
    const href = aEl.attr('href') || '';
    const url = href.startsWith('http') ? href : BASE_URL + href;

    // Title
    const title = $el.find('a.time-title').first().text().trim() || aEl.attr('title') || '';

    // Badge (热映 / 豆瓣 / episode count, etc.)
    const badge = $el.find('span.public-prt').first().text().trim();

    if (title && url.includes('/voddetail/')) {
      items.push({ title, url, poster, badge });
    }
  });

  return items;
}

/**
 * Check if a next page is available (simple heuristic: next-page link exists).
 */
function hasNextPage(html, currentPage) {
  if (remoteLogic?.hasNextPage) return remoteLogic.hasNextPage(html, currentPage);
  const $ = cheerio.load(html);
  const nextHref = $('a.page-next, a[title="下一页"]').attr('href') || '';
  if (nextHref) return true;
  // Fall back: count items — if >= 24 there's likely a next page
  const count = $('div.public-list-box').length;
  return count >= 24;
}

// ─── Category scraper ──────────────────────────────────────────────────────────
// URL format: /vodshow/{catId}[/area/{area}][/year/{year}]/{page}.html
async function scrapeCategory(catId, page = 1, area = '', year = '') {
  if (remoteLogic?.scrapeCategory) return remoteLogic.scrapeCategory(catId, page, area, year);
  let path = `/vodshow/${catId}`;
  if (area) path += `/area/${encodeURIComponent(area)}`;
  if (year) path += `/year/${year}`;
  path += `/${page}.html`;
  const { data: html } = await ax.get(path);
  console.log(`[Scrape] Fetched ${path}, length: ${html.length}`);
  return {
    items:   parseCards(html),
    hasMore: hasNextPage(html, page),
  };
}

// ─── Search scraper ────────────────────────────────────────────────────────────
// huavod.net disables its main listing API ("接口已关闭") but the suggest
// endpoint /index.php/ajax/suggest?mid=1&wd=… returns full JSON results.
async function scrapeSearch(keyword, page = 1) {
  if (remoteLogic?.scrapeSearch) return remoteLogic.scrapeSearch(keyword, page);
  const encoded = encodeURIComponent(keyword);
  const url = `/index.php/ajax/suggest?mid=1&wd=${encoded}&pg=${page}`;
  const { data: json } = await ax.get(url);

  if (!json || json.code !== 1 || !Array.isArray(json.list)) {
    console.warn('[Search] Unexpected response:', JSON.stringify(json).slice(0, 200));
    return { items: [], hasMore: false };
  }

  const items = json.list.map(v => {
    const poster = v.vod_pic || v.pic || '';
    return {
      title:  v.name || '',
      url:    `${BASE_URL}/voddetail/${v.id}.html`,
      poster: poster.startsWith('http') ? poster : (poster ? BASE_URL + poster : ''),
      badge:  '',
    };
  }).filter(v => v.title && v.url);

  const hasMore = page < (json.pagecount || 1);
  console.log(`[Search] "${keyword}" pg${page}: ${items.length} results, pagecount=${json.pagecount}`);
  return { items, hasMore };
}

// ─── Main Window ───────────────────────────────────────────────────────────────
let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d14',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Image Proxy (custom protocol) ────────────────────────────────────────────
// Usage in renderer: src="imgproxy://https%3A%2F%2Fexample.com%2Fposter.jpg"
function registerImageProxy() {
  protocol.handle('imgproxy', async (request) => {
    // The URL is: imgproxy://<url-encoded-real-url>
    const encoded = request.url.replace(/^imgproxy:\/\//, '');
    let realUrl;
    try {
      realUrl = decodeURIComponent(encoded);
    } catch {
      return new Response('Bad URL', { status: 400 });
    }

    if (realUrl.startsWith('//')) {
      realUrl = 'https:' + realUrl;
    } else if (realUrl.startsWith('/')) {
      realUrl = BASE_URL + realUrl;
    }

    try {
      const resp = await axios.get(realUrl, {
        responseType: 'arraybuffer',
        headers: {
          'Referer': BASE_URL + '/',
          'User-Agent': CHROME_UA,
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });
      return new Response(resp.data, {
        status: 200,
        headers: { 'Content-Type': resp.headers['content-type'] || 'image/jpeg' }
      });
    } catch (e) {
      return new Response(`Proxy error: ${e.message}`, { status: 502 });
    }
  });
}

// ─── Sniffer State ─────────────────────────────────────────────────────────────
let snifferWin      = null;
let sniffTimeoutId  = null;
let capturedM3u8    = null;
let capturedHeaders = {};
let sniffAborted    = false;

function cleanupSniffer() {
  if (sniffTimeoutId) { clearTimeout(sniffTimeoutId); sniffTimeoutId = null; }
  try { session.defaultSession.webRequest.onBeforeRequest(null, null); } catch (_) {}
  if (snifferWin && !snifferWin.isDestroyed()) { snifferWin.destroy(); snifferWin = null; }
  capturedM3u8    = null;
  capturedHeaders = {};
  sniffAborted    = false;
}

// Permanent Referer/Origin spoofer — registered once at startup, covers ALL URLs.
// HLS.js segment fetches to any CDN domain carry the correct headers, eliminating
// manifestParsingError from CDN hotlink protection on non-okokserver/huavod hosts.
function registerPermanentRefererSpoofer() {
  // Use <all_urls> so that HLS.js segment requests to ANY CDN domain
  // (not just okokserver/huavod) receive the correct Referer header,
  // which eliminates manifestParsingError caused by CDN hotlink protection.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, cb) => {
      const headers = { ...details.requestHeaders };
      headers['Referer']    = 'https://huavod.net/';
      headers['Origin']     = 'https://huavod.net';
      headers['User-Agent'] = CHROME_UA;
      cb({ requestHeaders: headers });
    }
  );
}

/**
 * Start sniffing targetUrl for its real (non-ad) m3u8 stream.
 */
async function startSniffing(targetUrl) {
  cleanupSniffer();
  sniffAborted = false;

  let finalUrl = targetUrl;

  // If it's a detail page, aggressively mutate the string to the play page standard
  if (targetUrl.includes('/voddetail/')) {
    sendStatus('🔍 直接跨越进入播放页…');
    finalUrl = targetUrl.replace('/voddetail/', '/vodplay/').replace('.html', '-1-1.html');
    if (!finalUrl.startsWith('http')) finalUrl = BASE_URL + finalUrl;
  }

  // FAST EXTRACTION: Parse mac_player_info from the play page for instant playback
  if (finalUrl.includes('/vodplay/')) {
    sendStatus('⚡ 尝试智能提取真实播放源 (秒播模式)…');
    try {
      const { data: html } = await ax.get(finalUrl);

      // ── Step 1: Extract url+encrypt ONLY from within mac_player_info block ──
      // Anchoring to this block prevents accidentally matching other "url" keys
      // elsewhere on the page (thumbnails, nav links, etc.) which caused the
      // encrypt:3 乱码 bug on TV-show pages.
      let streamUrl = null;
      let encrypt   = 0;

      const blockMatch = html.match(/mac_player_info\s*=\s*(\{[^\r\n]+\})/);
      if (blockMatch) {
        try {
          // Prefer a proper JSON parse (handles \" and \/ escapes correctly)
          const info = JSON.parse(blockMatch[1]);
          if (info.url) { streamUrl = info.url; encrypt = parseInt(info.encrypt) || 0; }
        } catch(_) {
          // JSON sometimes has unquoted keys; fall back to regex within the block
          const um = blockMatch[1].match(/"url"\s*:\s*"([^"]+)"/);
          const em = blockMatch[1].match(/"encrypt"\s*:\s*(\d+)/);
          if (um) streamUrl = um[1];
          if (em) encrypt   = parseInt(em[1]);
        }
      }
      // Global fallback if the block pattern wasn't found at all
      if (!streamUrl) {
        const um = html.match(/"url"\s*:\s*"([^"]+)"/);
        const em = html.match(/"encrypt"\s*:\s*(\d+)/);
        if (um) streamUrl = um[1];
        if (em) encrypt   = parseInt(em[1]);
      }

      if (streamUrl) {
        // Unescape JSON-escaped forward-slashes (\/ → /)
        streamUrl = streamUrl.replace(/\\\//g, '/');
        console.log(`\n[Sniffer] mac_player_info: url="${streamUrl.slice(0, 60)}..." encrypt=${encrypt}\n`);

        // ── Step 2: Decrypt ────────────────────────────────────────────────
        if (encrypt === 1) {
          streamUrl = decodeURIComponent(streamUrl);

        } else if (encrypt === 2) {
          streamUrl = decodeURIComponent(escape(Buffer.from(streamUrl, 'base64').toString('binary')));

        } else if (encrypt === 3 && !streamUrl.startsWith('http')) {
          // MacCMS encrypt:3 — different site templates use different schemes.
          // Evidence from live logs: "8u3m.xedni" = "index.m3u8" reversed, which
          // means S1-S4 (all of which reverse) are reversing an already-correct URL.
          // → huavod.net stores a plain btoa(url), so S0 (no reversal) must come first.
          // Some templates also pad the encoded value with junk like "O0O0O0" before
          // or after the real URL, so we extract the http:// URL from the decoded string.
          const b64    = streamUrl.replace(/-/g, '+').replace(/_/g, '/');
          const rawBuf = Buffer.from(b64, 'base64');

          const strategies = [
            // S0 — plain base64, NO reversal (huavod.net and similar)
            () => rawBuf.toString('utf8'),
            // S1 — standard MacCMS v3: latin1 → reverse → decodeURIComponent
            () => decodeURIComponent(rawBuf.toString('latin1').split('').reverse().join('')),
            // S2 — reverse raw bytes → UTF-8
            () => Buffer.from([...rawBuf].reverse()).toString('utf8'),
            // S3 — UTF-8 string → reverse chars
            () => rawBuf.toString('utf8').split('').reverse().join(''),
            // S4 — latin1 → reverse → unescape (old templates using escape())
            () => unescape(rawBuf.toString('latin1').split('').reverse().join('')),
            // S5 — plain UTF-8 decode yields a relative path (no protocol)
            //      e.g. "20240101/abcd1234/index.m3u8" → prepend okokserver domain
            () => {
              const decoded = rawBuf.toString('utf8');
              // Match a relative path: starts with path chars, has at least one slash, ends .m3u8
              const relMatch = decoded.match(/^[a-zA-Z0-9._\-]+(\/[a-zA-Z0-9._\-]+)+\.m3u8/);
              if (relMatch) return `https://p.okokserver.com/${relMatch[0]}`;
              return '';
            },
            // S6 — rescue relative m3u8 path from binary soup (reversed or plain)
            //      e.g. "2/14/name_of_show/file.m3u8" embedded in garbled bytes
            () => {
              const binary = rawBuf.toString('binary');
              const reversed = binary.split('').reverse().join('');
              // {1,} instead of {2,}: also match single-dir paths like "hash/index.m3u8"
              const relMatch = reversed.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
              if (relMatch) return `https://p.okokserver.com/${relMatch[0]}`;
              const relMatch2 = binary.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
              if (relMatch2) return `https://p.okokserver.com/${relMatch2[0]}`;
              return '';
            },
          ];

          for (const [i, fn] of strategies.entries()) {
            try {
              let candidate = fn();
              // Extract the first http:// token from the decoded string.
              // Some templates pad with "O0O0O" junk before/after the URL.
              const httpMatch = candidate.match(/https?:\/\/[^\s"'<>\\]+/);
              if (httpMatch) {
                candidate = httpMatch[0]
                  .replace(/[O0]{4,}$/, '')
                  .replace(/[^a-zA-Z0-9._\-/:?=&%+#~@!$'()*,;]+$/, '');
              }
              console.log(`[Sniffer] encrypt:3 S${i}: "${candidate.slice(0, 100)}"`);
              // STRICT check: must be a clean ASCII http URL that contains .m3u8
              // The old loose check (startsWith('http') || includes('.m3u8')) was
              // falsely matching garbage binary strings and sending them to the player.
              if (/^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/.test(candidate)) {
                streamUrl = candidate;
                console.log(`[Sniffer] encrypt:3 ✅ S${i} clean URL matched`);
                break;
              }
            } catch(_) {}
          }
        }

        // ── Step 3: Unwrap player-wrapper URLs  (?url=<encoded_m3u8>) ──────
        if (typeof streamUrl === 'string' && streamUrl.includes('url=')) {
          const m = streamUrl.match(/[?&]url=([^&]+)/);
          if (m) {
            const inner = decodeURIComponent(m[1]);
            // Only accept clean ASCII http URLs
            if (/^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/.test(inner)) streamUrl = inner;
          }
        }

        // ── Step 4: HEAD-validate before firing — prevents 404 from reaching the player ─
        if (streamUrl && /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/.test(streamUrl)) {
          sendStatus('🔎 验证流地址…');
          try {
            const headRes = await axios.head(streamUrl, {
              timeout: 6000,
              headers: { 'Referer': 'https://huavod.net/', 'User-Agent': CHROME_UA },
              maxRedirects: 5,
              httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            });
            console.log(`[Sniffer] ⚡ Fast extraction HEAD ${headRes.status}: ${streamUrl}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ipc:m3u8-found', {
                streamUrl, referer: BASE_URL + '/', userAgent: CHROME_UA,
              });
            }
            cleanupSniffer();
            return;
          } catch (headErr) {
            console.log(`[Sniffer] Fast extraction HEAD FAILED (${headErr.message}) — falling back to sniffer. url: ${streamUrl.slice(0, 80)}`);
            // fall through to sniffer window
          }
        } else {
          console.log('[Sniffer] Fast extraction: no clean m3u8 found, falling back to sniffer window. Last url:', String(streamUrl).slice(0, 80));
        }
      }

      // ── HAIL MARY: scan raw HTML for any m3u8 URL ──────────────────────────
      const rawM3u8 = html.match(/(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+(\.m3u8))/i);
      const b64M3u8 = html.match(/aHR0c[a-zA-Z0-9+/=]+/);

      const hailMaryUrl = rawM3u8?.[1] ?? (() => {
        try {
          const dec = Buffer.from(b64M3u8?.[0] ?? '', 'base64').toString('utf8');
          return dec.includes('.m3u8') ? dec : null;
        } catch(_) { return null; }
      })();

      if (hailMaryUrl) {
        sendStatus('🔎 验证 Hail-Mary 地址…');
        try {
          await axios.head(hailMaryUrl, {
            timeout: 6000,
            headers: { 'Referer': 'https://huavod.net/', 'User-Agent': CHROME_UA },
            maxRedirects: 5,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          });
          console.log('[Sniffer] ⚡ Hail-Mary m3u8 validated:', hailMaryUrl);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ipc:m3u8-found', {
              streamUrl: hailMaryUrl, referer: BASE_URL + '/', userAgent: CHROME_UA,
            });
          }
          cleanupSniffer();
          return;
        } catch (e) {
          console.log('[Sniffer] Hail-Mary HEAD failed:', e.message, '— falling back to sniffer');
        }
      }

    } catch (e) {
      console.log('[Sniffer] Fast extraction failed or skipped:', e.message);
    }
  }

  sendStatus('🔍 降级开启后台深度嗅探 (过滤广告中)…');

  // ── Hidden browser window ────────────────────────────────────────────────────
  snifferWin = new BrowserWindow({
    width: 800, height: 600,
    show: false, skipTaskbar: true,
    backgroundThrottling: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false, // MUST BE FALSE for the preload to natively override window.setTimeout
      webSecurity: false, // REQUIRED to traverse into cross-origin parse iframes
      nodeIntegrationInSubFrames: true, // Force preload into ALL nested iframes
      preload: path.join(__dirname, 'preload_sniffer.js'),
      devTools: true,
      javascript: true,
      images: true, // Need to see the page
    },
  });
  snifferWin.webContents.setAudioMuted(true);

  // ── Request interceptor ──────────────────────────────────────────────────────
  const startTime = Date.now();
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const url = details.url;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      
      // Specifically target okokserver's mp4 video ads and cleanly amputate them from the network
      if (url.includes('okokserver.com') && url.includes('.mp4')) {
        console.log(`[Sniffer Request @ ${elapsed}s] 🚫 Blocking ad media:`, url);
        callback({ cancel: true });
        return;
      }

      const isM3u8 = url.toLowerCase().includes('.m3u8') && !url.includes('api.php');

      // Only care about m3u8 URLs we haven't captured yet
      if (!capturedM3u8 && isM3u8) {
        // Filter out known ad streams (but never filter okokserver — it carries real content)
        if (isAdUrl(url) && !url.includes('okokserver')) {
          console.log(`[Sniffer] 🚫 Skipping known ad stream M3U8 at ${elapsed}s:`, url);
          callback({});
          return;
        }

        // Mark as pending to prevent duplicate captures while validation is in flight.
        // If HEAD fails we reset capturedM3u8 so the next m3u8 can be tried.
        capturedM3u8 = url;
        const candidateReferer = details.referrer || BASE_URL + '/';

        sendStatus('🔎 验证流地址…');
        console.log(`[Sniffer] 🔥 Intercepted M3U8 at ${elapsed}s, validating:`, url);

        // callback({}) is called unconditionally below — the request is allowed through
        // while we validate asynchronously in the background.
        ax.head(url, {
          timeout: 6000,
          headers: { 'Referer': 'https://huavod.net/', 'User-Agent': CHROME_UA },
          maxRedirects: 5,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        }).then(r => {
          console.log(`[Sniffer] ✅ M3U8 HEAD ${r.status}:`, url);
          capturedHeaders = { referer: candidateReferer, userAgent: CHROME_UA };
          sendStatus('✅ Stream found! Launching player…');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ipc:m3u8-found', {
              streamUrl: url,
              referer:   BASE_URL + '/',
              userAgent: CHROME_UA,
            });
          }
          if (snifferWin && !snifferWin.isDestroyed()) { snifferWin.destroy(); snifferWin = null; }
          setImmediate(() => cleanupSniffer());
        }).catch(e => {
          console.log(`[Sniffer] ❌ M3U8 HEAD failed (${e.message}) — resetting, will capture next m3u8. url: ${url.slice(0, 80)}`);
          capturedM3u8 = null; // allow the next intercepted m3u8 to be tried
        });
      }

      callback({});
    }
  );

  // ── Timeout ──────────────────────────────────────────────────────────────────
  sniffTimeoutId = setTimeout(() => {
    if (!capturedM3u8) {
      sendError('⏱️ Timeout: no stream found in 25 seconds. The source might be dead.');
      cleanupSniffer();
    }
  }, SNIFF_TIMEOUT_MS);

  // ── Navigate ─────────────────────────────────────────────────────────────────
  snifferWin.loadURL(finalUrl, { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }).catch((err) => {
    sendError(`❌ Failed to load URL: ${err.message}`);
    cleanupSniffer();
  });

  snifferWin.webContents.on('did-finish-load', () => {
    // Relying on preload_sniffer.js (injected into all frames) to handle skipping.
  });

  snifferWin.webContents.on('did-fail-load', (_e, code) => {
    if (code === 0 || sniffAborted) return;
    // Non-fatal codes (e.g. blocked resources in hidden window) are fine
    if (Math.abs(code) < 100) return;
    sendError(`❌ Page navigation failed (code ${code}).`);
    cleanupSniffer();
  });
}

// ─── IPC Helpers ───────────────────────────────────────────────────────────────
function sendStatus(msg) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('ipc:status', msg);
}
function sendError(msg) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('ipc:sniff-error', msg);
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Sniffer
ipcMain.on('ipc:sniff-url', (_event, url) => {
  if (!url || typeof url !== 'string') { sendError('❌ Invalid URL.'); return; }
  startSniffing(url);
});

ipcMain.on('ipc:stop-sniff', () => {
  cleanupSniffer();
});

// Catalog: fetch a category page
ipcMain.handle('ipc:scrape-category', async (_event, { catId, page, area = '', year = '' }) => {
  try {
    return await scrapeCategory(catId, page, area, year);
  } catch (err) {
    console.error('[Scrape] category error:', err.message);
    return { items: [], hasMore: false, error: err.message };
  }
});

// Search
ipcMain.handle('ipc:scrape-search', async (_event, { keyword, page }) => {
  try {
    return await scrapeSearch(keyword, page);
  } catch (err) {
    console.error('[Scrape] search error:', err.message);
    return { items: [], hasMore: false, error: err.message };
  }
});

// Detail: fetch episode list (multi-source anthology structure)
async function getDetail(targetUrl) {
  if (remoteLogic?.getDetail) return remoteLogic.getDetail(targetUrl);

  const { data: html } = await ax.get(targetUrl);
  const $ = cheerio.load(html);

  // huavod.net uses an "anthology" structure:
  //   .anthology-tab .swiper-wrapper a.swiper-slide  → source name tabs (each has an <i> icon)
  //   .anthology-list .anthology-list-box            → corresponding episode lists (1-to-1 with tabs)
  const sources = [];
  const tabEls    = $('.anthology-tab .swiper-wrapper a.swiper-slide');
  const listBoxes = $('.anthology-list .anthology-list-box');

  if (tabEls.length > 0) {
    tabEls.each((i, tabEl) => {
      // Strip the <i> icon child to get the plain source name
      const name = $(tabEl).clone().children('i').remove().end().text().trim()
                   || `线路${i + 1}`;
      const episodes = [];
      listBoxes.eq(i).find('a[href*="/vodplay/"]').each((j, aEl) => {
        const rawHref = $(aEl).attr('href') || '';
        const href    = rawHref.startsWith('http') ? rawHref : BASE_URL + rawHref;
        const title   = $(aEl).text().trim() || `${j + 1}`;
        episodes.push({ title, url: href });
      });
      if (episodes.length > 0) sources.push({ name, episodes });
    });
  }

  // Broad fallback: collect all /vodplay/ links as one source
  if (sources.length === 0) {
    const episodes = [];
    $('a[href*="/vodplay/"]').each((i, el) => {
      const rawHref = $(el).attr('href') || '';
      const href    = rawHref.startsWith('http') ? rawHref : BASE_URL + rawHref;
      const title   = $(el).text().trim() || `${i + 1}`;
      if (title.length < 30) episodes.push({ title, url: href });
    });
    const seen = new Set();
    const deduped = episodes.filter(ep => {
      if (seen.has(ep.url)) return false;
      seen.add(ep.url); return true;
    });
    if (deduped.length > 0) sources.push({ name: '默认线路', episodes: deduped });
  }

  console.log(`[Detail] ${sources.length} source(s):`,
    sources.map(s => `${s.name}(${s.episodes.length}ep)`).join(', '));
  return { sources };
}

ipcMain.handle('ipc:get-detail', async (_event, targetUrl) => {
  try {
    return await getDetail(targetUrl);
  } catch (err) {
    console.error('[Detail] Error:', err.message);
    return { sources: [], error: err.message };
  }
});

// Window controls
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win:close', () => { cleanupSniffer(); mainWindow?.close(); });
ipcMain.on('updater:restart', () => autoUpdater?.quitAndInstall());

// ─── Auto-Updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update',  () => console.log('[Updater] Checking…'));
  autoUpdater.on('update-not-available', () => console.log('[Updater] Up to date.'));
  autoUpdater.on('error', err           => console.error('[Updater] Error:', err.message));

  autoUpdater.on('update-available', info => {
    console.log('[Updater] Update available:', info.version);
    mainWindow?.webContents.send('updater:available', { version: info.version });
  });
  autoUpdater.on('download-progress', prog => {
    mainWindow?.webContents.send('updater:progress', { percent: Math.round(prog.percent || 0) });
  });
  autoUpdater.on('update-downloaded', info => {
    console.log('[Updater] Downloaded:', info.version);
    mainWindow?.webContents.send('updater:downloaded', { version: info.version });
  });

  // Delay first check so the main window finishes loading first
  setTimeout(() => autoUpdater.checkForUpdates().catch(e => console.warn('[Updater]', e.message)), 5000);
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  registerPermanentRefererSpoofer();
  registerImageProxy();
  createMainWindow();

  // Load remote site-parsing logic; built-in logic is used until it resolves
  loadRemoteLogic().catch(e => console.warn('[RemoteLogic]', e.message));

  // Auto-updater only works in a packaged build
  if (app.isPackaged) setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  cleanupSniffer();
  if (process.platform !== 'darwin') app.quit();
});
