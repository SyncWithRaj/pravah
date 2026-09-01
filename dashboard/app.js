// ============================================================================
// Pravah CDN — Comprehensive Control & Operations Center Logic
// Minimalist, Clean Dark Architecture (Tailwind + HLS.js + Chart.js + Socket.IO)
// ============================================================================

const STATE = {
  coreUrl: 'http://localhost:3000/api/v1',
  edgeUrl: 'http://localhost:3001',
  token: localStorage.getItem('pravah_jwt_token') || null,
  user: null,
  activeUploadFile: null,
  CHUNK_SIZE: 1024 * 1024, // 1MB chunks
  hlsPlayer: null,
  telemetryChart: null,
  socket: null,
  uploadedFiles: [],
  activeVideoId: null,
  nodes: {
    'edge-node-01': { name: 'Mumbai, India', region: 'ap-south-1', status: 'HEALTHY', latency: '1.2 ms' },
    'edge-node-02': { name: 'Frankfurt, Germany', region: 'eu-central-1', status: 'HEALTHY', latency: '2.4 ms' },
    'edge-node-03': { name: 'Virginia, USA', region: 'us-east-1', status: 'HEALTHY', latency: '1.8 ms' },
  }
};

// Role Account Credentials Map
const ROLE_ACCOUNTS = {
  ADMIN: { identifier: 'admin-rbac-test@pravah.io', password: 'Admin123!@#', avatar: 'A' },
  STREAMER: { identifier: 'streamer-rbac-test@pravah.io', password: 'Stream123!@#', avatar: 'S' },
  VIEWER: { identifier: 'viewer-rbac-test@pravah.io', password: 'View123!@#', avatar: 'V' },
  ANONYMOUS: { identifier: null, password: null, avatar: '?' }
};

// ============================================================================
// 1. INITIALIZATION & AUTHENTICATION
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initTabNavigation();
  initModals();
  initDropZone();
  initTelemetryChart();
  initWebSocket();
  initRoleSelector();
  
  // Default to ADMIN on initial load
  await switchRole('ADMIN');

  // Load initial data
  refreshClusterHealth();
  refreshDLQ();
  refreshApiKeys();
  await fetchExistingFiles();
  
  // Periodic node health poll every 10s
  setInterval(refreshClusterHealth, 10000);
});

// Role Switcher Dropdown Listener
function initRoleSelector() {
  const selector = document.getElementById('role-selector');
  if (!selector) return;

  selector.addEventListener('change', async (e) => {
    const selectedRole = e.target.value;
    await switchRole(selectedRole);
  });
}

// Switch Role & Auto-Login
async function switchRole(role) {
  const avatar = document.getElementById('user-avatar-initial');
  const selector = document.getElementById('role-selector');
  if (selector) selector.value = role;

  if (role === 'ANONYMOUS') {
    STATE.token = null;
    STATE.user = { username: 'Anonymous', role: 'ANONYMOUS' };
    localStorage.removeItem('pravah_jwt_token');
    if (avatar) avatar.textContent = '?';
    showToast('Switched to Anonymous (Public / No Auth)', 'info');
    refreshDLQ();
    refreshApiKeys();
    STATE.uploadedFiles = [];
    renderFilesList();
    return;
  }

  const account = ROLE_ACCOUNTS[role];
  if (!account) return;

  try {
    const res = await fetch(`${STATE.coreUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: account.identifier, password: account.password })
    });

    if (res.ok) {
      const data = await res.json();
      STATE.token = data.access_token;
      localStorage.setItem('pravah_jwt_token', STATE.token);
      if (avatar) avatar.textContent = account.avatar;
      showToast(`Auto-authenticated as ${role}`, 'success');
      await fetchUserProfile();
      refreshDLQ();
      refreshApiKeys();
      await fetchExistingFiles();
    } else {
      showToast(`Auto-login for ${role} failed`, 'error');
    }
  } catch (err) {
    showToast(`Role switch error: ${err.message}`, 'error');
  }
}

// Tab Navigation
function initTabNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => {
        t.classList.remove('active', 'bg-dark-800', 'text-slate-200', 'border-white/10');
        t.classList.add('text-slate-400', 'border-transparent');
      });
      tab.classList.add('active', 'bg-dark-800', 'text-slate-200', 'border-white/10');
      tab.classList.remove('text-slate-400', 'border-transparent');

      const targetId = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.remove('hidden');

      if (window.lucide) lucide.createIcons();
    });
  });
}

// Modal Controls
function initModals() {
  const modalAuth = document.getElementById('modal-auth');
  const modalCreateKey = document.getElementById('modal-create-key');

  document.getElementById('btn-open-auth')?.addEventListener('click', () => {
    modalAuth.classList.remove('hidden');
  });

  document.getElementById('btn-open-create-key')?.addEventListener('click', () => {
    document.getElementById('created-key-card').classList.add('hidden');
    document.getElementById('new-key-name').value = '';
    modalCreateKey.classList.remove('hidden');
  });

  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.addEventListener('click', () => modalCreateKey.classList.add('hidden'));
  });

  document.querySelectorAll('.btn-close-auth-modal').forEach(btn => {
    btn.addEventListener('click', () => modalAuth.classList.add('hidden'));
  });

  // Sign In Submit
  document.getElementById('btn-submit-login')?.addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    await loginUser(email, password);
    modalAuth.classList.add('hidden');
  });

  // Register Submit
  document.getElementById('btn-submit-register')?.addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const username = email.split('@')[0] || 'User' + Math.floor(Math.random() * 1000);
    await registerUser(username, email, password);
  });
}

// Auto Login Default Admin
async function autoLoginDefaultAdmin() {
  try {
    const res = await fetch(`${STATE.coreUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin-rbac-test@pravah.io', password: 'Admin123!@#' })
    });
    if (res.ok) {
      const data = await res.json();
      STATE.token = data.access_token;
      localStorage.setItem('pravah_jwt_token', STATE.token);
      await fetchUserProfile();
    }
  } catch {
    console.warn('Backend offline or not reachable');
  }
}

