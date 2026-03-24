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
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,PlatformHEVCDecoding');
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');

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
const REMOTE_LOGIC_URL = null; // 'https://raw.githubusercontent.com/xian1010/Pure-Video-Player/refs/heads/main/remote-logic.js';

let remoteLogic = null;

async function loadRemoteLogic() {
  if (!REMOTE_LOGIC_URL) {
    console.log('[RemoteLogic] URL is null, skipping remote logic for local development.');
    return;
  }
  
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
  responseType: 'arraybuffer',
  headers: {
    'User-Agent': CHROME_UA,
    'Referer':    BASE_URL + '/',
    'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
});

ax.interceptors.response.use(response => {
  if (response.data && (response.data instanceof Buffer || response.data instanceof ArrayBuffer)) {
    response.data = new TextDecoder('utf-8').decode(response.data);
  }
  return response;
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
  // Skip items inside .swiper-wrapper (featured carousel) — those are not filter-aware
  $('div.public-list-box, li.public-list-box').each((_i, el) => {
    const $el = $(el);
    if ($el.closest('.swiper-wrapper').length) return; // carousel item, skip

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

  if (items.length === 0) {
    console.warn('[Scraper] Warning: No items parsed from this URL!');
  }

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
async function scrapeCategory(catId, page = 1, area = '', year = '') {
  if (remoteLogic?.scrapeCategory) return remoteLogic.scrapeCategory(catId, page, area, year);

  let path = `/vodshow/${catId}`;
  if (area && area !== '全部') path += `/area/${encodeURIComponent(area)}`;
  if (year && year !== '全部') path += `/year/${year}`;
  path += page > 1 ? `/${page}.html` : '.html';

  console.log('[Scraper] Requesting URL:', BASE_URL + path);
  
  let html = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await ax.get(path, { timeout: 15000 });
      html = data;
      break;
    } catch (err) {
      if (attempt === 3) {
        console.error(`[Scrape] Category error after 3 attempts: ${err.message}`);
        throw new Error('目标网站响应缓慢，请稍后再试');
      }
      console.log(`[Scrape] Category 502/Error on ${path}, retrying (${attempt}/3)...`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }

  console.log(`[Scrape] Fetched ${path}, length: ${html?.length}`);
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
  let url = `/index.php/ajax/suggest?mid=1&wd=${encoded}&pg=${page}`;
  
  console.log('Final Search URL:', BASE_URL + url);
  
  let json = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Forcing a fresh User-Agent every request if needed, but it's already in ax defaults
      const { data } = await ax.get(url, { timeout: 15000 });
      // IMPORTANT FIX: Because of TextDecoder in interceptor, data might be a JSON string!
      json = typeof data === 'string' ? JSON.parse(data) : data;
      break;
    } catch (err) {
      if (attempt === 3) {
        console.error(`[Search] Error after 3 attempts: ${err.message}`);
        throw new Error('目标网站响应缓慢，请稍后再试');
      }
      console.log(`[Search] 502/Error, retrying (${attempt}/3)...`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }

  if (!json || json.code !== 1 || !Array.isArray(json.list)) {
    console.warn('[Search] Unexpected response:', JSON.stringify(json || '').slice(0, 200));
    throw new Error('目标网站响应缓慢或无结果，请稍后再试');
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
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      autoplayPolicy: 'no-user-gesture-required',
      hardwareAcceleration: true,
    },
  });

  // mainWindow.webContents.openDevTools();

  // Allow manual toggling of DevTools using Ctrl+Shift+I
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
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
        timeout: 3000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });
      return new Response(resp.data, {
        status: 200,
        headers: { 'Content-Type': resp.headers['content-type'] || 'image/jpeg' }
      });
    } catch (e) {
      return Response.redirect(realUrl, 302);
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

// ─── Preload Cache (background sniff of next episode) ─────────────────────────
const preloadCache = new Map(); // vodplayUrl → m3u8Url | 'pending'
let preloadWin = null;
let preloadSessionObj = null; // Dedicated session so its onBeforeRequest never clashes with defaultSession

function stopPreload() {
  if (preloadWin && !preloadWin.isDestroyed()) {
    try { preloadWin.destroy(); } catch (_) {}
    preloadWin = null;
  }
  if (preloadSessionObj) {
    try { preloadSessionObj.webRequest.onBeforeRequest(null, null); } catch (_) {}
  }
}

function initPreloadSession() {
  if (preloadSessionObj) return;
  preloadSessionObj = session.fromPartition('preload', { cache: false });
  // Spoof headers for the preload session, same as permanent spoofer on defaultSession
  preloadSessionObj.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const headers = { ...details.requestHeaders };
    headers['Referer']    = 'https://huavod.net/';
    headers['Origin']     = 'https://huavod.net';
    headers['User-Agent'] = CHROME_UA;
    cb({ requestHeaders: headers });
  });
}

