'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// remote-logic.js — xiaobaotv.tv 专用解析引擎
// ═══════════════════════════════════════════════════════════════════════════
// 解析函数在 renderer.js 和 main.js 中调用
// 使用 DOMParser（浏览器原生）而非 cheerio，以获得更快的解析速度
//
// xiaobaotv.tv URL patterns:
//   列表页   https://www.xiaobaotv.tv/movie/type/<id>.html
//   筛选页   https://www.xiaobaotv.tv/movie/type/<id>/area/<area>.html
//   筛选年份  https://www.xiaobaotv.tv/movie/type/<id>/year/<year>.html
//   详情页   https://www.xiaobaotv.tv/movie/detail/<id>.html
//   播放页   https://www.xiaobaotv.tv/movie/play/<id>-<sid>-<nid>.html
//   搜索页   https://www.xiaobaotv.tv/search.html?wd=<query>
// ═══════════════════════════════════════════════════════════════════════════

// ─── 辅助：创建 DOMParser ───────────────────────────────────────────────────
function makeDoc(html) {
  var p = new DOMParser();
  return p.parseFromString(html, 'text/html');
}

// ─── 列表页解析 ──────────────────────────────────────────────────────────────
// xiaobaotv.tv 使用: ul.myui-vodlist li a.myui-vodlist__thumb
// 兼容其他可能的 class 变体：
//   .module-item (某些模板)
//   .col-lg-8 a.myui-vodlist__thumb
function parseCards(html) {
  var doc = makeDoc(html);
  var cards = [];

  // 主要选择器：标准 MacCMS 模板
  var els = doc.querySelectorAll('ul.myui-vodlist li a.myui-vodlist__thumb, ul.myui-vodlist.col-lg-8 li a.myui-vodlist__thumb');
  if (els.length === 0) {
    // 备选：module-item 风格模板
    els = doc.querySelectorAll('.module-item a[href*="/movie/detail/"]');
  }
  if (els.length === 0) {
    // 备选：带 data-original 海报的任意链接
    els = doc.querySelectorAll('a.myui-vodlist__thumb[href*="/movie/detail/"]');
  }

  var seenUrls = {};

  els.forEach(function(el) {
    var href = (el.getAttribute('href') || '').trim();
    // 过滤掉非详情页链接
    if (!href || href.indexOf('/movie/detail/') === -1) return;
    if (seenUrls[href]) return;
    seenUrls[href] = true;

    // 海报图片：data-original (懒加载) 或 src
    var poster = (el.getAttribute('data-original') || el.getAttribute('src') || '').trim();
    if (poster) {
      if (!poster.startsWith('http')) {
        if (poster.startsWith('//')) poster = 'https:' + poster;
        else if (poster.startsWith('/')) poster = 'https://www.xiaobaotv.tv' + poster;
        else poster = 'https://www.xiaobaotv.tv/' + poster;
      }
    }

    // 标题：优先 title 属性，其次 span.pic-text
    var title = (el.getAttribute('title') || '').trim();
    if (!title) {
      var titleEl = el.querySelector('span.pic-text');
      if (titleEl) title = titleEl.textContent.trim();
    }
    // 备选：从 a 内部的文本节点
    if (!title) {
      var inner = el.cloneNode(true);
      inner.querySelectorAll('script, style, span').forEach(function(s) { s.remove(); });
      title = (inner.textContent || '').trim().substring(0, 100);
    }

    // 标签/徽章：年份、画质等
    var badge = '';
    var tagEl = el.querySelector('span.pic-tag-top span.tag, span.tag-top span.tag, span.pic-tag-top, .tag-top');
    if (tagEl) badge = tagEl.textContent.trim();

    // 类型标签（备选：直接文本）
    if (!badge) {
      var badgeEl = el.querySelector('.tag');
      if (badgeEl) badge = badgeEl.textContent.trim();
    }

    if (title && href) {
      if (!href.startsWith('http')) href = 'https://www.xiaobaotv.tv' + href;
      cards.push({ title: title, url: href, poster: poster, badge: badge });
    }
  });

  return cards;
}

