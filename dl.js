const fs = require('fs');
const https = require('https');

if (!fs.existsSync('vendor')) fs.mkdirSync('vendor');

const files = [
  { url: 'https://unpkg.com/dplayer@1.27.1/dist/DPlayer.min.css', out: 'vendor/DPlayer.min.css' },
  { url: 'https://unpkg.com/hls.js@1.5.13/dist/hls.min.js', out: 'vendor/hls.min.js' },
  { url: 'https://unpkg.com/dplayer@1.27.1/dist/DPlayer.min.js', out: 'vendor/DPlayer.min.js' },
];

files.forEach(f => {
  https.get(f.url, (res) => {
    // unpkg often redirects
    if (res.statusCode === 302) {
      https.get(res.headers.location, (res2) => {
        res2.pipe(fs.createWriteStream(f.out));
      });
    } else {
      res.pipe(fs.createWriteStream(f.out));
    }
  });
});
console.log('Fetching files...');
