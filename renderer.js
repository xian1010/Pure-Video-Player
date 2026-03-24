'use strict';

// ─── Environment detection ─────────────────────────────────────────────────────
const isElectron = !!window.electronAPI;
const isIOS = !isElectron && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

// ─── Screen console (intercepts errors → visible on iPad, no F12 needed) ───
if (!isElectron) {
  const _dbgEl = document.getElementById('debug-log');
  const _dbgLines = [];
  function _dbgPush(msg, color) {
    const t = new Date().toISOString().slice(11, 22);
    _dbgLines.push(`<span style="color:#6b7280">[${t}]</span> <span style="color:${color}">${
      String(msg).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    }</span>`);
    if (_dbgLines.length > 30) _dbgLines.shift();
    _dbgEl.innerHTML = _dbgLines.join('<br>');
    _dbgEl.style.display = 'block';
  }
  const _ce = console.error.bind(console);
  console.error = (...a) => { _ce(...a); _dbgPush(a.map(String).join(' '), '#f87171'); };
  const _cw = console.warn.bind(console);
  console.warn  = (...a) => { _cw(...a);  _dbgPush(a.map(String).join(' '), '#fbbf24'); };
  const _cl = console.log.bind(console);
  console.log   = (...a) => { _cl(...a);  _dbgPush(a.map(String).join(' '), '#86efac'); };
  window.onerror = (msg, src, line) =>
    _dbgPush(`ERR: ${msg} @ ${src}:${line}`, '#f87171');
  window.onunhandledrejection = (e) =>
    _dbgPush(`UNHANDLED: ${e.reason}`, '#fb923c');
}

// ── Cloudflare Worker base URL (only used in web / iPad mode) ─────────────────
// Replace with your deployed worker URL before publishing the web build.
const WORKER_URL = 'https://pure-video-proxy.yapshiuxian.workers.dev';