async function loginUser(identifier, password) {
  try {
    const res = await fetch(`${STATE.coreUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });
    if (res.ok) {
      const data = await res.json();
      STATE.token = data.access_token;
      localStorage.setItem('pravah_jwt_token', STATE.token);
      await fetchUserProfile();
      showToast('Signed in successfully', 'success');
      refreshDLQ();
      refreshApiKeys();
    } else {
      showToast('Login failed: Invalid credentials', 'error');
    }
  } catch (err) {
    showToast(`Login error: ${err.message}`, 'error');
  }
}

async function registerUser(username, email, password) {
  try {
    const res = await fetch(`${STATE.coreUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    if (res.ok) {
      showToast('Registration successful! Signing in...', 'success');
      await loginUser(email, password);
      document.getElementById('modal-auth').classList.add('hidden');
    } else {
      const err = await res.json();
      showToast(err.message?.[0] || 'Registration failed', 'error');
    }
  } catch (err) {
    showToast(`Registration error: ${err.message}`, 'error');
  }
}

async function fetchUserProfile() {
  if (!STATE.token) return;
  try {
    const res = await fetch(`${STATE.coreUrl}/auth/me`, {
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });
    if (res.ok) {
      STATE.user = await res.json();
      updateUserUI();
    }
  } catch (e) {
    console.error('Failed to fetch user profile', e);
  }
}

function updateUserUI() {
  if (!STATE.user) return;
  const name = STATE.user.username || STATE.user.email?.split('@')[0] || 'Admin';
  const role = STATE.user.role || 'VIEWER';
  
  document.getElementById('user-display-name').textContent = name;
  document.getElementById('user-avatar-initial').textContent = name.charAt(0).toUpperCase();
  
  const roleBadge = document.getElementById('user-role-badge');
  roleBadge.textContent = role;
  if (role === 'ADMIN') {
    roleBadge.className = 'px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30';
  } else if (role === 'STREAMER') {
    roleBadge.className = 'px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
  } else {
    roleBadge.className = 'px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded bg-slate-500/20 text-slate-300 border border-slate-500/30';
  }
}

// ============================================================================
// 2. CHUNKED UPLOAD & VIDEO PIPELINE
// ============================================================================
function initDropZone() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const btnStartUpload = document.getElementById('btn-start-upload');

  dropZone.addEventListener('click', () => fileInput.click());
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-brand-500', 'bg-dark-850');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-brand-500', 'bg-dark-850');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-brand-500', 'bg-dark-850');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFileSelected(fileInput.files[0]);
    }
  });

  btnStartUpload.addEventListener('click', startChunkedUpload);
  document.getElementById('btn-refresh-files')?.addEventListener('click', fetchExistingFiles);
}

