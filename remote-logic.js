// remote-logic.js
// ─────────────────────────────────────────────────────────────────────────────
// Hot-patchable site-parsing logic for huavod.net.
// This file is fetched from GitHub at app startup and executed in a vm sandbox.
// Edit it here and push to fix broken selectors without shipping a new release.
//
// Injected by host (do NOT require/import anything):
//   ax         — pre-configured axios instance (baseURL = https://huavod.net)
//   cheerio    — cheerio library
//   BASE_URL   — 'https://huavod.net'
//   CHROME_UA  — spoofed User-Agent string
//   console    — Node.js console
//   Promise    — outer Promise constructor
//
// ECMAScript builtins (Set, Map, Array, encodeURIComponent, etc.) are available
// natively in the vm context — no need to inject them.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Card grid parser ──────────────────────────────────────────────────────────
function parseCards(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('div.public-list-box, li.public-list-box').each((_i, el) => {
    const $el = $(el);
    if ($el.closest('.swiper-wrapper').length) return; // carousel item, skip

    const imgEl = $el.find('img').first();
    let poster  = imgEl.attr('data-src') || imgEl.attr('src') || '';
    if (poster && !poster.startsWith('http')) poster = BASE_URL + poster;

    const aEl  = $el.find('a.public-list-exp').first();
    const href = aEl.attr('href') || '';
    const url  = href.startsWith('http') ? href : BASE_URL + href;

    const title = $el.find('a.time-title').first().text().trim() || aEl.attr('title') || '';
    const badge = $el.find('span.public-prt').first().text().trim();

    if (title && url.includes('/voddetail/')) items.push({ title, url, poster, badge });
  });

  return items;
}

// ── Pagination check ──────────────────────────────────────────────────────────
function hasNextPage(html, currentPage) {
  const $ = cheerio.load(html);
  if ($('a.page-next, a[title="下一页"]').attr('href')) return true;
  return $('div.public-list-box').length >= 24;
}

// ── Category scraper ──────────────────────────────────────────────────────────
async function scrapeCategory(catId, page, area, year) {
  page = page || 1;
  area = area || '';
  year = year || '';
  let p = `/vodshow/${catId}`;
  if (area) p += `/area/${encodeURIComponent(area)}`;
  if (year) p += `/year/${year}`;
  p += `/${page}.html`;
  const { data: html } = await ax.get(p);
  return { items: parseCards(html), hasMore: hasNextPage(html, page) };
}

// ── Search ────────────────────────────────────────────────────────────────────
async function scrapeSearch(keyword, page) {
  page = page || 1;
  const encoded = encodeURIComponent(keyword);
  const { data: json } = await ax.get(`/index.php/ajax/suggest?mid=1&wd=${encoded}&pg=${page}`);
  if (!json || json.code !== 1 || !Array.isArray(json.list)) return { items: [], hasMore: false };
  const items = json.list.map(v => {
    const poster = v.vod_pic || v.pic || '';
    return {
      title:  v.name || '',
      url:    `${BASE_URL}/voddetail/${v.id}.html`,
      poster: poster.startsWith('http') ? poster : (poster ? BASE_URL + poster : ''),
      badge:  '',
    };
  }).filter(v => v.title && v.url);
  return { items, hasMore: page < (json.pagecount || 1) };
}

// ── Detail / episode list ─────────────────────────────────────────────────────
async function getDetail(targetUrl) {
  const { data: html } = await ax.get(targetUrl);
  const $ = cheerio.load(html);

  const sources   = [];
  const tabEls    = $('.anthology-tab .swiper-wrapper a.swiper-slide');
  const listBoxes = $('.anthology-list .anthology-list-box');

  if (tabEls.length > 0) {
    tabEls.each((i, tabEl) => {
      const name = $(tabEl).clone().children('i').remove().end().text().trim() || `线路${i + 1}`;
      const episodes = [];
      listBoxes.eq(i).find('a[href*="/vodplay/"]').each((j, aEl) => {
        const rawHref = $(aEl).attr('href') || '';
        const href    = rawHref.startsWith('http') ? rawHref : BASE_URL + rawHref;
        episodes.push({ title: $(aEl).text().trim() || `${j + 1}`, url: href });
      });
      if (episodes.length > 0) sources.push({ name, episodes });
    });
  }

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

  return { sources };
}

module.exports = { parseCards, hasNextPage, scrapeCategory, scrapeSearch, getDetail };