// ── Web polyfill: mirrors the electronAPI surface so the rest of the code
//    needs zero changes when running in a browser (iPad / PWA). ───────────────
if (!isElectron) {
  // -- Helpers -----------------------------------------------------------------
  async function fetchPage(sitePath) {
    const res = await fetch(`${WORKER_URL}/api/page?path=${encodeURIComponent(sitePath)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  function parseCardsDOM(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [];
    doc.querySelectorAll('div.public-list-box, li.public-list-box').forEach(el => {
      if (el.closest('.swiper-wrapper')) return;
      const title = el.querySelector('a.time-title')?.textContent?.trim()
        || el.querySelector('a.public-list-exp')?.getAttribute('title') || '';
      const aEl = el.querySelector('a.public-list-exp');
      const href = aEl?.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : 'https://huavod.net' + href;
      const imgEl = el.querySelector('img');
      const poster = imgEl?.dataset?.src || imgEl?.getAttribute('src') || '';
      const badge = el.querySelector('span.public-prt')?.textContent?.trim() || '';
      if (title && url.includes('/voddetail/')) items.push({ title, url, poster, badge });
    });
    return items;
  }

  function hasNextPageDOM(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelector('a.page-next, a[title="下一页"]')) return true;
    return doc.querySelectorAll('div.public-list-box:not(.swiper-wrapper *)').length >= 24;
  }

  // -- Web history (localStorage) ---------------------------------------------
  const WEB_HISTORY_KEY = 'pvp_web_history';
  function webGetHistory(vodID) {
    const all = JSON.parse(localStorage.getItem(WEB_HISTORY_KEY) || '{}');
    return Promise.resolve(all[vodID] || null);
  }
  function webSaveHistory(record) {
    const all = JSON.parse(localStorage.getItem(WEB_HISTORY_KEY) || '{}');
    all[record.vodID] = { episodeIndex: record.episodeIndex, currentTime: record.currentTime, updatedAt: Date.now() };
    localStorage.setItem(WEB_HISTORY_KEY, JSON.stringify(all));
  }

  // -- Sniff event bridge: simulates IPC events with CustomEventTarget --------
  const sniffBus = new EventTarget();
  let _sniffController = null;

  // -- electronAPI polyfill ----------------------------------------------------
  window.electronAPI = {
    // Catalog
    scrapeCategory: async (catId, page, area, year) => {
      let path = `/vodshow/${catId}`;
      if (area && area !== '全部') path += `/area/${encodeURIComponent(area)}`;
      if (year && year !== '全部') path += `/year/${year}`;
      path += page > 1 ? `/${page}.html` : '.html';
      const html = await fetchPage(path);
      return { items: parseCardsDOM(html), hasMore: hasNextPageDOM(html) };
    },
    scrapeSearch: async (keyword, page) => {
      const res = await fetch(`${WORKER_URL}/api/search?q=${encodeURIComponent(keyword)}&page=${page || 1}`);
      return res.json();
    },
    getDetail: async (url) => {
      const html = await fetchPage(url.replace('https://huavod.net', ''));
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const sources = [];
      const tabEls = doc.querySelectorAll('.anthology-tab .swiper-wrapper a.swiper-slide');
      const listBoxes = doc.querySelectorAll('.anthology-list .anthology-list-box');
      if (tabEls.length) {
        tabEls.forEach((tabEl, i) => {
          const name = tabEl.cloneNode(true);
          name.querySelectorAll('i').forEach(n => n.remove());
          const episodes = [];
          listBoxes[i]?.querySelectorAll('a[href*="/vodplay/"]').forEach(a => {
            const href = a.getAttribute('href');
            episodes.push({ title: a.textContent.trim(), url: href.startsWith('http') ? href : 'https://huavod.net' + href });
          });
          if (episodes.length) sources.push({ name: name.textContent.trim() || `线路${i + 1}`, episodes });
        });
      }
      if (!sources.length) {
        const episodes = [];
        const seen = new Set();
        doc.querySelectorAll('a[href*="/vodplay/"]').forEach(a => {
          const href = a.getAttribute('href');
          const url = href.startsWith('http') ? href : 'https://huavod.net' + href;
          if (!seen.has(url) && a.textContent.trim().length < 30) { seen.add(url); episodes.push({ title: a.textContent.trim(), url }); }
        });
        if (episodes.length) sources.push({ name: '默认线路', episodes });
      }
      return { sources };
    },
    fetchFilterOptions: async (catId) => {
      const html = await fetchPage(`/vodshow/${catId}.html`);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const areas = [], years = [], sa = new Set(), sy = new Set();
      doc.querySelectorAll('a[href*="/area/"]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/\/area\/([^./]+)/);
        if (!m) return;
        let v; try { v = decodeURIComponent(m[1]); } catch { v = m[1]; }
        if (v && !sa.has(v)) { sa.add(v); areas.push(v); }
      });
      doc.querySelectorAll('a[href*="/year/"]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/\/year\/(\d{4})/);
        if (m && !sy.has(m[1])) { sy.add(m[1]); years.push(m[1]); }
      });
      return { areas, years: years.sort((a, b) => Number(b) - Number(a)) };
    },
    // History
    getHistory: webGetHistory,
    saveHistory: webSaveHistory,
    // Sniffer (event-bridge pattern — triggerSniff code stays unchanged)
    stopSniff: () => { _sniffController?.abort(); },
    removeAllListeners: () => {
      const fresh = new EventTarget();
      Object.assign(sniffBus, fresh);         // swap internals
    },
    onM3u8Found: (cb) => sniffBus.addEventListener('m3u8-found', e => cb(e.detail), { once: true }),
    onSniffError: (cb) => sniffBus.addEventListener('sniff-error', e => cb(e.detail), { once: true }),
    onStatusUpdate: (cb) => sniffBus.addEventListener('status', e => cb(e.detail), { once: true }),
    sniffUrl: async (vodUrl) => {
      _sniffController = new AbortController();
      sniffBus.dispatchEvent(new CustomEvent('status', { detail: '⏳ 正在提取播放源…' }));
      try {
        const res = await fetch(`${WORKER_URL}/extract?url=${encodeURIComponent(vodUrl)}`, { signal: _sniffController.signal });
        const { streamUrl, error } = await res.json();
        if (error) throw new Error(error);
        sniffBus.dispatchEvent(new CustomEvent('m3u8-found', { detail: { streamUrl } }));
      } catch (err) {
        if (err.name !== 'AbortError') {
          sniffBus.dispatchEvent(new CustomEvent('sniff-error', { detail: err.message }));
        }
      }
    },
    // Window controls — no-op on web
    minimize: () => { }, maximize: () => { }, close: () => { },
    // Auto-updater — no-op on web
    onUpdateAvailable: () => { }, onUpdateProgress: () => { },
    onUpdateDownloaded: () => { }, onUpdateError: () => { },
    restartApp: () => { },
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

// Window controls
document.getElementById('btn-min').onclick = () => window.electronAPI.minimize();
document.getElementById('btn-max').onclick = () => window.electronAPI.maximize();
document.getElementById('btn-close').onclick = () => {
  if (typeof dpInstance !== 'undefined' && dpInstance && currentVodID && dpInstance.video.currentTime > 0) {
    window.electronAPI.saveHistory({
      vodID: currentVodID,
      episodeIndex: currentEpIndex,
      currentTime: dpInstance.video.currentTime
    });
  }
  window.electronAPI.close();
};

// ─── App State ────────────────────────────────────────────────────────────────
// The ONE AND ONLY source of truth for the catalog list
let currentParams = {
  baseCatId: 0,  // 顶层频道 tab 的 ID（0=全部, 1=电影, 2=电视剧, 3=综艺, 4=动漫）
  id: 0,         // 实际请求 ID（可能是子分类, 如 15=港台剧）
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
};

let currentFetchId = 0;

let epSortDesc = false;
let opSkipped = false;
let edSkipTriggered = false;
let currentSourceEpisodes = [];

let currentVodID = '';
let currentEpIndex = 0;
let currentEpUrl = '';
let sniffFallbackCount = 0; // Prevent infinite re-sniff loops on dead links
let lastWatchedTime = 0;
let hasRestoredTime = false;
let saveHistoryInterval = null;

function clearSaveHistoryInterval() {
  if (saveHistoryInterval) clearInterval(saveHistoryInterval);
  saveHistoryInterval = null;
}

// ─── Sub-category definitions per channel ─────────────────────────────────────
// label: display text; id: vodshow sub-category ID
const SUBCAT_DEFS = {
  1: [ // 电影
    { label: '全部', id: 1 },
    { label: '动作', id: 7 },
    { label: '喜剧', id: 9 },
    { label: '爱情', id: 9 },
    { label: '科幻', id: 6 },
    { label: '战争', id: 10 },
    { label: '动画', id: 11 },
    { label: '纪录片', id: 12 },
  ],
  2: [ // 电视剧
    { label: '全部', id: 2 },
    { label: '大陆剧', id: 14 },
    { label: '港台剧', id: 15 },
    { label: '日韩剧', id: 16 },
    { label: '欧美剧', id: 17 },
    { label: '其他剧', id: 18 },
  ],
  3: [ // 综艺
    { label: '全部', id: 3 },
    { label: '内地综艺', id: 19 },
    { label: '港台综艺', id: 20 },
    { label: '日韩综艺', id: 21 },
    { label: '欧美综艺', id: 22 },
  ],
  4: [ // 动漫
    { label: '全部', id: 4 },
    { label: '国产动漫', id: 23 },
    { label: '日本动漫', id: 24 },
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

// Map id=0 to two requests (电影+电视剧) for the "全部" tab
const CAT_IDS = { 0: [1, 2, 3, 4], 1: [1], 2: [2], 3: [3], 4: [4] };

// ─── Filter helpers ────────────────────────────────────────────────────────────
function updateFilterBar() {
  const showFilter = !currentParams.isSearch && !currentParams.isFavorites && currentParams.baseCatId !== 0;
  filterBar.classList.toggle('hidden', !showFilter);
}

// Populate one chip row: always starts with '全部', then the provided values
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

// Async: fetch real area/year options from the site for catId, then render chips
async function loadFilterOptions(catId) {
  // Show only '全部' while loading
  renderFilterChips(areaChips, [], '');
  renderFilterChips(yearChips, [], '');
  try {
    const opts = await window.electronAPI.fetchFilterOptions(catId);
    renderFilterChips(areaChips, opts.areas || [], currentParams.area);
    renderFilterChips(yearChips, opts.years || [], currentParams.year);
  } catch (err) {
    console.warn('[FilterOptions]', err);
  }
}

function resetFilterChips() {
  currentParams.area = '';
  currentParams.year = '';
  currentParams.id = currentParams.baseCatId;
  // Visual reset: make first chip ('全部') active in all rows
  [areaChips, yearChips].forEach(container =>
    container.querySelectorAll('.filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0))
  );
  // 重置分类芯片到第一项（全部）
  if (subcatChips) subcatChips.querySelectorAll('.filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
}

// ─── View Transitions ─────────────────────────────────────────────────────────
function showCatalog() {
  state.view = 'catalog';
  catalogView.classList.remove('hidden-left', 'hidden-right');
  playerView.classList.add('hidden-right');
  // Restore scroll
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

// ─── Card Rendering ───────────────────────────────────────────────────────────
const PROXY = (url) => url ? `imgproxy://${encodeURIComponent(url)}` : '';

function renderCards(items, append = false) {
  if (!append) cardGrid.innerHTML = '';

  if (!items.length && !append) {
    gridEmpty.classList.add('show');
    emptyMsg.textContent = currentParams.isFavorites
      ? '收藏夹是空的，点击卡片上的 ★ 来添加'
      : currentParams.isSearch ? `未找到"${currentParams.query}"的结果` : '暂无内容';
    loadMoreBtn.disabled = true;
    return;
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

    // Star button: toggles favorite without triggering card click
    const favBtn = card.querySelector('.card-fav-btn');
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowFaved = toggleFavorite(item);
      favBtn.classList.toggle('active', nowFaved);
      updateFavTabLabel();
      // If we're in the favorites view and just un-favorited, remove the card live
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

// ─── Data Loading (Unified) ─────────────────────────────────────────────────────
async function reloadCatalog() {
  const fetchId = ++currentFetchId;
  state.loading = true;
  catalogStatus.textContent = '加载中…';
  loadMoreBtn.disabled = true;

  // Instant UI clear
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
      const res = await window.electronAPI.scrapeSearch(currentParams.query, currentParams.page);
      allItems = res.items || [];
      anyMore = res.hasMore;
      if (res.error) throw new Error(res.error);
    } else {
      const cats = currentParams.page === 1
        ? (CAT_IDS[currentParams.id] || [currentParams.id === 0 ? 1 : currentParams.id])
        : [currentParams.id === 0 ? 1 : currentParams.id];

      const results = await Promise.all(
        cats.map(id => window.electronAPI.scrapeCategory(id, currentParams.page, currentParams.area, currentParams.year))
      );
      results.forEach(r => { allItems.push(...(r.items || [])); anyMore = anyMore || r.hasMore; });
      if (results[0]?.error) throw new Error(results[0].error);
    }

    if (fetchId !== currentFetchId) return;

    const ghosts = cardGrid.querySelectorAll('.ghost-card');
    ghosts.forEach(g => g.remove());

    state.hasMore = anyMore;
    renderCards(allItems, false);
    catalogStatus.textContent = '';

    // As requested: dump top 3 titles to console to verify data changed
    const top3 = allItems.slice(0, 3).map(i => i.title).join(' | ');
    console.log(`[Scraper] Parsed top 3: ${top3 || 'None'}`);
  } catch (err) {
    if (fetchId !== currentFetchId) return;
    const ghosts = cardGrid.querySelectorAll('.ghost-card');
    ghosts.forEach(g => g.remove());
    gridEmpty.classList.add('show');
    emptyMsg.innerHTML = `加载失败: ${err.message}<br><br><button id="btn-retry-catalog" class="ep-btn" style="padding: 6px 16px; font-size: 14px; margin-top: 10px;">点击重试</button>`;
    const retryBtn = document.getElementById('btn-retry-catalog');
    if (retryBtn) retryBtn.addEventListener('click', reloadCatalog);
    catalogStatus.textContent = '';
    console.error('[Catalog]', err);
  } finally {
    if (fetchId === currentFetchId) state.loading = false;
  }
}

async function loadPage(append = false) {
  if (state.loading && append) return;
  if (!append) return reloadCatalog(); // safeguard for old calls

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
      const res = await window.electronAPI.scrapeSearch(currentParams.query, currentParams.page);
      allItems = res.items || [];
      anyMore = res.hasMore;
      if (res.error) throw new Error(res.error);
    } else {
      const cats = [currentParams.id === 0 ? 1 : currentParams.id];
      const results = await Promise.all(
        cats.map(id => window.electronAPI.scrapeCategory(id, currentParams.page, currentParams.area, currentParams.year))
      );
      results.forEach(r => { allItems.push(...(r.items || [])); anyMore = anyMore || r.hasMore; });
      if (results[0]?.error) throw new Error(results[0].error);
    }

    if (fetchId !== currentFetchId) return;

    state.hasMore = anyMore;
    renderCards(allItems, true);
    catalogStatus.textContent = '';
  } catch (err) {
    if (fetchId !== currentFetchId) return;
    catalogStatus.innerHTML = `追加失败: ${err.message} <button id="btn-retry-loadmore" style="margin-left:10px; padding:4px 12px; font-size:12px; border-radius:15px; background:linear-gradient(45deg, #7c3aed, #ec4899); border:none; color:white; cursor:pointer;">点击重试</button>`;
    const retryBtn = document.getElementById('btn-retry-loadmore');
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

// ─── Fetch Episodes ─────────────────────────────────────────────────────────────
function fetchEpisodes(url) {
  epContainer.classList.add('hidden');
  epGrid.innerHTML = '';
  sourceTabBar.innerHTML = '';
  sourceTabBar.classList.add('hidden');

  currentVodID = url;
  const m = url.match(/\/voddetail\/(\d+)/);
  if (m) currentVodID = m[1];

  lastWatchedTime = 0;
  hasRestoredTime = false;
  currentEpIndex = 0;
  updateSkipUI();

  if (url.includes('/voddetail/')) {
    setPlayerLoading(true);
    setPlayerStatus('🔍 获取剧集列表…', 'loading');

    Promise.all([
      window.electronAPI.getDetail(url),
      window.electronAPI.getHistory(currentVodID)
    ]).then(([res, history]) => {
      if (state.view !== 'player') return; // Cancel if navigated away

      setPlayerLoading(false);
      clearPlayerStatus();
      const sources = res.sources || [];
      if (sources.length === 0) { triggerSniff(url); return; }

      if (history) {
        currentEpIndex = history.episodeIndex || 0;
        lastWatchedTime = history.currentTime || 0;
      }

      epContainer.classList.remove('hidden');

      // Preferred source: remember last selection across sessions
      const preferred = localStorage.getItem('pvp_preferred_source') || '';
      let activeIdx = 0;
      if (preferred) {
        const found = sources.findIndex(s => s.name === preferred);
        if (found !== -1) activeIdx = found;
      }

      // Default the currentEpUrl to the active episode's URL in case they don't click
      if (sources[activeIdx] && sources[activeIdx].episodes[currentEpIndex]) {
        currentEpUrl = sources[activeIdx].episodes[currentEpIndex].url;
      }

      // Render source-line tabs (only if there is more than one source)
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
          };
          sourceTabBar.appendChild(btn);
        });
      }

      renderSourceEpisodes(sources[activeIdx].episodes, currentEpIndex);

      // 在异步渲染完成后，自动点击 active 按钮，触发播放
      setTimeout(() => {
        if (state.view !== 'player') return; // Guard against back button race
        const activeBtn = epGrid.querySelector('.ep-btn.active');
        if (activeBtn) activeBtn.click();
      }, 50);

    }).catch(() => {
      if (state.view !== 'player') return; // Guard error handling

      // 捕获到 404 或解析失败时，不再显示红色错误，保持 loading 状态
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
      sniffFallbackCount = 0; // Reset fallback counter for new episode playback

      const activeSourceBtn = document.querySelector('#source-tab-bar .source-tab.active');
      const sourceName = activeSourceBtn ? activeSourceBtn.textContent : '';
      triggerSniff(ep.url, sourceName);
    };
    epGrid.appendChild(btn);
  });
}

