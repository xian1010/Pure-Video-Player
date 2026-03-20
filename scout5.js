const axios = require('axios');
async function test() {
  const urls = [
    'https://huavod.net/vodshow/1.html',
    'https://huavod.net/vodshow/1/area/%E9%A6%99%E6%B8%AF.html',
    'https://huavod.net/vodshow/1/area/%E9%A6%99%E6%B8%AF/page/2/year/2024.html',
    'https://huavod.net/vodshow/1/page/2.html'
  ];
  for (const u of urls) {
    try {
      const res = await axios.get(u);
      console.log('OK:', u, res.data.length);
    } catch (e) {
      console.log('FAIL:', u, e.response ? e.response.status : e.message);
    }
  }
}
test();
