// Pravah CDN — Testing Playground Logic

let state = {
  coreUrl: 'http://localhost:3000/api/v1',
  edgeUrl: 'http://localhost:3001',
  token: localStorage.getItem('pravah_token') || null,
  user: null,
  selectedFile: null,
  activeUploadFile: null,
  CHUNK_SIZE: 1024 * 1024, // 1MB chunks
};

// DOM Elements
const coreUrlInput = document.getElementById('core-url-input');
const edgeUrlInput = document.getElementById('edge-url-input');
const coreStatusPill = document.getElementById('core-status-pill');
const edgeStatusPill = document.getElementById('edge-status-pill');
const userDisplay = document.getElementById('user-display');
const btnRefreshStatus = document.getElementById('btn-refresh-status');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const btnStartUpload = document.getElementById('btn-start-upload');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadFileName = document.getElementById('upload-file-name');
const uploadFileSize = document.getElementById('upload-file-size');
const uploadProgressFill = document.getElementById('upload-progress-fill');
const uploadChunkStatus = document.getElementById('upload-chunk-status');
const uploadPercentage = document.getElementById('upload-percentage');

const fileList = document.getElementById('file-list');
const btnRefreshFiles = document.getElementById('btn-refresh-files');

const clientRegionSelect = document.getElementById('client-region-select');
const selectedFileIdInput = document.getElementById('selected-file-id');
const btnCdnDownload = document.getElementById('btn-cdn-download');

const metricCacheState = document.getElementById('metric-cache-state');
const metricLatency = document.getElementById('metric-latency');
const metricEdgeName = document.getElementById('metric-edge-name');
const metricDistance = document.getElementById('metric-distance');
const traceLog = document.getElementById('trace-log');
const previewBox = document.getElementById('preview-box');
const previewContent = document.getElementById('preview-content');

// Helper: Format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper: Compute SHA-256 in browser
async function computeSha256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// -------------------------------------------------------------
// 1. Health Probe & Status Check
// -------------------------------------------------------------
async function checkHealth() {
  state.coreUrl = coreUrlInput.value.replace(/\/+$/, '');
  state.edgeUrl = edgeUrlInput.value.replace(/\/+$/, '');

  // Probe Core
  try {
    const res = await fetch(`${state.coreUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      coreStatusPill.classList.add('online');
    } else {
      coreStatusPill.classList.remove('online');
    }
  } catch {
    coreStatusPill.classList.remove('online');
  }

  // Probe Edge
  try {
    const res = await fetch(`${state.edgeUrl}/`, { signal: AbortSignal.timeout(2000) });
    // Any HTTP response (even 404) means the server is online and listening
    if (res.status) {
      edgeStatusPill.classList.add('online');
    } else {
      edgeStatusPill.classList.remove('online');
    }
  } catch {
    edgeStatusPill.classList.remove('online');
  }
}

const btnOpenLogin = document.getElementById('btn-open-login');
const authModal = document.getElementById('auth-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const authForm = document.getElementById('auth-form');
const authIdentifier = document.getElementById('auth-identifier');
const authPassword = document.getElementById('auth-password');
const btnSubmitAuth = document.getElementById('btn-submit-auth');
const toggleAuthMode = document.getElementById('toggle-auth-mode');

// Modal open / close
btnOpenLogin.addEventListener('click', () => {
  authModal.style.display = 'flex';
});
btnCloseModal.addEventListener('click', () => {
  authModal.style.display = 'none';
});
authModal.addEventListener('click', (e) => {
  if (e.target === authModal) authModal.style.display = 'none';
});

// -------------------------------------------------------------
// 2. Authentication
// -------------------------------------------------------------
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const identifier = authIdentifier.value.trim();
  const password = authPassword.value;

  if (!identifier || !password) return;

  btnSubmitAuth.disabled = true;
  btnSubmitAuth.innerText = 'Authenticating...';

  try {
    // 1. Try Login first
    let loginRes = await fetch(`${state.coreUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });

    // 2. If user doesn't exist (401), auto-register and retry login
    if (!loginRes.ok && loginRes.status === 401) {
      const username = identifier.includes('@') ? identifier.split('@')[0] : identifier;
      const email = identifier.includes('@') ? identifier : `${identifier}@pravah.com`;

      await fetch(`${state.coreUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });

      // Retry login after auto-registration
      loginRes = await fetch(`${state.coreUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
    }

    if (!loginRes.ok) {
      const err = await loginRes.text();
      throw new Error(`Login failed (${loginRes.status}): ${err}`);
    }

    const loginData = await loginRes.json();
    if (loginData.access_token) {
      state.token = loginData.access_token;
      localStorage.setItem('pravah_token', state.token);
      userDisplay.innerText = identifier;
      userDisplay.parentElement.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      userDisplay.parentElement.style.color = '#10b981';
      authModal.style.display = 'none';
      fetchFiles();
    }
  } catch (err) {
    alert(`Authentication error: ${err.message}`);
  } finally {
    btnSubmitAuth.disabled = false;
    btnSubmitAuth.innerText = 'Sign In';
  }
});

toggleAuthMode.addEventListener('click', (e) => {
  e.preventDefault();
  authForm.dispatchEvent(new Event('submit'));
});

// -------------------------------------------------------------
// 3. Resumable Chunked Upload
// -------------------------------------------------------------
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    handleFileSelected(e.dataTransfer.files[0]);
  }
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) {
    handleFileSelected(e.target.files[0]);
  }
});

