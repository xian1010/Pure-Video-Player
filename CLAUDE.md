# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the app
npm start                    # electron .
```

No build step, no tests, no linter configured.

## Site

Target site: **xiaobaotv.tv** (小宝影院). No Cloudflare — direct `axios` access works.

## Architecture

This is a **frameless Electron app** (no native title bar) targeting `xiaobaotv.tv`. The source files are:

| File | Role |
|---|---|
| `main.js` | Main process: sniffer, IPC handlers, window management |
| `renderer.js` | Renderer process: all UI logic, catalog, player, episode list |
| `index.html` | Single-page shell — all CSS lives inline here |
| `preload.js` | Context bridge: exposes `window.electronAPI` to the renderer |
| `preload_sniffer.js` | Injected into the hidden sniffer `BrowserWindow` |
| `vendor/` | Locally-bundled hls.min.js, artplayer — do NOT update via npm |

### Data Fetching

**All data is fetched via `ipc:main-fetch` → `axios.get()` in the main process.** No session/cookie needed — xiaobaotv.tv has no Cloudflare.

Flow:
1. `fetchHTML(url)` in renderer → `window.electronAPI.mainFetch(url)` → `axios.get(url)` in main
2. HTML returned as `{ status, body, isCF }` — renderer parses with `DOMParser`

### IPC Contract (preload.js is the source of truth)

| Method | Direction | Channel | Purpose |
|---|---|---|---|
| `mainFetch(url)` | invoke | `ipc:main-fetch` | `axios.get` HTML, returns `{ status, body }` |
| `sniffUrl(url)` | send | `ipc:sniff-url` | Start sniffer for a play URL |
| `stopSniff()` | send | `ipc:stop-sniff` | Force-kill sniffer window + interceptors |
| `sendStopSniffing()` | send | `stop-sniffing` | Same as stopSniff |
| `onM3u8Found(cb)` | on | `ipc:m3u8-found` | Receive `{ streamUrl, referer, userAgent }` |
| `onSniffError(cb)` | on | `ipc:sniff-error` | Receive error string |
| `onStatusUpdate(cb)` | on | `ipc:status` | Receive status string |
| `removeAllListeners()` | — | — | Must be called before re-registering the three `on` handlers above |

### xiaobaotv.tv URL Patterns

| Resource | URL pattern |
|---|---|
| Homepage | `https://www.xiaobaotv.tv/` |
| Category (type) | `https://www.xiaobaotv.tv/movie/type/<id>.html` |
| Category filtered | `https://www.xiaobaotv.tv/movie/type/<id>/area/<area>.html` |
| Category filtered by year | `https://www.xiaobaotv.tv/movie/type/<id>/year/<year>.html` |
| Detail page | `https://www.xiaobaotv.tv/movie/detail/<id>.html` |
| Play page | `https://www.xiaobaotv.tv/movie/play/<id>-<sid>-<nid>.html` |
| Search | `https://www.xiaobaotv.tv/search.html?wd=<query>` |

Type IDs: 1=电影, 2=电视剧, 3=综艺, 4=动漫, 5=短剧

### HTML Selectors (xiaobaotv.tv)

| Selector | Purpose |
|---|---|
| `ul.myui-vodlist li a.myui-vodlist__thumb` | Movie cards |
| `a.myui-vodlist__thumb[data-original]` | Poster image (lazy load attribute) |
| `a[href*="/movie/detail/"]` | Card link |
| `a[href*="/movie/play/"]` | Episode link |
| `span.pic-tag-top span.tag` | Year/quality badge |
| `div.myui-panel` containing `a[href*="/movie/play/"]` | Source group (for multi-source series) |

### Sniffer Pipeline (main.js `startSniffing`)

1. Creates a hidden `BrowserWindow` with a fresh `session.fromPartition('sniffer:...')` and `preload_sniffer.js`
2. Registers `snifferSession.webRequest.onBeforeRequest` to intercept all requests — captures the first non-ad `.m3u8` URL
3. **Fast extract**: `snifferSession.fetch(playUrl)` gets the HTML, then `extractStreamInfo(html)` parses `mac_player_info = {...}` JSON block. Unicode escapes (`\uXXXX`) are unescaped before JSON.parse.
4. **Decrypt** `mac_player_info.url` by `encrypt` field (0=plain, 1=decodeURIComponent, 2=base64+binary, 3=base64+utf8). Validates with `^https?:\/\/[...]\.m3u8` before accepting.
5. If fast extract succeeds → fires `ipc:m3u8-found` → renderer launches player
6. If fast extract fails → sniffer window stays open, intercepting m3u8 from network
7. Ad blocking: cancels `.mp4` requests from known ad domains

### Player Teardown (renderer.js)

Order matters when destroying a player instance:

```js
dpInstance.pause();
dpInstance.video.muted = true;   // immediate audio silence
dpInstance.hls.destroy();        // kills HLS network + audio pipeline
dpInstance.destroy();             // cleans up Artplayer UI
dpInstance = null;
```

`dpInstance.hls` is set by the `customType.m3u8` callback inside Artplayer's `customType` config. Artplayer's own `destroy()` does **not** call `hls.destroy()`.

### Detail Page → Episode Flow (renderer.js)

`onCardClick` → `fetchEpisodes(url)` → `fetchHTML()` → `parseDetail()` → renders episode buttons → `triggerSniff(playUrl)`.

`triggerSniff` always calls `removeAllListeners()` before re-registering `onM3u8Found` / `onSniffError` / `onStatusUpdate`.

### Image Proxy

Poster images use a custom `imgproxy://` protocol (`protocol.handle` in main.js) to proxy requests through `axios` with spoofed Referer/UA headers. Usage in renderer: `src="imgproxy://<encodeURIComponent(realUrl)>"`.
