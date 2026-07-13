const state = {
  currentFile: null,   // { id, original_name, file_type, original_size, pages }
  activeTab: 'pdf'
};

const $ = (sel) => document.querySelector(sel);

// ---------- Theme ----------
const themeToggle = $('#themeToggle');
function applyTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('fc-theme', t);
}
applyTheme(localStorage.getItem('fc-theme') || 'light');
themeToggle.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(cur);
});

// ---------- Helpers ----------
function formatBytes(bytes){
  if (bytes === 0 || bytes == null) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return (bytes / 1024).toFixed(0) + ' KB';
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}
function formatDate(iso){
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  return d.toLocaleString('en-US', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function fileIcon(type){
  return type === 'pdf' ? '📄' : '🖼️';
}

// ---------- Upload ----------
const dropzone = $('#dropzone');
const pdfInput = $('#pdfInput');
const jpgInput = $('#jpgInput');
const pngInput = $('#pngInput');

[pdfInput, jpgInput, pngInput].forEach(input => {
  input.addEventListener('change', (e) => {
    if (e.target.files[0]) uploadFile(e.target.files[0]);
    e.target.value = '';
  });
});

['dragenter','dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave','drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

$('#replaceFileBtn').addEventListener('click', () => {
  $('#currentFileCard').style.display = 'none';
  $('#settingsCard').style.display = 'none';
  state.currentFile = null;
});

function uploadFile(file){
  const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowed.includes(file.type)){
    alert('Unsupported file type. Please upload a PDF, JPG, or PNG file.');
    return;
  }
  if (file.size > 200 * 1024 * 1024){
    alert('File exceeds 200MB maximum size.');
    return;
  }

  $('#currentFileCard').style.display = 'block';
  $('#settingsCard').style.display = 'none';
  $('#currentFileName').textContent = file.name;
  $('#currentFileSize').textContent = formatBytes(file.size);
  $('#currentFileIcon').textContent = file.type === 'application/pdf' ? '📄' : '🖼️';
  $('#currentFilePages').style.display = 'none';

  const progressWrap = $('#progressWrap');
  progressWrap.style.display = 'block';
  $('#progressStatus').textContent = 'Uploading...';
  $('#progressFill').style.width = '0%';
  $('#progressPercent').textContent = '0%';

  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  const startTime = Date.now();

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const percent = Math.round((e.loaded / e.total) * 100);
    $('#progressFill').style.width = percent + '%';
    $('#progressPercent').textContent = percent + '%';

    const elapsedSec = (Date.now() - startTime) / 1000;
    const speed = e.loaded / Math.max(elapsedSec, 0.1); // bytes/sec
    $('#progressSpeed').textContent = `Speed: ${(speed / (1024*1024)).toFixed(1)} MB/sec`;

    const remainingBytes = e.total - e.loaded;
    const remainingSec = speed > 0 ? Math.max(0, Math.round(remainingBytes / speed)) : 0;
    $('#progressRemaining').textContent = `Remaining: ${remainingSec} sec`;
  });

  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300){
      const data = JSON.parse(xhr.responseText);
      state.currentFile = data;
      $('#progressStatus').textContent = 'Upload complete';
      $('#progressFill').style.width = '100%';
      $('#progressPercent').textContent = '100%';
      $('#progressRemaining').textContent = 'Remaining: 0 sec';

      if (data.pages){
        $('#currentFilePages').style.display = 'inline-block';
        $('#currentFilePages').textContent = `${data.pages} Pages`;
      }

      setTimeout(() => { progressWrap.style.display = 'none'; showSettings(); }, 500);
    } else {
      let msg = 'Upload failed';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch(_){}
      alert(msg);
      $('#currentFileCard').style.display = 'none';
    }
  });

  xhr.addEventListener('error', () => {
    alert('Upload failed. Please check your connection and try again.');
    $('#currentFileCard').style.display = 'none';
  });

  xhr.open('POST', '/api/upload');
  xhr.send(formData);
}

// ---------- Settings / estimate ----------
const qualitySlider = $('#qualitySlider');
qualitySlider.addEventListener('input', updateEstimate);