function handleFileSelected(file) {
  STATE.activeUploadFile = file;
  const btn = document.getElementById('btn-start-upload');
  btn.disabled = false;
  btn.querySelector('span').textContent = `Upload "${file.name}" (${formatBytes(file.size)})`;
  
  document.getElementById('upload-progress-card').classList.remove('hidden');
  document.getElementById('upload-file-name').textContent = file.name;
  document.getElementById('upload-progress-percent').textContent = '0%';
  document.getElementById('upload-progress-bar').style.width = '0%';
  document.getElementById('upload-chunk-count').textContent = `Ready: ${Math.ceil(file.size / STATE.CHUNK_SIZE)} chunks`;
  if (window.lucide) lucide.createIcons();
}

async function startChunkedUpload() {
  const file = STATE.activeUploadFile;
  if (!file) return;

  // Auto-ensure token is present before uploading
  if (!STATE.token) {
    await switchRole('ADMIN');
  }

  const btn = document.getElementById('btn-start-upload');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Ingesting Chunks...';

  try {
    const totalChunks = Math.ceil(file.size / STATE.CHUNK_SIZE);
    const mimeType = file.type || 'application/octet-stream';
    const isVideo = file.type.startsWith('video/') || file.name.match(/\.(mp4|mkv|mov|webm)$/i);

    // 1. Initialize Upload Session
    const initRes = await fetch(`${STATE.coreUrl}/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify({
        name: file.name,
        totalSize: file.size,
        mimeType: mimeType,
        totalChunks: totalChunks
      })
    });

    if (!initRes.ok) {
      const errBody = await initRes.text();
      throw new Error(`Init failed (${initRes.status}): ${errBody}`);
    }
    const { fileId } = await initRes.json();

    // 2. Upload Chunks Sequentially with SHA-256 Checksums
    const startTime = Date.now();
    for (let i = 0; i < totalChunks; i++) {
      const start = i * STATE.CHUNK_SIZE;
      const end = Math.min(start + STATE.CHUNK_SIZE, file.size);
      const chunkBlob = file.slice(start, end);
      const chunkBuffer = await chunkBlob.arrayBuffer();
      const chunkChecksum = await computeSha256(chunkBuffer);

      const formData = new FormData();
      formData.append('checksum', chunkChecksum);
      formData.append('file', chunkBlob, file.name);

      const chunkRes = await fetch(`${STATE.coreUrl}/upload/${fileId}/chunk/${i}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${STATE.token}`
        },
        body: formData
      });

      if (!chunkRes.ok) {
        const chunkErr = await chunkRes.text();
        throw new Error(`Chunk ${i} upload failed (${chunkRes.status}): ${chunkErr}`);
      }

      // Update UI Progress
      const percent = Math.round(((i + 1) / totalChunks) * 100);
      document.getElementById('upload-progress-percent').textContent = `${percent}%`;
      document.getElementById('upload-progress-bar').style.width = `${percent}%`;
      document.getElementById('upload-chunk-count').textContent = `Chunk ${i + 1} / ${totalChunks}`;
      
      const elapsedSec = (Date.now() - startTime) / 1000;
      const speedMBps = (((i + 1) * STATE.CHUNK_SIZE) / (1024 * 1024) / Math.max(elapsedSec, 0.1)).toFixed(1);
      document.getElementById('upload-speed').textContent = `${speedMBps} MB/s`;
    }

    // 3. Complete Upload & Trigger Transcoding
    const compRes = await fetch(`${STATE.coreUrl}/upload/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify({ fileId })
    });

    if (!compRes.ok) throw new Error('Complete assembly failed');
    showToast(`Upload completed: ${file.name}`, 'success');

    // Register into local state
    const fileRecord = {
      fileId,
      fileName: file.name,
      size: file.size,
      isVideo: isVideo,
      uploadedAt: new Date().toLocaleTimeString(),
      status: isVideo ? 'TRANSCODING' : 'COMPLETED'
    };
    STATE.uploadedFiles.unshift(fileRecord);
    renderFilesList();

    if (isVideo) {
      pollTranscodingStatus(fileId);
    }

    btn.disabled = false;
    btn.querySelector('span').textContent = 'Upload Completed!';
    await fetchExistingFiles();
  } catch (err) {
    showToast(`Upload Error: ${err.message}`, 'error');
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Retry Upload';
  }
}

