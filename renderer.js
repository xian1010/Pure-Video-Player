'use strict';

// ── SHARED_UA: must match exactly what main.js uses ──────────────────────────
const SHARED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ── remote-logic.js: xiaobaotv.tv 解析引擎（秒开优化 + 多重备选选择器）────────
// remote-logic.js 通过 <script src> 加载，挂载在 window 上
// 注意：必须等 remote-logic.js 执行完才能访问，所以放在文件顶部靠前位置
function getRemoteLogic() {
  return {
    parseCards:   typeof window.parseCards   === 'function' ? window.parseCards   : function(h) { return []; },
    hasNextPage:  typeof window.hasNextPage  === 'function' ? window.hasNextPage  : function(h) { return false; },
    parseDetail:  typeof window.parseDetail  === 'function' ? window.parseDetail  : function(h) { return []; },
    parseFilter:  typeof window.parseFilter  === 'function' ? window.parseFilter  : function(h) { return { areas: [], years: [] }; },
    extractStreamFromHtml: typeof window.extractStreamFromHtml === 'function' ? window.extractStreamFromHtml : function(h) { return null; },
    isValidM3u8Url: typeof window.isValidM3u8Url === 'function' ? window.isValidM3u8Url : function(u) { return u && /^https?:\/\//.test(u) && u.toLowerCase().indexOf('.m3u8') !== -1; },
  };
}

const catalogView = document.getElementById('catalog-view');
const playerView = document.getElementById('player-view');
const cardGrid = document.getElementById('card-grid');
const gridEmpty = document.getElementById('grid-empty');
const emptyMsg = document.getElementById('empty-msg');
const loadMoreBtn = document.getElementById('load-more-btn');
const catalogStatus = document.getElementById('catalog-status');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const catTabs = document.querySelectorAll('.cat-tab');
const scrollSentinel = document.getElementById('scroll-sentinel');
const gridScroll = document.getElementById('grid-scroll');

const backBtn = document.getElementById('back-btn');
const playerUrlInput = document.getElementById('player-url-input');
const playerLoadBtn = document.getElementById('player-load-btn');
const playerStatusBar = document.getElementById('player-status-bar');
const statusText = document.getElementById('status-text');
const spinner = document.getElementById('spinner');
const playerPlaceholder = document.getElementById('player-placeholder');
const epContainer = document.getElementById('episode-list-container');
const epGrid = document.getElementById('episode-grid');
const sourceTabBar = document.getElementById('source-tab-bar');
const filterBar = document.getElementById('filter-bar');
const areaChips = document.getElementById('area-chips');
const yearChips = document.getElementById('year-chips');
const subcatRow = document.getElementById('subcat-row');
const subcatChips = document.getElementById('subcat-chips');
const epSortBtn = document.getElementById('ep-sort-btn');
const skipOpInput = document.getElementById('skip-op-input');
const skipEdInput = document.getElementById('skip-ed-input');
const skipClearBtn = document.getElementById('skip-clear-btn');

// ─── App State ────────────────────────────────────────────────────────────────
let currentParams = {
  baseCatId: 0,  // 顶层频道 tab 的 ID（0=全部, 1=电影, 2=电视剧, 3=综艺, 4=动漫, 5=短剧）
  id: 0,         // 实际请求 ID（可能是子分类）
  area: '',
  year: '',
  page: 1,
  isSearch: false,
  query: '',
  isFavorites: false
};

const state = {
  view: 'catalog',
  hasMore: false,
  loading: false,
  scrollTop: 0,
  pageLoaded: false,
};

let currentFetchId = 0;

// ─── Simple fetch — xiaobaotv.tv has no Cloudflare ─────────────────────────────
async function fetchHTML(url) {
  var resp = await window.electronAPI.mainFetch(url);
  var status = resp.status;
  var txt = resp.body || '';

  console.log('[Renderer] fetchHTML status=' + status + ' body=' + txt.length + ' isCF=' + resp.isCF);

  if (status === 0 && resp.error) {
    console.error('[Renderer] fetch error: ' + resp.error);
    throw new Error(resp.error);
  }

  return txt;
}

// ─── DOM Parsers for xiaobaotv.tv (via remote-logic.js) ──────────────────────
// All parsers are imported from remote-logic.js at the top of this file.
// Legacy inline functions kept as fallbacks only.
// ─── Legacy fallback parsers (used only if remote-logic.js is unavailable) ───
function _legacyParseCards(html) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(html, 'text/html');
  var cards = [];
  // xiaobaotv.tv uses: ul.myui-vodlist li.col-lg-8 a.myui-vodlist__thumb
  var els = doc.querySelectorAll('ul.myui-vodlist li a.myui-vodlist__thumb');
  els.forEach(function(el) {
    var href = (el.getAttribute('href') || '').trim();
    if (!href.includes('/movie/detail/')) return;
    var poster = (el.getAttribute('data-original') || '').trim();
    if (poster && !poster.startsWith('http')) {
      if (poster.startsWith('/')) poster = 'https://www.xiaobaotv.tv' + poster;
      else poster = 'https://www.xiaobaotv.tv/' + poster;
    }
    var title = el.getAttribute('title') || '';
    if (!title) {
      var titleEl = el.querySelector('span.pic-text');
      if (titleEl) title = titleEl.textContent.trim();
    }
    var badge = '';
    var tagEl = el.querySelector('span.pic-tag-top span.tag');
    if (tagEl) badge = tagEl.textContent.trim();
    if (title && href.includes('/movie/detail/')) {
      if (!href.startsWith('http')) href = 'https://www.xiaobaotv.tv' + href;
      cards.push({ title: title, url: href, poster: poster, badge: badge });
    }
  });
  var nextLink = doc.querySelector('a[href*="/movie/type/"][href*=".html"]:not([href*="page=1"])');
  var nextPage = false;
  if (nextLink) {
    var href = nextLink.getAttribute('href');
    nextPage = href && !href.includes('-1.html');
  }
  if (!nextPage) {
    var pageLinks = doc.querySelectorAll('a.myui-page__a');
    for (var i = 0; i < pageLinks.length; i++) {
      var ph = pageLinks[i].getAttribute('href') || '';
      if (ph.includes('type/') && (ph.match(/type\/\d+-\d+\.html/) || ph.match(/show\/\d+-\d+\.html/))) {
        nextPage = true; break;
      }
    }
  }
  return { cards: cards, nextPage: nextPage };
}

