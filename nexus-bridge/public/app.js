'use strict';

// ── State ──────────────────────────────────────────────
let pendingFiles = [];

// ── DOM refs ───────────────────────────────────────────
const dropzone      = document.getElementById('dropzone');
const fileInput     = document.getElementById('file-input');
const queue         = document.getElementById('queue');
const progressWrap  = document.getElementById('progress-wrap');
const progressBar   = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const uploadBtn     = document.getElementById('upload-btn');
const uploadStatus  = document.getElementById('upload-status');
const fileList      = document.getElementById('file-list');
const refreshBtn    = document.getElementById('refresh-btn');

// ── Drag-and-drop ──────────────────────────────────────
['dragenter','dragover'].forEach(ev =>
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave','drop'].forEach(ev =>
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
dropzone.addEventListener('drop', e => addFiles(Array.from(e.dataTransfer.files)));
fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });

// ── Queue management ───────────────────────────────────
function addFiles(files) {
  files.forEach(f => {
    if (!pendingFiles.find(p => p.name === f.name && p.size === f.size)) {
      pendingFiles.push(f);
    }
  });
  renderQueue();
}

function removeFile(idx) {
  pendingFiles.splice(idx, 1);
  renderQueue();
}

function renderQueue() {
  queue.innerHTML = '';
  if (pendingFiles.length === 0) {
    queue.classList.add('hidden');
    uploadBtn.classList.add('hidden');
    return;
  }
  queue.classList.remove('hidden');
  uploadBtn.classList.remove('hidden');
  pendingFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `
      <span class="queue-name">${escHtml(f.name)}</span>
      <span class="queue-size">${fmtSize(f.size)}</span>
      <button class="queue-remove" title="Remove">&times;</button>`;
    row.querySelector('.queue-remove').addEventListener('click', () => removeFile(i));
    queue.appendChild(row);
  });
}

// ── Upload ─────────────────────────────────────────────
uploadBtn.addEventListener('click', doUpload);

async function doUpload() {
  if (pendingFiles.length === 0) return;

  uploadBtn.disabled = true;
  setStatus('');
  progressWrap.classList.remove('hidden');
  setProgress(0);

  const form = new FormData();
  pendingFiles.forEach(f => form.append('files', f));

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload');

      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error(JSON.parse(xhr.responseText).error || 'Upload failed'));
      });
      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.send(form);
    });

    setProgress(100);
    setStatus(`Uploaded ${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''}`, 'ok');
    pendingFiles = [];
    renderQueue();
    loadFiles();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    uploadBtn.disabled = false;
    setTimeout(() => progressWrap.classList.add('hidden'), 1200);
  }
}

// ── File list ──────────────────────────────────────────
refreshBtn.addEventListener('click', loadFiles);

async function loadFiles() {
  fileList.innerHTML = '<p class="empty-state">Loading&#8230;</p>';
  try {
    const res = await fetch('/files');
    const files = await res.json();
    renderFileList(files);
  } catch {
    fileList.innerHTML = '<p class="empty-state" style="color:var(--danger)">Failed to load files</p>';
  }
}

function renderFileList(files) {
  if (!files.length) {
    fileList.innerHTML = '<p class="empty-state">No files yet — upload something above</p>';
    return;
  }
  fileList.innerHTML = '';
  files.forEach(f => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.stored = f.stored;
    row.innerHTML = `
      <span class="file-icon">${fileIcon(f.original)}</span>
      <div class="file-info">
        <div class="file-name" title="${escHtml(f.original)}">${escHtml(f.original)}</div>
        <div class="file-meta">${fmtSize(f.size)} &bull; ${fmtDate(f.mtime)}</div>
      </div>
      <div class="file-actions">
        <a class="btn-dl" href="/download/${encodeURIComponent(f.stored)}" download>&#8595; Download</a>
        <button class="btn-del" data-stored="${escHtml(f.stored)}">&#128465;</button>
      </div>`;
    row.querySelector('.btn-del').addEventListener('click', () => deleteFile(f.stored, row));
    fileList.appendChild(row);
  });
}

async function deleteFile(stored, row) {
  if (!confirm('Delete this file?')) return;
  try {
    const res = await fetch(`/files/${encodeURIComponent(stored)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
    row.remove();
    if (!fileList.children.length)
      fileList.innerHTML = '<p class="empty-state">No files yet — upload something above</p>';
  } catch (err) {
    alert(err.message);
  }
}

// ── Helpers ────────────────────────────────────────────
function setProgress(pct) {
  progressBar.style.width = pct + '%';
  progressLabel.textContent = pct + '%';
}

function setStatus(msg, type = '') {
  uploadStatus.textContent = msg;
  uploadStatus.className = 'status-msg' + (type ? ' ' + type : '');
}

function fmtSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1048576)     return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824)  return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️', svg:'🖼️',
    mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬', webm:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵', m4a:'🎵',
    pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊',
    zip:'🗜️', rar:'🗜️', '7z':'🗜️', tar:'🗜️', gz:'🗜️',
    js:'💻', ts:'💻', py:'💻', html:'💻', css:'💻', json:'💻',
    txt:'📃'
  };
  return map[ext] || '📁';
}

// ── Electron bridge ────────────────────────────────────
if (window.bridge) {
  const panel      = document.getElementById('bridge-panel');
  const localEl    = document.getElementById('local-url');
  const tunnelEl   = document.getElementById('tunnel-url');
  const copyBtns   = document.querySelectorAll('.btn-copy');
  const tunnelRefresh = document.getElementById('tunnel-refresh');

  panel.classList.remove('hidden');

  window.bridge.onUrls(({ local, tunnel }) => {
    if (local) {
      localEl.textContent = local;
      localEl.classList.remove('muted');
      copyBtns[0].disabled = false;
    }
    if (tunnel) {
      tunnelEl.textContent = tunnel;
      tunnelEl.classList.remove('muted');
      copyBtns[1].disabled = false;
    } else if (!tunnel && tunnelEl.textContent === 'connecting…') {
      tunnelEl.textContent = 'unavailable';
    }
  });

  copyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      navigator.clipboard.writeText(target.textContent).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      });
    });
  });

  tunnelRefresh.addEventListener('click', async () => {
    tunnelEl.textContent = 'connecting…';
    tunnelEl.classList.add('muted');
    copyBtns[1].disabled = true;
    const url = await window.bridge.startTunnel();
    if (url) {
      tunnelEl.textContent = url;
      tunnelEl.classList.remove('muted');
      copyBtns[1].disabled = false;
    } else {
      tunnelEl.textContent = 'failed — try again';
    }
  });
}

// ── Init ───────────────────────────────────────────────
loadFiles();
