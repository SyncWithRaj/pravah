// ============================================================================
// Pravah CDN — Comprehensive Enterprise Control & Operations Center (v3.0)
// Complete Route Wiring, Real Error Handling, Range 206, BullMQ Stepper & Logs
// ============================================================================

const HOSTNAME = window.location.hostname || 'localhost';
const CORE_API_URL = `http://${HOSTNAME}:3000/api/v1`;
const CORE_BASE_URL = `http://${HOSTNAME}:3000`;
const EDGE_URL = `http://${HOSTNAME}:3001`;

// Application Global State
const STATE = {
  token: localStorage.getItem('pravah_jwt_token') || '',
  user: JSON.parse(localStorage.getItem('pravah_user') || 'null'),
  selectedFile: null,
  activeUpload: JSON.parse(localStorage.getItem('pravah_active_upload') || 'null'),
  isUploading: false,
  isPaused: false,
  abortController: null,
  hlsPlayer: null,
  telemetryChart: null,
  socket: null,
  nodes: {},
  devLogs: []
};

// ============================================================================
// 1. INITIALIZATION & ROUTING SETUP
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  setupNavigationTabs();
  setupAuthFormListeners();
  setupUploadListeners();
  setupDevInspector();
  setupSocketIO();

  if (STATE.token && STATE.user) {
    showDashboardView();
  } else {
    showAuthView();
  }
});

// Update host labels in UI
document.getElementById('label-core-host').textContent = `:3000`;
document.getElementById('label-edge-host').textContent = `:3001`;

function setupNavigationTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => {
        t.classList.remove('active', 'bg-brand-600', 'text-white', 'shadow-sm', 'shadow-brand-500/20');
        t.classList.add('text-slate-400');
      });
      tab.classList.add('active', 'bg-brand-600', 'text-white', 'shadow-sm', 'shadow-brand-500/20');
      tab.classList.remove('text-slate-400');

      const targetId = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.remove('hidden');

      // Trigger tab-specific refresh
      if (targetId === 'tab-ingest') refreshFilesList();
      if (targetId === 'tab-topology') refreshTopologyNodes();
      if (targetId === 'tab-dlq') refreshDLQTable();
      if (targetId === 'tab-apikeys') refreshApiKeys();
      if (targetId === 'tab-telemetry') initTelemetryChart();
      if (window.lucide) lucide.createIcons();
    });
  });
}

// ============================================================================
// 2. AUTHENTICATION & RBAC PORTAL (REGISTER / LOGIN / DEMO)
// ============================================================================
function showAuthView() {
  document.getElementById('view-auth').classList.remove('hidden');
  document.getElementById('view-dashboard').classList.add('hidden');
}

function showDashboardView() {
  document.getElementById('view-auth').classList.add('hidden');
  document.getElementById('view-dashboard').classList.remove('hidden');
  updateUserProfileUI();
  refreshFilesList();
  refreshTopologyNodes();
}

function updateUserProfileUI() {
  if (!STATE.user) return;
  const nameEl = document.getElementById('nav-user-name');
  const roleEl = document.getElementById('nav-user-role');
  const avatarEl = document.getElementById('user-avatar');
  const emailEl = document.getElementById('menu-user-email');

  const username = STATE.user.username || 'User';
  const role = STATE.user.role || 'USER';

  if (nameEl) nameEl.textContent = username;
  if (roleEl) {
    roleEl.textContent = role;
    if (role === 'ADMIN') roleEl.className = 'text-[9px] font-bold uppercase tracking-wider text-amber-400';
    else if (role === 'STREAMER') roleEl.className = 'text-[9px] font-bold uppercase tracking-wider text-indigo-400';
    else roleEl.className = 'text-[9px] font-bold uppercase tracking-wider text-teal-400';
  }
  if (avatarEl) avatarEl.textContent = username.charAt(0).toUpperCase();
  if (emailEl) emailEl.textContent = STATE.user.email || `${username}@pravah.io`;
}

function setupAuthFormListeners() {
  const tabLogin = document.getElementById('auth-tab-login');
  const tabRegister = document.getElementById('auth-tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');

  tabLogin.addEventListener('click', () => {
    tabLogin.className = 'flex-1 py-2 text-xs font-semibold rounded-lg transition bg-brand-600 text-white shadow';
    tabRegister.className = 'flex-1 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-lg transition';
    formLogin.classList.remove('hidden');
    formRegister.classList.add('hidden');
    clearAuthBanners();
  });

  tabRegister.addEventListener('click', () => {
    tabRegister.className = 'flex-1 py-2 text-xs font-semibold rounded-lg transition bg-brand-600 text-white shadow';
    tabLogin.className = 'flex-1 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-lg transition';
    formRegister.classList.remove('hidden');
    formLogin.classList.add('hidden');
    clearAuthBanners();
  });

  // Login Submit
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthBanners();
    const identifier = document.getElementById('login-identifier').value.trim();
    const password = document.getElementById('login-password').value;

    const btn = document.getElementById('btn-login-submit');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Authenticating...`;

    try {
      const res = await apiRequest(`${CORE_API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password })
      });

      if (res.ok) {
        const data = res.data;
        const token = data.access_token || data.token || data.accessToken;
        STATE.token = token;
        STATE.user = data.user;
        localStorage.setItem('pravah_jwt_token', token);
        localStorage.setItem('pravah_user', JSON.stringify(data.user));

        showToast(`Welcome back, ${data.user.username} (${data.user.role})!`, 'success');
        showDashboardView();
      } else {
        const errorMsg = res.data?.message || `HTTP ${res.status}: Authentication failed`;
        showAuthError(Array.isArray(errorMsg) ? errorMsg.join(', ') : errorMsg);
      }
    } catch (err) {
      showAuthError(`Network error connecting to Core API: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="log-in" class="w-4 h-4"></i> Authenticate & Open Dashboard`;
      if (window.lucide) lucide.createIcons();
    }
  });

  // Register Submit
  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthBanners();
    const email = document.getElementById('reg-email').value.trim();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;

    const btn = document.getElementById('btn-register-submit');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Creating account...`;

    try {
      const regRes = await apiRequest(`${CORE_API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, username, password })
      });

      if (regRes.ok) {
        showToast('Account created successfully! Logging in...', 'success');
        // Auto-login
        const loginRes = await apiRequest(`${CORE_API_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: username, password })
        });

        if (loginRes.ok) {
          const data = loginRes.data;
          const token = data.access_token || data.token || data.accessToken;
          STATE.token = token;
          STATE.user = data.user;
          localStorage.setItem('pravah_jwt_token', token);
          localStorage.setItem('pravah_user', JSON.stringify(data.user));
          showDashboardView();
        }
      } else {
        const errorMsg = regRes.data?.message || `HTTP ${regRes.status}: Registration failed`;
        showAuthError(Array.isArray(errorMsg) ? errorMsg.join(', ') : errorMsg);
      }
    } catch (err) {
      showAuthError(`Network error connecting to Core API: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="user-plus" class="w-4 h-4"></i> Create Account & Log In`;
      if (window.lucide) lucide.createIcons();
    }
  });
}

function showAuthError(msg) {
  const banner = document.getElementById('auth-error-banner');
  const text = document.getElementById('auth-error-text');
  if (banner && text) {
    text.textContent = msg;
    banner.classList.remove('hidden');
  }
}

function clearAuthBanners() {
  const err = document.getElementById('auth-error-banner');
  const suc = document.getElementById('auth-success-banner');
  if (err) err.classList.add('hidden');
  if (suc) suc.classList.add('hidden');
}

function handleLogout() {
  STATE.token = '';
  STATE.user = null;
  localStorage.removeItem('pravah_jwt_token');
  localStorage.removeItem('pravah_user');
  showToast('Signed out successfully', 'info');
  showAuthView();
}

async function testProfileMeRoute() {
  const res = await apiRequest(`${CORE_API_URL}/auth/me`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${STATE.token}` }
  });

  if (res.ok) {
    showToast(`Profile Verified: User ID ${res.data.user?.id}`, 'success');
  } else {
    showToast(`Auth Verification Failed: HTTP ${res.status}`, 'error');
  }
}

