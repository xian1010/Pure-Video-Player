'use strict';

console.log('[Main] Starting PureVideoPlayer for xiaobaotv.tv...');
console.log('[Main] Architecture: simple axios fetch, sniffer window for m3u8.');

// ─── Electron modules ─────────────────────────────────────────────────────────
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  protocol,
} = require('electron');

app.commandLine.appendSwitch('ignore-certificate-errors', 'true');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,PlatformHEVCDecoding');
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');

const path  = require('path');
const axios  = require('axios');
const https  = require('https');
const fs     = require('fs');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}

// ─── Constants ───────────────────────────────────────────────────────────────
const SHARED_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/122.0.0.0 Safari/537.36';
const GLOBAL_UA = SHARED_UA;
const BASE_URL  = 'https://www.xiaobaotv.tv';

// ─── Global state ───────────────────────────────────────────────────────────
let mainWindow = null;
let snifferWin     = null;
let snifferSession = null;
let sniffTimeoutId  = null;
let capturedM3u8   = null;
// m3u8FoundFlag：流已捕获的永久标记，cleanupSniffer 不会清除它
let m3u8FoundFlag  = false;
let sniffAborted   = false;

// ─── Helpers ────────────────────────────────────────────────────────────────
function mlog() {
  var args = Array.prototype.slice.call(arguments);
  console.log('[Main] ' + args.join(' '));
}

function sendStatus(msg) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('ipc:status', msg);
}

function sendError(msg) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('ipc:sniff-error', msg);
}

