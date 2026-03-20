'use strict';

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const catalogView      = document.getElementById('catalog-view');
const playerView       = document.getElementById('player-view');
const cardGrid         = document.getElementById('card-grid');
const gridEmpty        = document.getElementById('grid-empty');
const emptyMsg         = document.getElementById('empty-msg');
const loadMoreBtn      = document.getElementById('load-more-btn');
const catalogStatus    = document.getElementById('catalog-status');
const searchInput      = document.getElementById('search-input');
const searchBtn        = document.getElementById('search-btn');
const catTabs          = document.querySelectorAll('.cat-tab');
const scrollSentinel   = document.getElementById('scroll-sentinel');
const gridScroll       = document.getElementById('grid-scroll');

const backBtn          = document.getElementById('back-btn');
const playerUrlInput   = document.getElementById('player-url-input');
const playerLoadBtn    = document.getElementById('player-load-btn');
const playerStatusBar  = document.getElementById('player-status-bar');
const statusText       = document.getElementById('status-text');
const spinner          = document.getElementById('spinner');
const playerPlaceholder = document.getElementById('player-placeholder');
const epContainer        = document.getElementById('episode-list-container');
const epGrid             = document.getElementById('episode-grid');
const sourceTabBar       = document.getElementById('source-tab-bar');
const filterBar          = document.getElementById('filter-bar');
const areaChips          = document.getElementById('area-chips');
const yearChips          = document.getElementById('year-chips');
const genreRow           = document.getElementById('genre-row');
const genreChips         = document.getElementById('genre-chips');
const epSortBtn          = document.getElementById('ep-sort-btn');

// Window controls
document.getElementById('btn-min').onclick   = () => window.electronAPI.minimize();
document.getElementById('btn-max').onclick   = () => window.electronAPI.maximize();
document.getElementById('btn-close').onclick = () => window.electronAPI.close();

// ─── App State ────────────────────────────────────────────────────────────────
// The ONE AND ONLY source of truth for the catalog list
let currentParams = {
  id: 0,         // 0=全部, 1=电影, 2=剧集, 3=综艺, 4=动漫
  area: '',
  year: '',
  page: 1,
  isSearch: false,
  query: '',
  isFavorites: false
};

const state = {
  view:        'catalog',
  hasMore:     false,
  loading:     false,
  scrollTop:   0,
};

let currentFetchId = 0;

let epSortDesc = false;
let currentSourceEpisodes = [];

// ─── Native Subcategory IDs ───────────────────────────────────────────────────
const CATEGORY_MAP = {
  1: { // 电影 (流派)
    '动作': 7, '喜剧': 9, '爱情': 9, '科幻': 6, '悬疑': 8, '战争': 10, '动画': 11
  },
  2: { // 电视剧 (地区)
    '大陆': 14, '香港': 15, '台湾': 15, '日本': 16, '韩国': 16, '美国': 17
  },
  3: { // 综艺 (地区)
    '大陆': 19, '香港': 20, '台湾': 20, '日本': 21, '韩国': 21
  },
  4: { // 动漫 (地区)
    '大陆': 23, '日本': 24
  }
};

// Map id=0 to two requests (电影+电视剧) for the "全部" tab
const CAT_IDS = { 0: [1, 2, 3, 4], 1: [1], 2: [2], 3: [3], 4: [4] };

// ─── Filter helpers ────────────────────────────────────────────────────────────
function updateFilterBar() {
  const showFilter = !currentParams.isSearch && !currentParams.isFavorites && currentParams.id !== 0;
  filterBar.classList.toggle('hidden', !showFilter);
}

function resetFilterChips() {
  currentParams.area = '';
  currentParams.year = '';
  areaChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.val === ''));
  yearChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.val === ''));
  if (genreChips) genreChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.val === ''));
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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Favorites (localStorage) ─────────────────────────────────────────────────
const FAV_KEY = 'pvp_favorites';

function getFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; }
}
function saveFavorites(arr) { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); }
function isFavorited(url)   { return getFavorites().some(f => f.url === url); }
function toggleFavorite(item) {
  const favs = getFavorites();
  const idx  = favs.findIndex(f => f.url === item.url);
  if (idx >= 0) { favs.splice(idx, 1); saveFavorites(favs); return false; }
  favs.push({ title: item.title, url: item.url, poster: item.poster || '', badge: item.badge || '' });
  saveFavorites(favs);
  return true;
}
function updateFavTabLabel() {
  const n = getFavorites().length;
  document.getElementById('fav-tab').textContent = n > 0 ? `★ 我的收藏 (${n})` : '★ 我的收藏';
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
    let anyMore  = false;

    if (currentParams.isFavorites) {
      allItems = getFavorites();
      anyMore  = false;
    } else if (currentParams.isSearch) {
      const res = await window.electronAPI.scrapeSearch(currentParams.query, currentParams.page);
      allItems = res.items || [];
      anyMore  = res.hasMore;
      if (res.error) throw new Error(res.error);
    } else {
      const cats = currentParams.page === 1 ? CAT_IDS[currentParams.id] : [currentParams.id === 0 ? 1 : currentParams.id];
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
    emptyMsg.textContent = `加载失败: ${err.message}`;
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
    let anyMore  = false;

    if (currentParams.isFavorites) {
      allItems = getFavorites();
      anyMore  = false;
    } else if (currentParams.isSearch) {
      const res = await window.electronAPI.scrapeSearch(currentParams.query, currentParams.page);
      allItems = res.items || [];
      anyMore  = res.hasMore;
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
    catalogStatus.textContent = `追加失败: ${err.message}`;
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

  if (url.includes('/voddetail/')) {
    setPlayerLoading(true);
    setPlayerStatus('🔍 获取剧集列表…', 'loading');
    window.electronAPI.getDetail(url).then(res => {
      setPlayerLoading(false);
      clearPlayerStatus();
      const sources = res.sources || [];
      if (sources.length === 0) { triggerSniff(url); return; }

      epContainer.classList.remove('hidden');

      // Preferred source: remember last selection across sessions
      const preferred = localStorage.getItem('pvp_preferred_source') || '';
      let activeIdx = 0;
      if (preferred) {
        const found = sources.findIndex(s => s.name === preferred);
        if (found !== -1) activeIdx = found;
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
            renderSourceEpisodes(src.episodes);
          };
          sourceTabBar.appendChild(btn);
        });
      }

      renderSourceEpisodes(sources[activeIdx].episodes);
    }).catch(() => {
      setPlayerLoading(false);
      setPlayerStatus('❌ 无法获取剧集列表，尝试直接播放…', 'error');
      setTimeout(() => triggerSniff(url), 1200);
    });
  } else {
    triggerSniff(url);
  }
}

function renderSourceEpisodes(episodes) {
  currentSourceEpisodes = episodes;
  epSortDesc = false;
  if (epSortBtn) { epSortBtn.textContent = '排序 ⇅'; epSortBtn.classList.remove('desc'); }
  _renderEpBtns(episodes);
}