function handleFileSelected(file) {
  state.activeUploadFile = file;
  uploadFileName.innerText = file.name;
  uploadFileSize.innerText = formatBytes(file.size);
  uploadProgressContainer.style.display = 'flex';
  uploadProgressFill.style.width = '0%';
  uploadPercentage.innerText = '0%';
  uploadChunkStatus.innerText = 'Ready to upload';
  btnStartUpload.disabled = false;
}

btnStartUpload.addEventListener('click', async () => {
  if (!state.activeUploadFile) return;
  if (!state.token) {
    alert('Please log in first using Quick Demo Login!');
    return;
  }

  const file = state.activeUploadFile;
  btnStartUpload.disabled = true;
  btnStartUpload.innerText = 'Computing Full File SHA-256...';

  const fullBuffer = await file.arrayBuffer();
  const fullChecksum = await computeSha256(fullBuffer);

  const totalChunks = Math.ceil(file.size / state.CHUNK_SIZE);
  uploadChunkStatus.innerText = `Initializing upload session (${totalChunks} chunk${totalChunks > 1 ? 's' : ''})...`;

  try {
    // 1. Init Upload
    const initRes = await fetch(`${state.coreUrl}/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        totalSize: file.size,
        totalChunks: totalChunks,
        fullFileChecksum: fullChecksum,
      }),
    });

    if (!initRes.ok) throw new Error(await initRes.text());
    const { fileId } = await initRes.json();

    // 2. Stream Chunks Sequentially
    for (let index = 0; index < totalChunks; index++) {
      const start = index * state.CHUNK_SIZE;
      const end = Math.min(start + state.CHUNK_SIZE, file.size);
      const chunkSlice = file.slice(start, end);
      const chunkBuffer = await chunkSlice.arrayBuffer();
      const chunkChecksum = await computeSha256(chunkBuffer);

      uploadChunkStatus.innerText = `Uploading chunk ${index + 1}/${totalChunks}...`;

      const formData = new FormData();
      formData.append('file', chunkSlice, file.name);
      formData.append('checksum', chunkChecksum);

      const chunkRes = await fetch(`${state.coreUrl}/upload/${fileId}/chunk/${index}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${state.token}` },
        body: formData,
      });

      if (!chunkRes.ok) throw new Error(await chunkRes.text());

      const progress = Math.round(((index + 1) / totalChunks) * 100);
      uploadProgressFill.style.width = `${progress}%`;
      uploadPercentage.innerText = `${progress}%`;
    }

    // 3. Complete Upload
    uploadChunkStatus.innerText = 'Assembling & Compressing on MinIO Origin...';
    const completeRes = await fetch(`${state.coreUrl}/upload/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
      body: JSON.stringify({ fileId }),
    });

    if (!completeRes.ok) throw new Error(await completeRes.text());

    uploadChunkStatus.innerText = '✅ Upload Complete & Kafka Event Emitted!';
    btnStartUpload.innerText = 'Upload Succeeded!';
    
    // Auto-select uploaded file for CDN inspection
    selectedFileIdInput.value = fileId;
    btnCdnDownload.disabled = false;

    fetchFiles();
  } catch (err) {
    uploadChunkStatus.innerText = `❌ Error: ${err.message}`;
    btnStartUpload.disabled = false;
    btnStartUpload.innerText = 'Retry Upload';
  }
});

