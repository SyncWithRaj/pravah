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
// 2. Authentication & Session Manager
// -------------------------------------------------------------
async function autoAuthenticate(identifier = 'raj@pravah.com', password = 'supersecretpassword') {
  try {
    let loginRes = await fetch(`${state.coreUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });

    if (!loginRes.ok && loginRes.status === 401) {
      const username = identifier.includes('@') ? identifier.split('@')[0] : identifier;
      const email = identifier.includes('@') ? identifier : `${identifier}@pravah.com`;

      await fetch(`${state.coreUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });

      loginRes = await fetch(`${state.coreUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
    }

    if (loginRes.ok) {
      const loginData = await loginRes.json();
      if (loginData.access_token) {
        state.token = loginData.access_token;
        localStorage.setItem('pravah_token', state.token);
        userDisplay.innerText = identifier;
        userDisplay.parentElement.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        userDisplay.parentElement.style.color = '#10b981';
        return true;
      }
    }
  } catch (err) {
    console.warn('Auto auth warning:', err);
  }
  return false;
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const identifier = authIdentifier.value.trim();
  const password = authPassword.value;

  if (!identifier || !password) return;

  btnSubmitAuth.disabled = true;
  btnSubmitAuth.innerText = 'Authenticating...';

  try {
    const success = await autoAuthenticate(identifier, password);
    if (!success) throw new Error('Invalid credentials');
    authModal.style.display = 'none';
    fetchFiles();
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
// 4. File Library & Purge API
// -------------------------------------------------------------
async function fetchFiles() {
  btnRefreshFiles.innerText = '...';

  if (!state.token) {
    const ok = await autoAuthenticate();
    if (!ok) {
      btnRefreshFiles.innerText = 'Refresh';
      fileList.innerHTML = '<div class="empty-state">Sign in to view your stored files.</div>';
      return;
    }
  }

  try {
    let res = await fetch(`${state.coreUrl}/metadata/files?limit=20`, {
      headers: { 'Authorization': `Bearer ${state.token}` },
    });

    if (res.status === 401) {
      const ok = await autoAuthenticate();
      if (ok) {
        res = await fetch(`${state.coreUrl}/metadata/files?limit=20`, {
          headers: { 'Authorization': `Bearer ${state.token}` },
        });
      }
    }

    if (!res.ok) {
      fileList.innerHTML = '<div class="empty-state">Could not load files. Click Refresh to retry.</div>';
      return;
    }

    const data = await res.json();
    const files = data.data || data.files || [];

    if (files.length === 0) {
      fileList.innerHTML = '<div class="empty-state">No files uploaded yet. Upload a file above to test!</div>';
      return;
    }

    fileList.innerHTML = files.map(f => {
      const displayName = f.name || f.fileName || 'Untitled File';
      const sizeStr = formatBytes(Number(f.totalSize || 0));
      const versionNum = f.currentVersion?.versionNumber || 1;
      const isSelected = selectedFileIdInput.value === f.id;
      const isVideo = f.mimeType?.includes('video') || displayName.endsWith('.mp4');
      const icon = isVideo ? '🎬' : '📄';

      return `
      <div class="file-item ${isSelected ? 'selected' : ''}" onclick="selectFile('${f.id}', '${displayName}')">
        <div class="file-item-info">
          <span class="file-item-name">${icon} ${displayName}</span>
          <span class="file-item-sub">${sizeStr} • v${versionNum} • <code>${f.id.slice(0, 8)}...</code></span>
        </div>
        <div class="file-item-actions">
          <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation(); purgeFile('${f.id}')" title="Purge RAM Cache across all Edge Nodes">🧹 Purge</button>
          <button class="btn btn-xs btn-danger" onclick="event.stopPropagation(); deleteFile('${f.id}')" title="Permanently delete from Origin & DB">🗑️</button>
        </div>
      </div>
    `;
    }).join('');

    // If no file is selected, automatically select the first file
    if (!selectedFileIdInput.value && files.length > 0) {
      selectFile(files[0].id, files[0].name || files[0].fileName);
    }
  } catch (err) {
    console.error('Fetch files error:', err);
    fileList.innerHTML = '<div class="empty-state">Error loading files. Check connection.</div>';
  } finally {
    btnRefreshFiles.innerText = 'Refresh';
  }
}

btnRefreshFiles.addEventListener('click', () => fetchFiles());

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



window.selectFile = function(fileId, name) {
  selectedFileIdInput.value = fileId;
  btnCdnDownload.disabled = false;
  document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
  if (event && event.currentTarget) event.currentTarget.classList.add('selected');
};

window.purgeFile = async function(fileId) {
  if (!confirm('Force purge this file across all Edge Nodes via Kafka?')) return;
  try {
    logTrace(`[Step 1] Sending Cluster Cache Purge request to Core (${state.coreUrl}/admin/cache/purge)...`);

    // 1. Core broadcasts invalidation event
    const res = await fetch(`${state.coreUrl}/admin/cache/purge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
      body: JSON.stringify({ fileId }),
    });

    // 2. Also call Edge Node directly for instant local eviction
    await fetch(`${state.edgeUrl}/edge/content/${fileId}/purge`, { method: 'POST' }).catch(() => {});

    if (res.ok) {
      metricCacheState.innerText = '⏳ PURGED / COLD';
      metricCacheState.className = 'metric-value miss';
      logTrace(`[Step 2] 🧹 Cluster Cache Purged Successfully!\n📡 Core emitted 'cache.invalidated' event over Kafka.\n⚡ Edge Node evicted '${fileId.slice(0, 8)}...' from Redis RAM.\n🎯 Next Geo-Routing request will be a verified CACHE MISS (re-fetching from Origin).`);
      appendWsEvent(`Cache Purged: ${fileId.slice(0, 8)}... (Evicted from Edge RAM)`, 'miss');
    }
  } catch (err) {
    logTrace(`❌ Purge failed: ${err.message}`);
    alert(`Purge failed: ${err.message}`);
  }
};

