'use strict';

// ── Auth token ─────────────────────────────────────────
function getToken()    { return localStorage.getItem('nb_token') || ''; }
function setToken(t)   { if (t) localStorage.setItem('nb_token', t); else localStorage.removeItem('nb_token'); }
function authHeaders() { const t = getToken(); return t ? { 'Authorization': `Bearer ${t}` } : {}; }
function dlUrl(stored) {
  const t = getToken();
  return `/download/${encodeURIComponent(stored)}${t ? '?token=' + encodeURIComponent(t) : ''}`;
}

// ── Auth / lock screen ─────────────────────────────────
const lockScreen = document.getElementById('lock-screen');
const lockInput  = document.getElementById('lock-input');
const lockBtn    = document.getElementById('lock-btn');
const lockError  = document.getElementById('lock-error');

async function checkAuth() {
  const { needsAuth } = await fetch('/status').then(r => r.json()).catch(() => ({ needsAuth: false }));
  if (!needsAuth) { lockScreen.classList.add('hidden'); return true; }
  const token = getToken();
  if (token) {
    const test = await fetch('/files', { headers: authHeaders() });
    if (test.ok) { lockScreen.classList.add('hidden'); return true; }
    setToken('');
  }
  lockScreen.classList.remove('hidden');
  return false;
}

async function doUnlock() {
  lockError.textContent = '';
  const res  = await fetch('/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: lockInput.value }) });
  const data = await res.json();
  if (!res.ok) { lockError.textContent = data.error || 'Wrong password'; return; }
  setToken(data.token);
  lockInput.value = '';
  lockScreen.classList.add('hidden');
  init();
}

lockBtn.addEventListener('click', doUnlock);
lockInput.addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });

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
dropzone.addEventListener('drop',  e => addFiles(Array.from(e.dataTransfer.files)));
fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });

// ── Queue ──────────────────────────────────────────────
function addFiles(files) {
  files.forEach(f => {
    if (!pendingFiles.find(p => p.name === f.name && p.size === f.size)) pendingFiles.push(f);
  });
  renderQueue();
}

function removeFile(idx) { pendingFiles.splice(idx, 1); renderQueue(); }

function renderQueue() {
  queue.innerHTML = '';
  if (!pendingFiles.length) { queue.classList.add('hidden'); uploadBtn.classList.add('hidden'); return; }
  queue.classList.remove('hidden');
  uploadBtn.classList.remove('hidden');
  pendingFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `<span class="queue-name">${escHtml(f.name)}</span><span class="queue-size">${fmtSize(f.size)}</span><button class="queue-remove">&times;</button>`;
    row.querySelector('.queue-remove').addEventListener('click', () => removeFile(i));
    queue.appendChild(row);
  });
}

// ── Upload ─────────────────────────────────────────────
uploadBtn.addEventListener('click', doUpload);

async function doUpload() {
  if (!pendingFiles.length) return;
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
      const t = getToken();
      if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        if (xhr.status === 401) { setToken(''); checkAuth(); reject(new Error('Session expired')); return; }
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
    setTimeout(() => progressWrap.classList.add('hidden'), 1400);
  }
}

// ── File list ──────────────────────────────────────────
refreshBtn.addEventListener('click', loadFiles);

async function loadFiles() {
  fileList.innerHTML = '<p class="empty-state">Loading&#8230;</p>';
  try {
    const res = await fetch('/files', { headers: authHeaders() });
    if (res.status === 401) { setToken(''); checkAuth(); return; }
    const files = await res.json();
    renderFileList(files);
  } catch {
    fileList.innerHTML = '<p class="empty-state" style="color:var(--danger)">Failed to load files</p>';
  }
}