// ─── Card Click → Trigger Sniffer ─────────────────────────────────────────────
let currentItem = null;

function onCardClick(item) {
  currentItem = item;
  showPlayer(item.url);
  // Update the player-view favorite button to reflect this item's state
  const playerFavBtn = document.getElementById('player-fav-btn');
  if (playerFavBtn) {
    playerFavBtn.classList.toggle('active', isFavorited(item.url));
    playerFavBtn.title = isFavorited(item.url) ? '取消收藏' : '收藏';
  }
  fetchEpisodes(item.url);
}

// ─── Category Tabs ────────────────────────────────────────────────────────────
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

    renderSubcatRow(currentParams.baseCatId);
    searchInput.value = '';
    resetFilterChips();
    gridScroll.scrollTop = 0;
    // 动态拉取该频道的真实地区/年份选项（异步，不阻塞内容加载）
    if (currentParams.baseCatId !== 0) loadFilterOptions(currentParams.baseCatId);
    reloadCatalog();
  });
});

// ─── Favorites Tab ─────────────────────────────────────────────────────────────
const favTab = document.getElementById('fav-tab');
updateFavTabLabel();
favTab.addEventListener('click', () => {
  catTabs.forEach(t => t.classList.remove('active'));
  favTab.classList.add('active');

  currentParams.isFavorites = true;
  currentParams.isSearch = false;
  currentParams.query = '';
  currentParams.page = 1;

  gridScroll.scrollTop = 0;
  reloadCatalog();
});

