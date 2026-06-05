'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onUrls:       cb       => ipcRenderer.on('urls',     (_, d) => cb(d)),
  onSettings:   cb       => ipcRenderer.on('settings', (_, d) => cb(d)),
  startTunnel:  ()       => ipcRenderer.invoke('start-tunnel'),
  openExternal: url      => ipcRenderer.invoke('open-external', url),
  getSettings:  ()       => ipcRenderer.invoke('get-settings'),
  saveSettings: updates  => ipcRenderer.invoke('save-settings', updates)
});