// ─── 翻页检测 ────────────────────────────────────────────────────────────────
function hasNextPage(html) {
  var doc = makeDoc(html);

  // xiaobaotv.tv 的"下一页"链接特征
  var nextLink = doc.querySelector('a.myui-page__a[href*="/movie/type/"], a[href*="-2.html"], a[href*="-3.html"]');
  if (nextLink) {
    var href = nextLink.getAttribute('href') || '';
    // 排除 page=1 的情况
    if (href && !href.match(/[&\?]page=1/)) return true;
    // 排除已经是 -1.html (末页) 的下一页按钮
    if (href.indexOf('-1.html') !== -1) return false;
    if (href.match(/\/type\/\d+(-\d+)?\.html/) && !href.match(/[&\?]page=1/)) return true;
  }

  // 备选：如果有多个页码链接且当前不是末页
  var pageLinks = doc.querySelectorAll('a[href*="/movie/type/"][href*=".html"]');
  if (pageLinks.length > 1) return true;

  return false;
}

// ─── 详情页解析 ──────────────────────────────────────────────────────────────
// xiaobaotv.tv 详情页底部集数结构（实测确定）：
// <div class="myui-panel">
//   <div class="myui-panel_hd">
//     <div class="myui-panel__head">
//       <h3 class="title">高清-Ⓓ</h3>          ← 线路名
//     </div>
//   </div>
//   <div class="myui-panel_bd">
//     <ul class="myui-content__list">
//       <li><a class="btn btn-default" href="/movie/play/xxx-1-1.html">第01集</a></li>
//       ...
//     </ul>
//   </div>
// </div>
// 集数按钮的 class 是 btn.btn-default，每个 li 只含一个 a
function parseDetail(html) {
  var doc = makeDoc(html);
  var sources = [];
  var SKIP_HEADINGS = ['猜你喜欢', '剧情简介', '本月热门', '香港剧本周热播', '为你推荐', '相关推荐', '热门推荐', '热门视频', '播放列表', '播放源', '影片评论'];

  // ── 全局统计（打印给开发者看）────────────────────────────────────
  var allATags = doc.querySelectorAll('a').length;
  var playATags = doc.querySelectorAll('a[href*="/movie/play/"]').length;
  var panelTags = doc.querySelectorAll('div.myui-panel').length;
  var ulTags = doc.querySelectorAll('ul').length;
  var btnATags = doc.querySelectorAll('a.btn').length;
  console.log('[parseDetail] HTML长度=' + html.length + ' | a标签=' + allATags + ' | play链接=' + playATags + ' | myui-panel=' + panelTags + ' | ul=' + ulTags + ' | a.btn=' + btnATags);

  // ── 方法1（主要）：精确匹配 .myui-panel → h3.title → ul.myui-content__list ──
  var panels = doc.querySelectorAll('div.myui-panel');
  console.log('[parseDetail M1] div.myui-panel=' + panels.length);
  if (panels.length > 0) {
    var currentSourceName = '默认线路';
    var currentEpisodes = [];
    var seen = {};

    panels.forEach(function(panel) {
      // 获取线路名称：h3.title 里的文本
      var heading = panel.querySelector('h3.title, .myui-panel__head h3');
      if (heading) {
        var hText = heading.textContent.replace(/[\n\r\t]+/g, '').replace(/\s+/g, ' ').trim();
        if (hText && SKIP_HEADINGS.indexOf(hText) === -1) {
          // 有新线路名时，保存上一个
          if (currentEpisodes.length > 0 && currentSourceName !== '默认线路') {
            sources.push({ name: currentSourceName, episodes: currentEpisodes });
            currentEpisodes = [];
          }
          currentSourceName = hText;
        }
      }

      // 集数列表：在 .myui-content__list 里找 btn.btn-default
      var epList = panel.querySelector('ul.myui-content__list');
      if (!epList) return;
      var epLinks = epList.querySelectorAll('li a.btn.btn-default[href*="/movie/play/"]');
      epLinks.forEach(function(aEl) {
        var href = (aEl.getAttribute('href') || '').trim();
        var title = (aEl.textContent || '').replace(/[\n\r\t]+/g, '').replace(/\s+/g, ' ').trim();
        // 过滤空白和超长文本
        if (title.length > 0 && title.length < 50 && !seen[href]) {
          seen[href] = true;
          if (!href.startsWith('http')) href = 'https://www.xiaobaotv.tv' + href;
          currentEpisodes.push({ title: title, url: href });
        }
      });
    });

    // 保存最后一个 source
    if (currentEpisodes.length > 0) {
      sources.push({ name: currentSourceName, episodes: currentEpisodes });
    }
  }

  // 方法2（备选）：宽泛扫描所有 .myui-content__list
  if (sources.length === 0) {
    var allLists = doc.querySelectorAll('.myui-content__list');
    console.log('[parseDetail M2] .myui-content__list=' + allLists.length);
    var seenAll = {};
    var defaultSrc = { name: '默认线路', episodes: [] };
    allLists.forEach(function(list) {
      var links = list.querySelectorAll('a[href*="/movie/play/"]');
      links.forEach(function(aEl) {
        var href = (aEl.getAttribute('href') || '').trim();
        var title = (aEl.textContent || '').replace(/[\n\r\t]+/g, '').replace(/\s+/g, ' ').trim();
        if (title.length > 0 && title.length < 50 && !seenAll[href]) {
          seenAll[href] = true;
          if (!href.startsWith('http')) href = 'https://www.xiaobaotv.tv' + href;
          defaultSrc.episodes.push({ title: title, url: href });
        }
      });
    });
    if (defaultSrc.episodes.length > 0) sources.push(defaultSrc);
  }

  // 方法3（备选）：全页扫描 a[href*="/movie/play/"] + 集数关键词
  if (sources.length === 0) {
    console.log('[parseDetail M3] 触发（全页扫描）');
    var seenAny = {};
    var fullSrc = { name: '默认线路', episodes: [] };
    doc.querySelectorAll('a[href*="/movie/play/"]').forEach(function(aEl) {
      var href = (aEl.getAttribute('href') || '').trim();
      var title = (aEl.textContent || '').replace(/[\n\r\t]+/g, '').replace(/\s+/g, ' ').trim();
      if (title.length > 0 && title.length < 50 && !seenAny[href] &&
          title.match(/^(第[\d一二三四五六七八九十零]+集|第?\d{1,3}(?:集|话|期)|第\d+话)/)) {
        seenAny[href] = true;
        if (!href.startsWith('http')) href = 'https://www.xiaobaotv.tv' + href;
        fullSrc.episodes.push({ title: title, url: href });
      }
    });
    if (fullSrc.episodes.length > 0) sources.push(fullSrc);
  }

  // 方法4（备选）：mac_player_list JS 全局变量
  if (sources.length === 0) {
    console.log('[parseDetail M4] 触发（JS变量扫描）');
    var listMatch = html.match(/mac_player_list\s*=\s*(\{[\s\S]*?\})\s*;/) ||
                    html.match(/mac_player_list\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (listMatch) {
      try {
        var raw = listMatch[1].replace(/\\u([0-9a-fA-F]{4})/g, function(_, code) {
          return String.fromCharCode(parseInt(code, 16));
        });
        raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        var list = JSON.parse(raw);
        var jsSrc = { name: '默认线路', episodes: [] };
        var seenJs = {};
        if (Array.isArray(list)) {
          list.forEach(function(item) {
            if (item.url && item.name && !seenJs[item.url]) {
              seenJs[item.url] = true;
              var href = item.url.startsWith('http') ? item.url : 'https://www.xiaobaotv.tv' + item.url;
              jsSrc.episodes.push({ title: item.name, url: href });
            }
          });
        } else if (typeof list === 'object') {
          Object.keys(list).forEach(function(k) {
            var item = list[k];
            if (item.url && item.name && !seenJs[item.url]) {
              seenJs[item.url] = true;
              var href = item.url.startsWith('http') ? item.url : 'https://www.xiaobaotv.tv' + item.url;
              jsSrc.episodes.push({ title: item.name, url: href });
            }
          });
        }
        if (jsSrc.episodes.length > 0) sources.push(jsSrc);
      } catch(e) {}
    }
  }

  console.log('[parseDetail] 最终返回 sources.length=' + sources.length, '线路');
  if (sources.length > 0) {
    sources.forEach(function(s, i) { console.log('[parseDetail]  线路' + i + ': "' + s.name + '" — ' + s.episodes.length + ' 集'); });
  } else {
    console.log('[parseDetail] 全部方法失败！HTML前500字符:');
    console.log(html.substring(0, 500));
  }
  return sources;
}

// ─── 筛选选项解析（地区 + 年份）────────────────────────────────────────────
function parseFilter(html) {
  var doc = makeDoc(html);
  var areas = [], years = [];
  var seenAreas = {}, seenYears = {};

  // 地区链接：/movie/show/<id>/area/<area>.html 或 /movie/type/<id>/area/<area>.html
  doc.querySelectorAll('a[href*="/area/"]').forEach(function(el) {
    var href = el.getAttribute('href') || '';
    var m = href.match(/\/area\/([^/]+)/);
    if (!m) return;
    var v;
    try { v = decodeURIComponent(m[1]); } catch(_e) { v = m[1]; }
    v = (v || '').trim();
    if (v && !seenAreas[v]) { seenAreas[v] = true; areas.push(v); }
  });

  // 年份链接：/year/<year>.html
  doc.querySelectorAll('a[href*="/year/"]').forEach(function(el) {
    var href = el.getAttribute('href') || '';
    var m = href.match(/\/year\/(\d{4})/);
    if (m && !seenYears[m[1]]) { seenYears[m[1]] = true; years.push(m[1]); }
  });

  // 排序：年份降序（最新的在前）
  years.sort(function(a, b) { return Number(b) - Number(a); });
  // 地区按字符串排序
  areas.sort();

  return { areas: areas, years: years };
}

// ─── 播放页 Stream Info 解析 ──────────────────────────────────────────────
// xiaobaotv.tv 的播放器信息存储在 mac_player_info 全局变量中
// 这是 MacCMS 的标准格式，小宝影院通常使用 encrypt=0（明文）或 encrypt=1（decodeURIComponent）
//
// encrypt 类型说明：
//   0 = 明文 URL，直接使用
//   1 = encodeURIComponent 编码，需要 decodeURIComponent
//   2 = base64 编码（二进制模式）
//   3 = base64 编码（UTF-8 模式）
function parseStreamInfo(html) {
  var streamUrl = null;
  var encrypt = 0;
  var playerFrom = '';

  // 匹配 mac_player_info = {...} JSON 块（支持多行）
  // 先用贪婪匹配，如果失败再用非贪婪
  var blockMatch = html.match(/mac_player_info\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!blockMatch) {
    blockMatch = html.match(/mac_player_info\s*=\s*(\{[^;]+\})/);
  }
  // 也尝试 player_info（某些站点变量名不同）
  if (!blockMatch) {
    blockMatch = html.match(/player_info\s*=\s*(\{[\s\S]*?\})\s*;/);
  }
  if (!blockMatch) {
    blockMatch = html.match(/player_info\s*=\s*(\{[^;]+\})/);
  }

  if (blockMatch) {
    try {
      var raw = blockMatch[1];
      // 处理 unicode escape: \uXXXX
      raw = raw.replace(/\\u([0-9a-fA-F]{4})/g, function(_, code) {
        return String.fromCharCode(parseInt(code, 16));
      });
      // 处理 HTML 实体编码
      raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      var info = JSON.parse(raw);
      if (info.url) {
        streamUrl = info.url;
        encrypt = parseInt(info.encrypt) || 0;
        playerFrom = info.from || '';
      }
      // 某些站把 URL 放在 url2 或 play_url 字段
      if (!streamUrl && info.url2) {
        streamUrl = info.url2;
        encrypt = parseInt(info.encrypt2) || encrypt;
      }
      if (!streamUrl && info.play_url) {
        streamUrl = info.play_url;
        encrypt = parseInt(info.encrypt) || encrypt;
      }
    } catch(e) {
      console.warn('[parseStreamInfo] JSON parse failed:', e.message);
    }
  }

  return { streamUrl: streamUrl, encrypt: encrypt, from: playerFrom };
}

// ─── Stream URL 解密 ────────────────────────────────────────────────────────
function decryptStreamUrl(raw, encrypt) {
  if (!raw) return null;
  var url = raw;

  switch (encrypt) {
    case 0: // 明文
      break;
    case 1: // encodeURIComponent
      try { url = decodeURIComponent(url); } catch(e) {}
      break;
    case 2: // base64 → binary string → escape → unescape
      try {
        url = decodeURIComponent(escape(atob(url)));
      } catch(e) {
        console.warn('[decrypt] encrypt=2 failed:', e.message);
      }
      break;
    case 3: // base64 → UTF-8 string
      try {
        url = atob(url);
        // 尝试将 binary string 转为 UTF-8
        try { url = decodeURIComponent(escape(url)); } catch(_e) {}
      } catch(e) {
        console.warn('[decrypt] encrypt=3 failed:', e.message);
      }
      break;
    default:
      // 尝试自动检测：如果是 base64 格式则尝试解码
      if (raw.length > 20 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
        try {
          var decoded = atob(raw);
          // 如果解码后看起来像 URL
          if (decoded.indexOf('http') !== -1 || decoded.indexOf('.m3u8') !== -1) {
            url = decoded;
            encrypt = 3; // 标记为已解码
          }
        } catch(e) {}
      }
  }

  return url;
}

// ─── 验证 m3u8 URL ──────────────────────────────────────────────────────────
// xiaobaotv.tv 的 m3u8 URL 通常以 .m3u8 结尾，前面是 http(s)://
function isValidM3u8Url(url) {
  if (!url || typeof url !== 'string') return false;
  // 基本格式验证
  if (!/^https?:\/\//.test(url)) return false;
  // m3u8 后缀或 query string 中包含 m3u8
  var u = url.toLowerCase();
  if (u.indexOf('.m3u8') === -1) return false;
  // 排除明显的非媒体 URL
  var blocked = ['ad.', 'stats.', 'analytics.', 'track.', 'click.', 'popup.', 'union.'];
  for (var i = 0; i < blocked.length; i++) {
    if (u.indexOf(blocked[i]) !== -1) return false;
  }
  return true;
}

// ─── 从解密后的字符串中提取 m3u8 URL ───────────────────────────────────────
function extractM3u8FromString(str) {
  if (!str || typeof str !== 'string') return null;
  var m = str.match(/https?:\/\/[^\s"'<>]+(?:\.m3u8[^\s"'<>]*)/g);
  if (m && m.length > 0) {
    // 返回第一个看起来合理的 m3u8 URL
    for (var i = 0; i < m.length; i++) {
      if (isValidM3u8Url(m[i])) return m[i];
    }
    // 如果没有严格匹配的，至少返回第一个
    return m[0];
  }
  return null;
}

// ─── 完整解析流程（main.js sniffer 使用）─────────────────────────────────────
function extractStreamFromHtml(html) {
  var info = parseStreamInfo(html);
  if (!info.streamUrl) return null;

  var url = decryptStreamUrl(info.streamUrl, info.encrypt);

  // 如果解密后不是有效 URL，尝试从字符串中提取
  if (!isValidM3u8Url(url)) {
    var extracted = extractM3u8FromString(url);
    if (extracted) url = extracted;
  }

  if (isValidM3u8Url(url)) {
    return { url: url, from: info.from, encrypt: info.encrypt };
  }

  return null;
}

// ─── 搜索页解析 ─────────────────────────────────────────────────────────────
// xiaobaotv.tv 搜索页面是标准 HTML，解析方式与列表页相同
function parseSearch(html) {
  var res = parseCards(html);
  return { items: res, hasMore: hasNextPage(html) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 导出所有解析函数，供 renderer.js 和 main.js 调用
// 浏览器环境：通过 window. 暴露
// ═══════════════════════════════════════════════════════════════════════════
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseCards:            parseCards,
    hasNextPage:           hasNextPage,
    parseDetail:           parseDetail,
    parseFilter:           parseFilter,
    parseStreamInfo:       parseStreamInfo,
    decryptStreamUrl:      decryptStreamUrl,
    isValidM3u8Url:        isValidM3u8Url,
    extractM3u8FromString: extractM3u8FromString,
    extractStreamFromHtml: extractStreamFromHtml,
    parseSearch:           parseSearch,
  };
} else {
  // 浏览器环境：挂载到 window（供 <script src> 方式加载）
  window.parseCards            = parseCards;
  window.hasNextPage           = hasNextPage;
  window.parseDetail           = parseDetail;
  window.parseFilter           = parseFilter;
  window.parseStreamInfo       = parseStreamInfo;
  window.decryptStreamUrl      = decryptStreamUrl;
  window.isValidM3u8Url        = isValidM3u8Url;
  window.extractM3u8FromString = extractM3u8FromString;
  window.extractStreamFromHtml = extractStreamFromHtml;
  window.parseSearch           = parseSearch;
}
