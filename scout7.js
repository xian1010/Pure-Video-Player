const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeIDs() {
  const targets = [
    'https://huavod.net/vodshow/1.html',
    'https://huavod.net/vodshow/2.html',
    'https://huavod.net/vodshow/3.html',
    'https://huavod.net/vodshow/4.html'
  ];
  const entries = [];
  for (const url of targets) {
    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href) {
          const match = href.match(/\/vodshow\/(\d+)\.html/);
          if (match && text && text !== '全部首页' && text !== '全部') {
            const id = Number(match[1]);
            // Exclude main categories (1,2,3,4)
            if (id > 4) {
              entries.push(`${text}: ${id}`);
            }
          }
        }
      });
    } catch(err) {}
  }
  console.log('\n--- ALL IDs ---');
  console.log([...new Set(entries)].join('\n'));
}

scrapeIDs();
