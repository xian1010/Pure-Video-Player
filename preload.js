'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Sniffer ───────────────────────────────────────────────────────────────
  sniffUrl:          (url)      => ipcRenderer.send('ipc:sniff-url', url),
  onM3u8Found:       (cb)       => ipcRenderer.on('ipc:m3u8-found',    (_e, d) => cb(d)),
  onSniffError:      (cb)       => ipcRenderer.on('ipc:sniff-error',   (_e, m) => cb(m)),
  onStatusUpdate:    (cb)       => ipcRenderer.on('ipc:status',        (_e, m) => cb(m)),
  removeAllListeners: ()        => {
    ipcRenderer.removeAllListeners('ipc:m3u8-found');
    ipcRenderer.removeAllListeners('ipc:sniff-error');
    ipcRenderer.removeAllListeners('ipc:status');
  },

  // ── Catalog (invoke = async request/response) ──────────────────────────────
  scrapeCategory: (catId, page, area = '', year = '') =>
    ipcRenderer.invoke('ipc:scrape-category', { catId, page, area, year }),
  scrapeSearch: (keyword, page) =>
    ipcRenderer.invoke('ipc:scrape-search', { keyword, page }),
  getDetail: (url) => ipcRenderer.invoke('ipc:get-detail', url),
  stopSniff: ()    => ipcRenderer.send('ipc:stop-sniff'),

  // ── Window controls ────────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),

  // ── Auto-updater ───────────────────────────────────────────────────────────
  onUpdateAvailable:  (cb) => ipcRenderer.on('updater:available',  (_e, d) => cb(d)),
  onUpdateProgress:   (cb) => ipcRenderer.on('updater:progress',   (_e, d) => cb(d)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('updater:downloaded',  (_e, d) => cb(d)),
  restartApp:         ()   => ipcRenderer.send('updater:restart'),
});