// ─── Search ───────────────────────────────────────────────────────────────────
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

  gridScroll.scrollTop = 0;
  console.log('[Search] Triggered, currentParams:', JSON.stringify(currentParams));
  reloadCatalog();
}

searchBtn.addEventListener('click', doSearch);
searchBtn.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doSearch();
  }
});
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (!searchInput.value.trim()) return; // don't auto-search empties
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
    // 切换子分类 → 重置地区和年份，并拉取该子分类的筛选项
    currentParams.id = parseInt(val, 10);
    currentParams.area = '';
    currentParams.year = '';
    areaChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.val === ''));
    yearChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.val === ''));
    loadFilterOptions(currentParams.id); // 动态更新地区/年份选项
  } else if (inArea) {
    // 地区只追加参数，不改 id
    currentParams.area = val;
  } else {
    // 年份只追加参数，不改 id / area
    currentParams.year = val;
  }

  currentParams.page = 1;
  currentParams.isSearch = false;
  currentParams.isFavorites = false;
  console.log('[Filter] currentParams:', JSON.stringify(currentParams));

  gridScroll.scrollTop = 0;
  reloadCatalog();
});

// ─── Load More Button + Intersection Observer ─────────────────────────────────
loadMoreBtn.addEventListener('click', loadMore);