function renderFileList(files) {
  if (!files.length) { fileList.innerHTML = '<p class="empty-state">No files yet — upload something above</p>'; return; }
  fileList.innerHTML = '';
  files.forEach(f => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <span class="file-icon">${fileIcon(f.original)}</span>
      <div class="file-info">
        <div class="file-name" title="${escHtml(f.original)}">${escHtml(f.original)}</div>
        <div class="file-meta">${fmtSize(f.size)} &bull; ${fmtDate(f.mtime)}</div>
      </div>
      <div class="file-actions">
        <a class="btn-dl" href="${dlUrl(f.stored)}" download>&#8595; Download</a>
        <button class="btn-del" data-stored="${escHtml(f.stored)}">&#128465;</button>
      </div>`;
    row.querySelector('.btn-del').addEventListener('click', () => deleteFile(f.stored, row));
    fileList.appendChild(row);
  });
}

async function deleteFile(stored, row) {
  if (!confirm('Delete this file?')) return;
  try {
    const res = await fetch(`/files/${encodeURIComponent(stored)}`, { method: 'DELETE', headers: authHeaders() });
    if (res.status === 401) { setToken(''); checkAuth(); return; }
    if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
    row.remove();
    if (!fileList.children.length) fileList.innerHTML = '<p class="empty-state">No files yet — upload something above</p>';
  } catch (err) { alert(err.message); }
}

// ── Clipboard ──────────────────────────────────────────
const clipText    = document.getElementById('clip-text');
const clipSend    = document.getElementById('clip-send');
const clipCopy    = document.getElementById('clip-copy');
const clipRefresh = document.getElementById('clip-refresh');
const clipStatus  = document.getElementById('clip-status');

async function loadClip() {
  try {
    const res  = await fetch('/clip', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.text && data.text !== clipText.value) clipText.value = data.text;
  } catch {}
}

async function sendClip() {
  try {
    await fetch('/clip', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clipText.value }) });
    flashClipStatus('Sent');
  } catch { flashClipStatus('Failed', true); }
}

function flashClipStatus(msg, err = false) {
  clipStatus.textContent = msg;
  clipStatus.style.color = err ? 'var(--danger)' : 'var(--success)';
  setTimeout(() => { clipStatus.textContent = ''; }, 2000);
}

clipSend.addEventListener('click', sendClip);
clipRefresh.addEventListener('click', loadClip);
clipCopy.addEventListener('click', async () => {
  if (!clipText.value) return;
  await navigator.clipboard.writeText(clipText.value).catch(() => {});
  flashClipStatus('Copied');
});
setInterval(loadClip, 10000); // auto-poll

// ── Settings ───────────────────────────────────────────
const settingsBtn   = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const sPassword     = document.getElementById('s-password');
const sExpiry       = document.getElementById('s-expiry');
const sAutostart    = document.getElementById('s-autostart');
const sAutostartRow = document.getElementById('s-autostart-row');
const sSave         = document.getElementById('s-save');
const sStatus       = document.getElementById('s-status');

async function openSettings() {
  try {
    let current;
    if (window.bridge) {
      current = await window.bridge.getSettings();
    } else {
      const res = await fetch('/settings', { headers: authHeaders() });
      current = await res.json();
    }
    sPassword.value     = '';
    sExpiry.value       = String(current.fileExpiry || 0);
    sAutostart.checked  = !!current.autoStart;
    sAutostartRow.style.display = window.bridge ? '' : 'none';
  } catch {}
  settingsModal.classList.remove('hidden');
}

async function saveSettings() {
  const updates = {
    password:    sPassword.value,
    fileExpiry:  Number(sExpiry.value),
    autoStart:   sAutostart.checked
  };
  try {
    if (window.bridge) {
      await window.bridge.saveSettings(updates);
    } else {
      const res = await fetch('/settings', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
      if (!res.ok) { sStatus.textContent = 'Save failed'; sStatus.className = 's-status err'; return; }
    }
    sStatus.textContent = 'Saved';
    sStatus.className   = 's-status ok';
    setTimeout(() => { sStatus.textContent = ''; }, 2000);
    if (updates.password) { setToken(''); settingsModal.classList.add('hidden'); checkAuth(); }
  } catch { sStatus.textContent = 'Error'; sStatus.className = 's-status err'; }
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });
sSave.addEventListener('click', saveSettings);

// ── QR modal ───────────────────────────────────────────
const qrModal = document.getElementById('qr-modal');
const qrClose = document.getElementById('qr-close');
const qrImg   = document.getElementById('qr-img');
const qrLabel = document.getElementById('qr-label');

async function showQR(url) {
  qrLabel.textContent = url;
  qrImg.src = '';
  qrModal.classList.remove('hidden');
  try {
    const res  = await fetch(`/qr?url=${encodeURIComponent(url)}`, { headers: authHeaders() });
    const data = await res.json();
    qrImg.src  = data.dataUrl;
  } catch { qrImg.alt = 'Failed to load QR'; }
}

qrClose.addEventListener('click', () => qrModal.classList.add('hidden'));
qrModal.addEventListener('click', e => { if (e.target === qrModal) qrModal.classList.add('hidden'); });

// ── Electron bridge ────────────────────────────────────
if (window.bridge) {
  const panel        = document.getElementById('bridge-panel');
  const localEl      = document.getElementById('local-url');
  const tunnelEl     = document.getElementById('tunnel-url');
  const copyBtns     = document.querySelectorAll('.btn-copy');
  const qrBtns       = document.querySelectorAll('.btn-qr');
  const tunnelRefresh = document.getElementById('tunnel-refresh');

  panel.classList.remove('hidden');

  window.bridge.onUrls(({ local, tunnel }) => {
    if (local) {
      localEl.textContent = local;
      localEl.classList.remove('muted');
      copyBtns[0].disabled = false;
      qrBtns[0].disabled   = false;
    }
    if (tunnel && tunnel !== 'reconnecting') {
      tunnelEl.textContent = tunnel;
      tunnelEl.classList.remove('muted');
      copyBtns[1].disabled = false;
      qrBtns[1].disabled   = false;
    } else if (tunnel === 'reconnecting') {
      tunnelEl.textContent = 'reconnecting…';
      tunnelEl.classList.add('muted');
      copyBtns[1].disabled = true;
      qrBtns[1].disabled   = true;
    } else if (!tunnel) {
      tunnelEl.textContent = 'unavailable';
    }
  });

  // Copy buttons
  copyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = document.getElementById(btn.dataset.target)?.textContent;
      if (!val) return;
      navigator.clipboard.writeText(val).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      });
    });
  });

  // QR buttons
  qrBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = document.getElementById(btn.dataset.target)?.textContent;
      if (val && !val.includes('…') && val !== 'unavailable') showQR(val);
    });
  });

  // Reconnect tunnel
  tunnelRefresh.addEventListener('click', async () => {
    tunnelEl.textContent = 'connecting…';
    tunnelEl.classList.add('muted');
    copyBtns[1].disabled = true;
    qrBtns[1].disabled   = true;
    await window.bridge.startTunnel();
  });
}

// ── Helpers ────────────────────────────────────────────
function setProgress(pct) {
  progressBar.style.width  = pct + '%';
  progressLabel.textContent = pct + '%';
}

function setStatus(msg, type = '') {
  uploadStatus.textContent = msg;
  uploadStatus.className   = 'status-msg' + (type ? ' ' + type : '');
}

function fmtSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',
    mp4:'🎬',mov:'🎬',avi:'🎬',mkv:'🎬',webm:'🎬',
    mp3:'🎵',wav:'🎵',flac:'🎵',m4a:'🎵',
    pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',
    zip:'🗜️',rar:'🗜️','7z':'🗜️',tar:'🗜️',gz:'🗜️',
    js:'💻',ts:'💻',py:'💻',html:'💻',css:'💻',json:'💻',txt:'📃'
  };
  return map[ext] || '📁';
}

// ── Init ───────────────────────────────────────────────
async function init() {
  const authed = await checkAuth();
  if (!authed) return;
  loadFiles();
  loadClip();
}

init();
