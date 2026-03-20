
const axios = require('axios');
const cheerio = require('cheerio');
async function test() {
  const { data } = await axios.get('https://huavod.net/index.php/vod/show/id/1/area/%E9%A6%99%E6%B8%AF.html');
  const $ = cheerio.load(data);
  const count = div.public-list-box, li.public-list-box.length;
  console.log('Cards found:', count);
}
test();