// -------------------------------------------------------------
// 4. File Library & Purge API
// -------------------------------------------------------------
async function fetchFiles() {
  if (!state.token) return;
  btnRefreshFiles.innerText = '...';

  try {
    const res = await fetch(`${state.coreUrl}/metadata/files?limit=20`, {
      headers: { 'Authorization': `Bearer ${state.token}` },
    });

    if (!res.ok) return;
    const data = await res.json();
    const files = data.files || [];

    if (files.length === 0) {
      fileList.innerHTML = '<div class="empty-state">No files uploaded yet. Upload a file above to test!</div>';
      return;
    }

    fileList.innerHTML = files.map(f => `
      <div class="file-item ${state.selectedFile?.id === f.id ? 'selected' : ''}" onclick="selectFile('${f.id}', '${f.name}')">
        <div class="file-item-info">
          <span class="file-item-name">${f.name}</span>
          <span class="file-item-sub">${formatBytes(Number(f.totalSize))} • v${f.currentVersion?.versionNumber || 1} • ${f.id.slice(0, 8)}...</span>
        </div>
        <div class="file-item-actions">
          <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation(); purgeFile('${f.id}')" title="Force Purge across all Edge Nodes">🧹 Purge</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Fetch files error:', err);
  } finally {
    btnRefreshFiles.innerText = 'Refresh';
  }
}

window.selectFile = function(fileId, name) {
  selectedFileIdInput.value = fileId;
  btnCdnDownload.disabled = false;
  document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
  if (event && event.currentTarget) event.currentTarget.classList.add('selected');
};

window.purgeFile = async function(fileId) {
  if (!confirm('Force purge this file across all Edge Nodes via Kafka?')) return;
  try {
    const res = await fetch(`${state.coreUrl}/metadata/purge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
      body: JSON.stringify({ fileId }),
    });

    if (res.ok) {
      logTrace(`[Cluster Purge] Dispatched cache.invalidate event for file ${fileId} over Kafka.\nAll edge nodes evicted file from RAM.`);
      alert('File successfully purged from all Edge Nodes!');
    }
  } catch (err) {
    alert(`Purge failed: ${err.message}`);
  }
};

btnRefreshFiles.addEventListener('click', fetchFiles);

// -------------------------------------------------------------
// 5. Geo-Routing & CDN Delivery Inspector
// -------------------------------------------------------------
function logTrace(message) {
  traceLog.innerText = `[${new Date().toLocaleTimeString()}] ${message}\n\n` + traceLog.innerText;
}

