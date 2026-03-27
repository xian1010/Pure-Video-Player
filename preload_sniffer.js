// ─── Bulletproof Script (sniffer preload) ──────────────────────────────────────
;(function() {
  window.open = function() { return null; };
  window.alert = function() { return null; };
  window.confirm = function() { return true; };
  window.prompt = function() { return null; };
  try { HTMLDialogElement && Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: function() {} }); } catch(e) {}

  // 定时清除遮罩层广告
  function killOverlays() {
    try {
      document.querySelectorAll('div, iframe').forEach(function(el) {
        try {
          var z = parseInt(window.getComputedStyle(el).zIndex) || 0;
          if (z < 2147483640) return;
          var rect = el.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) return;
          var op = parseFloat(window.getComputedStyle(el).opacity);
          if (op < 0.05) return;
          var vp = { w: window.innerWidth, h: window.innerHeight };
          if (rect.width < vp.w * 0.5 && rect.height < vp.h * 0.4) return;
          var marker = (el.className || '') + ' ' + (el.id || '');
          var bad = ['popup','modal','overlay','ad-','-ad','ads-','-ads','float','adbox','adlayer','admodal','adsbygoogle','gg-box'].some(function(k){ return marker.toLowerCase().indexOf(k) !== -1; });
          if (el.tagName && el.tagName.toLowerCase() === 'iframe') {
            var src = (el.src || '').toLowerCase();
            if (src.indexOf('ad') !== -1 || src.indexOf('popup') !== -1 || src.indexOf('union') !== -1 || !src) { el.remove(); return; }
          }
          if (bad) el.remove();
        } catch(e) {}
      });
    } catch(e) {}
  }
  setInterval(killOverlays, 600);
})();

// ─── 劫持长定时器（跳过广告倒计时）──────────────────────────────────────────────
var _nativeSetTimeout = window.setTimeout;
window.setTimeout = function(fn, delay) {
  // 劫持 15s–120s 的长定时器（广告倒计时），直接执行
  if (delay > 15000) return _nativeSetTimeout(fn, 1);
  return _nativeSetTimeout(fn, delay);
};

