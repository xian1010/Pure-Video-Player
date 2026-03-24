const axios = require('axios');
const cheerio = require('cheerio');

async function check() {
  try {
    console.log("Fetching /vodshow/1.html...");
    const { data: indexData } = await axios.get('https://huavod.net/vodshow/1.html', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/122.0.0.0' }
    });
    const $i = cheerio.load(indexData);
    let detailHref = $i('a[href*="/voddetail/"]').first().attr('href');
    if (!detailHref) throw new Error("No detail linked");
    detailHref = detailHref.startsWith('http') ? detailHref : 'https://huavod.net' + detailHref;
    
    console.log("Found detail page:", detailHref);
    const { data: detailData } = await axios.get(detailHref, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/122.0.0.0' }
    });
    
    const $d = cheerio.load(detailData);
    let playHref = $d('a[href*="/vodplay/"]').first().attr('href');
    if (!playHref) throw new Error("No play link found on detail page");
    playHref = playHref.startsWith('http') ? playHref : 'https://huavod.net' + playHref;
    
    console.log("Found play page:", playHref);
    
    const { data } = await axios.get(playHref, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/122.0.0.0', 'Referer': 'https://huavod.net/' }
    });
    
    const $ = cheerio.load(data);
    let scripts = [];
    $('script').each((i, el) => {
      const src = $(el).attr('src');
      if (src) {
        scripts.push(src);
      } else {
        const text = $(el).html();
        if (text.includes('player') || text.includes('hls') || text.includes('wasm') || text.includes('mac_')) {
          console.log('[Inline Script found]');
          const lines = text.split('\n');
          console.log(lines.slice(0, 10).join('\n'));
        }
      }
    });

    console.log('--- External Scripts ---');
    scripts.forEach(s => console.log(s));
    
  } catch (err) {
    console.error(err.message);
  }
}

check();
