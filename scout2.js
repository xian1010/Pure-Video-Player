const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
  const { data } = await axios.get('https://huavod.net/vodshow/1/area/%E9%A6%99%E6%B8%AF.html');
  const $ = cheerio.load(data);
  $('a').each((i, el) => {
    const text = $(el).text().trim();
    if (text === '2024') {
      console.log('Filter link for 2024 while in 香港 ->', $(el).attr('href'));
    }
  });
}
test();