function _legacyParseDetail(html) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(html, 'text/html');
  var sources = [];
  var playLinks = doc.querySelectorAll('a[href*="/movie/play/"]').length;
  var panelCount = doc.querySelectorAll('div.myui-panel').length;
  var ulCount = doc.querySelectorAll('ul').length;
  var btnLinks = doc.querySelectorAll('a.btn').length;
  console.log('[LEGACY parseDetail] HTML长度=' + html.length + ' | play链接=' + playLinks + ' | myui-panel=' + panelCount + ' | ul=' + ulCount + ' | a.btn=' + btnLinks);
  var panels = doc.querySelectorAll('div.myui-panel');
  var currentSourceName = '默认线路';
  var currentEpisodes = [];
  var seen = {};
  panels.forEach(function(panel) {
    var epLinks = panel.querySelectorAll('a[href*="/movie/play/"]');
    if (epLinks.length === 0) return;
    var heading = panel.querySelector('h3, .myui-panel__head, .myui-panel__box h3, h3.title');
    if (heading) {
      var hText = heading.textContent.replace(/[\n\r\s]+/g, '').trim();
      if (hText && hText !== '猜你喜欢' && hText !== '剧情简介' && hText !== '本月热门' && hText !== '香港剧本周热播') {
        currentSourceName = hText;
      }
    }
    epLinks.forEach(function(aEl) {
      var href = aEl.getAttribute('href') || '';
      var title = aEl.textContent.trim() || '';
      if (title.length < 40 && !seen[href]) {
        seen[href] = true;
        if (!href.startsWith('http')) href = 'https://www.xiaobaotv.tv' + href;
        currentEpisodes.push({ title: title, url: href });
      }
    });
  });
  if (currentEpisodes.length === 0) {
    var allLinks = doc.querySelectorAll('a[href*="/movie/play/"]');
    var defaultSrc = { name: '默认线路', episodes: [] };
    var seenEp = {};
    allLinks.forEach(function(aEl) {
      var href = aEl.getAttribute('href') || '';
      var title = aEl.textContent.trim() || '';
      if (title.length < 40 && !seenEp[href]) {
        seenEp[href] = true;
        if (!href.startsWith('http')) href = 'https://www.xiaobaotv.tv' + href;
        defaultSrc.episodes.push({ title: title, url: href });
      }
    });
    if (defaultSrc.episodes.length > 0) sources.push(defaultSrc);
  } else if (currentEpisodes.length > 0) {
    sources.push({ name: currentSourceName, episodes: currentEpisodes });
  }
  console.log('[LEGACY parseDetail] 返回 sources.length=' + sources.length);
  if (sources.length > 0) {
    sources.forEach(function(s, i) { console.log('[LEGACY]  线路' + i + ': "' + s.name + '" — ' + s.episodes.length + ' 集'); });
  }
  return sources;
}

function _legacyParseFilter(html) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(html, 'text/html');
  var areas = [], years = [];
  var seenAreas = {}, seenYears = {};
  doc.querySelectorAll('a[href*="/movie/show/"][href*="/area/"]').forEach(function(el) {
    var m = el.getAttribute('href').match(/\/area\/([^./]+)/);
    if (!m) return;
    var v;
    try { v = decodeURIComponent(m[1]); } catch(_e) { v = m[1]; }
    if (v && !seenAreas[v]) { seenAreas[v] = true; areas.push(v); }
  });
  doc.querySelectorAll('a[href*="/movie/show/"][href*="/year/"]').forEach(function(el) {
    var m = el.getAttribute('href').match(/\/year\/(\d{4})/);
    if (m && !seenYears[m[1]]) { seenYears[m[1]] = true; years.push(m[1]); }
  });
  years.sort(function(a, b) { return Number(b) - Number(a); });
  return { areas: areas, years: years };
}

// ─── Unified card parser (remote-logic primary, legacy fallback) ─────────────
function unifiedParseCards(html) {
  var rl = getRemoteLogic();
  var result = rl.parseCards(html);
  if (result && result.length > 0 && typeof result[0] === 'object' && result[0].title) {
    // remote-logic returned cards array directly — wrap it with nextPage
    var np = false;
    try { np = rl.hasNextPage(html); } catch(e) {}
    return { cards: result, nextPage: np };
  }
  // remote-logic returned { cards, nextPage } object
  if (result && Array.isArray(result.cards)) return result;
  // Fallback to legacy
  return _legacyParseCards(html);
}

// ─── Unified detail parser ───────────────────────────────────────────────────
function unifiedParseDetail(html) {
  var rl = getRemoteLogic();
  var result = rl.parseDetail(html);
  console.log('[DEBUG unifiedParseDetail] 方法1结果:', result && result.length, 'sources');
  if (result && Array.isArray(result) && result.length > 0) return result;

  // 也试 legacy
  var legacy = _legacyParseDetail(html);
  console.log('[DEBUG unifiedParseDetail] legacy 结果:', legacy && legacy.length, 'sources');
  if (legacy && Array.isArray(legacy) && legacy.length > 0) return legacy;
  return [];
}

// ─── Unified filter parser ───────────────────────────────────────────────────
function unifiedParseFilter(html) {
  var rl = getRemoteLogic();
  var result = rl.parseFilter(html);
  if (result && (Array.isArray(result.areas) || Array.isArray(result.years))) return result;
  return _legacyParseFilter(html);
}

let epSortDesc = false;
let opSkipped = false;
let edSkipTriggered = false;
let currentSourceEpisodes = [];

let currentVodID = '';
let currentEpIndex = 0;
let currentEpUrl = '';
let sniffFallbackCount = 0;
let lastWatchedTime = 0;
let hasRestoredTime = false;
let saveHistoryInterval = null;

function clearSaveHistoryInterval() {
  if (saveHistoryInterval) clearInterval(saveHistoryInterval);
  saveHistoryInterval = null;
}

// ─── Sub-category definitions per channel ─────────────────────────────────────
// xiaobaotv.tv: movie/type/<id>.html
const SUBCAT_DEFS = {
  1: [ // 电影
    { label: '全部', id: 1 },
  ],
  2: [ // 电视剧
    { label: '全部', id: 2 },
  ],
  3: [ // 综艺
    { label: '全部', id: 3 },
  ],
  4: [ // 动漫
    { label: '全部', id: 4 },
  ],
  5: [ // 短剧
    { label: '全部', id: 5 },
  ],
};

