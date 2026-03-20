const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL  = 'https://huavod.net';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const ax = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: {
    'User-Agent': CHROME_UA,
    'Referer': BASE_URL + '/',
  },
});

async function main() {
  const url = '/vodplay/194548-1-1.html';
  console.log(`Fetching ${url} ...`);
  try {
    const { data: html } = await ax.get(url);
    const $ = cheerio.load(html);
    
    let found = false;
    $('script').each((i, el) => {
      const text = $(el).html() || '';
      if (text.includes('player_') || text.includes('mac_')) {
        console.log(`\n--- Script ${i} ---`);
        console.log(text.slice(0, 500));
        found = true;
      }
    });

    if (!found) {
      console.log('No interesting player scripts found in HTML.');
    }
  } catch (err) {
    console.error('Request failed', err.message);
  }
}

main();