function _renderEpBtns(episodes) {
  epGrid.innerHTML = '';
  episodes.forEach((ep, i) => {
    const btn = document.createElement('button');
    btn.className = 'ep-btn';
    btn.textContent = ep.title;
    if (i === 0) btn.classList.add('active');
    btn.onclick = () => {
      document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      triggerSniff(ep.url);
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
    
    currentParams.id          = Number(tab.dataset.cat);
    currentParams.page        = 1;
    currentParams.isSearch    = false;
    currentParams.isFavorites = false;
    currentParams.query       = '';
    
    // Show/hide Genre row
    if (currentParams.id === 1) {
      genreRow.style.display = 'flex';
      document.getElementById('area-row').style.display = 'flex';
    } else {
      genreRow.style.display = 'none';
      document.getElementById('area-row').style.display = 'flex';
    }
    
    console.log('[UI Click] currentParams updated:', JSON.stringify(currentParams));
    
    searchInput.value = '';
    resetFilterChips();
    gridScroll.scrollTop = 0;
    
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
  currentParams.isSearch    = false;
  currentParams.query       = '';
  currentParams.page        = 1;
  
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
  
  currentParams.isSearch    = true;
  currentParams.isFavorites = false;
  currentParams.query       = q;
  currentParams.page        = 1;
  
  gridScroll.scrollTop = 0;
  reloadCatalog();
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (!searchInput.value.trim()) return; // don't auto-search empties
  searchTimer = setTimeout(doSearch, 500);
});

// ─── Filter Chips ─────────────────────────────────────────────────────────────
filterBar.addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  const inArea = chip.closest('#area-chips');
  const inYear = chip.closest('#year-chips');
  const inGenre = chip.closest('#genre-chips');
  const container = inArea || inYear || inGenre;
  if (!container) return;
  
  if (chip.classList.contains('active')) return; // ignore clicking already active chip
  
  container.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  
  const activeTab = document.querySelector('.cat-tab.active');
  const baseCat = activeTab ? Number(activeTab.dataset.cat) : 0;
  const val = chip.dataset.val;

  if (inArea) {
    currentParams.area = val;
    
    if (CATEGORY_MAP[baseCat] && CATEGORY_MAP[baseCat][val]) {
      currentParams.id = CATEGORY_MAP[baseCat][val];
      currentParams.area = ''; 
    } else {
      currentParams.id = baseCat;
    }
  } else if (inGenre) {
    // Movies: map genre text exclusively to Category ID
    if (baseCat === 1 && CATEGORY_MAP[1][val]) {
      currentParams.id = CATEGORY_MAP[1][val];
    } else {
      currentParams.id = baseCat;
    }
  } else {
    currentParams.year = val;
  }
  
  currentParams.page = 1;
  currentParams.isSearch = false;
  currentParams.isFavorites = false;
  console.log('[UI Click] currentParams updated:', JSON.stringify(currentParams));
  
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
  // 1. Immediately silence and destroy the HLS pipeline + DPlayer
  if (dpInstance) {
    try { dpInstance.pause(); } catch (_) {}
    try { if (dpInstance.video) dpInstance.video.muted = true; } catch (_) {}
    try { if (dpInstance._hls) { dpInstance._hls.destroy(); dpInstance._hls = null; } } catch (_) {}
    try { dpInstance.destroy(); } catch (_) {}
    dpInstance = null;
  }
  document.getElementById('dplayer').innerHTML = '';

  // 2. Tell the main process to forcibly destroy the sniffer window
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

function setPlayerStatus(msg, type = 'info') {
  spinner.style.display  = type === 'loading' ? 'block' : 'none';
  statusText.textContent = msg;
  playerStatusBar.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
  playerStatusBar.classList.remove('hidden');
}
function clearPlayerStatus() { playerStatusBar.classList.add('hidden'); }

function setPlayerLoading(on) {
  playerLoadBtn.disabled  = on;
  playerUrlInput.disabled = on;
}

function launchPlayer(streamUrl) {
  if (dpInstance) {
    try { dpInstance.pause(); } catch (_) {}
    try { if (dpInstance.video) dpInstance.video.muted = true; } catch (_) {}
    try { if (dpInstance._hls) { dpInstance._hls.destroy(); dpInstance._hls = null; } } catch (_) {}
    try { dpInstance.destroy(); } catch (_) {}
    dpInstance = null;
  }
  document.getElementById('dplayer').innerHTML = '';
  playerPlaceholder.classList.add('hidden');

  dpInstance = new DPlayer({
    container: document.getElementById('dplayer'),
    autoplay: true, theme: '#7c3aed', lang: 'zh-cn', screenshot: true, hotkey: true, preload: 'auto',
    video: {
      url: streamUrl, type: 'customHls',
      customType: {
        customHls(videoEl, player) {
          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
              backBufferLength: 90,
              startPosition: 1,
              xhrSetup(xhr, url) {
                // withCredentials=false: don't send cookies to CDN domains.
                // Referer/Origin spoofing for CDN hotlink protection is handled
                // by the main-process onBeforeSendHeaders interceptor — browsers
                // block JS from setting the Referer header directly.
                xhr.withCredentials = false;
              },
            });
            hls.loadSource(videoEl.src);
            hls.attachMedia(videoEl);
            hls.on(Hls.Events.ERROR, (_e, data) => {
              console.error('[HLS error]', data.type, data.details, data.fatal);
              if (data.fatal) showToast(`Stream error: ${data.details}`, 'error');
            });

            // Quality selector: shown only when the master playlist has ≥2 levels
            hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
              const levels = data.levels || [];
              if (levels.length < 2) return;

              const container = document.getElementById('dplayer');
              container.style.position = 'relative';

              // Build level labels  e.g. "1080P" / "720P" / "480P"
              const labels = levels.map(l => {
                const h = l.height || 0;
                return h >= 1080 ? '1080P' : h >= 720 ? '720P' : h >= 480 ? '480P' : h > 0 ? `${h}P` : `${Math.round((l.bitrate||0)/1000)}k`;
              });

              const menu = document.createElement('div');
              menu.className = 'hls-quality-menu';
              menu.id = 'hls-quality-menu';

              const addItem = (label, levelIdx) => {
                const item = document.createElement('button');
                item.className = 'hls-quality-item' + (levelIdx === -1 ? ' active' : '');
                item.textContent = label;
                item.onclick = () => {
                  hls.currentLevel = levelIdx;
                  menu.querySelectorAll('.hls-quality-item').forEach(b => b.classList.remove('active'));
                  item.classList.add('active');
                  qualBtn.textContent = label;
                  menu.classList.remove('open');
                };
                menu.appendChild(item);
              };
              addItem('自动', -1);
              labels.forEach((lbl, idx) => addItem(lbl, idx));

              const qualBtn = document.createElement('button');
              qualBtn.className = 'hls-quality-btn';
              qualBtn.id = 'hls-quality-btn';
              qualBtn.textContent = '自动';
              qualBtn.onclick = (e) => {
                e.stopPropagation();
                menu.classList.toggle('open');
              };
              document.addEventListener('click', () => menu.classList.remove('open'), { once: false, capture: true });

              container.appendChild(menu);
              container.appendChild(qualBtn);
            });

            player._hls = hls;
          } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            videoEl.src = videoEl.src;
          } else {
            showToast('该环境不支持 HLS 播放。', 'error');
          }
        }
      }
    }
  });

  dpInstance.on('error', () => showToast('播放出错，视频链接可能已过期，请重新加载。', 'error'));
}

function triggerSniff(url) {
  // Abort any in-progress sniff before starting a fresh one
  window.electronAPI.stopSniff();

  window.electronAPI.removeAllListeners();

  window.electronAPI.onStatusUpdate(msg  => setPlayerStatus(msg, 'loading'));
  window.electronAPI.onM3u8Found(({ streamUrl }) => {
    setPlayerLoading(false);
    setPlayerStatus('✅ 正在播放', 'success');
    launchPlayer(streamUrl);
    setTimeout(clearPlayerStatus, 3000);
  });
  window.electronAPI.onSniffError(msg => {
    setPlayerLoading(false);
    setPlayerStatus(msg, 'error');
    showToast(msg, 'error');
    playerPlaceholder.classList.remove('hidden');
  });

  setPlayerLoading(true);
  setPlayerStatus('🚀 启动嚅探器…', 'loading');
  window.electronAPI.sniffUrl(url);
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

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'error') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
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

updateFilterBar();
loadPage(false);