function renderSubcatRow(baseCatId) {
  const defs = SUBCAT_DEFS[baseCatId];
  if (!defs || defs.length <= 1) {
    subcatRow.style.display = 'none';
    return;
  }
  subcatRow.style.display = 'flex';
  subcatChips.innerHTML = '';
  defs.forEach((def, i) => {
    const btn = document.createElement('button');
    btn.className = 'filter-chip' + (i === 0 ? ' active' : '');
    btn.dataset.val = String(def.id);
    btn.textContent = def.label;
    subcatChips.appendChild(btn);
  });
}

const CAT_IDS = { 0: [1], 1: [1], 2: [2], 3: [3], 4: [4], 5: [5] };

// ─── Filter helpers ────────────────────────────────────────────────────────────
function updateFilterBar() {
  const showFilter = !currentParams.isSearch && !currentParams.isFavorites && currentParams.baseCatId !== 0;
  filterBar.classList.toggle('hidden', !showFilter);
}

function renderFilterChips(container, values, activeVal) {
  container.innerHTML = '';
  ['', ...values].forEach(val => {
    const btn = document.createElement('button');
    btn.className = 'filter-chip' + (val === activeVal ? ' active' : '');
    btn.dataset.val = val;
    btn.textContent = val || '全部';
    container.appendChild(btn);
  });
}

async function loadFilterOptions(catId) {
  renderFilterChips(areaChips, [], '');
  renderFilterChips(yearChips, [], '');
  try {
    var html = await fetchHTML('https://www.xiaobaotv.tv/movie/type/' + catId + '.html');
    var opts = unifiedParseFilter(html);
    renderFilterChips(areaChips, (opts.areas || []).slice(0, 20), currentParams.area);
    renderFilterChips(yearChips, (opts.years || []).slice(0, 20), currentParams.year);
  } catch (err) {
    console.warn('[FilterOptions]', err);
  }
}

function resetFilterChips() {
  currentParams.area = '';
  currentParams.year = '';
  currentParams.id = currentParams.baseCatId;
  [areaChips, yearChips].forEach(container =>
    container.querySelectorAll('.filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0))
  );
  if (subcatChips) subcatChips.querySelectorAll('.filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
}

// ─── View Transitions ─────────────────────────────────────────────────────────
function showCatalog() {
  state.view = 'catalog';
  catalogView.classList.remove('hidden-left', 'hidden-right');
  playerView.classList.add('hidden-right');
  requestAnimationFrame(() => { gridScroll.scrollTop = state.scrollTop; });
  updateFilterBar();
}

function showPlayer(autoUrl = '') {
  state.scrollTop = gridScroll.scrollTop;
  state.view = 'player';
  playerView.classList.remove('hidden-right', 'hidden-left');
  catalogView.classList.add('hidden-left');
  if (autoUrl) playerUrlInput.value = autoUrl;
}

// ─── Card Rendering ──────────────────────────────────────────────────────────
const PROXY = (url) => url ? `imgproxy://${encodeURIComponent(url)}` : '';

function renderCards(items, append = false, forceClear = false) {
  if (!append) cardGrid.innerHTML = '';

  if (!items.length && !append && !forceClear && !currentParams.isSearch && !currentParams.isFavorites) {
    if (cardGrid.querySelector('.movie-card')) {
      loadMoreBtn.disabled = !state.hasMore;
      return;
    }
  }
  gridEmpty.classList.remove('show');

  const frag = document.createDocumentFragment();
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'movie-card';
    card.dataset.url = item.url;
    card.innerHTML = `
      <div class="card-poster">
        <img src="${PROXY(item.poster)}" alt="${escHtml(item.title)}" loading="lazy"
             onerror="this.style.display='none'"/>
        ${item.badge ? `<span class="card-badge">${escHtml(item.badge)}</span>` : ''}
        <button class="card-fav-btn${isFavorited(item.url) ? ' active' : ''}" title="收藏">★</button>
        <div class="card-play-overlay">
          <svg viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="11" fill="rgba(124,58,237,0.85)"/>
            <polygon points="10,7.5 17.5,12 10,16.5" fill="#fff"/>
          </svg>
        </div>
      </div>
      <div class="card-info">
        <div class="card-title" title="${escHtml(item.title)}">${escHtml(item.title)}</div>
      </div>`;
    card.addEventListener('click', () => onCardClick(item));

    const favBtn = card.querySelector('.card-fav-btn');
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowFaved = toggleFavorite(item);
      favBtn.classList.toggle('active', nowFaved);
      updateFavTabLabel();
      if (currentParams.isFavorites && !nowFaved) {
        card.remove();
        if (!cardGrid.querySelector('.movie-card')) {
          gridEmpty.classList.add('show');
          emptyMsg.textContent = '收藏夹是空的，点击卡片上的 ★ 来添加';
        }
      }
    });
    frag.appendChild(card);
  });
  cardGrid.appendChild(frag);

  loadMoreBtn.disabled = !state.hasMore;
}

function renderGhosts(n = 12) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const g = document.createElement('div');
    g.className = 'ghost-card';
    g.innerHTML = '<div class="ghost-poster"></div><div class="ghost-info"><div class="ghost-line"></div></div>';
    frag.appendChild(g);
  }
  cardGrid.appendChild(frag);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Favorites (localStorage) ─────────────────────────────────────────────────
const FAV_KEY = 'pvp_favorites';
function getFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; }
}
function saveFavorites(arr) { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); }
function isFavorited(url) { return getFavorites().some(f => f.url === url); }
function toggleFavorite(item) {
  const favs = getFavorites();
  const idx = favs.findIndex(f => f.url === item.url);
  if (idx >= 0) { favs.splice(idx, 1); saveFavorites(favs); return false; }
  favs.push({ title: item.title, url: item.url, poster: item.poster || '', badge: item.badge || '' });
  saveFavorites(favs);
  return true;
}
function updateFavTabLabel() {
  const n = getFavorites().length;
  document.getElementById('fav-tab').textContent = n > 0 ? `★ 我的收藏 (${n})` : '★ 我的收藏';
}