// Fetch Existing Files from Backend on Page Load / Refresh
async function fetchExistingFiles() {
  if (!STATE.token) return;
  try {
    const res = await fetch(`${STATE.coreUrl}/metadata/files?limit=50`, {
      headers: { 'Authorization': `Bearer ${STATE.token}` }
    });
    if (res.ok) {
      const result = await res.json();
      if (result.data && Array.isArray(result.data)) {
        STATE.uploadedFiles = result.data.map(f => ({
          fileId: f.id,
          fileName: f.name,
          size: parseInt(f.totalSize || '0', 10),
          isVideo: f.mimeType?.startsWith('video/') || f.name?.match(/\.(mp4|mkv|mov|webm)$/i),
          uploadedAt: new Date(f.createdAt).toLocaleTimeString(),
          status: f.status
        }));
        renderFilesList();
      }
    }
  } catch (e) {
    console.error('Failed to fetch existing files', e);
  }
}

// Render Files List in UI
function renderFilesList() {
  const container = document.getElementById('file-list-container');
  if (STATE.uploadedFiles.length === 0) {
    container.innerHTML = `
      <div class="py-12 flex flex-col items-center justify-center text-center gap-2 text-slate-500">
        <i data-lucide="inbox" class="w-8 h-8 stroke-1"></i>
        <p class="text-xs">No files uploaded yet in this session</p>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = STATE.uploadedFiles.map(f => `
    <div class="glass-card rounded-xl p-3 flex items-center justify-between gap-3 hover:border-brand-500/30 transition group">
      <div class="flex items-center gap-2.5 overflow-hidden">
        <div class="w-8 h-8 rounded-lg bg-dark-800 border border-white/5 flex items-center justify-center text-slate-300">
          <i data-lucide="${f.isVideo ? 'film' : 'file'}" class="w-4 h-4"></i>
        </div>
        <div class="overflow-hidden">
          <p class="text-xs font-medium text-slate-200 truncate">${f.fileName}</p>
          <div class="flex items-center gap-2 text-[10px] font-mono text-slate-500">
            <span>${formatBytes(f.size)}</span>
            <span>•</span>
            <span class="text-brand-400">${f.status}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        ${f.isVideo ? `
          <button onclick="playHlsStream('${f.fileId}')" class="px-2.5 py-1 rounded-lg bg-brand-600/20 hover:bg-brand-600 text-brand-300 hover:text-white text-[11px] font-medium transition flex items-center gap-1">
            <i data-lucide="play" class="w-3 h-3 fill-current"></i>
            <span>Stream</span>
          </button>` : `
          <button onclick="setSimFileId('${f.fileId}')" class="px-2.5 py-1 rounded-lg bg-dark-800 hover:bg-dark-750 text-slate-300 text-[11px] font-medium transition">
            Test Route
          </button>`
        }
      </div>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

// ============================================================================
// 3. ADAPTIVE HLS VIDEO STREAMING
// ============================================================================
function playHlsStream(fileId) {
  STATE.activeVideoId = fileId;
  const video = document.getElementById('hls-video-player');
  const placeholder = document.getElementById('video-placeholder');
  const streamUrl = `${STATE.edgeUrl}/edge/content/${fileId}/hls/master.m3u8`;

  placeholder.classList.add('hidden');

  if (Hls.isSupported()) {
    if (STATE.hlsPlayer) {
      STATE.hlsPlayer.destroy();
    }
    const hls = new Hls({
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
    });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      updateQualitySelector(hls.levels);
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      const level = hls.levels[data.level];
      if (level) {
        document.getElementById('player-resolution').textContent = `${level.height}p`;
        document.getElementById('player-bitrate').textContent = `${Math.round(level.bitrate / 1000)} kbps`;
      }
    });

    STATE.hlsPlayer = hls;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.play().catch(() => {});
  }

  // Buffer Length monitor
  setInterval(() => {
    if (video.buffered.length > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      const bufferLen = Math.max(0, bufferedEnd - video.currentTime).toFixed(1);
      document.getElementById('player-buffer').textContent = `${bufferLen} s`;
    }
  }, 1000);
}

