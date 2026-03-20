const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeIDs() {
  const targets = [
    'https://huavod.net/',
    'https://huavod.net/vodshow/1.html',
    'https://huavod.net/vodshow/2.html',
    'https://huavod.net/vodshow/3.html',
    'https://huavod.net/vodshow/4.html'
  ];
  
  const map = {};
  
  for (const url of targets) {
    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href && text && text !== '全部') {
          const match = href.match(/\/vodshow\/(\d+)\.html/);
          if (match) {
            const id = Number(match[1]);
            // Exclude main categories and pagination
            if (id > 4 && !map[text] && text.length < 6) {
              map[text] = id;
            }
          }
        }
      });
      console.log(`Scanned ${url}`);
    } catch(err) {
      console.error(`Error scanning ${url}: ${err.message}`);
    }
  }
  
  console.log('\n--- EXTRACTED SUBCATEGORY IDs ---');
  for (const [name, id] of Object.entries(map)) {
    console.log(`${name}: ${id}`);
  }
}

scrapeIDs();