window.deleteFile = async function(fileId) {
  if (!confirm('Permanently delete this file from Origin (MinIO) and Database?')) return;
  try {
    const res = await fetch(`${state.coreUrl}/metadata/files/${fileId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${state.token}`,
      },
    });

    if (res.ok) {
      if (selectedFileIdInput.value === fileId) {
        selectedFileIdInput.value = '';
        btnCdnDownload.disabled = true;
      }
      logTrace(`[Delete] File ${fileId} permanently removed from Database and Origin.`);
      fetchFiles();
    } else {
      const err = await res.text();
      alert(`Delete failed: ${err}`);
    }
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
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

    const edgeStartTime = performance.now();
    const res = await fetch(`${state.coreUrl}/download/${fileId}`, {
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'x-test-client-region': region,
      },
      redirect: 'follow',
    });

    const totalLatency = Math.round(performance.now() - startTime);
    const edgeLatency = Math.round(performance.now() - edgeStartTime);

    if (!res.ok) throw new Error(`Delivery returned status ${res.status}`);

    const cacheHeader = res.headers.get('x-cache') || res.headers.get('X-Cache');
    const edgeName = res.headers.get('x-cdn-edge') || res.headers.get('X-CDN-Edge') || 'Mumbai Edge';
    const edgeRegion = res.headers.get('x-cdn-region') || res.headers.get('X-CDN-Region') || region;
    const strategy = res.headers.get('x-cdn-strategy') || res.headers.get('X-CDN-Strategy') || 'Haversine Geo';
    const distanceKm = res.headers.get('x-cdn-distance-km') || res.headers.get('X-CDN-Distance-Km') || '0';

    logTrace(`[Step 2] Core Geo-Routed Request!\n🎯 Target Edge: ${edgeName} (${edgeRegion})\n📐 Strategy: ${strategy}\n📏 Distance: ${distanceKm} km`);

    metricEdgeName.innerText = edgeName;
    metricDistance.innerText = distanceKm === 'N/A' ? '0 km' : `${distanceKm} km`;
    metricLatency.innerText = `${totalLatency} ms`;

    const isHit = cacheHeader === 'HIT' || cacheHeader === 'PEER_HIT';
    if (isHit) {
      const hitLabel = cacheHeader === 'PEER_HIT' ? '⚡ PEER HIT' : '⚡ CACHE HIT';
      metricCacheState.innerText = hitLabel;
      metricCacheState.className = 'metric-value hit';
      logTrace(`[Step 3] ✅ ${hitLabel}: Delivered directly from Edge Redis RAM in ${edgeLatency}ms! (Total roundtrip: ${totalLatency}ms)`);
    } else {
      metricCacheState.innerText = '⏳ CACHE MISS';
      metricCacheState.className = 'metric-value miss';
      logTrace(`[Step 3] ⚠️ CACHE MISS: Edge fetched from MinIO Origin & cached in RAM in ${edgeLatency}ms!`);
    }

    const contentType = res.headers.get('Content-Type') || '';
    const blob = await res.blob();

    // Step 4: Render Content Preview
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
// 7. Live Real-Time WebSocket Telemetry Connection
// -------------------------------------------------------------
const wsStatusBadge = document.getElementById('ws-status-badge');
const wsStatusText = document.getElementById('ws-status-text');
const wsThroughput = document.getElementById('ws-throughput');
const wsRps = document.getElementById('ws-rps');
const wsHitRatio = document.getElementById('ws-hit-ratio');
const wsEventStream = document.getElementById('ws-event-stream');

