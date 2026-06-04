'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app        = express();
const PORT       = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_');
    const unique = `${Date.now()}-${safe}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

app.use(express.static(path.join(__dirname, 'public')));

// Upload one or more files
app.post('/upload', upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files received' });
  }
  const saved = req.files.map(f => ({
    stored:   f.filename,
    original: f.originalname,
    size:     f.size
  }));
  res.json({ uploaded: saved });
});

// List all stored files
app.get('/files', (_req, res) => {
  fs.readdir(UPLOAD_DIR, (err, names) => {
    if (err) return res.status(500).json({ error: 'Cannot read uploads directory' });
    const files = names.map(name => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, name));
      const dash = name.indexOf('-');
      const original = dash !== -1 ? name.slice(dash + 1) : name;
      return { stored: name, original, size: stat.size, mtime: stat.mtime };
    });
    files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  });
});

// Download a file
app.get('/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  const dash = filename.indexOf('-');
  const original = dash !== -1 ? filename.slice(dash + 1) : filename;
  res.download(filepath, original);
});

// Delete a file
app.delete('/files/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  fs.unlink(filepath, err => {
    if (err) return res.status(500).json({ error: 'Delete failed' });
    res.json({ deleted: filename });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nexus Bridge running on http://0.0.0.0:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
