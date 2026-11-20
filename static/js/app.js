/**
 * LocalShare Application Controller
 * Manages UI state, real-time SSE event subscriptions, peer discovery,
 * file queuing, audio notifications, and drag-and-drop mechanics.
 */
(function() {
  'use strict';

  // --------------------------------------------------------------------------
  // Audio Synthesis Utilities (Zero external audio file dependencies)
  // --------------------------------------------------------------------------
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playChime(type = 'prompt') {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'prompt') {
        // Friendly double-tone chime
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.15);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === 'success') {
        // High bright chime
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880, now + 0.1); // A5
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
      }
    } catch (e) {
      // Audio autoplay policy or error
    }
  }

  // --------------------------------------------------------------------------
  // Application State
  // --------------------------------------------------------------------------
  const state = {
    myId: localStorage.getItem('ls_peer_id') || ('peer_' + Math.random().toString(36).substring(2, 10)),
    myName: localStorage.getItem('ls_peer_name') || '',
    myRoom: getUrlParam('room') || localStorage.getItem('ls_room') || 'local',
    deviceType: 'desktop',
    serverIp: '127.0.0.1',
    serverPort: 53317,
    peers: new Map(),
    selectedPeerId: null,
    fileQueue: [],
    activeTx: null,
    pendingIncomingOffer: null,
    sseSource: null,
    transferEngine: null,
    history: JSON.parse(localStorage.getItem('ls_history') || '[]')
  };

  localStorage.setItem('ls_peer_id', state.myId);
  state.transferEngine = new TransferEngine(state.myId);

  // --------------------------------------------------------------------------
  // DOM References
  // --------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const els = {
    currentRoomText: $('currentRoomText'),
    roomBtn: $('roomBtn'),
    qrBtn: $('qrBtn'),
    themeToggleBtn: $('themeToggleBtn'),
    myAvatar: $('myAvatar'),
    myNameText: $('myNameText'),
    myMetaText: $('myMetaText'),
    renameBtn: $('renameBtn'),
    connectionBadge: $('connectionBadge'),
    connectionText: $('connectionText'),
    peerCountBadge: $('peerCountBadge'),
    refreshPeersBtn: $('refreshPeersBtn'),
    radarArea: $('radarArea'),
    peersGrid: $('peersGrid'),
    emptyRadar: $('emptyRadar'),
    scanQrHeroBtn: $('scanQrHeroBtn'),
    joinRoomHeroBtn: $('joinRoomHeroBtn'),
    selectionBanner: $('selectionBanner'),
    selectedPeerName: $('selectedPeerName'),
    clearSelectionBtn: $('clearSelectionBtn'),
    dropzone: $('dropzone'),
    filePicker: $('filePicker'),
    pickFilesBtn: $('pickFilesBtn'),
    sendTextBtn: $('sendTextBtn'),
    dropOverlay: $('dropOverlay'),
    fileQueueCard: $('fileQueueCard'),
    queueList: $('queueList'),
    queueCount: $('queueCount'),
    queueTotalSize: $('queueTotalSize'),
    clearQueueBtn: $('clearQueueBtn'),
    sendBtn: $('sendBtn'),
    activeTxCard: $('activeTxCard'),
    txStatusBadge: $('txStatusBadge'),
    txTargetTitle: $('txTargetTitle'),
    cancelTxBtn: $('cancelTxBtn'),
    txProgressBar: $('txProgressBar'),
    txPercentText: $('txPercentText'),
    txStatsText: $('txStatsText'),
    txSpeedText: $('txSpeedText'),
    txEtaText: $('txEtaText'),
    txMethodBadge: $('txMethodBadge'),
    activeRxCard: $('activeRxCard'),
    rxStatusBadge: $('rxStatusBadge'),
    rxSenderTitle: $('rxSenderTitle'),
    rxProgressBar: $('rxProgressBar'),
    rxPercentText: $('rxPercentText'),
    rxStatsText: $('rxStatsText'),
    rxSpeedText: $('rxSpeedText'),
    rxFilesPreview: $('rxFilesPreview'),
    dismissRxBtn: $('dismissRxBtn'),
    historyList: $('historyList'),
    emptyHistory: $('emptyHistory'),
    clearHistoryBtn: $('clearHistoryBtn'),
    incomingModal: $('incomingModal'),
    incomingSenderName: $('incomingSenderName'),
    incomingFilesList: $('incomingFilesList'),
    incomingTotalCount: $('incomingTotalCount'),
    incomingTotalSize: $('incomingTotalSize'),
    rejectOfferBtn: $('rejectOfferBtn'),
    acceptOfferBtn: $('acceptOfferBtn'),
    qrModal: $('qrModal'),
    qrCanvas: $('qrCanvas'),
    shareUrlInput: $('shareUrlInput'),
    copyUrlBtn: $('copyUrlBtn'),
    qrRoomCodeText: $('qrRoomCodeText'),
    renameModal: $('renameModal'),
    renameInput: $('renameInput'),
    saveRenameBtn: $('saveRenameBtn'),
    roomModal: $('roomModal'),
    roomInput: $('roomInput'),
    joinRoomBtn: $('joinRoomBtn'),
    autoRoomBtn: $('autoRoomBtn'),
    sendTextModal: $('sendTextModal'),
    sendTextTargetName: $('sendTextTargetName'),
    textPayloadInput: $('textPayloadInput'),
    submitSendTextBtn: $('submitSendTextBtn'),
    incomingTextModal: $('incomingTextModal'),
    incomingTextSenderName: $('incomingTextSenderName'),
    receivedTextBox: $('receivedTextBox'),
    copyReceivedTextBtn: $('copyReceivedTextBtn'),
    toastContainer: $('toastContainer')
  };

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  function getUrlParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function getDeviceIcon(type) {
    switch (type) {
      case 'iphone':
      case 'mobile': return '📱';
      case 'ipad':
      case 'tablet': return '📟';
      case 'mac': return '💻';
      case 'windows': return '🖥️';
      case 'linux': return '🐧';
      default: return '💻';
    }
  }

  function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
    if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📕';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
    if (['doc', 'docx', 'txt', 'rtf', 'md'].includes(ext)) return '📄';
    if (['js', 'py', 'html', 'css', 'json', 'ts', 'c', 'cpp'].includes(ext)) return '💻';
    return '📁';
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // --------------------------------------------------------------------------
  // Theme Management
  // --------------------------------------------------------------------------
  function initTheme() {
    const saved = localStorage.getItem('ls_theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  }

  els.themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ls_theme', next);
  });

  // --------------------------------------------------------------------------
  // Server-Sent Events (SSE) & Registration
  // --------------------------------------------------------------------------
  async function registerPeer() {
    try {
      const resp = await fetch('/api/peers/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: state.myId,
          name: state.myName,
          room: state.myRoom
        })
      });
      const data = await resp.json();
      if (data.ok) {
        state.myId = data.peer.id;
        state.myName = data.peer.name;
        state.myRoom = data.room;
        state.deviceType = data.peer.device_type;
        state.serverIp = data.server_ip;
        state.serverPort = data.server_port;

        localStorage.setItem('ls_peer_name', state.myName);
        localStorage.setItem('ls_room', state.myRoom);

        updateIdentityUI();
        connectSSE();
        fetchState();
      }
    } catch (e) {
      console.warn('Peer registration error', e);
      setTimeout(registerPeer, 3000);
    }
  }

  function connectSSE() {
    if (state.sseSource) {
      state.sseSource.close();
    }

    const sse = new EventSource(`/api/events?peer_id=${encodeURIComponent(state.myId)}`);
    state.sseSource = sse;

    sse.addEventListener('connected', () => {
      els.connectionBadge.className = 'status-badge connected';
      els.connectionText.textContent = 'Connected';
    });

    sse.addEventListener('peer_joined', (e) => {
      const peer = JSON.parse(e.data);
      if (peer.id !== state.myId) {
        state.peers.set(peer.id, peer);
        renderPeers();
        showToast(`${peer.name} is nearby`, 'info');
      }
    });

    sse.addEventListener('peer_left', (e) => {
      const { id } = JSON.parse(e.data);
      if (state.peers.has(id)) {
        const p = state.peers.get(id);
        state.peers.delete(id);
        if (state.selectedPeerId === id) {
          clearSelection();
        }
        renderPeers();
      }
    });

    sse.addEventListener('peer_updated', (e) => {
      const peer = JSON.parse(e.data);
      if (peer.id !== state.myId) {
        state.peers.set(peer.id, peer);
        renderPeers();
      }
    });

    sse.addEventListener('offer_received', (e) => {
      const offer = JSON.parse(e.data);
      handleIncomingOffer(offer);
    });

    sse.addEventListener('signal', (e) => {
      const signal = JSON.parse(e.data);
      state.transferEngine.handleSignalingMessage(signal, (outSignal) => {
        sendSignalingPayload(outSignal);
      });
    });

    sse.addEventListener('text_message', (e) => {
      const msg = JSON.parse(e.data);
      handleIncomingText(msg);
    });

    sse.addEventListener('transfer_chunk', (e) => {
      const chunkInfo = JSON.parse(e.data);
      handleRelayChunkProgress(chunkInfo);
    });

    sse.addEventListener('transfer_completed', (e) => {
      const info = JSON.parse(e.data);
      handleTransferCompleted(info);
    });

    sse.onerror = () => {
      els.connectionBadge.className = 'status-badge';
      els.connectionText.textContent = 'Reconnecting…';
      setTimeout(() => {
        if (sse.readyState === EventSource.CLOSED) {
          connectSSE();
        }
      }, 3000);
    };
  }

  async function fetchState() {
    try {
      const resp = await fetch(`/api/state?room=${encodeURIComponent(state.myRoom)}&peer_id=${encodeURIComponent(state.myId)}`);
      const data = await resp.json();
      if (data.peers) {
        state.peers.clear();
        data.peers.forEach(p => state.peers.set(p.id, p));
        renderPeers();
      }
    } catch (e) {}
  }

  async function sendSignalingPayload(payload) {
    try {
      await fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn('Signaling error', e);
    }
  }

  // --------------------------------------------------------------------------
  // UI Rendering & Updates
  // --------------------------------------------------------------------------
  function updateIdentityUI() {
    els.myAvatar.textContent = getDeviceIcon(state.deviceType);
    els.myNameText.textContent = state.myName;
    els.currentRoomText.textContent = state.myRoom.toUpperCase();
    els.qrRoomCodeText.textContent = state.myRoom.toUpperCase();
    els.myMetaText.textContent = `Room: ${state.myRoom} · ID: ${state.myId.substring(0, 8)}`;
  }

  function renderPeers() {
    const list = Array.from(state.peers.values());
    els.peerCountBadge.textContent = `${list.length} found`;

    if (list.length === 0) {
      els.emptyRadar.style.display = 'block';
      els.peersGrid.style.display = 'none';
      return;
    }

    els.emptyRadar.style.display = 'none';
    els.peersGrid.style.display = 'grid';

    els.peersGrid.innerHTML = list.map((peer) => {
      const isSel = peer.id === state.selectedPeerId;
      const icon = getDeviceIcon(peer.device_type);
      const isUdp = peer.is_udp_peer;
      return `
        <div class="peer-card ${isSel ? 'selected' : ''}" data-peer-id="${escapeHtml(peer.id)}">
          ${isUdp ? '<span class="peer-badge">CLI Node</span>' : ''}
          <div class="peer-avatar">${icon}</div>
          <div class="peer-name" title="${escapeHtml(peer.name)}">${escapeHtml(peer.name)}</div>
          <div class="peer-meta">${escapeHtml(peer.ip)}</div>
        </div>
      `;
    }).join('');

    updateSelectionUI();
  }

  function selectPeer(peerId) {
    if (state.peers.has(peerId)) {
      state.selectedPeerId = peerId;
      renderPeers();
    }
  }

  function clearSelection() {
    state.selectedPeerId = null;
    renderPeers();
  }

  function updateSelectionUI() {
    const peer = state.peers.get(state.selectedPeerId);
    if (peer) {
      els.selectionBanner.style.display = 'flex';
      els.selectedPeerName.textContent = peer.name;
      els.sendBtn.textContent = `🚀 Send to ${peer.name}`;
      els.sendBtn.disabled = state.fileQueue.length === 0;
    } else {
      els.selectionBanner.style.display = 'none';
      els.sendBtn.textContent = '🚀 Select a Device Above to Send';
      els.sendBtn.disabled = true;
    }
  }

  // --------------------------------------------------------------------------
  // File Queue Management
  // --------------------------------------------------------------------------
  function addFilesToQueue(files) {
    for (const f of files) {
      state.fileQueue.push(f);
    }
    renderFileQueue();
  }

  function removeFileFromQueue(index) {
    state.fileQueue.splice(index, 1);
    renderFileQueue();
  }

  function clearFileQueue() {
    state.fileQueue = [];
    renderFileQueue();
  }

  function renderFileQueue() {
    if (state.fileQueue.length === 0) {
      els.fileQueueCard.style.display = 'none';
      updateSelectionUI();
      return;
    }

    els.fileQueueCard.style.display = 'block';
    els.queueCount.textContent = state.fileQueue.length;
    const totalSize = state.fileQueue.reduce((a, f) => a + f.size, 0);
    els.queueTotalSize.textContent = TransferEngine.formatBytes(totalSize);

    els.queueList.innerHTML = state.fileQueue.map((file, idx) => `
      <div class="queue-item">
        <div class="queue-item-info">
          <span class="file-type-icon">${getFileIcon(file.name)}</span>
          <span class="queue-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="queue-item-size">${TransferEngine.formatBytes(file.size)}</span>
        </div>
        <button class="remove-file-btn" data-index="${idx}" title="Remove file">×</button>
      </div>
    `).join('');

    updateSelectionUI();
  }

  // --------------------------------------------------------------------------
  // SEND FILE FLOW
  // --------------------------------------------------------------------------
  async function initiateSend() {
    const peer = state.peers.get(state.selectedPeerId);
    if (!peer || state.fileQueue.length === 0) return;

    const filesToSend = state.fileQueue.slice();
    const totalBytes = filesToSend.reduce((a, f) => a + f.size, 0);

    // Show active transfer card in waiting phase
    els.activeTxCard.style.display = 'block';
    els.txStatusBadge.textContent = 'Waiting';
    els.txTargetTitle.textContent = `Waiting for ${peer.name} to accept…`;
    els.txProgressBar.style.width = '0%';
    els.txPercentText.textContent = '0%';
    els.txStatsText.textContent = `0 B / ${TransferEngine.formatBytes(totalBytes)}`;
    els.txSpeedText.textContent = 'Waiting…';
    els.txEtaText.textContent = 'Offer sent to recipient';
    els.sendBtn.disabled = true;

    try {
      // Create Offer on Backend
      const offerResp = await fetch('/api/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_peer: state.myId,
          target_peer: peer.id,
          type: 'file',
          files: filesToSend.map(f => ({ name: f.name, size: f.size, type: f.type }))
        })
      });

      const offerData = await offerResp.json();
      if (!offerResp.ok) {
        throw new Error(offerData.error || 'Failed to create offer');
      }

      const offerId = offerData.offer.id;
      state.activeTx = { offerId, targetPeer: peer };

      // Poll/wait for offer response
      let offerStatus = 'pending';
      const pollStart = Date.now();
      while (offerStatus === 'pending') {
        if (!state.activeTx || state.activeTx.offerId !== offerId) return;
        await new Promise(r => setTimeout(r, 600));
        const statusResp = await fetch(`/api/offer/${offerId}`);
        const statusData = await statusResp.json();
        offerStatus = statusData.status;

        if (Date.now() - pollStart > 120000) {
          offerStatus = 'expired';
          break;
        }
      }

      if (offerStatus === 'rejected') {
        showToast(`${peer.name} declined the transfer request`, 'error');
        resetTxCard();
        return;
      }
      if (offerStatus !== 'accepted') {
        showToast(`Transfer request timed out with no response`, 'error');
        resetTxCard();
        return;
      }

      // Accepted! Begin streaming files
      els.txStatusBadge.textContent = 'Transferring';
      els.txTargetTitle.textContent = `Sending to ${peer.name}…`;

      await state.transferEngine.sendFiles(
        peer,
        offerId,
        filesToSend,
        // Progress callback
        (prog) => {
          const pct = Math.min(100, Math.floor((prog.done / prog.total) * 100));
          els.txProgressBar.style.width = pct + '%';
          els.txPercentText.textContent = pct + '%';
          els.txStatsText.textContent = `${TransferEngine.formatBytes(prog.done)} / ${TransferEngine.formatBytes(prog.total)}`;
          els.txSpeedText.textContent = TransferEngine.formatBytes(prog.speed) + '/s';
          els.txEtaText.textContent = TransferEngine.formatEta(prog.eta);
        },
        // Status mode callback
        (stat) => {
          if (stat.mode) els.txMethodBadge.textContent = stat.mode;
        },
        // WebRTC Signaling callback
        (sig) => {
          sendSignalingPayload(sig);
        }
      );

      // Completed successfully
      playChime('success');
      showToast(`Files sent successfully to ${peer.name}!`, 'success');
      addHistoryRecord({
        direction: 'sent',
        peerName: peer.name,
        files: filesToSend.map(f => f.name),
        totalSize: totalBytes,
        timestamp: Date.now()
      });

      clearFileQueue();
      resetTxCard();

    } catch (err) {
      console.error('Send error:', err);
      showToast(`Transfer error: ${err.message}`, 'error');
      resetTxCard();
    }
  }

  function resetTxCard() {
    els.activeTxCard.style.display = 'none';
    state.activeTx = null;
    updateSelectionUI();
  }

  // --------------------------------------------------------------------------
  // RECEIVE FILE FLOW
  // --------------------------------------------------------------------------
  function handleIncomingOffer(offer) {
    state.pendingIncomingOffer = offer;
    playChime('prompt');

    els.incomingSenderName.textContent = offer.from_name || 'Nearby Device';
    els.incomingTotalCount.textContent = `${offer.files.length} file(s)`;
    const totalSize = offer.files.reduce((a, f) => a + f.size, 0);
    els.incomingTotalSize.textContent = TransferEngine.formatBytes(totalSize);

    els.incomingFilesList.innerHTML = offer.files.map(f => `
      <div class="incoming-file-item">
        <span class="incoming-file-name">${getFileIcon(f.name)} ${escapeHtml(f.name)}</span>
        <span class="incoming-file-size">${TransferEngine.formatBytes(f.size)}</span>
      </div>
    `).join('');

    els.incomingModal.style.display = 'flex';
  }

  async function respondIncomingOffer(accept) {
    if (!state.pendingIncomingOffer) return;
    const offer = state.pendingIncomingOffer;
    state.pendingIncomingOffer = null;
    els.incomingModal.style.display = 'none';

    try {
      const resp = await fetch(`/api/offer/${offer.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept, use_relay: true })
      });
      const data = await resp.json();
      if (!resp.ok) {
        showToast(data.error || 'Failed to respond to offer', 'error');
        return;
      }

      if (accept) {
        // Prepare receiver UI
        els.activeRxCard.style.display = 'block';
        els.rxStatusBadge.textContent = 'Receiving';
        els.rxSenderTitle.textContent = `Receiving from ${offer.from_name}…`;
        els.rxProgressBar.style.width = '0%';
        els.rxPercentText.textContent = '0%';
        els.dismissRxBtn.style.display = 'none';

        // Listen on WebRTC DataChannel
        state.transferEngine.listenForIncomingDataChannel(
          offer.from_peer,
          offer,
          (prog) => {
            const pct = Math.min(100, Math.floor((prog.done / prog.total) * 100));
            els.rxProgressBar.style.width = pct + '%';
            els.rxPercentText.textContent = pct + '%';
            els.rxStatsText.textContent = `${TransferEngine.formatBytes(prog.done)} / ${TransferEngine.formatBytes(prog.total)}`;
            els.rxSpeedText.textContent = TransferEngine.formatBytes(prog.speed) + '/s';
          },
          (fileCompleted) => {
            showToast(`Received ${fileCompleted.name}`, 'success');
          },
          () => {
            playChime('success');
            els.rxStatusBadge.textContent = 'Done';
            els.rxProgressBar.style.width = '100%';
            els.rxPercentText.textContent = '100%';
            els.dismissRxBtn.style.display = 'inline-block';
            addHistoryRecord({
              direction: 'received',
              peerName: offer.from_name,
              files: offer.files.map(f => f.name),
              totalSize: offer.files.reduce((a, f) => a + f.size, 0),
              timestamp: Date.now()
            });
          }
        );
      }
    } catch (e) {
      showToast('Error responding to offer', 'error');
    }
  }

  function handleRelayChunkProgress(chunkInfo) {
    const pct = Math.min(100, Math.floor((chunkInfo.total_received / chunkInfo.total_size) * 100));
    els.rxProgressBar.style.width = pct + '%';
    els.rxPercentText.textContent = pct + '%';
    els.rxStatsText.textContent = `${TransferEngine.formatBytes(chunkInfo.total_received)} / ${TransferEngine.formatBytes(chunkInfo.total_size)}`;

    if (chunkInfo.is_last) {
      // Trigger download of this completed relayed file
      state.transferEngine.downloadRelayedFile(chunkInfo.offer_id, chunkInfo.file_idx, 'downloaded_file');
    }
  }

  function handleTransferCompleted(info) {
    playChime('success');
    els.rxStatusBadge.textContent = 'Done';
    els.rxProgressBar.style.width = '100%';
    els.rxPercentText.textContent = '100%';
    els.dismissRxBtn.style.display = 'inline-block';
  }

  // --------------------------------------------------------------------------
  // Instant Text Sharing Flow
  // --------------------------------------------------------------------------
  function openSendTextModal() {
    const peer = state.peers.get(state.selectedPeerId);
    if (!peer) {
      showToast('Please select a device first', 'info');
      return;
    }
    els.sendTextTargetName.textContent = peer.name;
    els.textPayloadInput.value = '';
    els.sendTextModal.style.display = 'flex';
    els.textPayloadInput.focus();
  }

  async function submitSendText() {
    const peer = state.peers.get(state.selectedPeerId);
    const text = els.textPayloadInput.value.trim();
    if (!peer || !text) return;

    try {
      const resp = await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_peer: state.myId,
          target_peer: peer.id,
          text
        })
      });
      if (resp.ok) {
        showToast(`Text message sent to ${peer.name}!`, 'success');
        els.sendTextModal.style.display = 'none';
      } else {
        showToast('Failed to send text', 'error');
      }
    } catch (e) {
      showToast('Error sending message', 'error');
    }
  }

  function handleIncomingText(msg) {
    playChime('prompt');
    els.incomingTextSenderName.textContent = msg.from_name;
    els.receivedTextBox.textContent = msg.text;
    els.incomingTextModal.style.display = 'flex';
  }

  // --------------------------------------------------------------------------
  // QR Code & Room Management
  // --------------------------------------------------------------------------
  function showQrModal() {
    let baseUrl = window.location.origin;
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocalhost && state.serverIp && state.serverIp !== '127.0.0.1') {
      baseUrl = `http://${state.serverIp}:${state.serverPort || window.location.port || 53317}`;
    }
    const shareUrl = `${baseUrl}/?room=${encodeURIComponent(state.myRoom)}`;
    els.shareUrlInput.value = shareUrl;
    els.qrModal.style.display = 'flex';
    if (window.QRCodeRenderer) {
      window.QRCodeRenderer.render(els.qrCanvas, shareUrl, { size: 200, margin: 2 });
    }
  }

  function joinCustomRoom(newRoom) {
    newRoom = (newRoom || '').trim().toLowerCase();
    if (!newRoom) return;
    state.myRoom = newRoom;
    localStorage.setItem('ls_room', newRoom);
    state.peers.clear();
    clearSelection();
    els.roomModal.style.display = 'none';
    registerPeer();
  }

  // --------------------------------------------------------------------------
  // History Drawer
  // --------------------------------------------------------------------------
  function addHistoryRecord(record) {
    state.history.unshift(record);
    if (state.history.length > 20) state.history.pop();
    localStorage.setItem('ls_history', JSON.stringify(state.history));
    renderHistory();
  }

  function renderHistory() {
    if (state.history.length === 0) {
      els.emptyHistory.style.display = 'flex';
      return;
    }
    els.emptyHistory.style.display = 'none';
    els.historyList.innerHTML = state.history.map(item => `
      <div class="history-item">
        <div class="history-item-left">
          <span class="history-status-icon">${item.direction === 'sent' ? '📤' : '📥'}</span>
          <div>
            <div class="history-file-name">${escapeHtml(item.files.join(', '))}</div>
            <div class="history-meta-sub">${item.direction === 'sent' ? 'To ' : 'From '} ${escapeHtml(item.peerName)} · ${TransferEngine.formatBytes(item.totalSize)}</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  // --------------------------------------------------------------------------
  // Event Bindings
  // --------------------------------------------------------------------------
  function bindEvents() {
    // Peers Grid Click
    els.peersGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.peer-card');
      if (card) {
        const peerId = card.dataset.peerId;
        selectPeer(peerId);
      }
    });

    els.clearSelectionBtn.addEventListener('click', clearSelection);

    // File Selection
    els.pickFilesBtn.addEventListener('click', () => els.filePicker.click());
    els.filePicker.addEventListener('change', (e) => {
      if (e.target.files.length) {
        addFilesToQueue(Array.from(e.target.files));
        e.target.value = '';
      }
    });

    els.clearQueueBtn.addEventListener('click', clearFileQueue);
    els.queueList.addEventListener('click', (e) => {
      const btn = e.target.closest('.remove-file-btn');
      if (btn) {
        removeFileFromQueue(parseInt(btn.dataset.index, 10));
      }
    });

    // Send Button
    els.sendBtn.addEventListener('click', initiateSend);

    // Full Window Drag & Drop Overlay
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      els.dropOverlay.classList.remove('hidden');
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        els.dropOverlay.classList.add('hidden');
      }
    });

    window.addEventListener('dragover', (e) => e.preventDefault());

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      els.dropOverlay.classList.add('hidden');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        addFilesToQueue(Array.from(e.dataTransfer.files));
      }
    });

    // Modals
    els.qrBtn.addEventListener('click', showQrModal);
    els.scanQrHeroBtn.addEventListener('click', showQrModal);
    els.copyUrlBtn.addEventListener('click', () => {
      els.shareUrlInput.select();
      navigator.clipboard.writeText(els.shareUrlInput.value);
      showToast('Link copied to clipboard!', 'success');
    });

    els.roomBtn.addEventListener('click', () => {
      els.roomInput.value = state.myRoom;
      els.roomModal.style.display = 'flex';
    });
    els.joinRoomHeroBtn.addEventListener('click', () => {
      els.roomInput.value = state.myRoom;
      els.roomModal.style.display = 'flex';
    });
    els.joinRoomBtn.addEventListener('click', () => joinCustomRoom(els.roomInput.value));
    els.autoRoomBtn.addEventListener('click', () => joinCustomRoom('local'));

    // Rename
    els.renameBtn.addEventListener('click', () => {
      els.renameInput.value = state.myName;
      els.renameModal.style.display = 'flex';
    });
    els.saveRenameBtn.addEventListener('click', async () => {
      const newName = els.renameInput.value.trim();
      if (!newName) return;
      try {
        const resp = await fetch('/api/peers/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.myId, name: newName })
        });
        if (resp.ok) {
          state.myName = newName;
          localStorage.setItem('ls_peer_name', newName);
          updateIdentityUI();
          els.renameModal.style.display = 'none';
          showToast('Device renamed successfully', 'success');
        }
      } catch (e) {}
    });

    // Offers
    els.acceptOfferBtn.addEventListener('click', () => respondIncomingOffer(true));
    els.rejectOfferBtn.addEventListener('click', () => respondIncomingOffer(false));

    // Text Sharing
    els.sendTextBtn.addEventListener('click', openSendTextModal);
    els.submitSendTextBtn.addEventListener('click', submitSendText);
    els.copyReceivedTextBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(els.receivedTextBox.textContent);
      showToast('Text copied to clipboard!', 'success');
    });

    // Cancel / Dismiss
    els.cancelTxBtn.addEventListener('click', () => {
      if (state.activeTx) {
        state.transferEngine.cancelTransfer(state.activeTx.offerId);
        fetch(`/api/offer/${state.activeTx.offerId}/cancel`, { method: 'POST' }).catch(() => {});
        resetTxCard();
        showToast('Transfer cancelled', 'info');
      }
    });

    els.dismissRxBtn.addEventListener('click', () => {
      els.activeRxCard.style.display = 'none';
    });

    els.refreshPeersBtn.addEventListener('click', () => {
      fetchState();
      showToast('Refreshed nearby devices', 'info');
    });

    els.clearHistoryBtn.addEventListener('click', () => {
      state.history = [];
      localStorage.setItem('ls_history', '[]');
      renderHistory();
    });

    // Close Modal backdrop clicks and [data-close]
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) {
        e.target.style.display = 'none';
      }
      const closeTarget = e.target.closest('[data-close]');
      if (closeTarget) {
        const modalId = closeTarget.dataset.close;
        const modal = $(modalId);
        if (modal) modal.style.display = 'none';
      }
    });
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  function init() {
    initTheme();
    bindEvents();
    renderHistory();
    registerPeer();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