// ─── Skip Settings (localStorage) ────────────────────────────────────────────
const SKIP_KEY = 'pvp_skip';
function getSkipForVod(vodID) {
  try {
    const all = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}');
    return all[String(vodID)] || { op: 0, ed: 0 };
  } catch { return { op: 0, ed: 0 }; }
}
function setSkipForVod(vodID, op, ed) {
  try {
    const all = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}');
    all[String(vodID)] = { op: Math.max(0, Number(op) || 0), ed: Math.max(0, Number(ed) || 0) };
    localStorage.setItem(SKIP_KEY, JSON.stringify(all));
  } catch { }
}
function clearSkipForVod(vodID) {
  try {
    const all = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}');
    delete all[String(vodID)];
    localStorage.setItem(SKIP_KEY, JSON.stringify(all));
  } catch { }
}
function updateSkipUI() {
  const { op, ed } = getSkipForVod(currentVodID);
  skipOpInput.value = op;
  skipEdInput.value = ed;
}

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function reloadCatalog() {
  const fetchId = ++currentFetchId;
  state.loading = true;
  catalogStatus.textContent = '加载中…';
  loadMoreBtn.disabled = true;

  cardGrid.innerHTML = '';
  gridEmpty.classList.remove('show');
  renderGhosts();
  updateFilterBar();

  try {
    let allItems = [];
    let anyMore = false;

    if (currentParams.isFavorites) {
      allItems = getFavorites();
      anyMore = false;
    } else if (currentParams.isSearch) {
      // xiaobaotv.tv search: /search.html?wd=<query>
      var searchUrl = 'https://www.xiaobaotv.tv/search.html?wd=' + encodeURIComponent(currentParams.query);
      var html = await fetchHTML(searchUrl);
      var res = unifiedParseCards(html);
      allItems = res.cards;
      anyMore = res.nextPage;
    } else {
      var id = (currentParams.id === 0) ? currentParams.baseCatId : currentParams.id;
      if (id === 0) id = 1;
      var urlPath = '/movie/type/' + id;
      if (currentParams.area && currentParams.area !== '全部') urlPath += '/area/' + encodeURIComponent(currentParams.area);
      if (currentParams.year && currentParams.year !== '全部') urlPath += '/year/' + currentParams.year;
      urlPath += currentParams.page > 1 ? '-' + currentParams.page + '.html' : '.html';
      var html2 = await fetchHTML('https://www.xiaobaotv.tv' + urlPath);
      var res2 = unifiedParseCards(html2);
      allItems = res2.cards;
      anyMore = res2.nextPage;
    }

    if (fetchId !== currentFetchId) return;

    const ghosts = cardGrid.querySelectorAll('.ghost-card');
    ghosts.forEach(g => g.remove());

    state.hasMore = anyMore;
    renderCards(allItems, false);
    catalogStatus.textContent = '';

    const top3 = allItems.slice(0, 3).map(i => i.title).join(' | ');
    console.log('[Catalog] Parsed top 3: ' + (top3 || 'None'));

  } catch (err) {
    if (fetchId !== currentFetchId) return;
    const ghosts = cardGrid.querySelectorAll('.ghost-card');
    ghosts.forEach(g => g.remove());

    gridEmpty.classList.add('show');
    emptyMsg.innerHTML = '加载失败: ' + escHtml(err.message || String(err)) + '<br><br><button id="btn-retry-catalog" class="ep-btn" style="padding: 6px 16px; font-size: 14px; margin-top: 10px;">点击重试</button>';
    catalogStatus.textContent = '';

    const retryBtn = document.getElementById('btn-retry-catalog');
    if (retryBtn) retryBtn.addEventListener('click', () => reloadCatalog());
    console.error('[Catalog]', err);
  } finally {
    if (fetchId === currentFetchId) state.loading = false;
  }
}

async function loadPage(append = false) {
  if (state.loading && append) return;
  if (!append) return reloadCatalog();

  const fetchId = ++currentFetchId;
  state.loading = true;
  catalogStatus.textContent = '加载中…';
  loadMoreBtn.disabled = true;

  try {
    let allItems = [];
    let anyMore = false;

    if (currentParams.isFavorites) {
      allItems = getFavorites();
      anyMore = false;
    } else if (currentParams.isSearch) {
      var searchUrl = 'https://www.xiaobaotv.tv/search.html?wd=' + encodeURIComponent(currentParams.query);
      var html = await fetchHTML(searchUrl);
      var res = unifiedParseCards(html);
      allItems = res.cards;
      anyMore = res.nextPage;
    } else {
      var id = (currentParams.id === 0) ? currentParams.baseCatId : currentParams.id;
      if (id === 0) id = 1;
      var urlPath = '/movie/type/' + id;
      if (currentParams.area && currentParams.area !== '全部') urlPath += '/area/' + encodeURIComponent(currentParams.area);
      if (currentParams.year && currentParams.year !== '全部') urlPath += '/year/' + currentParams.year;
      urlPath += currentParams.page > 1 ? '-' + currentParams.page + '.html' : '.html';
      var html2 = await fetchHTML('https://www.xiaobaotv.tv' + urlPath);
      var res2 = unifiedParseCards(html2);
      allItems = res2.cards;
      anyMore = res2.nextPage;
    }

    if (fetchId !== currentFetchId) return;

    state.hasMore = anyMore;
    renderCards(allItems, true);
    catalogStatus.textContent = '';

  } catch (err) {
    if (fetchId !== currentFetchId) return;
    catalogStatus.innerHTML = '追加失败: ' + escHtml(err.message || String(err)) + ' <button id="btn-retry-loadmore" style="margin-left:10px; padding:4px 12px; font-size:12px; border-radius:15px; background:linear-gradient(45deg, #7c3aed, #ec4899); border:none; color:white; cursor:pointer;">点击重试</button>';
    var retryBtn = document.getElementById('btn-retry-loadmore');
    if (retryBtn) retryBtn.addEventListener('click', loadMore);
    console.error('[loadMore]', err);
  } finally {
    if (fetchId === currentFetchId) state.loading = false;
  }
}

async function loadMore() {
  currentParams.page++;
  await loadPage(true);
}

