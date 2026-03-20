# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the app
npm start                    # electron .

# Debug scripts (run directly with Node, no Electron needed)
node debug_play.js           # Dumps mac_player_info JSON from a vodplay page to stdout
node debug_scrape.js         # Fetches a category page and saves raw HTML to scrape_sample.html
```

No build step, no tests, no linter configured.

## Architecture

This is a **frameless Electron app** (no native title bar) targeting `huavod.net`. The source files are:

| File | Role |
|---|---|
| `main.js` | Main process: scraping, sniffer, IPC handlers, window management |
| `renderer.js` | Renderer process: all UI logic, catalog, player, episode list |
| `index.html` | Single-page shell — all CSS lives inline here, no external stylesheet |
| `preload.js` | Context bridge: exposes `window.electronAPI` to the renderer |
| `preload_sniffer.js` | Injected into the hidden sniffer `BrowserWindow` (and all its subframes) |
| `vendor/` | Locally-bundled hls.min.js, DPlayer.min.js/.css — do NOT update via npm |
| `debug_play.js` | Standalone Node script to inspect a vodplay page's player scripts |
| `debug_scrape.js` | Standalone Node script to save raw category HTML for cheerio selector testing |

### IPC Contract (preload.js is the source of truth)

All renderer→main communication goes through `window.electronAPI`:

| Method | Direction | Channel | Purpose |
|---|---|---|---|
| `sniffUrl(url)` | send | `ipc:sniff-url` | Start sniffer for a vodplay URL |
| `stopSniff()` | send | `ipc:stop-sniff` | Force-kill sniffer window + interceptors |
| `onM3u8Found(cb)` | on | `ipc:m3u8-found` | Receive `{ streamUrl, referer, userAgent }` |
| `onSniffError(cb)` | on | `ipc:sniff-error` | Receive error string |
| `onStatusUpdate(cb)` | on | `ipc:status` | Receive status string |
| `removeAllListeners()` | — | — | Must be called before re-registering the three `on` handlers above |
| `scrapeCategory(id, page)` | invoke | `ipc:scrape-category` | Returns `{ items, hasMore }` |
| `scrapeSearch(kw, page)` | invoke | `ipc:scrape-search` | Returns `{ items, hasMore }` |
| `getDetail(url)` | invoke | `ipc:get-detail` | Returns `{ playlists: [{title,url}] }` |

### Playback Pipeline (main.js `startSniffing`)

1. **URL normalisation** — voddetail URLs are rewritten to vodplay (`/voddetail/123.html` → `/vodplay/123-1-1.html`) before any further work.

2. **Fast Extraction** — `ax.get(vodplayUrl)` then parses the `mac_player_info = {...}` JSON block from the HTML. The URL and encrypt value are extracted **only from within that block** to avoid matching unrelated `"url"` keys elsewhere on the page (thumbnails, nav links, etc.).

3. **Decrypt logic** for `mac_player_info.url`:
   - `encrypt:0` — plain URL, no-op
   - `encrypt:1` — `decodeURIComponent(url)`
   - `encrypt:2` — `decodeURIComponent(escape(Buffer.from(url,'base64').toString('binary')))`
   - `encrypt:3` — multi-strategy: S0 = plain `btoa` decode (huavod.net uses this, no reversal), S1–S4 = various reverse+decode combinations for other templates. **Crucially**, each candidate is validated with `/^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+\.m3u8/` before being accepted — loose checks like `includes('.m3u8')` cause garbage binary strings to reach the player.

4. **Gate condition** — Fast extraction only fires to the player if the final `streamUrl` passes the same strict ASCII-only regex above. Any failure silently falls through to the sniffer window.

5. **Sniffer Window fallback** — a hidden `BrowserWindow` loads the vodplay URL. `session.defaultSession.webRequest.onBeforeRequest` intercepts all requests and captures the first non-ad `.m3u8` URL. Ad video blocking targets `okokserver.com/*.mp4`. `preload_sniffer.js` is injected with `nodeIntegrationInSubFrames: true` to reach nested iframes.

6. **`cleanupSniffer()`** — must always be called to remove **both** `onBeforeRequest` and `onBeforeSendHeaders` interceptors, clear the timeout, and `destroy()` the sniffer window. Forgetting either interceptor causes network-level side effects on the main window.

### Player Teardown (renderer.js)

When destroying a player instance (back button or starting a new episode), the order matters:

```js
dpInstance.pause();
dpInstance.video.muted = true;    // immediate audio silence
dpInstance._hls.destroy();        // kills HLS network + audio pipeline
dpInstance.destroy();             // cleans up DPlayer UI
dpInstance = null;
```

`dpInstance._hls` is set by the `customHls` callback inside the DPlayer `customType` config. DPlayer's own `destroy()` does **not** call `hls.destroy()`, so skipping the third step causes background audio bleed.

### Detail Page → Episode Flow (renderer.js)

`onCardClick` → `fetchEpisodes(voddetailUrl)` → `window.electronAPI.getDetail(url)` (cheerio parses `a[href*="/vodplay/"]`) → renders episode buttons. Episode buttons call `triggerSniff(vodplayUrl)`. The user must click an episode button; there is no auto-play.

`triggerSniff` always calls `removeAllListeners()` before re-registering `onM3u8Found` / `onSniffError` / `onStatusUpdate` to prevent listener accumulation across episode changes.

### Image Proxy

Poster images use a custom `imgproxy://` protocol (`protocol.handle` in main.js) to proxy requests through Node/axios with spoofed Referer/UA headers, bypassing hotlink protection. Usage in renderer: `src="imgproxy://<encodeURIComponent(realUrl)>"`.