const observer = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && state.hasMore && !state.loading) loadMore();
}, { root: gridScroll, rootMargin: '200px' });
observer.observe(scrollSentinel);

// ─── Back Button ──────────────────────────────────────────────────────────────
backBtn.addEventListener('click', () => {
  // 先保存历史，再清理 video 元素（否则 removeAttribute src 会把 currentTime 归零）
  if (dpInstance && currentVodID && dpInstance.video && dpInstance.video.currentTime > 0) {
    window.electronAPI.saveHistory({
      vodID: currentVodID,
      episodeIndex: currentEpIndex,
      currentTime: dpInstance.video.currentTime
    });
  }

  // 暴力清除页面上所有的 video 标签，确保绝无余音
  document.querySelectorAll('video').forEach(v => {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
    } catch (_) { }
  });

  hideNextCountdownToast();
  clearSaveHistoryInterval();
  if (globalErrorToastTimer) {
    clearTimeout(globalErrorToastTimer);
    globalErrorToastTimer = null;
  }

  // 1. Immediately silence and destroy the HLS pipeline + DPlayer
  if (dpInstance) {
    try {
      dpInstance.pause();
      dpInstance.src = '';
      if (dpInstance.video) {
        dpInstance.video.muted = true;
        dpInstance.video.src = '';
      }
    } catch (_) { }
    try { if (dpInstance.hls) { dpInstance.hls.destroy(); dpInstance.hls = null; } } catch (_) { }
    try { dpInstance.destroy(); } catch (_) { }
    dpInstance = null;
  }
  const _artEl1 = document.getElementById('artplayer');
  if (_artEl1) _artEl1.innerHTML = '';

  // 2. Tell the main process to forcibly destroy the sniffer window
  if (window.electronAPI.sendStopSniffing) {
    window.electronAPI.sendStopSniffing(); // Matches ipcRenderer.send('stop-sniffing')
  }
  window.electronAPI.stopSniff();

  // 3. Reset player view to its initial state
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
let isSniffing = false; // Add state lock
let globalErrorToastTimer = null; // 全局计时器，防止旧的播放器实例触发的错误残留

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

  // In web / iOS mode route the m3u8 through the Worker proxy so all segment
  // requests also go through /proxy with correct Referer + CORS headers.
  const playUrl = isElectron
    ? streamUrl
    : `${WORKER_URL}/proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent('https://huavod.net/')}`;

  // Debug overlay — shows while a segment is actively loading (web mode only).
  let debugEl = null;
  if (!isElectron) {
    debugEl = document.createElement('div');
    debugEl.style.cssText = 'position:absolute;bottom:52px;left:8px;color:#fff;font-size:11px;' +
      'background:rgba(0,0,0,.65);padding:2px 8px;border-radius:3px;z-index:9999;pointer-events:none;display:none';
    debugEl.textContent = '[Debug] Loading segment...';
    document.getElementById('artplayer').appendChild(debugEl);
  }

  let bitrateInfoEl = null;      // 闭包变量，ready 后赋值，FRAG_LOADED 直接引用
  let pendingRestoreMsg = '';    // MANIFEST_PARSED 里设置，play 事件里显示

  const activeSourceBtn = document.querySelector('#source-tab-bar .source-tab.active');
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
    url: playUrl,
    type: 'm3u8',
    theme: '#7c3aed',
    autoplay: true,
    muted: !isElectron,      // Web/iOS: start muted so autoplay is allowed
    playsinline: true,       // Prevent iOS fullscreen hijack
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
        if (isIOS) {
          // iOS: bypass HLS.js entirely — use Safari's built-in HLS decoder.
          // The proxy URL already carries CORS + Referer for every segment.
          console.log('[iOS] native HLS src =', url);
          if (debugEl) { debugEl.style.display = 'block'; debugEl.textContent = '[Debug] iOS native HLS loading…'; }
          video.src = url;
          video.load();
          video.addEventListener('canplay', () => {
            console.log('[iOS] canplay fired — playback ready');
            if (debugEl) debugEl.style.display = 'none';
          }, { once: true });
          video.addEventListener('error', () => {
            const e = video.error;
            console.error('[iOS] video error code=' + (e && e.code) + ' msg=' + (e && e.message));
            if (debugEl) { debugEl.style.display = 'block'; debugEl.textContent = '[Debug] video.error code=' + (e && e.code); }
          }, { once: true });
        } else if (Hls.isSupported()) {
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

          hls.on(Hls.Events.FRAG_LOADING, () => { if (debugEl) debugEl.style.display = 'block'; });

          hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
            if (debugEl) debugEl.style.display = 'none';
            try {
              // 跳过 init segment（sn 为 'initSegment'，没有有效 duration）
              if (!data.frag || data.frag.sn === 'initSegment') return;
              // hls.js v1.x: payload 是 ArrayBuffer；fallback 到 frag.stats.loaded
              const sizeBytes = (data.payload && data.payload.byteLength > 0 ? data.payload.byteLength : 0)
                || (data.frag.stats && data.frag.stats.loaded)
                || 0;
              const dur = data.frag.duration || 0;
              console.log('[Bitrate] FRAG_LOADED sn=', data.frag.sn, 'size=', sizeBytes, 'dur=', dur);
              if (sizeBytes > 0 && dur > 0) {
                const mbps = (sizeBytes * 8 / (dur * 1000000)).toFixed(2);
                console.log('[Bitrate] Calculated:', mbps, 'Mbps');
                const infoTarget = bitrateInfoEl || document.querySelector('[data-pvp-bitrate]');
                if (infoTarget) infoTarget.textContent = `${mbps} Mbps`;
              }
            } catch (err) {
              console.warn('[Bitrate] Error:', err);
            }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            // 清单加载完毕后恢复播放位置（延迟一帧让 ArtPlayer 完成初始化再 seek）
            if (lastWatchedTime > 3 && !hasRestoredTime) {
              hasRestoredTime = true;
              const mm = Math.floor(lastWatchedTime / 60).toString().padStart(2, '0');
              const ss = Math.floor(lastWatchedTime % 60).toString().padStart(2, '0');
              pendingRestoreMsg = `已为您恢复到上次观看位置：${mm}:${ss}`;
              setTimeout(() => { video.currentTime = lastWatchedTime; }, 200);
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

  console.log('Artplayer HEVC status:', dpInstance.plugins.artplayerPluginHevcWasm);

  dpInstance.on('ready', () => {
    const infoPanel = dpInstance.query('.art-info');
    if (infoPanel) {
      const row = document.createElement('div');
      row.className = 'art-info-item';
      row.innerHTML = '<div class="art-info-item-left">实时码率</div><div class="art-info-item-right" data-pvp-bitrate>检测中…</div>';
      infoPanel.appendChild(row);
      bitrateInfoEl = row.querySelector('[data-pvp-bitrate]');
      console.log('[Bitrate Debug] Info panel row injected. bitrateInfoEl=', bitrateInfoEl);
    } else {
      console.warn('[Bitrate Debug] .art-info panel not found in ready event');
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

    // 显示 MANIFEST_PARSED 里准备好的恢复提示（hideAllToasts 之后再 show）
    if (pendingRestoreMsg) {
      showToast(pendingRestoreMsg, 'success');
      pendingRestoreMsg = '';
    }

    clearSaveHistoryInterval(); saveHistoryInterval = setInterval(() => {
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

  // 片头 & 片尾 skip — 统一在 timeupdate 处理（video 确实在播才触发，seek 可靠）
  dpInstance.on('video:timeupdate', () => {
    const ct = dpInstance.currentTime;
    const dur = dpInstance.duration;

    // 片头：首次 ct > 0，且 restore 已完成（或本集无历史记录）
    if (!opSkipped && ct > 0 && (!lastWatchedTime || hasRestoredTime)) {
      opSkipped = true;
      const { op } = getSkipForVod(currentVodID);
      // 只有上次观看位置也在片头以内时才跳过，否则说明用户已看过片头
      if (op > 0 && ct < op && lastWatchedTime < op) {
        dpInstance.currentTime = op;
        showToast(`已跳过片头 ${op} 秒`, 'success');
      }
    }

    // 片尾：剩余时长 <= ed 时触发下一集倒计时
    if (!edSkipTriggered && dur > 0) {
      const { ed } = getSkipForVod(currentVodID);
      if (ed > 0 && ct >= dur - ed) {
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
    if (hasNextEpisode()) {
      showNextCountdownToast();
    }
  });
}

function triggerSniff(url, sourceName = '') {
  isSniffing = true;
  opSkipped = false;
  edSkipTriggered = false;
  hideAllToasts();

  // 提前销毁现有的播放器，防止后台继续播放或报错
  if (dpInstance) {
    try { dpInstance.pause(); } catch (_) { }
    try { if (dpInstance.video) dpInstance.video.muted = true; } catch (_) { }
    try { if (dpInstance.hls) { dpInstance.hls.destroy(); dpInstance.hls = null; } } catch (_) { }
    try { dpInstance.destroy(); } catch (_) { }
    dpInstance = null;
    document.getElementById('artplayer').innerHTML = '';
  }

  // Abort any in-progress sniff before starting a fresh one
  window.electronAPI.stopSniff();

  window.electronAPI.removeAllListeners();

  window.electronAPI.onStatusUpdate(msg => {
    if (state.view === 'player') setPlayerStatus(msg, 'loading');
  });
  window.electronAPI.onM3u8Found(({ streamUrl }) => {
    if (state.view !== 'player') return; // Guard against rogue ghost sniff returns!
    isSniffing = false;
    setPlayerLoading(false);
    setPlayerStatus('✅ 正在播放', 'success');
    launchPlayer(streamUrl);
    setTimeout(clearPlayerStatus, 3000);
  });
  window.electronAPI.onSniffError(msg => {
    if (state.view !== 'player') return;
    setPlayerLoading(false);
    setPlayerStatus(msg, 'error');
    showToast(msg, 'error');
    playerPlaceholder.classList.remove('hidden');
  });

  setPlayerLoading(true);
  setPlayerStatus('🚀 启动嚅探器…', 'loading');
  window.electronAPI.sniffUrl(url, sourceName);
}


// Player toolbar — manual URL paste
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

// ─── Auto-Next Logic ──────────────────────────────────────────────────────────
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

  let left = 3;
  toast.innerHTML = `
    <span><b>${left}</b> 秒后自动播放下一集</span>
    <button id="cancel-next-btn">取消</button>
    <button id="play-next-now-btn">立即播放</button>
  `;

  container.appendChild(toast);
  const numSpan = toast.querySelector('b');

  toast.querySelector('#cancel-next-btn').onclick = (e) => {
    e.stopPropagation();
    hideNextCountdownToast();
  };

  toast.querySelector('#play-next-now-btn').onclick = (e) => {
    e.stopPropagation();
    hideNextCountdownToast();
    playNextEpisode();
  };

  nextCountdownTimer = setInterval(() => {
    left--;
    if (left <= 0) {
      hideNextCountdownToast();
      playNextEpisode();
    } else {
      numSpan.textContent = left;
    }
  }, 1000);
}

function hideNextCountdownToast() {
  if (nextCountdownTimer) {
    clearInterval(nextCountdownTimer);
    nextCountdownTimer = null;
  }
  const toast = document.getElementById('next-countdown-toast');
  if (toast) toast.remove();
}



// ─── Toast ────────────────────────────────────────────────────────────────────
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

// ─── Boot ─────────────────────────────────────────────────────────────────────
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

updateFilterBar();
loadPage(false);
