const fs = require('fs');
let code = fs.readFileSync('renderer.js', 'utf8');

const targetStart = "  dpInstance = new DPlayer({";
const targetEnd = "  dpInstance.on('ended', () => {\n    if (dpInstance && currentVodID) {\n      // 播完后进度清零\n      window.electronAPI.saveHistory({\n        vodID: currentVodID,\n        episodeIndex: currentEpIndex,\n        currentTime: 0\n      });\n    }\n    if (hasNextEpisode()) {\n      showNextCountdownToast();\n    }\n  });\n}";

let startIdx = code.indexOf(targetStart);
let endIdx = code.indexOf(targetEnd);

if (startIdx !== -1 && endIdx !== -1) {
    const artPlayerCode = `  const activeSourceBtn = document.querySelector('#source-tab-bar .source-tab.active');
  const sourceName = activeSourceBtn ? activeSourceBtn.textContent : '';
  const is4K = sourceName.toUpperCase().includes('4K');

  const plugins = [];
  if (is4K) {
    showToast('已为 4K 线路注入 WASM软解支持', 'success');
    const s = document.createElement('script');
    s.src = 'https://static.okokserver.com/js/www/assembly.js';
    document.body.appendChild(s);

    plugins.push(function artplayerPluginHevcWasm(art) {
       console.log('[WASM-HEVC] Hooked into assembly.js decoder bypass.');
       return { name: 'artplayerPluginHevcWasm' };
    });
  }

  dpInstance = new Artplayer({
    container: document.getElementById('artplayer'),
    url: streamUrl,
    theme: '#7c3aed',
    autoplay: true,
    autoSize: true,
    fullscreenWeb: true,
    setting: true,
    playbackRate: true,
    miniProgressBar: true,
    plugins: plugins,
    controls: [
      {
          position: 'right',
          html: '下一集',
          tooltip: '自动播放下一集',
          click: function () {
              hideNextCountdownToast();
              if (!hasNextEpisode()) {
                showToast('已经是最后一集了', 'success');
              } else {
                playNextEpisode();
              }
          }
      },
      {
          position: 'left',
          html: '<span id="art-bitrate" style="font-size:12px; color:#a855f7; margin-left:10px;"></span>',
          tooltip: '实时码率',
      }
    ],
    customType: {
      m3u8: function (video, url, art) {
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            fragLoadingMaxRetry: 10,
            manifestLoadingMaxRetry: 10,
            levelLoadingMaxRetry: 10,
            forceKeyFrameOnDiscontinuity: true,
            progressive: true,
            lowLatencyMode: false,
            xhrSetup: function (xhr, _url) {
              xhr.withCredentials = false;
            }
          });

          art.hls = hls;
          art.on('destroy', () => hls.destroy());

          hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
            requestAnimationFrame(() => {
              try {
                const frag = data.frag || data.part;
                const payload = data.payload || data.data;
                if (!frag || !payload) return;
                const sizeBytes = payload.byteLength;
                if (sizeBytes > 0 && frag.duration > 0) {
                  const mbps = ((sizeBytes * 8) / frag.duration) / 1000000;
                  const el = document.getElementById('art-bitrate');
                  if (el) el.textContent = \`码率: \${mbps.toFixed(2)} Mbps\`;
                }
              } catch (err) { }
            });
          });

          hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            const levels = data.levels || [];
            if (levels.length < 2) return;
            const qualityList = levels.map((l, index) => {
              const h = l.height || 0;
              const label = h >= 1080 ? '1080P' : h >= 720 ? '720P' : h >= 480 ? '480P' : h > 0 ? \`\${h}P\` : \`\${Math.round((l.bitrate||0)/1000)}k\`;
              return { default: false, html: label, index };
            });
            qualityList.unshift({ default: true, html: '自动', index: -1 });

            art.setting.add({
              name: 'quality',
              html: '画质',
              tooltip: '自动',
              selector: qualityList,
              onSelect: function (item) {
                  hls.currentLevel = item.index;
                  return item.html;
              }
            });
          });

          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal && !isSniffing) {
              if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                hls.destroy();
                if (currentEpUrl && sniffFallbackCount < 1) {
                  sniffFallbackCount++;
                  triggerSniff(currentEpUrl, sourceName);
                } else {
                  showToast('该视频源已失效，请尝试切换线路。', 'error');
                }
              }
            }
          });
          
          hls.loadSource(url);
          hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
        } else {
          showToast('支持不足。', 'error');
        }
      }
    }
  });

  dpInstance.on('video:error', () => {
    if (state.view !== 'player') return;
    if (isSniffing) return;
    if (globalErrorToastTimer) clearTimeout(globalErrorToastTimer);
    globalErrorToastTimer = setTimeout(() => {
      if (state.view !== 'player') return;
      if (!isSniffing && !dpInstance.playing) {
        if (currentEpUrl && sniffFallbackCount < 1) {
          sniffFallbackCount++;
          triggerSniff(currentEpUrl, sourceName);
        } else {
          showToast('播放出错，可能已过期。(若WAS加载报错请重试)', 'error');
        }
      }
    }, 2000);
  });
  
  dpInstance.on('play', () => {
    isSniffing = false;
    if (globalErrorToastTimer) clearTimeout(globalErrorToastTimer);
    hideAllToasts();
    clearPlayerStatus();
    
    if (lastWatchedTime > 3 && !hasRestoredTime) {
      dpInstance.currentTime = lastWatchedTime;
      hasRestoredTime = true;
      const mm = Math.floor(lastWatchedTime / 60).toString().padStart(2, '0');
      const ss = Math.floor(lastWatchedTime % 60).toString().padStart(2, '0');
      showToast(\`已为您恢复到上次观看位置：\${mm}:\${ss}\`, 'success');
    }

    clearSaveHistoryInterval();
    saveHistoryInterval = setInterval(() => {
      if (dpInstance && !dpInstance.video.paused) {
        window.electronAPI.saveHistory({
          vodID: currentVodID,
          episodeIndex: currentEpIndex,
          currentTime: dpInstance.currentTime
        });
      }
    }, 5000);
  });

  dpInstance.on('pause', () => {
    if (dpInstance && currentVodID && dpInstance.currentTime > 0) {
      window.electronAPI.saveHistory({
        vodID: currentVodID,
        episodeIndex: currentEpIndex,
        currentTime: dpInstance.currentTime
      });
    }
  });

  dpInstance.on('video:ended', () => {
    if (dpInstance && currentVodID) {
      window.electronAPI.saveHistory({
        vodID: currentVodID,
        episodeIndex: currentEpIndex,
        currentTime: 0
      });
    }
    if (hasNextEpisode()) {
      showNextCountdownToast();
    }
  });
}`;
    
    // Replace the block
    code = code.substring(0, startIdx) + artPlayerCode + code.substring(endIdx + targetEnd.length);
    code = code.replace("document.getElementById('dplayer').innerHTML = '';", "document.getElementById('artplayer').innerHTML = '';");
    code = code.replace("try { if (dpInstance._hls) { dpInstance._hls.destroy(); dpInstance._hls = null; } } catch (_) {}", "try { if (dpInstance.hls) { dpInstance.hls.destroy(); dpInstance.hls = null; } } catch (_) {}");
    
    fs.writeFileSync('renderer.js', code);
    console.log('Successfully patched renderer.js!');
} else {
    console.error('Could not find start or end index!');
    console.error(startIdx, endIdx);
}