btnCdnDownload.addEventListener('click', async () => {
  const fileId = selectedFileIdInput.value.trim();
  const region = clientRegionSelect.value;
  if (!fileId) return;

  btnCdnDownload.disabled = true;
  btnCdnDownload.innerText = '⚡ Routing & Downloading...';

  // Reset telemetry display
  metricCacheState.innerText = 'Evaluating...';
  metricCacheState.className = 'metric-value';
  metricLatency.innerText = '—';
  metricEdgeName.innerText = '—';
  metricDistance.innerText = '—';
  previewBox.style.display = 'none';

  const startTime = performance.now();

  try {
    logTrace(`[Step 1] Sending download request to Core (${state.coreUrl}/download/${fileId}) with client region '${region}'...`);

    // Step 1: Request Core with redirect: manual
    const coreRes = await fetch(`${state.coreUrl}/download/${fileId}`, {
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'x-test-client-region': region,
      },
      redirect: 'manual',
    });

    let fetchUrl = '';
    const redirectUrl = coreRes.headers.get('Location') || coreRes.headers.get('location');
    const edgeName = coreRes.headers.get('X-CDN-Edge') || 'Mumbai Edge';
    const edgeRegion = coreRes.headers.get('X-CDN-Region') || region;
    const strategy = coreRes.headers.get('X-CDN-Strategy') || 'Haversine Geo';
    const distanceKm = coreRes.headers.get('X-CDN-Distance-Km') || '0';

    if (coreRes.status === 302 && redirectUrl) {
      logTrace(`[Step 2] Core 302 Redirect Received!\n🎯 Target Edge: ${edgeName} (${edgeRegion})\n📐 Strategy: ${strategy}\n📏 Distance: ${distanceKm} km\n🔗 Edge URL: ${redirectUrl}`);
      fetchUrl = redirectUrl;
    } else {
      logTrace(`[Step 2] Core direct stream fallback (Status: ${coreRes.status})`);
      // Direct stream or reconstruct Edge URL
      fetchUrl = `${state.edgeUrl}/edge/content/${fileId}?v=1`;
    }

    metricEdgeName.innerText = edgeName;
    metricDistance.innerText = distanceKm === 'N/A' ? '0 km' : `${distanceKm} km`;

    // Step 3: Fetch file from Edge Node
    logTrace(`[Step 3] Fetching file binary from Edge Node...`);
    const edgeStartTime = performance.now();
    const edgeRes = await fetch(fetchUrl);
    const totalLatency = Math.round(performance.now() - startTime);
    const edgeLatency = Math.round(performance.now() - edgeStartTime);

    if (!edgeRes.ok) throw new Error(`Edge returned status ${edgeRes.status}`);

    const contentType = edgeRes.headers.get('Content-Type') || '';
    const blob = await edgeRes.blob();

    metricLatency.innerText = `${totalLatency} ms`;

    // Cache hit detection (latency < 40ms typically indicates Redis RAM delivery)
    if (edgeLatency <= 35) {
      metricCacheState.innerText = '⚡ CACHE HIT';
      metricCacheState.className = 'metric-value hit';
      logTrace(`[Step 4] ✅ CACHE HIT: Delivered directly from Edge Redis RAM in ${edgeLatency}ms! (Total roundtrip: ${totalLatency}ms)`);
    } else {
      metricCacheState.innerText = '⏳ CACHE MISS';
      metricCacheState.className = 'metric-value miss';
      logTrace(`[Step 4] ⚠️ CACHE MISS: Edge fetched from MinIO Origin & cached in RAM in ${edgeLatency}ms!`);
    }

    // Step 5: Render Content Preview
    renderPreview(blob, contentType);

  } catch (err) {
    logTrace(`❌ CDN Delivery Error: ${err.message}`);
  } finally {
    btnCdnDownload.disabled = false;
    btnCdnDownload.innerText = '⚡ Request via Pravah Geo-Routing';
  }
});

function renderPreview(blob, contentType) {
  previewBox.style.display = 'block';
  previewContent.innerHTML = '';

  if (contentType.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    previewContent.appendChild(img);
  } else if (contentType.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    video.controls = true;
    previewContent.appendChild(video);
  } else if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('javascript')) {
    blob.text().then(text => {
      const pre = document.createElement('pre');
      pre.textContent = text.slice(0, 1000) + (text.length > 1000 ? '\n... (truncated)' : '');
      previewContent.appendChild(pre);
    });
  } else {
    previewContent.innerHTML = `<div class="empty-state">Binary Content Delivered (${formatBytes(blob.size)})</div>`;
  }
}

// -------------------------------------------------------------
// Initialization
// -------------------------------------------------------------
btnRefreshStatus.addEventListener('click', checkHealth);
selectedFileIdInput.addEventListener('input', () => {
  btnCdnDownload.disabled = !selectedFileIdInput.value.trim();
});

// Initial load
checkHealth();
if (state.token) {
  userDisplay.innerText = 'Active Session';
  userDisplay.parentElement.style.borderColor = 'rgba(16, 185, 129, 0.4)';
  userDisplay.parentElement.style.color = '#10b981';
  fetchFiles();
}
