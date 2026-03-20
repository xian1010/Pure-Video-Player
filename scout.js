const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
  const { data } = await axios.get('https://huavod.net/vodshow/1.html');
  const $ = cheerio.load(data);
  $('a').each((i, el) => {
    const text = $(el).text().trim();
    if (text === '香港' || text === '2024' || text === '大陆') {
      console.log('Filter link for', text, '->', $(el).attr('href'));
    }
  });
}
test();
