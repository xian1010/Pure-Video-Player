// 终极劫持：强行剥夺长定时器
const nativeSetTimeout = window.setTimeout;
window.setTimeout = function(fn, delay) {
  // 劫持 15 到 30 秒之间的长时间等待（广告倒计时）
  if (delay > 15000 && delay <= 30000) {
    return nativeSetTimeout(fn, 1);
  }
  return nativeSetTimeout(fn, delay);
};

(function() {
  const skipAd = () => {
    // 强制变量清零
    window.video_ads_time = 0;
    window.ads_time = 0;
    if (window.MacPlayer) {
      window.MacPlayer.PlayTime = 0;
    }

    // 类名寻址物理点击
    const btnQueries = [
      ‘.art-ad-skip’, ‘.play-btn’, ‘#buffer’, ‘.ad-skip’, ‘.art-ad-close’,
      ‘.dplayer-play-icon’, ‘.mac_play’, ‘.video-play’, ‘.video-con’,
      ‘[class*="skip"]’, ‘[id*="skip"]’,
      // Common play button patterns in MacCMS / video players
      ‘.player-play’, ‘#play’, ‘.btn-play’, ‘.icon-play’,
      ‘button[class*="play"]’, ‘div[class*="play"]’, ‘span[class*="play"]’,
    ];
    document.querySelectorAll(btnQueries.join(‘, ‘)).forEach(btn => {
      try { btn.click(); } catch(e){}
    });

    // 文本寻址物理点击与 UI 粉碎
    const allDivs = document.querySelectorAll(‘div, span, a, button, i’);
    allDivs.forEach(el => {
      const text = el.innerText || ‘’;
      // 寻找’跳过’
      if (text.includes(‘跳过’) || text.toLowerCase().includes(‘skip’) || text === ‘X’ || text === ‘x’ || text.includes(‘关闭’)) {
        try {
          el.click();
          if (el.parentElement) el.parentElement.click();
        } catch(e){}
      }
      // 粉碎数字倒计时 UI
      if (/^\d{1,2}$/.test(text.trim())) {
        const num = parseInt(text.trim());
        if (num > 0 && num <= 30) {
          el.innerText = ‘0’;
          try {
            el.click();
            if (el.parentElement) el.parentElement.click();
          } catch(e){}
        }
      }
    });

    // 强制播放所有视频（包括短广告快进）
    const vids = document.querySelectorAll(‘video’);
    vids.forEach(v => {
      if (v.duration && v.duration < 60) {
        if (v.currentTime < v.duration - 0.5) {
          v.currentTime = v.duration;
        }
      }
      if (v.paused) v.play().catch(()=>{});
    });
  };

  // 立刻触发：DOM 内容加载完毕后马上点一次播放
  document.addEventListener(‘DOMContentLoaded’, () => {
    skipAd();
    // 延迟重试，覆盖 JS 渲染后的播放器 DOM
    nativeSetTimeout(skipAd, 300);
    nativeSetTimeout(skipAd, 800);
    nativeSetTimeout(skipAd, 1500);
    nativeSetTimeout(skipAd, 3000);
  });

  // 页面完全加载后再触发一次
  window.addEventListener(‘load’, () => {
    skipAd();
    nativeSetTimeout(skipAd, 500);
  });

  // 每 100 毫秒全域无死角爆破
  setInterval(skipAd, 100);
})();
