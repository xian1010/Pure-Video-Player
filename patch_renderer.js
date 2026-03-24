const fs = require('fs');

// Patch renderer.js
let rendererCode = fs.readFileSync('renderer.js', 'utf8');

// Fix dplayer to artplayer globally where applicable
rendererCode = rendererCode.replace(/document\.getElementById\('dplayer'\)/g, "document.getElementById('artplayer')");

// Inject the requested logging for WASM testing
const logAnchor = "controls: [";
const logInject = `plugins: plugins,
    controls: [`;
// Since the user asked to log the WASM status AFTER the player initializes, we find where `dpInstance = new Artplayer` finishes.
const initAnchor = "  dpInstance.on('video:error'";
if (rendererCode.includes(initAnchor)) {
    rendererCode = rendererCode.replace(initAnchor, "  console.log('Artplayer HEVC status:', dpInstance.plugins.artplayerPluginHevcWasm);\n" + initAnchor);
}

fs.writeFileSync('renderer.js', rendererCode);
console.log('Patched renderer.js successfully.');

// Patch main.js imgproxy redirect
let mainCode = fs.readFileSync('main.js', 'utf8');
// The user says "依然有 ERR_CONNECTION_TIMED_OUT。请确保我们的 302 重定向逻辑在 main.js 里是全局生效的"
// I will check if imgproxy is handled.
if (mainCode.includes('protocol.interceptStreamProtocol')) {
   // Already intercepted? I need to analyze main.js
}
