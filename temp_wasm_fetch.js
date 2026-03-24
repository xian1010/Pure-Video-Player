const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

async function check() {
  try {
    let log = '';
    const { data: indexData } = await axios.get('https://huavod.net/vodshow/1.html', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/122.0.0.0' }
    });
    const $i = cheerio.load(indexData);
    let detailHref = $i('a[href*="/voddetail/"]').first().attr('href');
    detailHref = detailHref.startsWith('http') ? detailHref : 'https://huavod.net' + detailHref;
    
    const { data: detailData } = await axios.get(detailHref, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/122.0.0.0' }
    });
    
    const $d = cheerio.load(detailData);
    let playHref = $d('a[href*="/vodplay/"]').first().attr('href');
    playHref = playHref.startsWith('http') ? playHref : 'https://huavod.net' + playHref;
    
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
        log += '\n[Inline Script]:\n' + $(el).html().substring(0, 500) + '\n';
      }
    });

    log += '\n--- External Scripts ---\n' + scripts.join('\n') + '\n';
    
    for (let s of scripts) {
      if (s.includes('player') || s.includes('wasm') || s.includes('hevc')) {
          log += `\n[SUSPICIOUS SCRIPT] ${s}\n`;
      }
    }

    fs.writeFileSync('huavod_scripts.txt', log);
    console.log("Done checking, results written to huavod_scripts.txt");
  } catch (err) {
    console.error(err.message);
  }
}

check();
