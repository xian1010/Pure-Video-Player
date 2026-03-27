'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// ─── Bulletproof Script ──────────────────────────────────────────────────────
// 这段代码在 preload 上下文执行 — 页面加载前先废掉所有弹窗相关的 JS 函数
// 定时清除 xiaobaotv.tv 的遮罩层广告
// 注意：由于 preload 有 DOM API 访问权（session/fromPartition），可以直接操作 DOM
;(function() {
  // 1. 废掉 window.open — 彻底禁用弹窗
  window.open = function() { return null; };

  // 2. 废掉 alert/confirm/prompt — 防止 JS 弹窗
  window.alert = function() { return null; };
  window.confirm = function() { return true; };
  window.prompt = function() { return null; };

  // 3. 拦截 document.write / writeln（某些站点用这个插入广告脚本）
  var _docWrite = document.write.bind(document);
  var _docWriteln = document.writeln.bind(document);
  document.write = function(s) {
    if (typeof s === 'string' && s.indexOf('ad') !== -1) return;
    return _docWrite(s);
  };
  document.writeln = function(s) {
    if (typeof s === 'string' && s.indexOf('ad') !== -1) return;
    return _docWriteln(s);
  };

  // 4. 定时清除遮罩层广告（z-index 极高 + 全屏/半透明 + 覆盖整个视口）
  var KILL_INTERVAL_MS = 800;
  var _killTimer = null;
  function killOverlays() {
    try {
      var all = document.querySelectorAll('div, iframe');
      all.forEach(function(el) {
        try {
          var style = window.getComputedStyle(el);
          var z = parseInt(style.zIndex) || 0;
          if (z < 2147483640) return;

          var rect = el.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) return;

          var op = parseFloat(style.opacity);
          if (op < 0.05) return;

          var vp = { w: window.innerWidth, h: window.innerHeight };
          if (rect.width < vp.w * 0.5 && rect.height < vp.h * 0.4) return;

          var marker = (el.className || '') + ' ' + (el.id || '') + ' ' + (el.tagName || '');
          var bad = ['popup','modal','overlay','ad-','-ad','ads-','-ads','float','adbox','adlayer','admodal','adsbygoogle','gg-box','tongji','union-ad'].some(function(k) {
            return marker.toLowerCase().indexOf(k) !== -1;
          });

          if (el.tagName && el.tagName.toLowerCase() === 'iframe') {
            var src = (el.src || '').toLowerCase();
            if (src.indexOf('ad') !== -1 || src.indexOf('popup') !== -1 || src.indexOf('union') !== -1 || !src) {
              el.remove(); return;
            }
          }
          if (bad) el.remove();
        } catch(e) {}
      });
    } catch(e) {}
  }
  _killTimer = setInterval(killOverlays, KILL_INTERVAL_MS);

  // 5. MutationObserver — 动态新增广告节点时立即清除
  try {
    var _obs = new MutationObserver(function(records) {
      records.forEach(function(r) {
        r.addedNodes.forEach(function(node) {
          if (node.nodeType !== 1) return;
          try {
            var z = parseInt(window.getComputedStyle(node).zIndex) || 0;
            if (z > 2147483640 && (node.className || '').toLowerCase().match(/popup|modal|overlay|ad-/)) {
              node.remove();
            }
          } catch(e) {}
        });
      });
    });
    _obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch(e) {}

  // 6. 页面卸载前清理
  window.addEventListener('beforeunload', function() {
    if (_killTimer) { clearInterval(_killTimer); _killTimer = null; }
  });

  // 7. 拦截 <dialog> showModal（现代浏览器弹窗）
  try {
    HTMLDialogElement && Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: function() { /* 静默拒绝 */ }
    });
  } catch(e) {}
})();

// ─── IPC Bridge ─────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {
  // ── Sniffer ───────────────────────────────────────────────────────────
  sniffUrl:         (url, sourceName) => ipcRenderer.send('ipc:sniff-url', url, sourceName),
  preloadNext:      (url)            => ipcRenderer.send('ipc:preload-next', url),
  stopSniff:        ()               => ipcRenderer.send('ipc:stop-sniff'),
  sendStopSniffing: ()               => ipcRenderer.send('stop-sniffing'),
  onM3u8Found:     (cb)             => ipcRenderer.on('ipc:m3u8-found',  (_e, d) => cb(d)),
  onSniffError:     (cb)             => ipcRenderer.on('ipc:sniff-error', (_e, m) => cb(m)),
  onStatusUpdate:   (cb)             => ipcRenderer.on('ipc:status',       (_e, m) => cb(m)),

  // ── mainFetch: axios.get in main process — no Cloudflare needed ────────
  mainFetch: (url) => ipcRenderer.invoke('ipc:main-fetch', url),

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('ipc:m3u8-found');
    ipcRenderer.removeAllListeners('ipc:sniff-error');
    ipcRenderer.removeAllListeners('ipc:status');
  },

  // ── Window controls ────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),

  // ── Playback History ───────────────────────────────────────────────────
  getHistory:  (vodID)  => ipcRenderer.invoke('ipc:get-history', vodID),
  saveHistory: (record) => ipcRenderer.send('ipc:save-history',  record),

  // ── Auto-updater ──────────────────────────────────────────────────────
  onUpdateAvailable:  (cb) => ipcRenderer.on('updater:available',  (_e, d) => cb(d)),
  onUpdateProgress:   (cb) => ipcRenderer.on('updater:progress',   (_e, d) => cb(d)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('updater:downloaded', (_e, d) => cb(d)),
  onUpdateError:      (cb) => ipcRenderer.on('updater:error',      (_e, m) => cb(m)),
  restartApp:         ()   => ipcRenderer.send('updater:restart'),
});