// ─── 主自动化脚本 ─────────────────────────────────────────────────────────────
(function() {
  var CLICK_INTERVAL_MS = 150; // 每 150ms 尝试一次
  var _clickTimer = null;

  function tryPlay() {
    // ── 1. 点击 tmplayer 覆盖层（核心！小宝影院视频需要这一步）────────────
    // tmplayer 播放器在点击遮罩后才加载真正的 m3u8
    var tmplayerSelectors = [
      // tmplayer 自身的播放触发
      '.tmplayer', '.tmplayer-wrap', '.tmplayer-container',
      '.tmplayer-player', '.tmplayer_iframe',
      // tmplayer 覆盖遮罩（点击即播放）
      '.tmplayer-cover', '.tmplayer-overlay', '.tmplayer-poster',
      '.tmplayer-play-overlay', '.tmplayer-mask',
      // Video.js 风格
      '.vjs-big-play-button', '.vjs-play-control', '.vjs-play-button',
      // DPlayer
      '.dplayer-play-icon', '.dplayer-play',
      // ArtPlayer
      '.art-icon-play', '.artplayer-play-btn', '.artplayer-icon',
      '.art-video', '.artplayer-video-wrap',
      // MacCMS 播放器
      '.mac_play', '#mac_player', '.player-btn-play',
      // 最通用：任何大尺寸播放按钮
      '[class*="play-icon"]', '[class*="play-btn"]',
      '[class*="poster"]', '[class*="cover"]',
      // video 元素本身
      'video',
      // 任意 iframe（可能包含播放器）
      'iframe',
    ];

    tmplayerSelectors.forEach(function(sel) {
      try {
        document.querySelectorAll(sel).forEach(function(el) {
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          var rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) return;
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            // 尝试 focus + click（某些播放器需要）
            try { el.focus(); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch(e) {}
          }
        });
      } catch(e) {}
    });

    // ── 2. 强制播放 video 元素 ────────────────────────────────────────────────
    try {
      document.querySelectorAll('video').forEach(function(v) {
        if (v.paused) {
          v.play().catch(function() {});
          v.dispatchEvent(new Event('canplay', { bubbles: true, cancelable: true }));
        }
        // 尝试手动设置 src 触发加载（如果 video 没有 src）
        if (!v.src && v.getAttribute('src') === null) {
          // 尝试从父级 iframe 获取
        }
      });
    } catch(e) {}

    // ── 3. 强制触发 tmplayer / macplayer 的播放函数 ──────────────────────────
    try {
      // 废掉广告时间变量
      window.video_ads_time = 0;
      window.ads_time = 0;
      window.ad_time = 0;
      window.countdown = 0;
      window.adCountdown = 0;
      window._adClosed = true;

      if (window.MacPlayer) {
        window.MacPlayer.PlayTime = 0;
        window.MacPlayer.ads_time = 0;
        window.MacPlayer.status = 'play';
        // 强制执行 MacPlayer.Play()
        if (typeof window.MacPlayer.Play === 'function') {
          try { window.MacPlayer.Play(); } catch(e) {}
        }
        // 尝试触发 start
        if (typeof window.MacPlayer.Start === 'function') {
          try { window.MacPlayer.Start(); } catch(e) {}
        }
      }

      // DPlayer
      if (window.DPlayer) {
        try { window.DPlayer.prototype.start = function() {}; } catch(e) {}
      }

      // 尝试直接调用全局播放函数
      ['MacPlayerPlay', 'player_start', 'dplayer_start', 'dp_start'].forEach(function(fn) {
        try { if (typeof window[fn] === 'function') window[fn](); } catch(e) {}
      });
    } catch(e) {}

    // ── 4. 点击跳过按钮 ────────────────────────────────────────────────────────
    var skipSelectors = [
      '.art-ad-skip', '.ad-skip', '.skip-btn', '.mac_skip',
      '#buffer', '.dplayer-skip', '[class*="skip"]',
      '[class*="ad-skip"]', '[class*="ad_skip"]', '[id*="skip"]',
    ];
    skipSelectors.forEach(function(sel) {
      try {
        document.querySelectorAll(sel).forEach(function(el) {
          if (el.offsetWidth > 0 || el.offsetHeight > 0) {
            el.click();
          }
        });
      } catch(e) {}
    });

    // ── 5. 粉碎数字倒计时 UI ───────────────────────────────────────────────────
    try {
      document.querySelectorAll('div, span, i, b').forEach(function(el) {
        var text = (el.textContent || '').trim();
        if (/^(5|4|3|2|1|0)$/.test(text)) {
          var parent = el.parentElement;
          if (parent) {
            var pClass = ((parent.className || '') + ' ' + (parent.id || '')).toLowerCase();
            if (pClass.indexOf('count') !== -1 || pClass.indexOf('timer') !== -1 || pClass.indexOf('skip') !== -1) {
              el.textContent = '0';
              parent.style.display = 'none';
            }
          }
        }
      });
    } catch(e) {}
  }

  // DOMContentLoaded 后立即执行
  document.addEventListener('DOMContentLoaded', function() {
    tryPlay();
    _nativeSetTimeout(tryPlay, 200);
    _nativeSetTimeout(tryPlay, 500);
    _nativeSetTimeout(tryPlay, 1000);
    _nativeSetTimeout(tryPlay, 2000);
    _nativeSetTimeout(tryPlay, 3000);
    _nativeSetTimeout(tryPlay, 5000);

    // 每 150ms 持续尝试（播放按钮可能延迟渲染）
    _clickTimer = setInterval(tryPlay, 150);

    // 5 秒后停止自动点击（避免影响正常交互）
    _nativeSetTimeout(function() {
      if (_clickTimer) { clearInterval(_clickTimer); _clickTimer = null; }
    }, 8000);
  });

  // load 事件再触发一次
  window.addEventListener('load', function() {
    tryPlay();
    _nativeSetTimeout(tryPlay, 300);
  });

  // 页面卸载前清理
  window.addEventListener('beforeunload', function() {
    if (_clickTimer) { clearInterval(_clickTimer); _clickTimer = null; }
  });
})();
