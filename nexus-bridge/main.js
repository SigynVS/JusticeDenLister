'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const os   = require('os');
const path = require('path');
const { deflateSync } = require('zlib');
const { startServer } = require('./server');
const localtunnel = require('localtunnel');

const PORT = 4000;
let win = null, tray = null, activeTunnel = null;
const urls = { local: null, tunnel: null };

// ── Local IP ──────────────────────────────────────────
function getLocalIP() {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ── Inline PNG icon (no external file needed) ─────────
function makePng(size, rgb = [124, 106, 247]) {
  const [R, G, B] = rgb;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = R; row[2 + x * 3] = G; row[3 + x * 3] = B;
    }
    rows.push(row);
  }
  const crc = d => {
    let c = 0xFFFFFFFF;
    for (const b of d) { c ^= b; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
    return (~c) >>> 0;
  };
  const chunk = (t, d) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0); b.write(t, 4, 'ascii'); d.copy(b, 8);
    b.writeUInt32BE(crc(b.slice(4, 8 + d.length)), 8 + d.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Push URLs to renderer ─────────────────────────────
function pushUrls() {
  if (win && !win.isDestroyed()) win.webContents.send('urls', { ...urls });
}

// ── Window ────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 780, height: 640, minWidth: 480, minHeight: 420,
    icon: nativeImage.createFromBuffer(makePng(32)),
    backgroundColor: '#0f1117',
    show: false,
    title: 'Nexus Bridge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadURL(`http://localhost:${PORT}`);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', pushUrls);
  win.on('close', e => { e.preventDefault(); win.hide(); });
}

// ── System tray ───────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makePng(16)));
  tray.setToolTip('Nexus Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show',      click: () => win.show() },
    { type: 'separator' },
    { label: 'Quit',      click: () => { win.destroy(); app.quit(); } }
  ]));
  tray.on('click', () => win.show());
}

// ── Tunnel ────────────────────────────────────────────
async function openTunnel() {
  if (activeTunnel) return activeTunnel.url;
  try {
    activeTunnel = await localtunnel({ port: PORT });
    activeTunnel.on('close', () => { activeTunnel = null; urls.tunnel = null; pushUrls(); });
    activeTunnel.on('error', () => { activeTunnel = null; urls.tunnel = null; pushUrls(); });
    return activeTunnel.url;
  } catch { return null; }
}

// ── IPC ───────────────────────────────────────────────
ipcMain.handle('start-tunnel', async () => {
  const url = await openTunnel();
  if (url) { urls.tunnel = url; pushUrls(); }
  return url;
});
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// ── Boot ──────────────────────────────────────────────
app.whenReady().then(async () => {
  const uploadDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'uploads')
    : path.join(__dirname, 'uploads');
  await startServer(PORT, uploadDir);
  urls.local = `http://${getLocalIP()}:${PORT}`;

  createWindow();
  createTray();

  const tunnelUrl = await openTunnel();
  if (tunnelUrl) { urls.tunnel = tunnelUrl; pushUrls(); }
});

app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => activeTunnel?.close());
