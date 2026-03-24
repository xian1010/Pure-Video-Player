const axios = require('axios');
const cheerio = require('cheerio');

const ax = axios.create({
  baseURL: 'https://huavod.net',
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Referer': 'https://huavod.net/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
});

async function main() {
  const { data: html } = await ax.get('/voddetail/1.html');
  const $ = cheerio.load(html);
  const tabEls = $('.anthology-tab .swiper-wrapper a.swiper-slide');
  tabEls.each((i, el) => {
    const text = $(el).clone().children('i').remove().end().text().trim();
    console.log('Source:', text);
  });
}
main().catch(e => console.error(e));
