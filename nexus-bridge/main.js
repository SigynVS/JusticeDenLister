'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const os   = require('os');
const path = require('path');
const { deflateSync } = require('zlib');
const settings    = require('./lib/settings');
const { startServer } = require('./server');
const localtunnel = require('localtunnel');

const PORT = 4000;
let win = null, tray = null, activeTunnel = null, reconnectTimer = null;
const urls = { local: null, tunnel: null };

// ── Local IP ──────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const [name, nets] of Object.entries(ifaces)) {
    if (/tailscale|vpn|tun|tap/i.test(name)) continue;
    for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) return net.address;
    }
  }
  for (const nets of Object.values(ifaces)) {
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ── Inline PNG icon ───────────────────────────────────
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

// ── Broadcast helpers ─────────────────────────────────
function pushUrls() {
  if (win && !win.isDestroyed()) win.webContents.send('urls', { ...urls });
}
function pushSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('settings', settings.get());
}

// ── Auto-start ────────────────────────────────────────
function applyAutoStart(enabled) {
  app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
}

// ── Window ────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 780, height: 720, minWidth: 480, minHeight: 520,
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
  win.webContents.on('did-finish-load', () => { pushUrls(); pushSettings(); });
  win.on('close', e => { e.preventDefault(); win.hide(); });
}

// ── Tray ──────────────────────────────────────────────
function buildTrayMenu() {
  const { autoStart } = settings.get();
  return Menu.buildFromTemplate([
    { label: 'Show', click: () => win.show() },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox', checked: autoStart,
      click: item => {
        settings.set({ autoStart: item.checked });
        applyAutoStart(item.checked);
        tray.setContextMenu(buildTrayMenu());
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { win.destroy(); app.quit(); } }
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makePng(16)));
  tray.setToolTip('Nexus Bridge');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => win.show());
  settings.onChange(() => tray.setContextMenu(buildTrayMenu()));
}

// ── Tunnel with auto-reconnect ────────────────────────
async function openTunnel() {
  if (activeTunnel) return activeTunnel.url;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try {
    activeTunnel = await localtunnel({ port: PORT });
    const onDropped = () => {
      activeTunnel = null;
      urls.tunnel = 'reconnecting';
      pushUrls();
      reconnectTimer = setTimeout(async () => {
        const url = await openTunnel();
        if (url) { urls.tunnel = url; pushUrls(); }
      }, 5000);
    };
    activeTunnel.on('close', onDropped);
    activeTunnel.on('error', onDropped);
    return activeTunnel.url;
  } catch { return null; }
}

// ── IPC ───────────────────────────────────────────────
ipcMain.handle('start-tunnel', async () => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (activeTunnel) { try { activeTunnel.close(); } catch {} activeTunnel = null; }
  const url = await openTunnel();
  if (url) { urls.tunnel = url; pushUrls(); }
  return url;
});
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
ipcMain.handle('get-settings',  ()       => settings.get());
ipcMain.handle('save-settings', (_, updates) => {
  settings.set(updates);
  if ('autoStart' in updates) applyAutoStart(updates.autoStart);
  pushSettings();
  return settings.get();
});

// ── Boot ──────────────────────────────────────────────
app.whenReady().then(async () => {
  const base = app.isPackaged ? app.getPath('userData') : __dirname;
  settings.init(path.join(base, 'settings.json'));
  applyAutoStart(settings.get().autoStart);

  await startServer(PORT, path.join(base, 'uploads'));
  urls.local = `http://${getLocalIP()}:${PORT}`;

  createWindow();
  createTray();

  const tunnelUrl = await openTunnel();
  if (tunnelUrl) { urls.tunnel = tunnelUrl; pushUrls(); }
});

app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { activeTunnel?.close(); } catch {}
});