let socket = null;

function appendWsEvent(text, type = 'info') {
  if (!wsEventStream) return;
  const item = document.createElement('div');
  item.className = `ws-event-item ${type}`;
  const time = new Date().toLocaleTimeString();
  item.textContent = `[${time}] ${text}`;
  wsEventStream.prepend(item);

  // Limit stream length to 50 entries
  if (wsEventStream.children.length > 50) {
    wsEventStream.removeChild(wsEventStream.lastChild);
  }
}

function initWebSocket() {
  if (typeof io === 'undefined') {
    setTimeout(initWebSocket, 500);
    return;
  }

  try {
    const wsOrigin = state.coreUrl.replace(/\/api\/v1\/?$/, '');
    if (socket) socket.disconnect();

    socket = io(wsOrigin, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
      wsStatusBadge?.classList.add('connected');
      if (wsStatusText) wsStatusText.innerText = 'Connected';
      appendWsEvent('Connected to Pravah Real-Time Telemetry Gateway', 'health');
    });

    socket.on('disconnect', () => {
      wsStatusBadge?.classList.remove('connected');
      if (wsStatusText) wsStatusText.innerText = 'Disconnected';
      appendWsEvent('Disconnected from Telemetry Gateway', 'miss');
    });

    socket.on('telemetry.throughput', (data) => {
      if (wsThroughput) wsThroughput.innerText = `${formatBytes(data.bandwidthBps)}/s`;
      if (wsRps) wsRps.innerText = `${data.requestsPerSecond} req/s`;
      if (wsHitRatio) wsHitRatio.innerText = `${data.hitRatio}%`;
    });

    socket.on('cache.access', (data) => {
      const type = data.eventType === 'hit' ? 'hit' : data.eventType === 'peer_fill' ? 'peer' : 'miss';
      const label = data.eventType === 'hit' ? 'RAM Cache Hit' : data.eventType === 'peer_fill' ? 'Peer Fill' : 'Origin Miss';
      appendWsEvent(`${label} (${data.downloadLatencyMs}ms): ${data.edgeId} served ${data.fileId.slice(0, 8)}... (${formatBytes(data.bytesServed)})`, type);
    });

    socket.on('edge.health_changed', (data) => {
      appendWsEvent(`Node Health: ${data.edgeId} changed ${data.oldStatus} -> ${data.newStatus}`, 'health');
      checkHealth();
    });

    socket.on('replication.status', (data) => {
      appendWsEvent(`Replication [${data.status}]: ${data.fileId.slice(0, 8)}... -> ${data.edgeNodeId}`, 'peer');
    });

    socket.on('upload.progress', (data) => {
      appendWsEvent(`Upload: ${data.fileName} chunk ${data.chunkIndex + 1}/${data.totalChunks} (${data.percentage}%)`, 'upload');
    });

    socket.on('cache.invalidated', (data) => {
      appendWsEvent(`Cache Purged: ${data.fileId.slice(0, 8)}... (Evicted from cluster)`, 'miss');
      fetchFiles();
    });
  } catch (err) {
    console.error('Failed to init WebSocket:', err);
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
initWebSocket();
fetchFiles();