function showSettings(){
  $('#settingsCard').style.display = 'block';
  $('#originalSizeVal').textContent = formatBytes(state.currentFile.original_size);
  updateEstimate();
}

function updateEstimate(){
  if (!state.currentFile) return;
  const quality = parseInt(qualitySlider.value, 10);
  $('#qualityLabel').textContent = `Quality: ${quality}%`;

  // Rough client-side estimate purely for UX preview; actual result computed server-side.
  let ratio;
  if (state.currentFile.file_type === 'pdf') {
    ratio = 0.35 + (quality / 100) * 0.5; // pdf compresses less predictably
  } else {
    ratio = 0.15 + (quality / 100) * 0.6;
  }
  const estimatedSize = Math.round(state.currentFile.original_size * ratio);
  const reduction = Math.round((1 - ratio) * 100);

  $('#estimatedSizeVal').textContent = formatBytes(estimatedSize);
  $('#estimatedReduction').textContent = reduction + '%';
}

// ---------- Compress ----------
$('#compressBtn').addEventListener('click', async () => {
  if (!state.currentFile) return;
  const btn = $('#compressBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Compressing...';

  try {
    const res = await fetch(`/api/compress/${state.currentFile.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quality: parseInt(qualitySlider.value, 10) })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Compression failed');

    btn.textContent = '✔ Compressed!';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '⚙ Compress File';
    }, 1500);

    loadStats();
    loadHistory();
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.textContent = '⚙ Compress File';
  }
});

// ---------- Stats ----------
async function loadStats(){
  const res = await fetch('/api/stats');
  const s = await res.json();
  $('#statFiles').textContent = s.totalFiles;
  $('#statStorage').textContent = formatBytes(s.storageSaved);
  $('#statAvg').textContent = s.avgCompression + '%';
  $('#statToday').textContent = s.todayFiles;
}

// ---------- History ----------
const tabs = document.querySelectorAll('.tab');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.activeTab = tab.dataset.type;
    loadHistory();
  });
});

$('#searchInput').addEventListener('input', debounce(loadHistory, 300));
$('#dateFilter').addEventListener('change', loadHistory);
$('#clearDateBtn').addEventListener('click', () => { $('#dateFilter').value = ''; loadHistory(); });
$('#refreshBtn').addEventListener('click', () => { loadHistory(); loadStats(); });

function debounce(fn, ms){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function loadHistory(){
  const search = $('#searchInput').value.trim();
  const date = $('#dateFilter').value;
  const params = new URLSearchParams({ type: state.activeTab, search, date });

  const res = await fetch(`/api/history?${params.toString()}`);
  const rows = await res.json();

  const tbody = $('#historyBody');
  if (!rows.length){
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No files found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}">
      <td>
        <div class="file-name-cell">
          <span>${fileIcon(r.file_type)}</span>
          <span>${escapeHtml(r.original_name)}</span>
        </div>
      </td>
      <td>${formatDate(r.uploaded_at)}</td>
      <td>${formatBytes(r.original_size)}</td>
      <td>${r.compressed_size ? formatBytes(r.compressed_size) : '—'}</td>
      <td>${r.saved_percent != null ? `<span class="saved-pill">${Math.round(r.saved_percent)}%</span>` : '<span class="muted">pending</span>'}</td>
      <td>
        <div class="action-cell">
          <a class="action-link" href="/uploads/${r.original_path}" download="${escapeHtml(r.original_name)}">⬇ Original</a>
          ${r.compressed_path ? `<a class="action-link green" href="/compressed/${r.compressed_path}" download="${escapeHtml(r.original_name)}">⬇ Compressed</a>` : ''}
          <button class="action-link delete-btn" data-id="${r.id}" title="Delete this file">🗑 Delete</button>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteFile(btn.dataset.id));
  });
}

async function deleteFile(id){
  if (!confirm('Delete this file and its compressed copy? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/file/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    loadHistory();
    loadStats();
  } catch (e) {
    alert(e.message);
  }
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Init ----------
loadStats();
loadHistory();