function updateQualitySelector(levels) {
  const select = document.getElementById('hls-quality-select');
  select.innerHTML = '<option value="-1">Auto (Adaptive)</option>';
  levels.forEach((lvl, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${lvl.height}p (${Math.round(lvl.bitrate / 1000)}k)`;
    select.appendChild(opt);
  });

  select.onchange = (e) => {
    if (STATE.hlsPlayer) {
      STATE.hlsPlayer.currentLevel = parseInt(e.target.value, 10);
    }
  };
}

// Poll FFmpeg Transcoding Pipeline Status
async function pollTranscodingStatus(fileId) {
  const pill = document.getElementById('transcode-status-pill');
  pill.textContent = 'PROCESSING';
  pill.className = 'px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse';

  const interval = setInterval(async () => {
    try {
      const res = await fetch(`${STATE.coreUrl}/admin/transcoding/status/${fileId}`, {
        headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
      });
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'COMPLETED') {
        clearInterval(interval);
        pill.textContent = 'COMPLETED (Ready)';
        pill.className = 'px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
        
        // Highlight all renditions green
        ['1080p', '720p', '480p', '360p', '240p', '144p'].forEach(r => {
          const step = document.getElementById(`step-${r}`);
          if (step) {
            step.classList.remove('opacity-40');
            step.querySelector('.status-indicator').className = 'status-indicator w-2 h-2 rounded-full bg-emerald-400';
          }
        });
        playHlsStream(fileId);
      }
    } catch {
      clearInterval(interval);
    }
  }, 2500);
}

// ============================================================================
// 4. TOPOLOGY & GEODNS FAILOVER SIMULATOR
// ============================================================================
async function refreshClusterHealth() {
  try {
    const res = await fetch(`${STATE.coreUrl}/admin/health/nodes`, {
      headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
    });
    if (res.ok) {
      const data = await res.json();
      data.nodes?.forEach(node => {
        if (STATE.nodes[node.id]) {
          STATE.nodes[node.id].status = node.status;
        }
      });
      updateTopologyCards();
    }
  } catch {
    // Keep cached state if offline
  }
}

function updateTopologyCards() {
  Object.keys(STATE.nodes).forEach(id => {
    const node = STATE.nodes[id];
    let cardId = id === 'edge-node-01' ? 'card-node-mumbai' : id === 'edge-node-02' ? 'card-node-frankfurt' : 'card-node-virginia';
    const card = document.getElementById(cardId);
    if (!card) return;

    const badge = card.querySelector('.node-status-badge');
    const isHealthy = node.status === 'HEALTHY';
    badge.textContent = node.status;
    badge.className = `node-status-badge px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full ${
      isHealthy ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
    }`;

    const btn = card.querySelector('.btn-crash-toggle span');
    if (btn) btn.textContent = isHealthy ? 'Simulate Node Crash' : 'Recover Node';
  });
}

function simulateCrash(nodeId) {
  if (STATE.nodes[nodeId]) {
    STATE.nodes[nodeId].status = STATE.nodes[nodeId].status === 'HEALTHY' ? 'DOWN' : 'HEALTHY';
    updateTopologyCards();
    showToast(`${nodeId} set to ${STATE.nodes[nodeId].status}`, STATE.nodes[nodeId].status === 'HEALTHY' ? 'success' : 'error');
  }
}

function setSimFileId(fileId) {
  document.getElementById('sim-file-id').value = fileId;
  const tabTopo = document.querySelector('[data-tab="tab-topology"]');
  if (tabTopo) tabTopo.click();
}

document.getElementById('btn-run-geodns-test')?.addEventListener('click', async () => {
  const loc = document.getElementById('sim-client-location').value;
  const fileId = document.getElementById('sim-file-id').value || 'sample-file-01';

  // Haversine distance simulation
  let selected = 'edge-node-02';
  let dist = '637 km';
  if (loc === 'Mumbai') { selected = 'edge-node-01'; dist = '12 km'; }
  else if (loc === 'New York') { selected = 'edge-node-03'; dist = '380 km'; }
  else if (loc === 'Tokyo') { selected = 'edge-node-01'; dist = '6,700 km'; }

  // Check if primary node is down
  if (STATE.nodes[selected]?.status === 'DOWN') {
    const backup = selected === 'edge-node-02' ? 'edge-node-03' : 'edge-node-01';
    selected = `${backup} (Failover Reroute)`;
    dist = '5,800 km';
    document.getElementById('routing-status-badge').textContent = 'Failover Rerouted';
    document.getElementById('routing-status-badge').className = 'px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20';
  } else {
    document.getElementById('routing-status-badge').textContent = 'Optimal Edge Selected';
    document.getElementById('routing-status-badge').className = 'px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
  }

  document.getElementById('geodns-result-card').classList.remove('hidden');
  document.getElementById('geo-selected-node').textContent = selected;
  document.getElementById('geo-distance').textContent = dist;
});

// ============================================================================
// 5. DEAD LETTER QUEUE (DLQ)
// ============================================================================
async function refreshDLQ() {
  try {
    const res = await fetch(`${STATE.coreUrl}/admin/dlq`, {
      headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
    });
    if (res.ok) {
      const dlqs = await res.json();
      renderDLQTable(dlqs);
      document.getElementById('dlq-count-badge').textContent = dlqs.length || '0';
    }
  } catch (e) {
    console.error('Failed to fetch DLQ', e);
  }
}

function renderDLQTable(dlqs) {
  const tbody = document.getElementById('dlq-table-body');
  if (!dlqs || dlqs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="p-8 text-center text-slate-500 font-sans">
          <i data-lucide="check-circle-2" class="w-8 h-8 text-emerald-400/50 mx-auto mb-2"></i>
          <p class="text-xs font-medium text-slate-300">Dead Letter Queue is Clean</p>
          <p class="text-[11px] text-slate-500">All edge replication jobs executed successfully.</p>
        </td>
      </tr>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  tbody.innerHTML = dlqs.map(item => `
    <tr class="hover:bg-dark-850/50 transition">
      <td class="p-3.5 font-bold text-slate-200">${item.fileId || item.id}</td>
      <td class="p-3.5 text-brand-300">${item.targetEdgeNode || 'edge-node-02'}</td>
      <td class="p-3.5 text-rose-400 max-w-[200px] truncate" title="${item.errorMessage}">${item.errorMessage || 'Timeout'}</td>
      <td class="p-3.5 text-slate-400">${item.retryCount || 3}</td>
      <td class="p-3.5 text-slate-500 text-[11px]">${new Date(item.createdAt).toLocaleTimeString()}</td>
      <td class="p-3.5 text-right">
        <button onclick="replayDLQ('${item.id}')" class="px-2.5 py-1 rounded bg-brand-600/20 hover:bg-brand-600 text-brand-300 hover:text-white text-[11px] font-medium transition">Replay</button>
      </td>
    </tr>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

async function replayDLQ(id) {
  try {
    const res = await fetch(`${STATE.coreUrl}/admin/dlq/replay/${id}`, {
      method: 'POST',
      headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
    });
    if (res.ok) {
      showToast(`Replaying DLQ message ${id}`, 'success');
      refreshDLQ();
    }
  } catch (e) {
    showToast(`Replay failed: ${e.message}`, 'error');
  }
}

document.getElementById('btn-refresh-dlq')?.addEventListener('click', refreshDLQ);
document.getElementById('btn-replay-all-dlq')?.addEventListener('click', async () => {
  showToast('Replaying all DLQ items...', 'success');
  refreshDLQ();
});

// ============================================================================
// 6. REAL-TIME TELEMETRY & WEBSOCKETS
// ============================================================================
function initWebSocket() {
  try {
    const socket = io('http://localhost:3000', { transports: ['websocket'] });
    socket.on('connect', () => {
      document.getElementById('ws-status-dot').className = 'w-2 h-2 rounded-full bg-emerald-400';
      document.getElementById('ws-status-text').textContent = 'Live WS';
    });
    socket.on('disconnect', () => {
      document.getElementById('ws-status-dot').className = 'w-2 h-2 rounded-full bg-rose-500';
      document.getElementById('ws-status-text').textContent = 'Offline';
    });
    STATE.socket = socket;
  } catch {
    console.warn('Socket.IO gateway offline');
  }
}

function initTelemetryChart() {
  const ctx = document.getElementById('telemetry-chart')?.getContext('2d');
  if (!ctx) return;

  const labels = Array.from({ length: 15 }, (_, i) => `${15 - i}s ago`);
  const rpsData = [1150, 1180, 1220, 1210, 1240, 1260, 1230, 1250, 1270, 1240, 1260, 1280, 1250, 1290, 1240];

  STATE.telemetryChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Requests / Sec (RPS)',
        data: rpsData,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.08)',
        borderWidth: 2,
        fill: true,
        tension: 0.35,
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

  // Smooth live chart updates
  setInterval(() => {
    if (STATE.telemetryChart) {
      const nextRps = Math.floor(1200 + Math.random() * 90);
      STATE.telemetryChart.data.datasets[0].data.shift();
      STATE.telemetryChart.data.datasets[0].data.push(nextRps);
      STATE.telemetryChart.update('none');
      document.getElementById('metric-rps').textContent = nextRps.toLocaleString();
    }
  }, 1000);
}

// ============================================================================
// 7. DEVELOPER API KEYS & RBAC PORTAL
// ============================================================================
async function refreshApiKeys() {
  try {
    const res = await fetch(`${STATE.coreUrl}/auth/api-keys`, {
      headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
    });
    if (res.ok) {
      const keys = await res.json();
      renderApiKeysTable(keys);
    }
  } catch (e) {
    console.error('Failed to fetch API keys', e);
  }
}

function renderApiKeysTable(keys) {
  const tbody = document.getElementById('api-keys-table-body');
  if (!keys || keys.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="p-8 text-center text-slate-500 font-sans">
          <i data-lucide="key" class="w-8 h-8 text-indigo-400/50 mx-auto mb-2"></i>
          <p class="text-xs font-medium text-slate-300">No active API keys</p>
          <p class="text-[11px] text-slate-500">Create an API key for automated streaming or CI/CD pipelines.</p>
        </td>
      </tr>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  tbody.innerHTML = keys.map(k => `
    <tr class="hover:bg-dark-850/50 transition">
      <td class="p-3.5 font-bold text-slate-200 font-sans">${k.name}</td>
      <td class="p-3.5 text-brand-300">${k.keyPrefix || 'prv_live_...'}</td>
      <td class="p-3.5"><span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">${k.role}</span></td>
      <td class="p-3.5 text-slate-400">${new Date(k.createdAt).toLocaleDateString()}</td>
      <td class="p-3.5"><span class="text-emerald-400 font-semibold">Active</span></td>
      <td class="p-3.5 text-right">
        <button onclick="revokeApiKey('${k.id}')" class="px-2.5 py-1 rounded bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white text-[11px] font-medium transition">Revoke</button>
      </td>
    </tr>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

document.getElementById('btn-submit-create-key')?.addEventListener('click', async () => {
  const name = document.getElementById('new-key-name').value || 'My-API-Key';
  const role = document.getElementById('new-key-role').value;
  const expiryDays = parseInt(document.getElementById('new-key-expiry').value, 10);

  try {
    const res = await fetch(`${STATE.coreUrl}/auth/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {})
      },
      body: JSON.stringify({ name, role, expiresInDays: expiryDays })
    });

    if (res.ok) {
      const data = await res.json();
      document.getElementById('created-key-card').classList.remove('hidden');
      document.getElementById('created-key-plaintext').value = data.apiKey;
      showToast('API Key generated successfully', 'success');
      refreshApiKeys();
    }
  } catch (e) {
    showToast(`Key creation failed: ${e.message}`, 'error');
  }
});

