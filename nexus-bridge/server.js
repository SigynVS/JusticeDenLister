'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const QRCode   = require('qrcode');
const settings = require('./lib/settings');

let UPLOAD_DIR = path.join(__dirname, 'uploads');
const activeTokens = new Set();
let clipText = '';

// ── Auth ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  const { password } = settings.get();
  if (!password) return next();
  const header = req.headers.authorization || '';
  const token  = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token;
  if (!activeTokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });
const app    = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Status (unprotected) ──────────────────────────────
app.get('/status', (_req, res) => {
  res.json({ needsAuth: !!settings.get().password });
});

// ── Auth endpoints ────────────────────────────────────
app.post('/unlock', (req, res) => {
  const { password } = settings.get();
  if (!password) return res.json({ token: '' });
  if (req.body.password !== password) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomUUID();
  activeTokens.add(token);
  res.json({ token });
});

// ── Files ─────────────────────────────────────────────
app.post('/upload', requireAuth, upload.array('files'), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files received' });
  res.json({ uploaded: req.files.map(f => ({ stored: f.filename, original: f.originalname, size: f.size })) });
});

app.get('/files', requireAuth, (_req, res) => {
  fs.readdir(UPLOAD_DIR, (err, names) => {
    if (err) return res.status(500).json({ error: 'Cannot read uploads' });
    const files = names.map(name => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, name));
      const dash = name.indexOf('-');
      return { stored: name, original: dash !== -1 ? name.slice(dash + 1) : name, size: stat.size, mtime: stat.mtime };
    });
    res.json(files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)));
  });
});

app.get('/download/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  const dash = filename.indexOf('-');
  res.download(filepath, dash !== -1 ? filename.slice(dash + 1) : filename);
});

app.delete('/files/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  fs.unlink(filepath, err => err
    ? res.status(500).json({ error: 'Delete failed' })
    : res.json({ deleted: filename }));
});

// ── QR code ───────────────────────────────────────────
app.get('/qr', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 240, margin: 1,
      color: { dark: '#e2e4f0', light: '#1a1d27' }
    });
    res.json({ dataUrl });
  } catch { res.status(500).json({ error: 'QR generation failed' }); }
});

// ── Clipboard ─────────────────────────────────────────
app.get('/clip',  requireAuth, (_req, res) => res.json({ text: clipText }));
app.post('/clip', requireAuth, (req, res) => {
  clipText = String(req.body.text ?? '');
  res.json({ ok: true });
});

// ── Settings ──────────────────────────────────────────
app.get('/settings',  requireAuth, (_req, res) => res.json(settings.get()));
app.post('/settings', requireAuth, (req, res) => {
  const allowed = ['password', 'fileExpiry', 'autoStart'];
  const updates = {};
  allowed.forEach(k => { if (k in req.body) updates[k] = req.body[k]; });
  settings.set(updates);
  if ('password' in updates) activeTokens.clear();
  res.json(settings.get());
});

// ── File expiry ───────────────────────────────────────
function cleanupExpiredFiles() {
  const { fileExpiry } = settings.get();
  if (!fileExpiry) return;
  const cutoff = Date.now() - fileExpiry * 3_600_000;
  fs.readdir(UPLOAD_DIR, (err, names) => {
    if (err) return;
    names.forEach(name => {
      try {
        const fp = path.join(UPLOAD_DIR, name);
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    });
  });
}
setInterval(cleanupExpiredFiles, 5 * 60 * 1000);

function startServer(port, uploadDir) {
  if (uploadDir) UPLOAD_DIR = uploadDir;
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  cleanupExpiredFiles();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => resolve(server));
    server.on('error', reject);
  });
}

module.exports = { startServer };