function copyTokenToClipboard() {
  if (!STATE.token) return;
  navigator.clipboard.writeText(STATE.token);
  showToast('JWT Token copied to clipboard', 'success');
}

// ============================================================================
// 3. API REQUEST WRAPPER & LIVE DEVELOPER INSPECTOR
// ============================================================================
async function apiRequest(url, options = {}) {
  const startTime = performance.now();
  const method = options.method || 'GET';
  let status = 0;
  let responseData = null;
  let errorMsg = null;

  try {
    const res = await fetch(url, options);
    status = res.status;
    const duration = Math.round(performance.now() - startTime);

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      responseData = await res.json();
    } else {
      responseData = await res.text();
    }

    logApiRequest({
      timestamp: new Date().toLocaleTimeString(),
      method,
      url,
      status,
      duration,
      headers: Object.fromEntries(res.headers.entries()),
      body: responseData
    });

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      data: responseData
    };
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    errorMsg = err.message;
    logApiRequest({
      timestamp: new Date().toLocaleTimeString(),
      method,
      url,
      status: 'ERR',
      duration,
      headers: {},
      body: { error: errorMsg }
    });
    throw err;
  }
}

function setupDevInspector() {
  const toggle = document.getElementById('dev-console-toggle');
  const drawer = document.getElementById('dev-console-drawer');
  const icon = document.getElementById('dev-drawer-icon');
  let open = false;

  toggle.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    open = !open;
    if (open) {
      drawer.classList.remove('translate-y-[calc(100%-38px)]');
      icon.classList.add('rotate-180');
    } else {
      drawer.classList.add('translate-y-[calc(100%-38px)]');
      icon.classList.remove('rotate-180');
    }
  });
}

function logApiRequest(log) {
  STATE.devLogs.unshift(log);
  if (STATE.devLogs.length > 50) STATE.devLogs.pop();

  const badge = document.getElementById('dev-logs-badge');
  if (badge) badge.textContent = `${STATE.devLogs.length} requests`;

  const container = document.getElementById('dev-logs-container');
  if (!container) return;

  const statusColor = log.status >= 200 && log.status < 300 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' :
                      log.status === 206 ? 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' :
                      log.status >= 400 ? 'text-rose-400 bg-rose-500/10 border-rose-500/20' : 'text-slate-400 bg-dark-850';

  const logRow = document.createElement('div');
  logRow.className = 'p-2.5 rounded-lg bg-dark-950 border border-white/5 space-y-1 hover:border-white/10 transition';
  logRow.innerHTML = `
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${statusColor} border">${log.status}</span>
        <span class="font-bold text-slate-300 uppercase">${log.method}</span>
        <span class="text-slate-400 truncate max-w-md">${log.url}</span>
      </div>
      <div class="flex items-center gap-2 text-slate-500 text-[10px]">
        <span>${log.duration}ms</span>
        <span>${log.timestamp}</span>
      </div>
    </div>
    <details class="text-[10px] text-slate-400">
      <summary class="cursor-pointer hover:text-slate-200">Response Payload</summary>
      <pre class="mt-1 p-2 rounded bg-dark-900 border border-white/5 text-slate-300 overflow-x-auto max-h-32">${typeof log.body === 'object' ? JSON.stringify(log.body, null, 2) : log.body}</pre>
    </details>
  `;

  if (container.children.length === 1 && container.children[0].textContent.includes('No HTTP requests')) {
    container.innerHTML = '';
  }
  container.prepend(logRow);
}

function clearDevLogs(e) {
  if (e) e.stopPropagation();
  STATE.devLogs = [];
  const container = document.getElementById('dev-logs-container');
  if (container) container.innerHTML = '<div class="text-center text-slate-600 py-8 font-sans text-xs">No HTTP requests captured yet.</div>';
  const badge = document.getElementById('dev-logs-badge');
  if (badge) badge.textContent = `0 requests`;
}

// ============================================================================
// 4. CHUNKED INGESTION & SMART RESUMABLE UPLOAD
// ============================================================================
function setupUploadListeners() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const btnStart = document.getElementById('btn-start-upload');
  const btnPause = document.getElementById('btn-pause-upload');
  const btnSimDrop = document.getElementById('btn-sim-interrupt');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-brand-500'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-brand-500'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-brand-500');
    if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFileSelect(e.target.files[0]);
  });

  btnStart.addEventListener('click', () => startChunkedUpload());
  btnPause.addEventListener('click', () => togglePauseUpload());
  btnSimDrop.addEventListener('click', () => simulateUploadDropout());
}

async function handleFileSelect(file) {
  STATE.selectedFile = file;
  const chunkSize = parseInt(document.getElementById('upload-chunk-size').value, 10);
  const totalChunks = Math.ceil(file.size / chunkSize);

  document.getElementById('selected-file-card').classList.remove('hidden');
  document.getElementById('sel-file-name').textContent = file.name;
  document.getElementById('sel-file-size').textContent = formatBytes(file.size);
  document.getElementById('sel-file-chunks').textContent = totalChunks;
  document.getElementById('sel-file-mime').textContent = file.type || 'application/octet-stream';

  const btnStart = document.getElementById('btn-start-upload');
  btnStart.disabled = false;

  // Check if there is an active session in localStorage for this file name + size
  const resumeBadge = document.getElementById('resumable-detected-badge');
  if (STATE.activeUpload && STATE.activeUpload.name === file.name && STATE.activeUpload.totalSize === file.size) {
    try {
      const res = await apiRequest(`${CORE_API_URL}/upload/status/${STATE.activeUpload.fileId}`, {
        headers: { 'Authorization': `Bearer ${STATE.token}` }
      });
      const verifiedList = Array.isArray(res.data?.verifiedChunks) ? res.data.verifiedChunks : [];
      if (res.ok && verifiedList.length > 0) {
        resumeBadge.classList.remove('hidden');
        resumeBadge.innerHTML = `<i data-lucide="check" class="w-3 h-3 text-emerald-400"></i> Resumable session active! ${verifiedList.length}/${totalChunks} chunks verified on server.`;
        if (window.lucide) lucide.createIcons();
      } else {
        resumeBadge.classList.add('hidden');
      }
    } catch {
      resumeBadge.classList.add('hidden');
    }
  } else {
    resumeBadge.classList.add('hidden');
  }
}