function startPreload(vodplayUrl) {
  if (preloadCache.has(vodplayUrl)) return; // Already cached or in-progress
  if (snifferWin) return;                   // Main sniffer is active, skip
  preloadCache.set(vodplayUrl, 'pending');
  stopPreload();
  initPreloadSession();

  let finalUrl = vodplayUrl;
  if (vodplayUrl.includes('/voddetail/')) {
    finalUrl = vodplayUrl.replace('/voddetail/', '/vodplay/').replace('.html', '-1-1.html');
  }
  if (!finalUrl.startsWith('http')) finalUrl = BASE_URL + finalUrl;
  console.log('[Preload] 🔄 Starting background preload:', finalUrl);

  preloadWin = new BrowserWindow({
    show: false, skipTaskbar: true, focusable: false,
    backgroundThrottling: true,
    webPreferences: {
      session: preloadSessionObj,
      nodeIntegration: false,
      contextIsolation: false,
      webSecurity: false,
      nodeIntegrationInSubFrames: true,
      preload: path.join(__dirname, 'preload_sniffer.js'),
      devTools: false,
      javascript: true,
      autoplayPolicy: 'user-gesture-required',
    },
  });
  preloadWin.webContents.setAudioMuted(true);

  preloadSessionObj.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = details.url;
    const blockTypes = ['image', 'stylesheet', 'font', 'media', 'ping'];
    if (blockTypes.includes(details.resourceType)) { callback({ cancel: true }); return; }
    if (url.includes('okokserver.com') && url.includes('.mp4')) { callback({ cancel: true }); return; }

    const isM3u8 = url.toLowerCase().includes('.m3u8') && !url.includes('api.php');
    if (isM3u8 && !(isAdUrl(url) && !url.includes('okokserver'))) {
      if (preloadCache.get(vodplayUrl) === 'pending') {
        preloadCache.set(vodplayUrl, url);
        console.log('[Preload] ✅ Cached m3u8 for next episode:', url);
        try { preloadSessionObj.webRequest.onBeforeRequest(null, null); } catch (_) {}
        if (preloadWin && !preloadWin.isDestroyed()) { preloadWin.destroy(); preloadWin = null; }
      }
    }
    callback({});
  });

  // Give up after 25s to avoid orphaned windows
  setTimeout(() => {
    if (preloadCache.get(vodplayUrl) === 'pending') preloadCache.delete(vodplayUrl);
    if (preloadWin && !preloadWin.isDestroyed()) { preloadWin.destroy(); preloadWin = null; }
    try { preloadSessionObj.webRequest.onBeforeRequest(null, null); } catch (_) {}
  }, 25000);

  preloadWin.loadURL(finalUrl, { userAgent: CHROME_UA }).catch(() => {});
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

  // Bypass CORS for all media requests (especially HLS segments and m3u8)
  // since mainWindow operates from file:// and some CDNs don't send ACAO headers.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['<all_urls>'] },
    (details, cb) => {
      const respHeaders = { ...details.responseHeaders };
      respHeaders['Access-Control-Allow-Origin'] = ['*'];
      respHeaders['Access-Control-Allow-Headers'] = ['*'];
      cb({ responseHeaders: respHeaders });
    }
  );
}

/**
 * Start sniffing targetUrl for its real (non-ad) m3u8 stream.
 */