// ─── Fetch Episodes ──────────────────────────────────────────────────────────
function fetchEpisodes(url) {
  epContainer.classList.add('hidden');
  epGrid.innerHTML = '';
  sourceTabBar.innerHTML = '';
  sourceTabBar.classList.add('hidden');

  // xiaobaotv.tv: /movie/detail/<id>.html → extract vodID
  currentVodID = url;
  var m = url.match(/\/movie\/detail\/(\d+)/);
  if (m) currentVodID = m[1];

  lastWatchedTime = 0;
  hasRestoredTime = false;
  currentEpIndex = 0;
  updateSkipUI();

  if (url.includes('/movie/detail/')) {
    setPlayerLoading(true);
    setPlayerStatus('🔍 获取剧集列表…', 'loading');

    Promise.all([
      fetchHTML(url).then(function(html) {
        // ─── 强力诊断：打印原始 HTML ─────────────────────────────────────────
        console.log('--- RAW HTML START ---');
        console.log(html.substring(0, 8000));
        console.log('--- RAW HTML END ---');

        // ─── 模糊匹配：扫描 HTML 中所有 /movie/play/ 链接 ───────────────────
        var allPlayLinks = html.match(/href="([^"]*\/movie\/play\/[^"]+)"/gi) || [];
        var uniqueLinks = {};
        allPlayLinks.forEach(function(m) {
          var u = m.match(/href="([^"]+)"/);
          if (u) uniqueLinks[u[1]] = true;
        });
        var linkCount = Object.keys(uniqueLinks).length;
        console.log('[DEBUG] /movie/play/ 链接总数（去重后）:', linkCount);
        console.log('[DEBUG] 前 20 个链接:', Object.keys(uniqueLinks).slice(0, 20));

        // ─── 扫描 HTML 中包含 /movie/play/ 的行 ─────────────────────────────
        var lines = html.split('\n');
        var playLines = lines.filter(function(l) { return l.indexOf('/movie/play/') !== -1; });
        console.log('[DEBUG] 含 /movie/play/ 的行数:', playLines.length);
        if (playLines.length > 0) {
          console.log('[DEBUG] 前 5 行含 play 的 HTML:');
          playLines.slice(0, 5).forEach(function(l) { console.log(l.replace(/</g, '&lt;').substring(0, 300)); });
        }

        // ─── 扫描集数文字（第X集） ─────────────────────────────────────────
        var jiMatches = html.match(/["']第[\u4e00-\u9fa5a-zA-Z\d]+集["']/g) || [];
        console.log('[DEBUG] 集数文字匹配:', jiMatches.slice(0, 10));

        return { sources: unifiedParseDetail(html) };
      }),
      window.electronAPI.getHistory(currentVodID)
    ]).then(([res, history]) => {
      if (state.view !== 'player') return;

      setPlayerLoading(false);
      clearPlayerStatus();
      const sources = res.sources || [];
      if (sources.length === 0) {
        // parseDetail 失败时不传 detail URL 给嗅探器（会超时）
        // 只提示用户
        setPlayerStatus('无法解析集数列表，请尝试直接粘贴播放链接', 'error');
        showToast('无法解析集数列表，请尝试直接粘贴播放链接', 'error');
        playerPlaceholder.classList.remove('hidden');
        return;
      }

      if (history) {
        currentEpIndex = history.episodeIndex || 0;
        lastWatchedTime = history.currentTime || 0;
      }

      epContainer.classList.remove('hidden');

      const preferred = localStorage.getItem('pvp_preferred_source') || '';
      let activeIdx = 0;
      if (preferred) {
        const found = sources.findIndex(s => s.name === preferred);
        if (found !== -1) activeIdx = found;
      }

      if (sources[activeIdx] && sources[activeIdx].episodes[currentEpIndex]) {
        currentEpUrl = sources[activeIdx].episodes[currentEpIndex].url;
      }

      if (sources.length > 1) {
        sourceTabBar.classList.remove('hidden');
        sources.forEach((src, i) => {
          const btn = document.createElement('button');
          btn.className = 'source-tab' + (i === activeIdx ? ' active' : '');
          btn.textContent = src.name;
          btn.onclick = () => {
            sourceTabBar.querySelectorAll('.source-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            localStorage.setItem('pvp_preferred_source', src.name);
            renderSourceEpisodes(src.episodes, currentEpIndex);
            // 切换线路后自动点击第一集开始嗅探
            setTimeout(function() {
              var first = epGrid.querySelector('.ep-btn');
              if (first) first.click();
            }, 80);
          };
          sourceTabBar.appendChild(btn);
        });
      }

      renderSourceEpisodes(sources[activeIdx].episodes, currentEpIndex);

      setTimeout(() => {
        if (state.view !== 'player') return;
        const activeBtn = epGrid.querySelector('.ep-btn.active');
        if (activeBtn) activeBtn.click();
      }, 50);

    }).catch(() => {
      if (state.view !== 'player') return;
      setPlayerLoading(true);
      setPlayerStatus('⚡ 正在尝试直接提取播放源…', 'loading');
      setTimeout(() => triggerSniff(url), 500);
    });
  } else {
    triggerSniff(url);
  }
}

function renderSourceEpisodes(episodes, activeIndex = 0) {
  currentSourceEpisodes = episodes;
  epSortDesc = false;
  if (epSortBtn) { epSortBtn.textContent = '正序 ⇅'; epSortBtn.classList.remove('desc'); }
  _renderEpBtns(episodes, activeIndex);
}

function _renderEpBtns(episodes, activeIndex = 0) {
  epGrid.innerHTML = '';
  episodes.forEach((ep, i) => {
    const originalIdx = epSortDesc ? episodes.length - 1 - i : i;
    const btn = document.createElement('button');
    btn.className = 'ep-btn';
    btn.textContent = ep.title;
    btn.dataset.url = ep.url;

    if (originalIdx === activeIndex) {
      btn.classList.add('active');
      if (lastWatchedTime > 0) {
        btn.style.boxShadow = 'inset 0 0 0 1px rgba(124,58,237,0.8)';
        btn.innerHTML += `<span style="font-size:10px; margin-left:4px; opacity:0.8;">(上次观看)</span>`;
      }
    }

    btn.onclick = () => {
      document.querySelectorAll('.ep-btn').forEach(b => {
        b.classList.remove('active');
        b.style.boxShadow = '';
        const idx = b.innerHTML.indexOf('<span');
        if (idx !== -1) b.innerHTML = b.innerHTML.substring(0, idx);
      });
      btn.classList.add('active');

      if (originalIdx !== activeIndex) {
        lastWatchedTime = 0;
        hasRestoredTime = false;
      }
      currentEpIndex = originalIdx;
      currentEpUrl = ep.url;
      sniffFallbackCount = 0;

      const activeSourceBtn = document.querySelector('#source-tab-bar .source-tab.active');
      const sourceName = activeSourceBtn ? activeSourceBtn.textContent : '';
      triggerSniff(ep.url, sourceName);
    };
    epGrid.appendChild(btn);
  });
}

// ─── Card Click ───────────────────────────────────────────────────────────────
let currentItem = null;

function onCardClick(item) {
  currentItem = item;
  showPlayer(item.url);
  const playerFavBtn = document.getElementById('player-fav-btn');
  if (playerFavBtn) {
    playerFavBtn.classList.toggle('active', isFavorited(item.url));
    playerFavBtn.title = isFavorited(item.url) ? '取消收藏' : '收藏';
  }
  fetchEpisodes(item.url);
}

// ─── Category Tabs ───────────────────────────────────────────────────────────
catTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    catTabs.forEach(t => t.classList.remove('active'));
    document.getElementById('fav-tab').classList.remove('active');
    tab.classList.add('active');

    currentParams.baseCatId = Number(tab.dataset.cat);
    currentParams.id = Number(tab.dataset.cat);
    currentParams.page = 1;
    currentParams.isSearch = false;
    currentParams.isFavorites = false;
    currentParams.query = '';
    state.pageLoaded = false;

    renderSubcatRow(currentParams.baseCatId);
    searchInput.value = '';
    resetFilterChips();
    gridScroll.scrollTop = 0;
    if (currentParams.baseCatId !== 0) loadFilterOptions(currentParams.baseCatId);
    reloadCatalog();
  });
});

