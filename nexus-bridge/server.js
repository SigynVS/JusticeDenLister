'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

let UPLOAD_DIR = path.join(__dirname, 'uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload', upload.array('files'), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files received' });
  res.json({ uploaded: req.files.map(f => ({ stored: f.filename, original: f.originalname, size: f.size })) });
});

app.get('/files', (_req, res) => {
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

app.get('/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  const dash = filename.indexOf('-');
  res.download(filepath, dash !== -1 ? filename.slice(dash + 1) : filename);
});

app.delete('/files/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  fs.unlink(filepath, err => err
    ? res.status(500).json({ error: 'Delete failed' })
    : res.json({ deleted: filename }));
});

function startServer(port, uploadDir) {
  if (uploadDir) UPLOAD_DIR = uploadDir;
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => resolve(server));
    server.on('error', reject);
  });
}

module.exports = { startServer };