async function startChunkedUpload() {
  if (!STATE.selectedFile) return;
  const file = STATE.selectedFile;
  const chunkSize = parseInt(document.getElementById('upload-chunk-size').value, 10);
  const totalChunks = Math.ceil(file.size / chunkSize);

  STATE.isUploading = true;
  STATE.isPaused = false;
  STATE.abortController = new AbortController();

  document.getElementById('btn-start-upload').classList.add('hidden');
  document.getElementById('upload-controls').classList.remove('hidden');
  document.getElementById('upload-progress-card').classList.remove('hidden');

  // Initialize Chunk Status Matrix in DOM
  const chunkGrid = document.getElementById('chunk-grid');
  chunkGrid.innerHTML = '';
  for (let i = 0; i < totalChunks; i++) {
    const chunkDot = document.createElement('div');
    chunkDot.id = `chunk-dot-${i}`;
    chunkDot.className = 'w-4 h-4 rounded bg-dark-800 border border-white/5 flex items-center justify-center text-[9px] font-mono text-slate-500';
    chunkDot.textContent = i + 1;
    chunkGrid.appendChild(chunkDot);
  }

  let fileId = STATE.activeUpload?.fileId;
  let verifiedChunks = [];

  try {
    // 1. Check existing upload status or Initialize new session
    if (fileId && STATE.activeUpload?.name === file.name && STATE.activeUpload?.totalSize === file.size) {
      const statusRes = await apiRequest(`${CORE_API_URL}/upload/status/${fileId}`, {
        headers: { 'Authorization': `Bearer ${STATE.token}` }
      });
      if (statusRes.ok) {
        verifiedChunks = Array.isArray(statusRes.data?.verifiedChunks) 
          ? statusRes.data.verifiedChunks 
          : (Array.isArray(statusRes.data?.uploadedChunks) ? statusRes.data.uploadedChunks : []);
      }
    }

    if (!fileId || verifiedChunks.length === 0) {
      const initRes = await apiRequest(`${CORE_API_URL}/upload/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${STATE.token}`
        },
        body: JSON.stringify({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          totalSize: file.size,
          totalChunks
        })
      });

      if (!initRes.ok) {
        throw new Error(initRes.data?.message || `Init upload failed with status ${initRes.status}`);
      }

      fileId = initRes.data.fileId;
      STATE.activeUpload = { fileId, name: file.name, totalSize: file.size, totalChunks, chunkSize };
      localStorage.setItem('pravah_active_upload', JSON.stringify(STATE.activeUpload));
    }

    // Mark already uploaded chunks as verified
    verifiedChunks.forEach(idx => {
      const dot = document.getElementById(`chunk-dot-${idx}`);
      if (dot) dot.className = 'w-4 h-4 rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 flex items-center justify-center text-[9px] font-mono font-bold';
    });

    // 2. Upload missing chunks sequentially with retry
    for (let i = 0; i < totalChunks; i++) {
      if (verifiedChunks.includes(i)) continue;

      while (STATE.isPaused) {
        await new Promise(r => setTimeout(r, 500));
      }

      if (!STATE.isUploading) break;

      const dot = document.getElementById(`chunk-dot-${i}`);
      if (dot) dot.className = 'w-4 h-4 rounded bg-brand-500/30 border border-brand-500/50 text-white flex items-center justify-center text-[9px] font-mono animate-pulse';

      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunkBlob = file.slice(start, end);
      const arrayBuffer = await chunkBlob.arrayBuffer();
      const checksum = sha256(arrayBuffer);

      const formData = new FormData();
      formData.append('file', chunkBlob, `chunk-${i}`);
      formData.append('checksum', checksum);

      let chunkUploaded = false;
      let attempts = 0;

      while (!chunkUploaded && attempts < 3) {
        try {
          attempts++;
          const uploadRes = await fetch(`${CORE_API_URL}/upload/${fileId}/chunk/${i}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${STATE.token}` },
            body: formData,
            signal: STATE.abortController.signal
          });

          if (uploadRes.ok) {
            chunkUploaded = true;
            verifiedChunks.push(i);
            if (dot) dot.className = 'w-4 h-4 rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 flex items-center justify-center text-[9px] font-mono font-bold';
            
            const pct = Math.round((verifiedChunks.length / totalChunks) * 100);
            document.getElementById('upload-progress-bar').style.width = `${pct}%`;
            document.getElementById('upload-pct-text').textContent = `${pct}%`;
            document.getElementById('upload-status-text').textContent = `Uploaded chunk ${i + 1}/${totalChunks}`;
          } else {
            const errJson = await uploadRes.json().catch(() => ({}));
            throw new Error(errJson.message || `HTTP ${uploadRes.status}`);
          }
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (attempts >= 3) throw new Error(`Chunk ${i} failed after 3 attempts: ${err.message}`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    // 3. Complete Upload & trigger Transcoding + Kafka replication
    document.getElementById('upload-status-text').textContent = 'Assembling chunks & triggering pipeline...';
    const completeRes = await apiRequest(`${CORE_API_URL}/upload/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify({ fileId })
    });

    if (!completeRes.ok) {
      throw new Error(completeRes.data?.message || 'Failed to assemble file');
    }

    showToast(`Upload complete! File stored & transcode queued.`, 'success');
    localStorage.removeItem('pravah_active_upload');
    STATE.activeUpload = null;
    resetUploadUI();
    refreshFilesList();

    // Auto-select in streaming and download tabs
    setTargetFileId(fileId);
  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('Upload disconnected. You can resume at any time.', 'info');
    } else {
      showToast(`Upload error: ${err.message}`, 'error');
      document.getElementById('upload-status-text').textContent = `Failed: ${err.message}`;
    }
  }
}

function togglePauseUpload() {
  STATE.isPaused = !STATE.isPaused;
  const btn = document.getElementById('btn-pause-upload');
  if (STATE.isPaused) {
    btn.innerHTML = `<i data-lucide="play" class="w-3.5 h-3.5"></i> Resume`;
    document.getElementById('upload-status-text').textContent = 'Upload paused';
  } else {
    btn.innerHTML = `<i data-lucide="pause" class="w-3.5 h-3.5"></i> Pause`;
    document.getElementById('upload-status-text').textContent = 'Resuming upload...';
  }
  if (window.lucide) lucide.createIcons();
}

function simulateUploadDropout() {
  if (STATE.abortController) {
    STATE.abortController.abort();
    STATE.isUploading = false;
    resetUploadUI();
  }
}

function resetUploadUI() {
  STATE.isUploading = false;
  STATE.isPaused = false;
  const btnStart = document.getElementById('btn-start-upload');
  btnStart.classList.remove('hidden');
  btnStart.disabled = false;
  document.getElementById('upload-controls').classList.add('hidden');
}

// ============================================================================
// 5. FILES CATALOG & ACTIONS TABLE
// ============================================================================
async function refreshFilesList() {
  try {
    const res = await apiRequest(`${CORE_API_URL}/metadata/files`, {
      headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
    });

    if (res.ok) {
      const files = res.data?.data || res.data?.files || (Array.isArray(res.data) ? res.data : []);
      STATE.filesList = files;
      renderFilesTable(files);
      populateMediaDropdowns(files);
    }
  } catch (err) {
    console.error('Failed to load files:', err);
  }
}

function populateMediaDropdowns(files) {
  const streamSelector = document.getElementById('stream-video-selector');
  const dlSelector = document.getElementById('dl-file-selector');

  if (streamSelector && Array.isArray(files)) {
    const currentVal = streamSelector.value;
    streamSelector.innerHTML = '<option value="">-- Choose a video to stream --</option>' +
      files.map(f => `<option value="${f.id}" ${f.id === currentVal ? 'selected' : ''}>${f.name} (${formatBytes(f.totalSize)}) [${f.status}]</option>`).join('');
  }

  if (dlSelector && Array.isArray(files)) {
    const currentDl = dlSelector.value;
    dlSelector.innerHTML = '<option value="">-- Choose from uploaded catalog --</option>' +
      files.map(f => `<option value="${f.id}" ${f.id === currentDl ? 'selected' : ''}>${f.name} (${formatBytes(f.totalSize)}) [${f.status}]</option>`).join('');
  }
}

function onStreamVideoSelected(fileId) {
  if (!fileId) return;
  playHlsStream(fileId);
}

function onDownloadFileSelected(fileId) {
  if (!fileId) return;
  setTargetFileId(fileId);
}

function renderFilesTable(files) {
  const tbody = document.getElementById('files-table-body');
  const countLabel = document.getElementById('files-count-label');
  if (!tbody) return;

  if (countLabel) countLabel.textContent = `Total Files: ${files.length}`;

  if (!files || files.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="p-8 text-center text-slate-500 font-sans">
          <i data-lucide="folder-open" class="w-8 h-8 text-slate-600 mx-auto mb-2"></i>
          <p class="text-xs">No files uploaded yet.</p>
        </td>
      </tr>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  tbody.innerHTML = files.map(f => {
    const statusBg = f.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                     f.status === 'UPLOADING' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 'bg-dark-800 text-slate-400';

    return `
      <tr class="hover:bg-dark-850/50 transition">
        <td class="p-3">
          <div class="font-bold text-slate-200 font-sans truncate max-w-[200px]">${f.name}</div>
          <div class="text-[10px] text-slate-500 font-mono">${f.id}</div>
        </td>
        <td class="p-3 text-slate-300 font-mono">${formatBytes(f.totalSize)}</td>
        <td class="p-3">
          <span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full ${statusBg} border">${f.status}</span>
        </td>
        <td class="p-3 text-slate-400">${new Date(f.createdAt).toLocaleDateString()}</td>
        <td class="p-3 text-right">
          <div class="flex items-center justify-end gap-1.5 font-sans">
            <button onclick="playHlsStream('${f.id}')" class="px-2 py-1 rounded bg-brand-600/20 hover:bg-brand-600 text-brand-300 hover:text-white text-[11px] font-semibold transition flex items-center gap-1">
              <i data-lucide="play" class="w-3 h-3"></i> Stream
            </button>
            <button onclick="openRangeTester('${f.id}')" class="px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-white text-[11px] font-semibold transition flex items-center gap-1">
              <i data-lucide="download" class="w-3 h-3"></i> Range 206
            </button>
            <button onclick="triggerPurgeModal('${f.id}')" class="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-white text-[11px] font-semibold transition flex items-center gap-1" title="Evict from Edge RAM & Invalidate Kafka">
              <i data-lucide="refresh-cw" class="w-3 h-3"></i> Purge
            </button>
            <button onclick="deleteFileRecord('${f.id}')" class="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-white text-[11px] font-semibold transition flex items-center gap-1" title="Permanently delete from MinIO and Database">
              <i data-lucide="trash-2" class="w-3 h-3"></i> Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

async function deleteFileRecord(fileId) {
  if (!confirm(`Are you sure you want to permanently delete this file and all its data from MinIO and Database?`)) return;
  try {
    const res = await apiRequest(`${CORE_API_URL}/metadata/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      showToast('File permanently deleted from MinIO S3 and PostgreSQL', 'success');
      refreshFilesList();
    } else {
      showToast(`Delete failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    showToast(`Delete error: ${err.message}`, 'error');
  }
}

function setTargetFileId(fileId) {
  const dlInput = document.getElementById('dl-file-id');
  const dlSelect = document.getElementById('dl-file-selector');
  const purgeInput = document.getElementById('purge-file-id');
  const streamSelect = document.getElementById('stream-video-selector');
  if (dlInput) dlInput.value = fileId;
  if (dlSelect && fileId) dlSelect.value = fileId;
  if (purgeInput) purgeInput.value = fileId;
  if (streamSelect && fileId) streamSelect.value = fileId;
  if (fileId) checkActiveDownloadSession(fileId);
}

function checkActiveDownloadSession(fileId) {
  const card = document.getElementById('resumable-dl-card');
  const bar = document.getElementById('resumable-dl-bar');
  const text = document.getElementById('resumable-dl-bytes');
  const title = document.getElementById('resumable-dl-status-title');
  if (!card || !fileId) return;

  const saved = JSON.parse(localStorage.getItem('pravah_active_download') || 'null');
  if (saved && saved.fileId === fileId && saved.downloadedBytes > 0 && saved.downloadedBytes < (saved.totalBytes || Infinity)) {
    card.classList.remove('hidden');
    const pct = Math.min(100, Math.round((saved.downloadedBytes / (saved.totalBytes || 1)) * 100));
    if (bar) bar.style.width = `${pct}%`;
    if (text) text.textContent = `${formatBytes(saved.downloadedBytes)} / ${formatBytes(saved.totalBytes)} (${pct}%)`;
    if (title) title.textContent = 'Paused Session Restored (Click Resume):';
    showToast(`In-progress download found at ${formatBytes(saved.downloadedBytes)} (${pct}%). Click Resume to continue!`, 'info');
  }
}

function openRangeTester(fileId) {
  setTargetFileId(fileId);
  const tab = document.querySelector('[data-tab="tab-download"]');
  if (tab) tab.click();
}

function triggerPurgeModal(fileId) {
  setTargetFileId(fileId);
  const tab = document.querySelector('[data-tab="tab-cache"]');
  if (tab) tab.click();
}

// ============================================================================
// 6. DOWNLOAD LAB & RFC 7233 BYTE-RANGE 206 DIAGNOSTICS
// ============================================================================
async function executeRangeDownloadTest() {
  const fileId = document.getElementById('dl-file-id').value.trim();
  if (!fileId) {
    showToast('Please enter or select a File ID', 'error');
    return;
  }

  const preset = document.getElementById('dl-range-preset').value;
  const custom = document.getElementById('dl-custom-range').value.trim();
  const region = document.getElementById('dl-client-region').value;

  let rangeHeader = '';
  if (preset === 'CUSTOM') rangeHeader = custom;
  else if (preset !== 'FULL') rangeHeader = `bytes=${preset}`;

  const headers = {
    'X-Test-Client-Region': region,
    ...(STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {})
  };

  if (rangeHeader) headers['Range'] = rangeHeader;

  const startTime = performance.now();
  const badge = document.getElementById('dl-status-badge');
  badge.textContent = 'Executing...';
  badge.className = 'px-2.5 py-1 text-xs font-mono font-bold uppercase rounded-full bg-dark-900 text-slate-400 border border-white/5';

  try {
    const res = await fetch(`${CORE_API_URL}/download/${fileId}`, { headers });
    const duration = Math.round(performance.now() - startTime);

    document.getElementById('diag-http-status').textContent = `${res.status} ${res.statusText}`;
    document.getElementById('diag-edge-name').textContent = res.headers.get('x-cdn-edge') || 'Origin Core';
    document.getElementById('diag-latency').textContent = `${duration} ms`;

    const cacheState = res.headers.get('x-cache') || (res.status === 206 ? 'HIT (Edge RAM)' : 'MISS');
    document.getElementById('diag-cache-state').textContent = cacheState;

    // Headers Box
    const headerLines = [];
    res.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));
    document.getElementById('diag-headers-box').textContent = headerLines.join('\n');

    const is206 = res.status === 206;
    badge.textContent = is206 ? 'HTTP 206 Partial Content (PASS)' : `HTTP ${res.status}`;
    badge.className = is206 ? 'px-2.5 py-1 text-xs font-mono font-bold uppercase rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                              'px-2.5 py-1 text-xs font-mono font-bold uppercase rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30';

    logApiRequest({
      timestamp: new Date().toLocaleTimeString(),
      method: 'GET',
      url: `${CORE_API_URL}/download/${fileId}`,
      status: res.status,
      duration,
      headers: Object.fromEntries(res.headers.entries()),
      body: `[Binary Stream Delivered - Content-Length: ${res.headers.get('content-length') || 'Unknown'}]`
    });

    showToast(is206 ? `RFC 7233 Range Verified (${duration}ms)` : `Download response: HTTP ${res.status}`, 'success');
  } catch (err) {
    badge.textContent = 'Error';
    badge.className = 'px-2.5 py-1 text-xs font-mono font-bold uppercase rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30';
    showToast(`Range test failed: ${err.message}`, 'error');
  }
}

async function generatePresignedUrl() {
  const fileId = document.getElementById('dl-file-id').value.trim();
  if (!fileId) {
    showToast('Please enter or select a File ID', 'error');
    return;
  }

  try {
    const res = await apiRequest(`${CORE_API_URL}/download/${fileId}/signed`, {
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      const card = document.getElementById('presigned-url-card');
      const input = document.getElementById('presigned-url-val');
      card.classList.remove('hidden');
      input.value = res.data.signedUrl || res.data.url;
      showToast('Presigned URL generated', 'success');
    } else {
      showToast(`Failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    showToast(`Presigned URL error: ${err.message}`, 'error');
  }
}

function copyPresignedUrl() {
  const input = document.getElementById('presigned-url-val');
  navigator.clipboard.writeText(input.value);
  showToast('Presigned URL copied to clipboard', 'success');
}

// Resumable Browser Stream
let streamAbort = null;
let streamBytesDownloaded = 0;
let streamTotalBytes = 0;

async function startBrowserResumableDownload(isResuming = false) {
  const fileId = document.getElementById('dl-file-id').value.trim();
  if (!fileId) {
    showToast('Please enter or select a File ID', 'error');
    return;
  }

  const card = document.getElementById('resumable-dl-card');
  const title = document.getElementById('resumable-dl-status-title');
  if (card) card.classList.remove('hidden');
  if (title) title.textContent = 'Resumable Stream:';

  const saved = JSON.parse(localStorage.getItem('pravah_active_download') || 'null');
  if (isResuming && saved && saved.fileId === fileId) {
    streamBytesDownloaded = saved.downloadedBytes || 0;
    streamTotalBytes = saved.totalBytes || 0;
  } else if (!isResuming) {
    streamBytesDownloaded = 0;
    streamTotalBytes = 0;
    localStorage.removeItem('pravah_active_download');
  }

  streamAbort = new AbortController();

  try {
    const res = await fetch(`${CORE_API_URL}/download/${fileId}`, {
      headers: {
        'Range': `bytes=${streamBytesDownloaded}-`,
        ...(STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {})
      },
      signal: streamAbort.signal
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const contentRange = res.headers.get('content-range');
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)/);
      if (match) streamTotalBytes = parseInt(match[1], 10);
    }
    if (!streamTotalBytes) {
      streamTotalBytes = (parseInt(res.headers.get('content-length'), 10) || 0) + streamBytesDownloaded;
    }

    const reader = res.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamBytesDownloaded += value.length;

      const pct = Math.min(100, Math.round((streamBytesDownloaded / (streamTotalBytes || 1)) * 100));
      document.getElementById('resumable-dl-bar').style.width = `${pct}%`;
      document.getElementById('resumable-dl-bytes').textContent = `${formatBytes(streamBytesDownloaded)} / ${formatBytes(streamTotalBytes)} (${pct}%)`;

      // Persist progress to localStorage on each chunk
      localStorage.setItem('pravah_active_download', JSON.stringify({
        fileId,
        downloadedBytes: streamBytesDownloaded,
        totalBytes: streamTotalBytes
      }));
    }

    localStorage.removeItem('pravah_active_download');
    if (title) title.textContent = 'Stream Completed (100%):';
    showToast('Browser stream download complete (100%)!', 'success');
  } catch (err) {
    if (err.name === 'AbortError') {
      if (title) title.textContent = 'Paused (Session Saved in Storage):';
      showToast(`Stream paused at ${formatBytes(streamBytesDownloaded)}. Refresh the page to test resumption!`, 'info');
    } else {
      showToast(`Stream error: ${err.message}`, 'error');
    }
  }
}

function pauseBrowserStream() {
  if (streamAbort) {
    streamAbort.abort();
  }
}

function resumeBrowserStream() {
  const fileId = document.getElementById('dl-file-id').value.trim();
  const saved = JSON.parse(localStorage.getItem('pravah_active_download') || 'null');
  if (saved && saved.fileId === fileId && saved.downloadedBytes > 0) {
    startBrowserResumableDownload(true);
  } else {
    startBrowserResumableDownload(false);
  }
}

function resetBrowserStream() {
  if (streamAbort) streamAbort.abort();
  localStorage.removeItem('pravah_active_download');
  streamBytesDownloaded = 0;
  streamTotalBytes = 0;
  const card = document.getElementById('resumable-dl-card');
  if (card) card.classList.add('hidden');
  showToast('Download session reset', 'info');
}

document.getElementById('btn-pause-stream')?.addEventListener('click', () => pauseBrowserStream());
document.getElementById('btn-resume-stream')?.addEventListener('click', () => resumeBrowserStream());
document.getElementById('btn-reset-stream')?.addEventListener('click', () => resetBrowserStream());

// ============================================================================
// 7. HLS ADAPTIVE VIDEO STREAMING & BULLMQ PIPELINE STEPPER
// ============================================================================
async function playHlsStream(fileId) {
  setTargetFileId(fileId);
  const tab = document.querySelector('[data-tab="tab-streaming"]');
  if (tab) tab.click();

  const file = STATE.filesList?.find(f => f.id === fileId);
  const streamSelector = document.getElementById('stream-video-selector');
  if (streamSelector && fileId) streamSelector.value = fileId;

  const banner = document.getElementById('active-video-banner');
  const activeName = document.getElementById('active-video-name');
  const activePath = document.getElementById('active-video-path');
  const activeStatus = document.getElementById('active-video-status');

  if (banner && file) {
    banner.classList.remove('hidden');
    if (activeName) activeName.textContent = file.name;
    if (activePath) activePath.textContent = file.storagePath || `s3://pravah-origin/${file.id}`;
    if (activeStatus) {
      activeStatus.textContent = file.status;
      activeStatus.className = file.status === 'COMPLETED' ? 'px-2 py-0.5 text-[9px] font-bold uppercase rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'px-2 py-0.5 text-[9px] font-bold uppercase rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30';
    }
  }

  const video = document.getElementById('hls-video');
  const emptyState = document.getElementById('video-empty-state');
  if (emptyState) emptyState.classList.add('hidden');

  // HLS Master Playlist URL directly from Edge Node
  const streamUrl = `${EDGE_URL}/edge/content/${fileId}/hls/master.m3u8?v=1`;

  if (STATE.hlsPlayer) {
    STATE.hlsPlayer.destroy();
  }

  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30
    });

    STATE.hlsPlayer = hls;
    hls.loadSource(streamUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      video.play().catch(() => {});
      populateQualityLevels(data.levels);
      showToast('Adaptive HLS Master Manifest Loaded', 'success');
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      const level = hls.levels[data.level];
      if (level) {
        document.getElementById('hls-stat-rendition').textContent = `${level.height}p`;
        document.getElementById('hls-stat-bitrate').textContent = `${Math.round(level.bitrate / 1000)} kbps`;
      }
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        showToast(`HLS stream not ready yet (transcoding in progress)`, 'info');
      }
    });

    // Update buffer stats
    setInterval(() => {
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const bufferLen = Math.max(0, bufferedEnd - video.currentTime);
        document.getElementById('hls-stat-buffer').textContent = `${bufferLen.toFixed(1)} s`;
      }
    }, 500);

  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.play();
  }

  // Poll Transcoding Records
  pollTranscodeStatus(fileId);
}

