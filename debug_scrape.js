// Saves raw HTML to a file so we can examine it
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const BASE_URL  = 'https://huavod.net';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const ax = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: {
    'User-Agent':      CHROME_UA,
    'Referer':         BASE_URL + '/',
    'Accept':          'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
});

async function main() {
  const { data: html } = await ax.get('/vodshow/1/1.html');
  const outPath = path.join(__dirname, 'scrape_sample.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Saved to', outPath, '— size:', html.length, 'bytes');
}

main().catch(console.error);