async function startSniffing(targetUrl, sourceName = '') {
  if (snifferWin) {
    try { snifferWin.destroy(); } catch (_) {}
    snifferWin = null;
  }
  cleanupSniffer();
  sniffAborted = false;

  let finalUrl = targetUrl;
  if (targetUrl.includes('/voddetail/')) {
    sendStatus('🔍 直接跨越进入播放页…');
    finalUrl = targetUrl.replace('/voddetail/', '/vodplay/').replace('.html', '-1-1.html');
    if (!finalUrl.startsWith('http')) finalUrl = BASE_URL + finalUrl;
  }

  sendStatus('🚀 并行启动深度嗅探引擎与快速提取…');

  // ── Check preload cache (next-episode pre-sniff) ──
  stopPreload(); // Always stop preload window before starting main sniff (avoids session.onBeforeRequest conflict)
  const preloadHit = preloadCache.get(finalUrl);
  if (preloadHit && preloadHit !== 'pending') {
    preloadCache.delete(finalUrl);
    console.log('[Preload] 🎯 Cache hit — instant playback:', preloadHit);
    sendStatus('⚡ 下一集已就绪，立即播放…');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ipc:m3u8-found', { streamUrl: preloadHit, referer: BASE_URL + '/', userAgent: CHROME_UA });
    }
    return;
  }
  preloadCache.delete(finalUrl); // Drop any stale 'pending' marker for this URL

  // 1. 立即启动后台深度嗅探窗口 (Parallel Background Sniffer)
  snifferWin = new BrowserWindow({
    width: 800, height: 600,
    show: false, skipTaskbar: true, focusable: false,
    backgroundThrottling: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false, // MUST BE FALSE for the preload to natively override window.setTimeout
      webSecurity: false, // REQUIRED to traverse into cross-origin parse iframes
      nodeIntegrationInSubFrames: true, // Force preload into ALL nested iframes
      preload: path.join(__dirname, 'preload_sniffer.js'),
      devTools: false,
      javascript: true,
      images: true, // Need to see the page
      autoplayPolicy: 'user-gesture-required', // 预防后台静默播放声音
    },
  });
  snifferWin.webContents.setAudioMuted(true);

  // ── Request interceptor ──
  const startTime = Date.now();
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const url = details.url;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      
      // 拦截无关资源加速窗口加载
      const blockTypes = ['image', 'stylesheet', 'font', 'media', 'ping'];
      if (blockTypes.includes(details.resourceType) && !url.toLowerCase().includes('.m3u8')) {
        callback({ cancel: true });
        return;
      }
      
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

        capturedM3u8 = url;
        const referer = details.referrer || BASE_URL + '/';
        console.log(`[Sniffer] ⚡ Intercepted M3U8 at ${elapsed}s — sending immediately:`, url);
        sendStatus('✅ Stream captured! Launching player…');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ipc:m3u8-found', {
            streamUrl: url,
            referer,
            userAgent: CHROME_UA,
          });
        }
        if (snifferWin && !snifferWin.isDestroyed()) { snifferWin.destroy(); snifferWin = null; }
        setImmediate(() => cleanupSniffer());

        callback({});
        return;
      }
      callback({});
    }
  );

  // ── Timeout ──
  sniffTimeoutId = setTimeout(() => {
    if (!capturedM3u8) {
      sendError('⏱️ Timeout: no stream found in 25 seconds. The source might be dead.');
      cleanupSniffer();
    }
  }, 25000);

  // ── Navigate ──
  snifferWin.loadURL(finalUrl, { userAgent: CHROME_UA }).catch((err) => {
    // 忽略因为提前终止 (例如已经成功捕捉到 m3u8 并销毁窗口) 导致的错误
    if (err.message.includes('ERR_ABORTED')) return;
    if (capturedM3u8) return;
    
    sendError(`❌ Failed to load URL: ${err.message}`);
    cleanupSniffer();
  });

  snifferWin.webContents.on('did-finish-load', () => {});

  snifferWin.webContents.on('did-fail-load', (_e, code, desc, validatedUrl, isMainFrame) => {
    if (code === 0 || sniffAborted || capturedM3u8) return;
    // Non-fatal codes (e.g. blocked resources in hidden window) are fine
    if (Math.abs(code) < 100) return;
    // 忽略 iframe 或其它子框架的加载失败，只关心主框架
    if (!isMainFrame) return;

    sendError(`❌ Page navigation failed (code ${code}).`);
    cleanupSniffer();
  });

  // 2. 并行快速提取 (Fast Extraction — 无 HEAD 验证，直接信任解出的 URL)
  const is4K = (sourceName || '').toUpperCase().includes('4K');
  if (finalUrl.includes('/vodplay/') && !is4K) {
    try {
      const { data: html } = await ax.get(finalUrl);

      let streamUrl = null;
      let encrypt   = 0;

      const blockMatch = html.match(/mac_player_info\s*=\s*(\{[^\r\n]+\})/);
      if (blockMatch) {
        try {
          const info = JSON.parse(blockMatch[1]);
          if (info.url) { streamUrl = info.url; encrypt = parseInt(info.encrypt) || 0; }
        } catch(_) {
          const um = blockMatch[1].match(/"url"\s*:\s*"([^"]+)"/);
          const em = blockMatch[1].match(/"encrypt"\s*:\s*(\d+)/);
          if (um) streamUrl = um[1];
          if (em) encrypt   = parseInt(em[1]);
        }
      }
      if (!streamUrl) {
        const um = html.match(/"url"\s*:\s*"([^"]+)"/);
        const em = html.match(/"encrypt"\s*:\s*(\d+)/);
        if (um) streamUrl = um[1];
        if (em) encrypt   = parseInt(em[1]);
      }

      if (streamUrl) {
        streamUrl = streamUrl.replace(/\\\//g, '/');
        if (encrypt === 1) {
          streamUrl = decodeURIComponent(streamUrl);
        } else if (encrypt === 2) {
          streamUrl = decodeURIComponent(escape(Buffer.from(streamUrl, 'base64').toString('binary')));
        } else if (encrypt === 3 && !streamUrl.startsWith('http')) {
          const b64 = streamUrl.replace(/-/g, '+').replace(/_/g, '/');
          const rawBuf = Buffer.from(b64, 'base64');
          const strategies = [
            () => rawBuf.toString('utf8'),
            () => decodeURIComponent(rawBuf.toString('latin1').split('').reverse().join('')),
            () => Buffer.from([...rawBuf].reverse()).toString('utf8'),
            () => rawBuf.toString('utf8').split('').reverse().join(''),
            () => unescape(rawBuf.toString('latin1').split('').reverse().join('')),
            () => {
              const relMatch = rawBuf.toString('utf8').match(/^[a-zA-Z0-9._\-]+(\/[a-zA-Z0-9._\-]+)+\.m3u8/);
              if (relMatch) return `https://p.okokserver.com/${relMatch[0]}`; return '';
            },
            () => {
              const binary = rawBuf.toString('binary');
              const reversed = binary.split('').reverse().join('');
              let relMatch = reversed.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
              if (relMatch) return `https://p.okokserver.com/${relMatch[0]}`;
              relMatch = binary.match(/([a-zA-Z0-9_\-]+\/){1,}[a-zA-Z0-9._\-]+\.m3u8/);
              if (relMatch) return `https://p.okokserver.com/${relMatch[0]}`;
              return '';
            }
          ];
          for (const [i, fn] of strategies.entries()) {
            try {
              let candidate = fn();
              const httpMatch = candidate.match(/https?:\/\/[^\s"'<>\\]+/);
              if (httpMatch) {
                candidate = httpMatch[0].replace(/[O0]{4,}$/, '').replace(/[^a-zA-Z0-9._\-/:?=&%+#~@!$'()*,;]+$/, '');
              }
              if (/^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/.test(candidate)) {
                streamUrl = candidate; break;
              }
            } catch(_) {}
          }
        }
        if (typeof streamUrl === 'string' && streamUrl.includes('url=')) {
          const m = streamUrl.match(/[?&]url=([^&]+)/);
          if (m) {
            const inner = decodeURIComponent(m[1]);
            if (/^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/.test(inner)) streamUrl = inner;
          }
        }
      }

      const rawM3u8 = html.match(/(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+(\.m3u8))/i);
      const b64M3u8 = html.match(/aHR0c[a-zA-Z0-9+/=]+/);
      const hailMaryUrl = rawM3u8?.[1] ?? (() => {
        try {
          const dec = Buffer.from(b64M3u8?.[0] ?? '', 'base64').toString('utf8');
          return dec.includes('.m3u8') ? dec : null;
        } catch(_) { return null; }
      })();

      let candidateUrl = null;
      if (streamUrl && /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/.test(streamUrl)) {
        candidateUrl = streamUrl;
      } else if (hailMaryUrl) {
        candidateUrl = hailMaryUrl;
      }

      // 直接信任通过正则验证的 URL，不做 HEAD 验证（HEAD 会耗时 800ms~4s）
      if (candidateUrl && !capturedM3u8) {
        capturedM3u8 = candidateUrl;
        console.log(`[Sniffer] ⚡ Fast extraction sending immediately: ${candidateUrl}`);
        sendStatus('✅ Stream extracted! Launching player…');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ipc:m3u8-found', { streamUrl: candidateUrl, referer: BASE_URL+'/', userAgent: CHROME_UA });
        }
        cleanupSniffer();
      }

    } catch (e) {
      console.log('[Sniffer] Fast extraction failed or skipped:', e.message);
    }
  } else if (is4K) {
    console.log(`[Sniffer] 🚫 Fast Extraction disabled specifically for 4K source (${sourceName}).`);
  }
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
ipcMain.on('ipc:sniff-url', (_event, url, sourceName) => {
  if (!url || typeof url !== 'string') { sendError('❌ Invalid URL.'); return; }
  startSniffing(url, sourceName);
});

ipcMain.on('ipc:stop-sniff', () => {
  stopPreload();
  cleanupSniffer();
});

ipcMain.on('stop-sniffing', () => {
  stopPreload();
  cleanupSniffer();
});

ipcMain.on('ipc:preload-next', (_event, url) => {
  if (url && typeof url === 'string') startPreload(url);
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

// ─── Dynamic filter options ────────────────────────────────────────────────────
async function fetchFilterOptions(catId) {
  try {
    const { data: html } = await ax.get(`/vodshow/${catId}.html`, { timeout: 10000 });
    const $ = cheerio.load(html);

    const areas = [];
    const years = [];
    const seenAreas = new Set();
    const seenYears = new Set();

    $('a[href*="/area/"]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/area\/([^./]+)/);
      if (!m) return;
      let val;
      try { val = decodeURIComponent(m[1]); } catch { val = m[1]; }
      if (val && !seenAreas.has(val)) { seenAreas.add(val); areas.push(val); }
    });

    $('a[href*="/year/"]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/year\/(\d{4})/);
      if (!m) return;
      const val = m[1];
      if (!seenYears.has(val)) { seenYears.add(val); years.push(val); }
    });

    years.sort((a, b) => Number(b) - Number(a)); // newest first
    console.log(`[FilterOptions] cat=${catId} areas=${areas.length} years=${years.length}`);
    return { areas, years };
  } catch (err) {
    console.error('[FilterOptions] error:', err.message);
    return { areas: [], years: [] };
  }
}

ipcMain.handle('ipc:fetch-filter-options', async (_event, catId) => {
  return fetchFilterOptions(catId);
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

// ─── Playback History ──────────────────────────────────────────────────────────
const HISTORY_FILE = path.join(app.getPath('userData'), 'pvp_history.json');

function readHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[History] Read error:', err.message);
  }
  return {};
}

function writeHistory(data) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.error('[History] Write error:', err.message);
  }
}

ipcMain.handle('ipc:get-history', async (_event, vodID) => {
  const history = readHistory();
  return history[vodID] || null;
});

ipcMain.on('ipc:save-history', (_event, record) => {
  if (!record || !record.vodID) return;
  const history = readHistory();
  history[record.vodID] = {
    episodeIndex: record.episodeIndex,
    currentTime: record.currentTime,
    updatedAt: Date.now()
  };
  writeHistory(history);
});

// ─── Auto-Updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update',  () => console.log('[Updater] Checking…'));
  autoUpdater.on('update-not-available', () => console.log('[Updater] Up to date.'));
  autoUpdater.on('error', err => {
    console.error('[Updater] Error:', err.message);
    mainWindow?.webContents.send('updater:error', err.message);
  });

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
  initPreloadSession(); // Initialise preload session early so it's ready when needed
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