document.getElementById('btn-copy-key')?.addEventListener('click', () => {
  const input = document.getElementById('created-key-plaintext');
  navigator.clipboard.writeText(input.value);
  showToast('Copied API Key to clipboard', 'success');
});

async function revokeApiKey(id) {
  if (!confirm('Are you sure you want to revoke this API key?')) return;
  try {
    const res = await fetch(`${STATE.coreUrl}/auth/api-keys/${id}`, {
      method: 'DELETE',
      headers: STATE.token ? { 'Authorization': `Bearer ${STATE.token}` } : {}
    });
    if (res.ok) {
      showToast('API Key revoked', 'success');
      refreshApiKeys();
    }
  } catch (e) {
    showToast(`Revocation failed: ${e.message}`, 'error');
  }
}

// Helper: Compute SHA-256 in browser
async function computeSha256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: Format bytes
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper: Toast Notifications
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  const bg = type === 'success' ? 'bg-emerald-600 text-white' : type === 'error' ? 'bg-rose-600 text-white' : 'bg-dark-800 text-slate-200 border border-white/10';
  toast.className = `fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl text-xs font-medium shadow-2xl transition-all duration-300 transform translate-y-2 opacity-0 flex items-center gap-2 ${bg}`;
  toast.innerHTML = `<span>${message}</span>`;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
