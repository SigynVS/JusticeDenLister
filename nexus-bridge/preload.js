'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onUrls:       cb  => ipcRenderer.on('urls', (_, data) => cb(data)),
  startTunnel:  ()  => ipcRenderer.invoke('start-tunnel'),
  openExternal: url => ipcRenderer.invoke('open-external', url)
});