// ─── Favorites Tab ────────────────────────────────────────────────────────────
const favTab = document.getElementById('fav-tab');
updateFavTabLabel();
favTab.addEventListener('click', () => {
  catTabs.forEach(t => t.classList.remove('active'));
  favTab.classList.add('active');

  currentParams.isFavorites = true;
  currentParams.isSearch = false;
  currentParams.query = '';
  currentParams.page = 1;
  state.pageLoaded = false;

  gridScroll.scrollTop = 0;
  reloadCatalog();
});

// ─── Search ─────────────────────────────────────────────────────────────────
let searchTimer = null;
function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  catTabs.forEach(t => t.classList.remove('active'));
  favTab.classList.remove('active');

  currentParams.isSearch = true;
  currentParams.isFavorites = false;
  currentParams.query = q;
  currentParams.page = 1;
  currentParams.id = 0;
  state.pageLoaded = false;

  gridScroll.scrollTop = 0;
  console.log('[Search] Triggered, currentParams:', JSON.stringify(currentParams));
  reloadCatalog();
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (!searchInput.value.trim()) return;
  searchTimer = setTimeout(doSearch, 500);
});

// ─── Filter Chips ─────────────────────────────────────────────────────────────
filterBar.addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  const inSubcat = chip.closest('#subcat-chips');
  const inArea = chip.closest('#area-chips');
  const inYear = chip.closest('#year-chips');
  const container = inSubcat || inArea || inYear;
  if (!container) return;

  if (chip.classList.contains('active')) return;

  container.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');

  const val = chip.dataset.val;

  if (inSubcat) {
    currentParams.id = parseInt(val, 10);
    currentParams.area = '';
    currentParams.year = '';
    areaChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.val === ''));
    yearChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.val === ''));
    loadFilterOptions(currentParams.id);
  } else if (inArea) {
    currentParams.area = val;
  } else {
    currentParams.year = val;
  }

  currentParams.page = 1;
  currentParams.isSearch = false;
  currentParams.isFavorites = false;
  state.pageLoaded = false;
  console.log('[Filter] currentParams:', JSON.stringify(currentParams));

  gridScroll.scrollTop = 0;
  reloadCatalog();
});

// ─── Load More + Intersection Observer ────────────────────────────────────────
loadMoreBtn.addEventListener('click', loadMore);

const observer = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && state.hasMore && !state.loading) loadMore();
}, { root: gridScroll, rootMargin: '200px' });
observer.observe(scrollSentinel);

// ─── Back Button ──────────────────────────────────────────────────────────────
backBtn.addEventListener('click', () => {
  if (dpInstance && currentVodID && dpInstance.video && dpInstance.video.currentTime > 0) {
    window.electronAPI.saveHistory({
      vodID: currentVodID,
      episodeIndex: currentEpIndex,
      currentTime: dpInstance.video.currentTime
    });
  }

  document.querySelectorAll('video').forEach(v => {
    try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (_) { }
  });

  hideNextCountdownToast();
  clearSaveHistoryInterval();
  if (globalErrorToastTimer) { clearTimeout(globalErrorToastTimer); globalErrorToastTimer = null; }

  if (dpInstance) {
    try {
      dpInstance.pause();
      dpInstance.src = '';
      if (dpInstance.video) { dpInstance.video.muted = true; dpInstance.video.src = ''; }
    } catch (_) { }
    try { if (dpInstance.hls) { dpInstance.hls.destroy(); dpInstance.hls = null; } } catch (_) { }
    try { dpInstance.destroy(); } catch (_) { }
    dpInstance = null;
  }
  const _artEl1 = document.getElementById('artplayer');
  if (_artEl1) _artEl1.innerHTML = '';

  window.electronAPI.sendStopSniffing();
  window.electronAPI.stopSniff();

  epContainer.classList.add('hidden');
  epGrid.innerHTML = '';
  sourceTabBar.innerHTML = '';
  sourceTabBar.classList.add('hidden');
  playerPlaceholder.classList.remove('hidden');
  setPlayerLoading(false);
  clearPlayerStatus();

  showCatalog();
});

// ─── Player Sniff Logic ───────────────────────────────────────────────────────
let dpInstance = null;
let isSniffing = false;
let globalErrorToastTimer = null;

function setPlayerStatus(msg, type = 'info') {
  spinner.style.display = type === 'loading' ? 'block' : 'none';
  statusText.textContent = msg;
  playerStatusBar.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
  playerStatusBar.classList.remove('hidden');
}
function clearPlayerStatus() { playerStatusBar.classList.add('hidden'); }

function setPlayerLoading(on) {
  playerLoadBtn.disabled = on;
  playerUrlInput.disabled = on;
}