// ─── Image Proxy ────────────────────────────────────────────────────────────
// Proxies image requests so we can add Referer/UA headers for xiaobaotv.tv.
function registerImageProxy() {
  protocol.handle('imgproxy', async function(request) {
    var encoded = request.url.replace(/^imgproxy:\/\//, '');
    var realUrl;
    try { realUrl = decodeURIComponent(encoded); }
    catch { return new Response('Bad URL', { status: 400 }); }
    if (realUrl.startsWith('//'))     realUrl = 'https:' + realUrl;
    else if (realUrl.startsWith('/')) realUrl = BASE_URL + realUrl;
    try {
      var resp = await axios.get(realUrl, {
        responseType: 'arraybuffer',
        headers: {
          'Referer':   BASE_URL + '/',
          'User-Agent': SHARED_UA,
          'Accept':    'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        timeout: 10000,
      });
      var ct = resp.headers['content-type'] || 'image/jpeg';
      return new Response(resp.data, { status: 200, headers: { 'Content-Type': ct } });
    } catch (_) {
      return new Response('Image fetch failed', { status: 502 });
    }
  });
}

// ─── Sniffer ───────────────────────────────────────────────────────────────
function cleanupSniffer() {
  if (sniffTimeoutId) { clearTimeout(sniffTimeoutId); sniffTimeoutId = null; }
  if (snifferSession) {
    try { snifferSession.webRequest.onBeforeRequest(null, null); } catch (_) {}
    snifferSession = null;
  }
  if (snifferWin && !snifferWin.isDestroyed()) { snifferWin.destroy(); snifferWin = null; }
  capturedM3u8  = null;
  sniffAborted = false;
  // 注意：不清除 m3u8FoundFlag — 它在整个生命周期内永久标记"流已找到"
}

function stopPreload() {}

function startPreload() {}

// ── Ad blocking helpers ────────────────────────────────────────────────────
function isAdUrl(url) {
  if (!url) return false;
  var AD_DENYLIST = [
    // 通用广告平台
    'googleads', 'doubleclick', 'baidustatic', 'aliyuncdn',
    'staticfile', 'mobclix', 'admob', 'adsense', 'adcolony',
    // 国内常见广告域名
    'union', 'stats', 'analytics', 'tongji', 'taobao', 'alibaba',
    'sinaimg', 'weibo', 'tencent', 'qq.com', 'bdstatic',
    'cnzz', '51.la', 'click', 'clicki', 'bdjzs',
    // 视频/内容站弹窗常见
    'miaozhen', 'rtbasia', 'iasacpsi', 'adsrvr', 'exelator',
    'taboola', 'outbrain', 'criteo', 'mgid', 'revcontent',
    // xiaobaotv.tv 常见广告
    'ads.xiaobaotv', 'gg.xiaobaotv', 'ad.xiaobaotv',
    'popup', 'float', 'modal', 'overlay',
    // 追踪/埋点
    'hm.baidu.com', 'sdk', 'bce', 'bos', 'log',
    'wma', 'push', 'pushwoosh', 'jpush', 'getui',
    // 其他危险域名
    'coinhive', 'cryptoloot', 'popup', 'landing',
  ];
  return AD_DENYLIST.some(function(d) { return url.toLowerCase().indexOf(d) !== -1; });
}

// ── Extract m3u8 URL from mac_player_info block in HTML ──────────────────
function extractStreamInfo(html) {
  var streamUrl = null, encrypt = 0;
  // mac_player_info = {...} JSON block
  var blockMatch = html.match(/mac_player_info\s*=\s*(\{[^;]+\})/);
  if (blockMatch) {
    try {
      var raw = blockMatch[1];
      // Unescape unicode sequences (\uXXXX)
      raw = raw.replace(/\\u([0-9a-fA-F]{4})/g, function(_, code) {
        return String.fromCharCode(parseInt(code, 16));
      });
      var info = JSON.parse(raw);
      if (info.url) {
        streamUrl = info.url;
        encrypt = parseInt(info.encrypt) || 0;
      }
    } catch (_) {}
  }
  return { streamUrl: streamUrl, encrypt: encrypt };
}

// Decrypt stream URL per encrypt mode
function decryptUrl(raw, encrypt) {
  if (!raw) return null;
  var url = raw;
  if      (encrypt === 1) url = decodeURIComponent(url);
  else if (encrypt === 2) url = decodeURIComponent(escape(Buffer.from(url, 'base64').toString('binary')));
  else if (encrypt === 3 && !/^https?:\/\//.test(url)) {
    try { url = Buffer.from(url, 'base64').toString('utf8'); } catch (_) {}
  }
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// tmplayer "剥壳"：tmplayer 链接是外壳，真实 m3u8 在 url= 参数里
// 例如: https://xxx.tmplayer.cn/xxx?url=https%3A%2F%2Fcdn.xxx.com%2Fstream.m3u8
// 返回解密后的真实 m3u8 URL，或 null
// ─────────────────────────────────────────────────────────────────────────────
function extractM3u8FromTmplayer(url) {
  try {
    // 如果 URL 里已经有 .m3u8（并以引号结尾），清理后返回
    if (url.toLowerCase().indexOf('.m3u8') !== -1) {
      var clean = url.replace(/\\\//g, '/').replace(/"[^"]*$/, '').trim();
      if (/^https?:\/\//.test(clean) && clean.toLowerCase().indexOf('.m3u8') !== -1) {
        return clean;
      }
    }
    // 查找 url= 参数（单次解码）
    var urlParamMatch = url.match(/[?&]url=([^&]+)/);
    if (!urlParamMatch) return null;
    var inner1 = decodeURIComponent(urlParamMatch[1]);
    // 清理尾随引号
    inner1 = inner1.replace(/\\\//g, '/').replace(/"[^"]*$/, '').trim();
    if (inner1.toLowerCase().indexOf('.m3u8') !== -1 && /^https?:\/\//.test(inner1)) {
      mlog('[Sniffer] tmplayer shell peeled (1x decode):', inner1.substring(0, 100));
      return inner1;
    }
    // 尝试双重解码（以防双重编码）
    var inner2 = '';
    try { inner2 = decodeURIComponent(inner1); } catch(e) {}
    inner2 = inner2.replace(/\\\//g, '/').replace(/"[^"]*$/, '').trim();
    if (inner2.toLowerCase().indexOf('.m3u8') !== -1 && /^https?:\/\//.test(inner2)) {
      mlog('[Sniffer] tmplayer shell peeled (2x decode):', inner2.substring(0, 100));
      return inner2;
    }
    return null;
  } catch(e) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 发射 m3u8 给播放器（统一入口）
// ─────────────────────────────────────────────────────────────────────────────
function fireM3u8(streamUrl, referer) {
  if (!streamUrl || capturedM3u8) return;
  capturedM3u8 = streamUrl;
  m3u8FoundFlag = true; // 永久标记，cleanupSniffer 不会清除它
  console.log('[Sniffer] >>> M3U8 FOUND:', streamUrl.substring(0, 120));
  sendStatus('Stream found!');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ipc:m3u8-found', {
      streamUrl: streamUrl,
      referer: referer || BASE_URL + '/',
      userAgent: GLOBAL_UA,
    });
  }
  cleanupSniffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// 快速提取：直接从播放页 HTML 里找真实 m3u8 URL
// xiaobaotv.tv 使用 player = {...} 块（非 mac_player_info）
// HTML 中的格式: "url":"https:\/\/vip.dytt-tvs.com\/...\/index.m3u8","url_next":
// 验证：vip.dytt-tvs.com 不需要 Referer，HTTP 200 + #EXTM3U 全部通过
// ─────────────────────────────────────────────────────────────────────────────
function fastExtract(html) {
  // ── 方法A：直接扫描 .m3u8 URL（验证成功的算法）─────────────────────────
  // 在 HTML 中找 .m3u8，往前找到 https:\/\/ 或 https://，提取到 .m3u8 结尾
  var idx = 0;
  while ((idx = html.indexOf('.m3u8', idx)) !== -1) {
    // 往前最多 300 字符的窗口
    var windowStart = Math.max(0, idx - 300);
    var windowText = html.substring(windowStart, idx + 6);

    // 找到 URL 前缀（支持双重编码的斜杠）
    var prefixes = ['https:\\/\\/', 'https://', 'http:\\/\\/', 'http://'];
    var foundPrefix = null;
    var prefixStart = -1;
    for (var pi = 0; pi < prefixes.length; pi++) {
      var p = windowText.lastIndexOf(prefixes[pi]);
      if (p !== -1 && (prefixStart === -1 || p < prefixStart)) {
        prefixStart = p;
        foundPrefix = prefixes[pi];
      }
    }

    if (foundPrefix !== null) {
      var urlStart = windowStart + prefixStart;
      // 提取从前缀到 .m3u8 结尾，然后去掉末尾引号和空白
      var raw = html.substring(urlStart, idx + 6);
      // 清理：\/ → /，去掉尾随引号
      var clean = raw.replace(/\\\//g, '/').replace(/"[^"]*$/, '').trim();
      if (/^https?:\/\//.test(clean) && clean.toLowerCase().indexOf('.m3u8') !== -1) {
        mlog('[Sniffer] fastExtract: ✅ 找到 m3u8:', clean.substring(0, 100));
        return clean;
      }
    }
    idx += 6;
  }

  // ── 方法B：直接扫描 player = {...} JSON 块（备用）────────────────────────
  // xiaobaotv.tv 用的是 player = {...} 而不是 mac_player_info
  var playerMatch = html.match(/player\s*=\s*(\{[\s\S]{50,5000})/);
  if (playerMatch) {
    try {
      var rawBlock = playerMatch[1];
      // 处理转义
      var json = rawBlock
        .replace(/\\\//g, '/')
        .replace(/\\u([0-9a-fA-F]{4})/g, function(_, code) {
          return String.fromCharCode(parseInt(code, 16));
        });
      var info = JSON.parse(json);
      if (info.url) {
        var url = info.url.trim();
        if (/^https?:\/\//.test(url) && url.toLowerCase().indexOf('.m3u8') !== -1) {
          mlog('[Sniffer] fastExtract: ✅ player JSON m3u8:', url.substring(0, 100));
          return url;
        }
      }
    } catch(e) {
      mlog('[Sniffer] fastExtract: player JSON 解析失败:', e.message);
    }
  }

  // ── 方法C：tmplayer 剥壳（保留，作为第三道防线）────────────────────────
  var tmMatches = html.match(/https?:\/\/[^\s"'<>]*tmplayer[^\s"'<>]*/gi) || [];
  for (var i = 0; i < tmMatches.length; i++) {
    var inner = extractM3u8FromTmplayer(tmMatches[i]);
    if (inner) {
      mlog('[Sniffer] fastExtract: ✅ tmplayer 剥壳:', inner.substring(0, 100));
      return inner;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主嗅探函数
// ─────────────────────────────────────────────────────────────────────────────
async function startSniffing(vodplayUrl) {
  cleanupSniffer();
  capturedM3u8 = null;
  m3u8FoundFlag = false; // 重置永久标记，新嗅探周期开始
  sniffAborted = false;

  mlog('[Sniffer] Starting for URL:', vodplayUrl);

  snifferSession = session.fromPartition('sniffer:' + Date.now());
  snifferWin = new BrowserWindow({
    width: 480, height: 360, show: false,
    webPreferences: {
      session:         snifferSession,
      preload:         path.join(__dirname, 'preload_sniffer.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
      autoplayPolicy: 'user-gesture-required',
    },
  });

  // 物理禁用所有弹窗
  snifferWin.webContents.setWindowOpenHandler(function() { return { action: 'deny' }; });
  snifferWin.webContents.setAudioMuted(true);

  // ── Fix 2: Referer 防盗链注入（sniffer session）───────────────────────────
  snifferSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, function(details, callback) {
    var reqUrl = details.url || '';
    var uLower = reqUrl.toLowerCase();
    // Fix 2: 追加 dytt-tvs.com 到白名单
    var cdnHosts = [
      'dytt-network.com', 'dytt-tvs.com',   // 用户提供的两个 CDN 域名
      'tmplayer.cn', 'tmcdn.net', 'cdnv4', 'cdnvid',
      'vip.dytt-', 'dytt-tvs',              // 前缀匹配更保险
    ];
    var needsReferer = cdnHosts.some(function(h) {
      return uLower.indexOf(h) !== -1;
    });
    if (needsReferer) {
      var headers = Object.assign({}, details.requestHeaders);
      headers['Referer'] = BASE_URL + '/';
      headers['Origin']  = BASE_URL;
      callback({ requestHeaders: headers });
      return;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // ── Fix 1 & 3: 拦截所有请求 — m3u8 捕获 + tmplayer 剥壳 ──────────────────
  snifferSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, function(details, callback) {
    var url = details.url;
    var rt  = details.resourceType;

    // 加速：只放行可能包含媒体的文件类型
    var blockTypes = ['image', 'stylesheet', 'font', 'ping'];
    if (blockTypes.indexOf(rt) !== -1) {
      callback({ cancel: true }); return;
    }

    // 阻断已知广告 MP4
    if (url.toLowerCase().indexOf('.mp4') !== -1 && isAdUrl(url)) {
      callback({ cancel: true }); return;
    }

    if (capturedM3u8) { callback({ cancel: false }); return; }

    var uLower = url.toLowerCase();

    // ── 直接包含 .m3u8 的 URL ─────────────────────────────────────────────
    if (uLower.indexOf('.m3u8') !== -1) {
      var blocked = ['ad.', 'stats.', 'analytics.', 'tracker'].some(function(k) { return uLower.indexOf(k) !== -1; });
      if (!blocked) {
        console.log('[Sniffer] onBeforeRequest: direct .m3u8 →', url.substring(0, 120));
        fireM3u8(url, BASE_URL + '/');
        callback({ cancel: false }); return;
      }
    }

    // ── 第二步 + 第三步：正式硬化 — 捕获 tmplayer → 剥壳 → 立即发射 ─────
    // 模式: https://www.xiaobaotv.tv/tmplayer/?url=https%3A%2F%2Fvip.dytt-tvs.com%2F20260325%2F14170_xxx%2Findex.m3u8
    if (uLower.indexOf('tmplayer') !== -1) {
      var urlParamMatch = url.match(/[?&]url=([^&]+)/);
      if (urlParamMatch) {
        var rawParam = urlParamMatch[1];
        // STEP 2 分析：解码 1 次（浏览器地址栏格式：%3A%2F%2F = 单次编码）
        var decoded1 = decodeURIComponent(rawParam);
        // STEP 2 分析：解码 2 次（以防双重编码）
        var decoded2 = '';
        try { decoded2 = decodeURIComponent(decoded1); } catch(e) {}
        var candidate = '';
        if (decoded1.toLowerCase().indexOf('.m3u8') !== -1 && /^https?:\/\//.test(decoded1)) {
          candidate = decoded1;
        } else if (decoded2.toLowerCase().indexOf('.m3u8') !== -1 && /^https?:\/\//.test(decoded2)) {
          candidate = decoded2;
        }
        if (candidate) {
          console.log('[Sniffer] tmplayer shell peeled →', candidate);
          // STEP 3 硬化：立即发射，不等任何异步回调
          capturedM3u8 = candidate;
          m3u8FoundFlag = true; // 永久标记，cleanupSniffer 不会清除
          console.log('[Sniffer] >>> M3U8 FOUND:', candidate);
          sendStatus('Stream found!');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ipc:m3u8-found', {
              streamUrl: candidate,
              referer: BASE_URL + '/',
              userAgent: GLOBAL_UA,
            });
          }
          // STEP 3 硬化：同步销毁嗅探窗口，阻断一切 ERR_FAILED 后续
          sniffAborted = true;
          if (snifferWin && !snifferWin.isDestroyed()) snifferWin.destroy();
          callback({ cancel: false });
          return;
        }
        console.log('[Sniffer] tmplayer intercepted but url= param has no m3u8:', decoded1.substring(0, 120));
      }
    }

    callback({ cancel: false });
  });

  // ── 延长超时 ─────────────────────────────────────────────────────────────
  sniffTimeoutId = setTimeout(function() {
    if (!capturedM3u8) {
      mlog('[Sniffer] Timeout — no m3u8 in 40s');
      sendError('Timeout: no stream found in 40s — 请尝试切换其他线路');
      cleanupSniffer();
    }
  }, 40000);

  // ── 快速提取（mac_player_info + tmplayer HTML 扫描）────────────────────
  try {
    mlog('[Sniffer] Fast extract...');
    var resp = await snifferSession.fetch(vodplayUrl, {
      headers: { 'User-Agent': GLOBAL_UA, 'Referer': BASE_URL + '/' },
    });
    var html = await resp.text();
    mlog('[Sniffer] Fast extract: status=' + resp.status + ' len=' + html.length);

    var m3u8Url = await fastExtract(html);
    if (m3u8Url && !capturedM3u8) {
      fireM3u8(m3u8Url, BASE_URL + '/');
      return;
    } else {
      mlog('[Sniffer] Fast extract: no m3u8 found in HTML');
    }
  } catch (e) {
    mlog('[Sniffer] Fast extract failed:', e.message);
  }

  // ── Fix 3: ERR_FAILED 容错 — 嗅探窗口加载播放页 ───────────────────────
  // 用 m3u8FoundFlag 而非 capturedM3u8：
  // fireM3u8 → cleanupSniffer() → capturedM3u8=null，但 m3u8FoundFlag 永久为 true
  snifferWin.webContents.on('did-fail-load', function(_e, code, _desc, _validatedUrl, isMainFrame) {
    if (m3u8FoundFlag || sniffAborted) return;
    if (!isMainFrame) return;
    // ERR_FAILED (-2): 窗口被销毁导致的-abort, 不是真实网络错误
    if (code === -2) { mlog('[Sniffer] did-fail-load ERR_FAILED (window destroyed, ignored)'); return; }
    if (Math.abs(code) >= 300) {
      mlog('[Sniffer] Navigation failed code=' + code + ' isMainFrame=' + isMainFrame);
      sendError('页面加载失败 (code ' + code + ')');
      cleanupSniffer();
    }
    // code = 0, -3 等：静默忽略，让嗅探继续等 m3u8
  });

  // 让嗅探窗口加载播放页
  try {
    snifferWin.loadURL(vodplayUrl, { userAgent: GLOBAL_UA }).catch(function(err) {
      var msg = err.message || '';
      // ERR_ABORTED: 页面被主动停止（cleanup 或用户导航）→ 忽略
      if (msg.indexOf('ERR_ABORTED') !== -1) { mlog('[Sniffer] loadURL ERR_ABORTED (ignored)'); return; }
      // ERR_FAILED (-2): 窗口在加载过程中被销毁 → 忽略
      if (msg.indexOf('ERR_FAILED') !== -1) { mlog('[Sniffer] loadURL ERR_FAILED (window destroyed, ignored)'); return; }
      if (m3u8FoundFlag) return;
      // 真实网络错误
      if (msg.indexOf('ERR_NAME_NOT_RESOLVED') !== -1) { sendError('域名无法解析，请检查网络'); cleanupSniffer(); return; }
      mlog('[Sniffer] loadURL error:', msg);
    });
  } catch(e) {
    mlog('[Sniffer] loadURL sync error:', e.message);
  }
}

// ─── IPC ─────────────────────────────────────────────────────────────────
ipcMain.on('ipc:sniff-url',    function(_e, url) { if (!url || typeof url !== 'string') { sendError('Invalid URL.'); return; } startSniffing(url); });
ipcMain.on('ipc:stop-sniff',   function() { cleanupSniffer(); });
ipcMain.on('stop-sniffing',    function() { cleanupSniffer(); });
ipcMain.on('ipc:preload-next', function() {});
ipcMain.on('win:minimize',  function() { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win:maximize',  function() {
  if (mainWindow && mainWindow.isMaximized()) mainWindow.unmaximize();
  else if (mainWindow) mainWindow.maximize();
});
ipcMain.on('win:close',     function() { cleanupSniffer(); if (mainWindow) mainWindow.close(); });
ipcMain.on('updater:restart', function() { if (autoUpdater) autoUpdater.quitAndInstall(); });

// Simple axios fetch — no session/cookie needed for xiaobaotv.tv
ipcMain.handle('ipc:main-fetch', async function(_event, url) {
  try {
    var resp = await axios.get(url, {
      headers: {
        'User-Agent':      SHARED_UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer':         BASE_URL + '/',
      },
      timeout: 15000,
    });
    return { status: resp.status, body: resp.data, isCF: false };
  } catch (e) {
    if (e.response) return { status: e.response.status, body: e.response.data || '', isCF: false };
    mlog('mainFetch ERROR: ' + e.message);
    return { status: 0, body: '', isCF: false, error: e.message };
  }
});

// ─── Playback History ─────────────────────────────────────────────────────
var HISTORY_FILE = null;
function getHistoryFile() {
  if (!HISTORY_FILE) HISTORY_FILE = path.join(app.getPath('userData'), 'pvp_history.json');
  return HISTORY_FILE;
}
function readHistory() {
  try {
    var hf = getHistoryFile();
    if (fs.existsSync(hf)) return JSON.parse(fs.readFileSync(hf, 'utf8'));
  } catch (e) { console.error('[History] Read error:', e.message); }
  return {};
}
function writeHistory(data) {
  try { fs.writeFileSync(getHistoryFile(), JSON.stringify(data), 'utf8'); }
  catch (e) { console.error('[History] Write error:', e.message); }
}
ipcMain.handle('ipc:get-history', async function(_event, vodID) {
  return readHistory()[vodID] || null;
});
ipcMain.on('ipc:save-history', function(_event, record) {
  if (!record || !record.vodID) return;
  var history = readHistory();
  history[record.vodID] = {
    episodeIndex: record.episodeIndex,
    currentTime:  record.currentTime,
    updatedAt:    Date.now(),
  };
  writeHistory(history);
});

// ─── Main Window ──────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d0d14',
    frame: false, titleBarStyle: 'hidden',
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

  mainWindow.webContents.on('before-input-event', function(event, input) {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 物理禁用所有弹窗 — 从根源掐断 popup 广告
  mainWindow.webContents.setWindowOpenHandler(function() {
    return { action: 'deny' };
  });

  mainWindow.webContents.on('render-process-gone', function(_e, details) {
    mlog('Renderer crashed: ' + details.reason);
  });

  // Load app UI directly — no verification needed
  mainWindow.loadFile('index.html').then(function() {
    console.log('[Main] index.html loaded — app UI ready');
  }).catch(function(e) {
    console.error('[Main] loadFile failed: ' + e.message);
  });

  // ── Fix: 对主窗口的 m3u8 / ts / media 请求注入 Referer ─────────────────
  // ArtPlayer 的 video 元素发起的请求不携带 Referer，CDN 会返回 403
  // 在主 session 上拦截所有媒体请求，强制注入 Referer
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, function(details, callback) {
    var url = (details.url || '').toLowerCase();
    // 只对媒体相关 URL 注入 Referer，避免污染其他请求
    var isMedia = url.indexOf('.m3u8') !== -1 ||
                  url.indexOf('.ts') !== -1 ||
                  url.indexOf('.mp4') !== -1 ||
                  url.indexOf('.key') !== -1 ||
                  url.indexOf('segment') !== -1 ||
                  url.indexOf('dytt-network') !== -1 ||
                  url.indexOf('dytt-tvs') !== -1 ||      // ← 用户提供的 CDN 域名
                  url.indexOf('tmplayer') !== -1 ||
                  url.indexOf('cdnv') !== -1;
    if (isMedia) {
      var headers = Object.assign({}, details.requestHeaders);
      headers['Referer'] = BASE_URL + '/';
      headers['Origin'] = BASE_URL;
      callback({ requestHeaders: headers });
      return;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  mainWindow.on('closed', function() { mainWindow = null; });
}

// ─── Auto-Updater ────────────────────────────────────────────────────────
function setupAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update',  function() { console.log('[Updater] Checking...'); });
  autoUpdater.on('update-not-available', function() { console.log('[Updater] Up to date.'); });
  autoUpdater.on('error', function(err) {
    console.error('[Updater] Error:', err.message);
    if (mainWindow) mainWindow.webContents.send('updater:error', err.message);
  });
  autoUpdater.on('update-available', function(info) {
    console.log('[Updater] Update available:', info.version);
    if (mainWindow) mainWindow.webContents.send('updater:available', { version: info.version });
  });
  autoUpdater.on('download-progress', function(prog) {
    if (mainWindow) mainWindow.webContents.send('updater:progress', { percent: Math.round(prog.percent || 0) });
  });
  autoUpdater.on('update-downloaded', function(info) {
    console.log('[Updater] Downloaded:', info.version);
    if (mainWindow) mainWindow.webContents.send('updater:downloaded', { version: info.version });
  });
  setTimeout(function() { autoUpdater.checkForUpdates().catch(function(e) { console.warn('[Updater]', e.message); }); }, 5000);
}

// ─── App Lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(function() {
  console.log('[Main] app.whenReady — registering protocol and creating window');
  registerImageProxy();
  createMainWindow();
  console.log('[Main] createMainWindow() called');
  if (app.isPackaged) setupAutoUpdater();
  app.on('activate', function() { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', function() {
  cleanupSniffer();
  if (process.platform !== 'darwin') app.quit();
});