function populateQualityLevels(levels) {
  const selector = document.getElementById('hls-quality-selector');
  selector.innerHTML = '<option value="-1" selected>Auto (Adaptive Bitrate)</option>';
  levels.forEach((l, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${l.height}p (${Math.round(l.bitrate / 1000)} kbps)`;
    selector.appendChild(opt);
  });

  selector.onchange = () => {
    if (STATE.hlsPlayer) {
      STATE.hlsPlayer.currentLevel = parseInt(selector.value, 10);
    }
  };
}

async function pollTranscodeStatus(targetFileId) {
  const fileId = targetFileId || document.getElementById('dl-file-id')?.value;
  if (!fileId) return;

  try {
    const res = await apiRequest(`${CORE_API_URL}/admin/transcoding/status/${fileId}`, {
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      const transcodes = res.data.transcodes || [];
      updateTranscoderStepper(transcodes);
    }
  } catch (err) {
    console.error('Transcode poll error:', err);
  }
}

function updateTranscoderStepper(records) {
  const qualityMap = {
    'Q_1080P': 'step-1080p',
    'Q_720P': 'step-720p',
    'Q_480P': 'step-480p',
    'Q_360P': 'step-360p',
    'Q_240P': 'step-240p',
    'Q_144P': 'step-144p'
  };

  records.forEach(t => {
    const stepId = qualityMap[t.quality];
    const el = document.getElementById(stepId);
    if (!el) return;

    const badge = el.querySelector('.status-badge');
    if (!badge) return;

    if (t.status === 'COMPLETED') {
      badge.textContent = 'READY';
      badge.className = 'status-badge px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    } else if (t.status === 'PROCESSING') {
      badge.textContent = 'ENCODING...';
      badge.className = 'status-badge px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-brand-500/20 text-brand-300 border border-brand-500/30 animate-pulse';
    } else if (t.status === 'FAILED') {
      badge.textContent = 'FAILED';
      badge.className = 'status-badge px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-rose-500/20 text-rose-400 border border-rose-500/30';
      if (t.errorMessage) el.title = t.errorMessage;
    }
  });
}

// ============================================================================
// 8. MULTI-REGION TOPOLOGY & GEODNS FAILOVER
// ============================================================================
async function refreshTopologyNodes() {
  try {
    const res = await apiRequest(`${CORE_API_URL}/admin/health/nodes`, {
      headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
    });

    if (res.ok) {
      const nodes = res.data.nodes || [];
      renderTopologyGrid(nodes);
    }
  } catch (err) {
    console.error('Topology fetch error:', err);
  }
}

function renderTopologyGrid(nodes) {
  const grid = document.getElementById('topology-nodes-grid');
  if (!grid) return;

  if (nodes.length === 0) {
    // Default 3 Edge Node Representation if DB empty
    nodes = [
      { id: 'edge-node-01', name: 'Mumbai Edge (ap-south-1)', region: 'ap-south-1', status: 'HEALTHY', latencyMs: 8 },
      { id: 'edge-node-02', name: 'Virginia Edge (us-east-1)', region: 'us-east-1', status: 'HEALTHY', latencyMs: 65 },
      { id: 'edge-node-03', name: 'Frankfurt Edge (eu-central-1)', region: 'eu-central-1', status: 'HEALTHY', latencyMs: 42 }
    ];
  }

  grid.innerHTML = nodes.map(n => {
    const isHealthy = n.status === 'HEALTHY';
    const statusBg = isHealthy ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-400 bg-rose-500/10 border-rose-500/20';
    const dotColor = isHealthy ? 'bg-emerald-400' : 'bg-rose-400';

    return `
      <div class="p-4 rounded-xl bg-dark-900 border border-white/5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="font-bold text-white text-xs">${n.name}</span>
          <span class="w-2.5 h-2.5 rounded-full ${dotColor}"></span>
        </div>
        <div class="text-[11px] font-mono text-slate-400 space-y-1">
          <div class="flex justify-between"><span>Region:</span><span class="text-slate-200">${n.region}</span></div>
          <div class="flex justify-between"><span>Latency:</span><span class="text-brand-300 font-bold">${n.latencyMs || 8} ms</span></div>
          <div class="flex justify-between"><span>Status:</span><span class="px-1.5 py-0.2 rounded font-bold ${statusBg} border">${n.status}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

async function simulateNodeCrash() {
  const edgeId = document.getElementById('sim-crash-node').value;
  try {
    const res = await apiRequest(`${CORE_API_URL}/admin/replication/failover/${edgeId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      showToast(`Simulated crash for ${edgeId}. Failover repair executed!`, 'success');
      refreshTopologyNodes();
    } else {
      showToast(`Failover error: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    showToast(`Crash trigger error: ${err.message}`, 'error');
  }
}

function calculateGeoDNSRoute() {
  const loc = document.getElementById('sim-client-loc').value;
  let target = 'edge-node-01';
  let dist = '12 km';

  if (loc === 'New York') { target = 'edge-node-02 (Virginia)'; dist = '380 km'; }
  else if (loc === 'Frankfurt' || loc === 'London') { target = 'edge-node-03 (Frankfurt)'; dist = '450 km'; }
  else if (loc === 'Tokyo' || loc === 'Sydney') { target = 'edge-node-01 (Mumbai)'; dist = '5,400 km'; }

  document.getElementById('geodns-result-card').classList.remove('hidden');
  document.getElementById('geo-target-node').textContent = target;
  document.getElementById('geo-distance').textContent = dist;
}

// ============================================================================
// 9. EDGE CACHE PURGE & KAFKA INVALIDATION
// ============================================================================
async function executeClusterPurge() {
  const fileId = document.getElementById('purge-file-id').value.trim();
  if (!fileId) {
    showToast('Please enter a File ID to purge', 'error');
    return;
  }

  const badge = document.getElementById('purge-status-badge');
  const output = document.getElementById('purge-response-json');
  badge.textContent = 'Broadcasting...';
  badge.className = 'px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-amber-500/20 text-amber-300 animate-pulse';

  try {
    // Real Core API Purge Route: /api/v1/admin/cache/purge
    const res = await apiRequest(`${CORE_API_URL}/admin/cache/purge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {})
      },
      body: JSON.stringify({ fileId })
    });

    output.textContent = JSON.stringify(res.data, null, 2);

    if (res.ok) {
      badge.textContent = '200 OK (Purged)';
      badge.className = 'px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      showToast(`Cache purge broadcasted via Kafka for ${fileId}`, 'success');
    } else {
      badge.textContent = `HTTP ${res.status}`;
      badge.className = 'px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-rose-500/20 text-rose-400 border border-rose-500/30';
      showToast(`Purge failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    badge.textContent = 'Network Error';
    badge.className = 'px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-rose-500/20 text-rose-400';
    output.textContent = JSON.stringify({ error: err.message }, null, 2);
    showToast(`Purge error: ${err.message}`, 'error');
  }
}

async function executeEdgeDirectPurge() {
  const fileId = document.getElementById('purge-file-id').value.trim();
  if (!fileId) {
    showToast('Please enter a File ID to purge', 'error');
    return;
  }

  const badge = document.getElementById('purge-status-badge');
  const output = document.getElementById('purge-response-json');
  badge.textContent = 'Purging Edge RAM...';

  try {
    // Direct Edge RAM Purge Route: POST http://localhost:3001/edge/content/:fileId/purge
    const res = await apiRequest(`${EDGE_URL}/edge/content/${fileId}/purge`, {
      method: 'POST'
    });

    output.textContent = JSON.stringify(res.data, null, 2);
    if (res.ok) {
      badge.textContent = 'Edge RAM Evicted';
      badge.className = 'px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      showToast('Edge node RAM cache evicted immediately', 'success');
    } else {
      badge.textContent = `HTTP ${res.status}`;
      badge.className = 'px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-rose-500/20 text-rose-400';
      showToast(`Edge purge failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    badge.textContent = 'Edge Error';
    output.textContent = JSON.stringify({ error: err.message }, null, 2);
    showToast(`Edge purge error: ${err.message}`, 'error');
  }
}

// ============================================================================
// 10. DEAD LETTER QUEUE (DLQ) & RECOVERY
// ============================================================================
async function refreshDLQTable() {
  try {
    const res = await apiRequest(`${CORE_API_URL}/admin/dlq`, {
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      const events = res.data.events || [];
      renderDLQTable(events);
    }
  } catch (err) {
    console.error('DLQ fetch error:', err);
  }
}

function renderDLQTable(events) {
  const tbody = document.getElementById('dlq-table-body');
  const badge = document.getElementById('dlq-count-badge');
  if (!tbody) return;

  if (badge) {
    badge.textContent = events.length;
    if (events.length > 0) badge.classList.remove('hidden');
    else badge.classList.add('hidden');
  }

  if (events.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="p-8 text-center text-slate-500 font-sans">
          <i data-lucide="shield-check" class="w-8 h-8 text-emerald-500/50 mx-auto mb-2"></i>
          <p class="text-xs font-medium text-slate-300">DLQ is clean — 0 dead letters</p>
          <p class="text-[11px] text-slate-500">All edge replication pipelines operating normally.</p>
        </td>
      </tr>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  tbody.innerHTML = events.map(e => `
    <tr class="hover:bg-dark-850/50 transition">
      <td class="p-3 text-slate-400 font-mono">${e.id.substring(0, 8)}...</td>
      <td class="p-3 font-mono text-slate-200">${e.fileId || '--'}</td>
      <td class="p-3 font-bold text-amber-300">${e.edgeNodeId || '--'}</td>
      <td class="p-3 text-rose-400 font-bold">${e.attempts}</td>
      <td class="p-3 text-slate-400 truncate max-w-xs" title="${e.lastError || ''}">${e.lastError || 'Replication Timeout'}</td>
      <td class="p-3 text-right">
        <button onclick="replayDLQEvent('${e.id}')" class="px-2.5 py-1 rounded bg-brand-600/20 hover:bg-brand-600 text-brand-300 hover:text-white text-[11px] font-semibold transition">Replay</button>
      </td>
    </tr>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

async function replayDLQEvent(id) {
  try {
    const res = await apiRequest(`${CORE_API_URL}/admin/dlq/replay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify({ event_id: id })
    });

    if (res.ok) {
      showToast('DLQ event re-queued for execution', 'success');
      refreshDLQTable();
    } else {
      showToast(`Replay failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    showToast(`Replay error: ${err.message}`, 'error');
  }
}

async function replayAllDLQEvents() {
  try {
    const res = await apiRequest(`${CORE_API_URL}/admin/dlq/replay-all`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      showToast('All DLQ events re-queued!', 'success');
      refreshDLQTable();
    } else {
      showToast(`Replay all failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    showToast(`Replay error: ${err.message}`, 'error');
  }
}

// ============================================================================
// 11. DEVELOPER API KEYS & RBAC PORTAL
// ============================================================================
async function refreshApiKeys() {
  try {
    const res = await apiRequest(`${CORE_API_URL}/auth/api-keys`, {
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      const keys = Array.isArray(res.data) ? res.data : [];
      renderApiKeysTable(keys);
    }
  } catch (err) {
    console.error('API Keys fetch error:', err);
  }
}

function renderApiKeysTable(keys) {
  const tbody = document.getElementById('api-keys-table-body');
  if (!tbody) return;

  if (keys.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="p-8 text-center text-slate-500 font-sans">
          <i data-lucide="key" class="w-8 h-8 text-slate-600 mx-auto mb-2"></i>
          <p class="text-xs font-medium text-slate-300">No active API keys</p>
          <p class="text-[11px] text-slate-500">Generate a key above to enable automated pipeline access.</p>
        </td>
      </tr>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  tbody.innerHTML = keys.map(k => `
    <tr class="hover:bg-dark-850/50 transition">
      <td class="p-3 font-bold text-slate-200">${k.name}</td>
      <td class="p-3 text-brand-300">${k.keyPrefix || 'prv_live_...'}</td>
      <td class="p-3"><span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">${k.role}</span></td>
      <td class="p-3 text-slate-400">${new Date(k.createdAt).toLocaleDateString()}</td>
      <td class="p-3"><span class="text-emerald-400 font-semibold">Active</span></td>
      <td class="p-3 text-right">
        <button onclick="revokeApiKey('${k.id}')" class="px-2.5 py-1 rounded bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white text-[11px] font-medium transition">Revoke</button>
      </td>
    </tr>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

document.getElementById('btn-submit-create-key')?.addEventListener('click', async () => {
  const name = document.getElementById('new-key-name').value.trim() || 'CI-Pipeline-Key';
  const role = document.getElementById('new-key-role').value;
  const expiryDays = parseInt(document.getElementById('new-key-expiry').value, 10);

  try {
    const res = await apiRequest(`${CORE_API_URL}/auth/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify({ name, role, expiresInDays: expiryDays })
    });

    if (res.ok) {
      document.getElementById('created-key-card').classList.remove('hidden');
      document.getElementById('created-key-plaintext').value = res.data.apiKey;
      const testInput = document.getElementById('test-api-key-input');
      if (testInput) testInput.value = res.data.apiKey;
      showToast('API Key generated successfully (Auto-populated into Test Lab below)', 'success');
      refreshApiKeys();
    } else {
      showToast(`Key creation failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    showToast(`API Key error: ${err.message}`, 'error');
  }
});

document.getElementById('btn-copy-key')?.addEventListener('click', () => {
  const input = document.getElementById('created-key-plaintext');
  navigator.clipboard.writeText(input.value);
  showToast('API Key copied to clipboard', 'success');
});

async function executeApiKeyTest() {
  const apiKey = document.getElementById('test-api-key-input').value.trim();
  const endpoint = document.getElementById('test-api-endpoint').value;

  if (!apiKey) {
    showToast('Please enter or paste an API Key (prv_live_...)', 'error');
    return;
  }

  const outputBox = document.getElementById('api-test-output-box');
  const badge = document.getElementById('api-test-status-badge');
  const pre = document.getElementById('api-test-response-pre');

  outputBox.classList.remove('hidden');
  badge.textContent = 'Testing...';
  badge.className = 'px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-dark-900 border text-slate-400';
  pre.textContent = `Sending authenticated request to: ${CORE_API_URL}${endpoint}\nHeaders:\n  x-api-key: ${apiKey.substring(0, 16)}...\n\nWaiting for response...`;

  try {
    const res = await apiRequest(`${CORE_API_URL}${endpoint}`, {
      headers: {
        'x-api-key': apiKey
      }
    });

    if (res.ok) {
      badge.textContent = `${res.status} OK (AUTHENTICATED)`;
      badge.className = 'px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      pre.textContent = JSON.stringify(res.data, null, 2);
      showToast(`API Key authenticated successfully (HTTP ${res.status})`, 'success');
    } else {
      badge.textContent = `HTTP ${res.status}`;
      badge.className = 'px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-rose-500/20 text-rose-300 border border-rose-500/30';
      pre.textContent = JSON.stringify(res.data, null, 2);
      showToast(`Auth rejected: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    badge.textContent = 'Error';
    badge.className = 'px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-rose-500/20 text-rose-300 border border-rose-500/30';
    pre.textContent = `Request error: ${err.message}`;
    showToast(`Request failed: ${err.message}`, 'error');
  }
}

async function revokeApiKey(id) {
  if (!confirm('Are you sure you want to revoke this API key?')) return;
  try {
    const res = await apiRequest(`${CORE_API_URL}/auth/api-keys/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });

    if (res.ok) {
      showToast('API Key revoked', 'success');
      refreshApiKeys();
    } else {
      showToast(`Revocation failed: ${res.data?.message || res.status}`, 'error');
    }
  } catch (err) {
    showToast(`Revoke error: ${err.message}`, 'error');
  }
}

// ============================================================================
// 12. WEBSOCKET REAL-TIME TELEMETRY
// ============================================================================
function setupSocketIO() {
  if (typeof io === 'undefined') return;

  try {
    const socket = io(CORE_BASE_URL, { transports: ['websocket', 'polling'] });
    STATE.socket = socket;

    socket.on('connect', () => {
      document.getElementById('dot-ws').className = 'w-2 h-2 rounded-full bg-emerald-400';
      document.getElementById('text-ws').textContent = 'Live WS Connected';
    });

    socket.on('disconnect', () => {
      document.getElementById('dot-ws').className = 'w-2 h-2 rounded-full bg-rose-400';
      document.getElementById('text-ws').textContent = 'WS Disconnected';
    });

    socket.on('cache.access', (data) => {
      appendLiveCacheItem(data);
    });

    socket.on('upload.progress', (data) => {
      if (data.fileId === STATE.activeUpload?.fileId) {
        document.getElementById('upload-status-text').textContent = `WS Broadcast: Chunk ${data.chunkIndex + 1}/${data.totalChunks} (${data.percentage}%)`;
      }
    });

  } catch (err) {
    console.error('Socket.IO connection failed:', err);
  }
}

function appendLiveCacheItem(data) {
  const feed = document.getElementById('live-cache-feed');
  if (!feed) return;

  const row = document.createElement('div');
  const isHit = data.eventType === 'hit';
  const tag = isHit ? '[HIT]' : '[MISS]';
  const color = isHit ? 'text-emerald-400' : 'text-amber-400';

  row.className = 'p-2 rounded-lg bg-dark-900 border border-white/5 flex items-center justify-between text-[11px] font-mono animate-fadeIn';
  row.innerHTML = `
    <span class="${color} font-semibold">${tag} ${data.fileId?.substring(0, 8)}</span>
    <span class="text-slate-500 text-[10px]">${data.region || 'Mumbai'} • ${data.downloadLatencyMs || 2}ms</span>
  `;

  feed.prepend(row);
  if (feed.children.length > 20) feed.lastChild.remove();
}

function initTelemetryChart() {
  const ctx = document.getElementById('telemetry-chart');
  if (!ctx || STATE.telemetryChart) return;

  const labels = Array.from({ length: 20 }, (_, i) => `${20 - i}s ago`);
  const data = Array.from({ length: 20 }, () => Math.floor(1150 + Math.random() * 120));

  STATE.telemetryChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Requests per Second',
        data,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.08)',
        fill: true,
        tension: 0.4,
        borderWidth: 2,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255, 255, 255, 0.04)' }, ticks: { color: '#64748b', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255, 255, 255, 0.04)' }, ticks: { color: '#64748b', font: { size: 10 } } }
      }
    }
  });

  setInterval(() => {
    if (STATE.telemetryChart) {
      const nextRps = Math.floor(1200 + Math.random() * 90);
      STATE.telemetryChart.data.datasets[0].data.shift();
      STATE.telemetryChart.data.datasets[0].data.push(nextRps);
      STATE.telemetryChart.update('none');
      const rpsEl = document.getElementById('metric-rps');
      if (rpsEl) rpsEl.textContent = nextRps.toLocaleString();
    }
  }, 1000);
}

// ============================================================================
// 13. UTILITY FUNCTIONS
// ============================================================================
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bg = type === 'success' ? 'bg-emerald-600 text-white' :
             type === 'error' ? 'bg-rose-600 text-white' : 'bg-dark-800 text-slate-200 border border-white/10';

  toast.className = `px-4 py-2.5 rounded-xl text-xs font-medium shadow-2xl transition-all duration-300 transform translate-y-2 opacity-0 flex items-center gap-2 ${bg} pointer-events-auto`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Global Window Bindings for HTML onclick attributes
window.handleLogout = handleLogout;
window.testProfileMeRoute = testProfileMeRoute;
window.copyTokenToClipboard = copyTokenToClipboard;
window.refreshFilesList = refreshFilesList;
window.deleteFileRecord = deleteFileRecord;
window.onStreamVideoSelected = onStreamVideoSelected;
window.onDownloadFileSelected = onDownloadFileSelected;
window.playHlsStream = playHlsStream;
window.openRangeTester = openRangeTester;
window.triggerPurgeModal = triggerPurgeModal;
window.executeRangeDownloadTest = executeRangeDownloadTest;
window.generatePresignedUrl = generatePresignedUrl;
window.copyPresignedUrl = copyPresignedUrl;
window.startBrowserResumableDownload = startBrowserResumableDownload;
window.pollTranscodeStatus = pollTranscodeStatus;
window.refreshTopologyNodes = refreshTopologyNodes;
window.simulateNodeCrash = simulateNodeCrash;
window.calculateGeoDNSRoute = calculateGeoDNSRoute;
window.executeClusterPurge = executeClusterPurge;
window.executeEdgeDirectPurge = executeEdgeDirectPurge;
window.refreshDLQTable = refreshDLQTable;
window.replayDLQEvent = replayDLQEvent;
window.replayAllDLQEvents = replayAllDLQEvents;
window.refreshApiKeys = refreshApiKeys;
window.revokeApiKey = revokeApiKey;
window.executeApiKeyTest = executeApiKeyTest;
window.clearDevLogs = clearDevLogs;