function launchPlayer(streamUrl) {
  if (dpInstance) {
    try { dpInstance.pause(); } catch (_) { }
    try { if (dpInstance.video) dpInstance.video.muted = true; } catch (_) { }
    try { if (dpInstance._hls) { dpInstance._hls.destroy(); dpInstance._hls = null; } } catch (_) { }
    try { dpInstance.destroy(); } catch (_) { }
    dpInstance = null;
  }
  const _artEl = document.getElementById('artplayer');
  if (_artEl) _artEl.innerHTML = '';
  playerPlaceholder.classList.add('hidden');

  let bitrateInfoEl = null;
  let pendingRestoreMsg = '';

  const activeSourceBtn = document.querySelector('#source-tab-bar .source-tab.active');
  const sourceName = activeSourceBtn ? activeSourceBtn.textContent : '';
  const is4K = sourceName.toUpperCase().includes('4K');

  const plugins = [];
  if (is4K && typeof artplayerPluginHevcWasm === 'function') {
    showToast('已为 4K 线路注入 WASM 软解支持', 'success');
    plugins.push(artplayerPluginHevcWasm());
  }

  dpInstance = new Artplayer({
    container: document.getElementById('artplayer'),
    url: streamUrl,
    type: 'm3u8',
    theme: '#7c3aed',
    autoplay: true,
    muted: false,
    playsinline: true,
    autoSize: true,
    fullscreen: true,
    fullscreenWeb: true,
    setting: true,
    playbackRate: true,
    miniProgressBar: true,
    plugins: plugins,
    controls: [
      {
        position: 'right',
        html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;vertical-align:middle"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
        tooltip: '原生全屏',
        click: function () {
          const el = document.getElementById('artplayer');
          if (!document.fullscreenElement) {
            (el || document.documentElement).requestFullscreen().catch(() => { });
          } else {
            document.exitFullscreen().catch(() => { });
          }
        }
      },
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
      }
    ],
    customType: {
      m3u8: function (video, url, art) {
        if (art.hls) { try { art.hls.destroy(); } catch (_) {} art.hls = null; }
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
            try {
              if (!data.frag || data.frag.sn === 'initSegment') return;
              const sizeBytes = (data.payload && data.payload.byteLength > 0 ? data.payload.byteLength : 0)
                || (data.frag.stats && data.frag.stats.loaded) || 0;
              const dur = data.frag.duration || 0;
              if (sizeBytes > 0 && dur > 0) {
                const mbps = (sizeBytes * 8 / (dur * 1000000)).toFixed(2);
                const infoTarget = bitrateInfoEl || document.querySelector('[data-pvp-bitrate]');
                if (infoTarget) infoTarget.textContent = `${mbps} Mbps`;
              }
            } catch (err) { console.warn('[Bitrate] Error:', err); }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            if (lastWatchedTime > 3 && !hasRestoredTime) {
              hasRestoredTime = true;
              const { op } = getSkipForVod(currentVodID);
              const seekTo = (op > 0 && lastWatchedTime < op) ? op : lastWatchedTime;
              const mm = Math.floor(seekTo / 60).toString().padStart(2, '0');
              const ss = Math.floor(seekTo % 60).toString().padStart(2, '0');
              pendingRestoreMsg = seekTo === lastWatchedTime
                ? `已为您恢复到上次观看位置：${mm}:${ss}`
                : `已跳过片头，从 ${mm}:${ss} 继续`;
              setTimeout(() => { video.currentTime = seekTo; }, 200);
            }

            const levels = data.levels || [];
            if (levels.length < 2) return;
            const qualityList = levels.map((l, index) => {
              const h = l.height || 0;
              const label = h >= 1080 ? '1080P' : h >= 720 ? '720P' : h >= 480 ? '480P' : h > 0 ? `${h}P` : `${Math.round((l.bitrate || 0) / 1000)}k`;
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

  dpInstance.on('ready', () => {
    const infoPanel = dpInstance.query('.art-info');
    if (infoPanel) {
      const row = document.createElement('div');
      row.className = 'art-info-item';
      row.innerHTML = '<div class="art-info-item-left">实时码率</div><div class="art-info-item-right" data-pvp-bitrate>检测中…</div>';
      infoPanel.appendChild(row);
      bitrateInfoEl = row.querySelector('[data-pvp-bitrate]');
    }
  });

  dpInstance.on('video:canplay', () => {
    if (opSkipped) return;
    const { op } = getSkipForVod(currentVodID);
    if (op <= 0) return;
    if (dpInstance.currentTime < op) {
      opSkipped = true;
      dpInstance.currentTime = op;
      showToast(`已跳过片头 ${op} 秒`, 'success');
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
          if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
          triggerSniff(currentEpUrl, sourceName);
        } else {
          showToast('播放出错，可能已过期。(若 WAS 加载报错请重试)', 'error');
        }
      }
    }, 2000);
  });

  dpInstance.on('play', () => {
    isSniffing = false;
    if (globalErrorToastTimer) clearTimeout(globalErrorToastTimer);
    hideAllToasts();
    clearPlayerStatus();

    if (pendingRestoreMsg) {
      showToast(pendingRestoreMsg, 'success');
      pendingRestoreMsg = '';
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

  dpInstance.on('video:timeupdate', () => {
    if (edSkipTriggered) return;
    const dur = dpInstance.duration;
    if (dur > 0) {
      const { ed } = getSkipForVod(currentVodID);
      if (ed > 0 && dpInstance.currentTime >= dur - ed) {
        edSkipTriggered = true;
        if (hasNextEpisode()) showNextCountdownToast();
      }
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
    if (hasNextEpisode()) showNextCountdownToast();
  });
}

function triggerSniff(url, sourceName = '') {
  isSniffing = true;
  opSkipped = false;
  edSkipTriggered = false;
  sniffFallbackCount = 0;
  hideAllToasts();

  if (dpInstance) {
    try { dpInstance.pause(); } catch (_) {}
    try { if (dpInstance.video) dpInstance.video.muted = true; } catch (_) {}
  }

  window.electronAPI.stopSniff();
  window.electronAPI.removeAllListeners();

  window.electronAPI.onStatusUpdate(msg => {
    if (state.view === 'player') setPlayerStatus(msg, 'loading');
  });
  window.electronAPI.onM3u8Found(({ streamUrl }) => {
    if (state.view !== 'player') return;
    isSniffing = false;
    setPlayerLoading(false);
    setPlayerStatus('✅ 正在播放', 'success');
    console.log('[Sniffer] M3U8 received in renderer:', streamUrl);

    if (dpInstance) {
      try { dpInstance.video.muted = false; } catch (_) {}

      const wasFullscreen = !!document.fullscreenElement;
      try {
        if (wasFullscreen) { document.exitFullscreen().catch(() => {}); }
        dpInstance.switchUrl(streamUrl);
        if (wasFullscreen) {
          dpInstance.once('video:canplay', () => { dpInstance.fullscreen = true; });
        }
      } catch (e) {
        console.warn('[Sniff] switchUrl failed, relaunching player:', e.message);
        launchPlayer(streamUrl);
      }
    } else {
      launchPlayer(streamUrl);
    }
    setTimeout(clearPlayerStatus, 3000);
  });
  window.electronAPI.onSniffError(msg => {
    if (state.view !== 'player') return;
    setPlayerLoading(false);
    setPlayerStatus(msg, 'error');
    showToast(msg, 'error');
    if (dpInstance) {
      try { dpInstance.video.muted = false; } catch (_) {}
    } else {
      playerPlaceholder.classList.remove('hidden');
    }
  });

  setPlayerLoading(true);
  setPlayerStatus('🚀 启动嗅探器…', 'loading');
  window.electronAPI.sniffUrl(url, sourceName);
}

// ─── Player Toolbar ───────────────────────────────────────────────────────────
playerLoadBtn.addEventListener('click', () => {
  const raw = playerUrlInput.value.trim();
  if (!raw) { showToast('请输入一个链接', 'error'); return; }
  let url;
  try {
    url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    showToast('请输入有效的 http/https 链接', 'error'); return;
  }
  fetchEpisodes(url.href);
});
playerUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') playerLoadBtn.click(); });

// ─── Auto-Next Logic ─────────────────────────────────────────────────────────
function hasNextEpisode() {
  const activeBtn = epGrid.querySelector('.ep-btn.active');
  if (!activeBtn) return false;
  const targetBtn = epSortDesc ? activeBtn.previousElementSibling : activeBtn.nextElementSibling;
  return targetBtn && targetBtn.classList.contains('ep-btn');
}

function playNextEpisode() {
  const activeBtn = epGrid.querySelector('.ep-btn.active');
  if (!activeBtn) return false;
  const targetBtn = epSortDesc ? activeBtn.previousElementSibling : activeBtn.nextElementSibling;
  if (targetBtn && targetBtn.classList.contains('ep-btn')) {
    targetBtn.click();
    return true;
  }
  return false;
}

let nextCountdownTimer = null;
function showNextCountdownToast() {
  const container = document.getElementById('artplayer');
  if (!container) return;
  hideNextCountdownToast();

  const toast = document.createElement('div');
  toast.id = 'next-countdown-toast';
  toast.innerHTML = `<span>正在播放下一集…</span><button id="cancel-next-btn">取消</button>`;
  container.appendChild(toast);

  toast.querySelector('#cancel-next-btn').onclick = (e) => { e.stopPropagation(); hideNextCountdownToast(); };

  playNextEpisode();
}

function hideNextCountdownToast() {
  if (nextCountdownTimer) { clearInterval(nextCountdownTimer); nextCountdownTimer = null; }
  const toast = document.getElementById('next-countdown-toast');
  if (toast) toast.remove();
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg, type = 'error') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function hideAllToasts() {
  document.querySelectorAll('.toast').forEach(t => t.remove());
}

function showUpdateBanner(version) {
  document.getElementById('update-banner')?.remove();
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.style.cssText =
    'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
    'background:rgba(124,58,237,0.95);color:#fff;padding:12px 22px;border-radius:10px;' +
    'z-index:9999;display:flex;align-items:center;gap:14px;font-size:13px;' +
    'box-shadow:0 4px 24px rgba(0,0,0,0.45);white-space:nowrap;';
  el.innerHTML =
    `<span>🎉 v${version} 已下载完毕，重启后生效</span>` +
    `<button onclick="window.electronAPI.restartApp()" style="background:#fff;color:#7c3aed;` +
    `border:none;padding:5px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;">` +
    `立即重启</button>` +
    `<button onclick="this.parentElement.remove()" style="background:none;border:none;` +
    `color:rgba(255,255,255,0.6);font-size:16px;cursor:pointer;padding:0 4px;">×</button>`;
  document.body.appendChild(el);
}

// ─── Status listener ─────────────────────────────────────────────────────────
function registerStatusListener() {
  window.electronAPI.onStatusUpdate(msg => {
    console.log('[Renderer] Status: ' + msg);
  });
}
registerStatusListener();

// ─── Boot ─────────────────────────────────────────────────────────────────────
updateFilterBar();

// Start loading immediately — no verification needed
currentParams.baseCatId = 1;
currentParams.id = 1;
currentParams.page = 1;
renderSubcatRow(1);
loadFilterOptions(1);
reloadCatalog();

// Player-view favourite button
document.getElementById('player-fav-btn').addEventListener('click', () => {
  if (!currentItem) return;
  const nowFaved = toggleFavorite(currentItem);
  const btn = document.getElementById('player-fav-btn');
  btn.classList.toggle('active', nowFaved);
  btn.title = nowFaved ? '取消收藏' : '收藏';
  updateFavTabLabel();
  showToast(nowFaved ? `已收藏《${currentItem.title}》` : `已取消收藏《${currentItem.title}》`, 'success');
});

// ─── Skip Settings UI ─────────────────────────────────────────────────────────
skipOpInput.addEventListener('input', () => {
  if (!currentVodID) return;
  setSkipForVod(currentVodID, skipOpInput.value, skipEdInput.value);
});
skipEdInput.addEventListener('input', () => {
  if (!currentVodID) return;
  setSkipForVod(currentVodID, skipOpInput.value, skipEdInput.value);
});
skipClearBtn.addEventListener('click', () => {
  if (!currentVodID) return;
  clearSkipForVod(currentVodID);
  skipOpInput.value = 0;
  skipEdInput.value = 0;
  showToast('已清空跳过设置', 'success');
});

// ─── Episode sort ─────────────────────────────────────────────────────────────
if (epSortBtn) {
  epSortBtn.addEventListener('click', () => {
    epSortDesc = !epSortDesc;
    epSortBtn.classList.toggle('desc', epSortDesc);
    epSortBtn.textContent = epSortDesc ? '倒序 ⇅' : '正序 ⇅';
    _renderEpBtns(epSortDesc ? [...currentSourceEpisodes].reverse() : [...currentSourceEpisodes]);
  });
}

// ─── Auto-update notifications ────────────────────────────────────────────────
window.electronAPI.onUpdateAvailable(info => {
  showToast(`发现新版本 v${info.version}，正在后台下载…`, 'success');
});
window.electronAPI.onUpdateProgress(prog => {
  console.log(`[Updater] Download ${prog.percent}%`);
});
window.electronAPI.onUpdateDownloaded(info => {
  showUpdateBanner(info.version);
});
window.electronAPI.onUpdateError(err => {
  showToast(`更新检查失败: ${err}`, 'error');
});

// ─── Window Controls (minimize / maximize / close) ─────────────────────────
document.getElementById('btn-min').addEventListener('click', () => {
  window.electronAPI.minimize();
});
document.getElementById('btn-max').addEventListener('click', () => {
  window.electronAPI.maximize();
});
document.getElementById('btn-close').addEventListener('click', () => {
  window.electronAPI.close();
});
