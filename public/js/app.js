/**
 * ShareLocal Client Application Controller
 * Handles SPA view routing, file drag-and-drop, streaming upload progress,
 * QR generation, camera QR scanning, share retrieval, and countdown timers.
 */
(function() {
  'use strict';

  // --------------------------------------------------------------------------
  // Application State
  // --------------------------------------------------------------------------
  const state = {
    currentView: 'landingView',
    selectedFiles: [],
    activeShare: null,
    countdownTimer: null,
    qrScannerInstance: null
  };

  // --------------------------------------------------------------------------
  // DOM Elements
  // --------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const views = {
    landingView: $('landingView'),
    senderView: $('senderView'),
    receiverView: $('receiverView'),
    downloadView: $('downloadView')
  };

  const els = {
    brandBtn: $('brandBtn'),
    themeToggleBtn: $('themeToggleBtn'),
    chooseSendBtn: $('chooseSendBtn'),
    chooseReceiveBtn: $('chooseReceiveBtn'),
    // Sender elements
    senderUploadStep: $('senderUploadStep'),
    senderResultStep: $('senderResultStep'),
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    browseFilesBtn: $('browseFilesBtn'),
    selectedFilesCard: $('selectedFilesCard'),
    selectedFilesList: $('selectedFilesList'),
    fileCountText: $('fileCountText'),
    totalSizeText: $('totalSizeText'),
    expirationSelect: $('expirationSelect'),
    clearFilesBtn: $('clearFilesBtn'),
    uploadAndShareBtn: $('uploadAndShareBtn'),
    uploadProgressWrap: $('uploadProgressWrap'),
    uploadProgressBar: $('uploadProgressBar'),
    uploadPercentText: $('uploadPercentText'),
    uploadStatusText: $('uploadStatusText'),
    // Result elements
    resultShareCode: $('resultShareCode'),
    resultQrCanvas: $('resultQrCanvas'),
    resultShareUrl: $('resultShareUrl'),
    copyCodeBtn: $('copyCodeBtn'),
    copyLinkBtn: $('copyLinkBtn'),
    downloadQrBtn: $('downloadQrBtn'),
    nativeShareBtn: $('nativeShareBtn'),
    createNewShareBtn: $('createNewShareBtn'),
    newShareTopBtn: $('newShareTopBtn'),
    shareExpiryNotice: $('shareExpiryNotice'),
    // Receiver elements
    tabEnterCode: $('tabEnterCode'),
    tabScanQr: $('tabScanQr'),
    contentEnterCode: $('contentEnterCode'),
    contentScanQr: $('contentScanQr'),
    findShareForm: $('findShareForm'),
    manualCodeInput: $('manualCodeInput'),
    findFilesBtn: $('findFilesBtn'),
    scannerVideo: $('scannerVideo'),
    scannerPrompt: $('scannerPrompt'),
    stopCameraBtn: $('stopCameraBtn'),
    // Download elements
    dlShareId: $('dlShareId'),
    dlTotalSummary: $('dlTotalSummary'),
    dlTotalSizeText: $('dlTotalSizeText'),
    countdownText: $('countdownText'),
    countdownBadge: $('countdownBadge'),
    downloadFilesList: $('downloadFilesList'),
    downloadAllBtn: $('downloadAllBtn'),
    toastContainer: $('toastContainer')
  };

  // --------------------------------------------------------------------------
  // Utility Helpers
  // --------------------------------------------------------------------------
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 1) + ' ' + units[i];
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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
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

  function extractShareCode(input) {
    if (!input || typeof input !== 'string') return '';
    let val = input.trim();
    // Check if user pasted a full URL like https://domain.com/receive/X7K92P
    const urlMatch = val.match(/\/receive\/([A-Za-z0-9]+)/i);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1].toUpperCase();
    }
    // Remove non-alphanumeric characters and uppercase
    return val.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  // --------------------------------------------------------------------------
  // Navigation & View Switching
  // --------------------------------------------------------------------------
  function showView(viewId) {
    // Stop camera if leaving receiver view
    if (state.currentView === 'receiverView' && viewId !== 'receiverView') {
      stopCameraScanner();
    }

    // Stop countdown timer if leaving download view
    if (state.currentView === 'downloadView' && viewId !== 'downloadView') {
      if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
      }
    }

    Object.keys(views).forEach((id) => {
      if (views[id]) {
        views[id].classList.toggle('active', id === viewId);
      }
    });

    state.currentView = viewId;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --------------------------------------------------------------------------
  // Theme Toggle
  // --------------------------------------------------------------------------
  function initTheme() {
    const savedTheme = localStorage.getItem('sl_theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  }

  els.themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('sl_theme', next);
  });

  // --------------------------------------------------------------------------
  // SENDER FLOW: File Selection & Queue
  // --------------------------------------------------------------------------
  function addFiles(files) {
    for (const f of files) {
      state.selectedFiles.push(f);
    }
    renderSelectedFiles();
  }

  function removeFile(index) {
    state.selectedFiles.splice(index, 1);
    renderSelectedFiles();
  }

  function clearSelectedFiles() {
    state.selectedFiles = [];
    els.fileInput.value = '';
    renderSelectedFiles();
  }

  function renderSelectedFiles() {
    if (state.selectedFiles.length === 0) {
      els.selectedFilesCard.style.display = 'none';
      return;
    }

    els.selectedFilesCard.style.display = 'block';
    els.fileCountText.textContent = state.selectedFiles.length;
    const totalBytes = state.selectedFiles.reduce((acc, f) => acc + f.size, 0);
    els.totalSizeText.textContent = formatBytes(totalBytes);

    els.selectedFilesList.innerHTML = state.selectedFiles.map((file, idx) => `
      <div class="file-row-item">
        <div class="file-info-group">
          <span class="file-glyph">${getFileIcon(file.name)}</span>
          <span class="file-name-text" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="file-size-text">${formatBytes(file.size)}</span>
        </div>
        <button type="button" class="remove-btn" data-remove-index="${idx}" title="Remove file">×</button>
      </div>
    `).join('');
  }

  // --------------------------------------------------------------------------
  // SENDER FLOW: Streaming Upload to Server
  // --------------------------------------------------------------------------
  function uploadFilesAndCreateShare() {
    if (state.selectedFiles.length === 0) {
      showToast('Please select at least one file to upload.', 'error');
      return;
    }

    const formData = new FormData();
    for (const f of state.selectedFiles) {
      formData.append('files', f);
    }
    formData.append('expirationMinutes', els.expirationSelect.value);

    // Prepare upload UI
    els.uploadProgressWrap.style.display = 'block';
    els.uploadProgressBar.style.width = '0%';
    els.uploadPercentText.textContent = '0%';
    els.uploadStatusText.textContent = 'Uploading files…';
    els.uploadAndShareBtn.disabled = true;
    els.clearFilesBtn.disabled = true;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/share', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
        els.uploadProgressBar.style.width = `${percent}%`;
        els.uploadPercentText.textContent = `${percent}%`;
        if (percent === 100) {
          els.uploadStatusText.textContent = 'Processing & generating share code…';
        }
      }
    };

    xhr.onload = () => {
      els.uploadAndShareBtn.disabled = false;
      els.clearFilesBtn.disabled = false;
      els.uploadProgressWrap.style.display = 'none';

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const resp = JSON.parse(xhr.responseText);
          showShareResult(resp);
          showToast('Share code & QR created successfully!', 'success');
        } catch (e) {
          showToast('Server returned an invalid response.', 'error');
        }
      } else {
        let errorMsg = 'Upload failed.';
        try {
          const errResp = JSON.parse(xhr.responseText);
          if (errResp.error) errorMsg = errResp.error;
        } catch {}
        showToast(errorMsg, 'error');
      }
    };

    xhr.onerror = () => {
      els.uploadAndShareBtn.disabled = false;
      els.clearFilesBtn.disabled = false;
      els.uploadProgressWrap.style.display = 'none';
      showToast('Network error during file upload. Please check connection.', 'error');
    };

    xhr.send(formData);
  }

  function showShareResult(data) {
    els.senderUploadStep.style.display = 'none';
    els.senderResultStep.style.display = 'block';

    els.resultShareCode.textContent = data.shareId;
    const shareUrl = `${window.location.origin}/receive/${data.shareId}`;
    els.resultShareUrl.value = shareUrl;

    // Render QR Code onto canvas
    if (window.QRCode && window.QRCode.toCanvas) {
      window.QRCode.toCanvas(els.resultQrCanvas, shareUrl, {
        width: 220,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      }, (err) => {
        if (err) console.error('[QRCode] Render error:', err);
      });
    } else if (window.QRGenerator) {
      window.QRGenerator.render(els.resultQrCanvas, shareUrl, { size: 220, margin: 2 });
    }

    const expMins = parseInt(els.expirationSelect.value, 10) || 30;
    els.shareExpiryNotice.innerHTML = `⏳ This share will automatically expire and be deleted in <strong>${expMins} minutes</strong>.`;

    // Show native share button if supported on mobile
    if (navigator.share) {
      els.nativeShareBtn.style.display = 'inline-flex';
    } else {
      els.nativeShareBtn.style.display = 'none';
    }

    clearSelectedFiles();
  }

  function resetSenderForm() {
    clearSelectedFiles();
    els.senderUploadStep.style.display = 'block';
    els.senderResultStep.style.display = 'none';
  }

  // --------------------------------------------------------------------------
  // RECEIVER FLOW: Find & Download Files
  // --------------------------------------------------------------------------
  async function findAndDisplayShare(rawCode) {
    const shareCode = extractShareCode(rawCode);
    if (!shareCode || shareCode.length < 4) {
      showToast('Please enter a valid share code.', 'error');
      return;
    }

    els.findFilesBtn.disabled = true;
    els.findFilesBtn.textContent = 'Searching…';

    try {
      const resp = await fetch(`/api/share/${encodeURIComponent(shareCode)}`);
      const data = await resp.json();

      els.findFilesBtn.disabled = false;
      els.findFilesBtn.textContent = '🔍 Find Files';

      if (!resp.ok) {
        showToast(data.error || 'Share not found or has expired.', 'error');
        return;
      }

      displayAvailableFiles(data);
    } catch (e) {
      els.findFilesBtn.disabled = false;
      els.findFilesBtn.textContent = '🔍 Find Files';
      showToast('Could not reach server to retrieve share.', 'error');
    }
  }

  function displayAvailableFiles(share) {
    state.activeShare = share;
    showView('downloadView');

    els.dlShareId.textContent = share.shareId;
    els.dlTotalSummary.textContent = `${share.totalFiles} file(s) available (${share.formattedTotalSize})`;
    els.dlTotalSizeText.textContent = share.formattedTotalSize;

    // Set Download All link
    els.downloadAllBtn.href = `/api/share/${encodeURIComponent(share.shareId)}/download-all`;

    // Render individual file download rows
    els.downloadFilesList.innerHTML = share.files.map((file) => `
      <div class="download-file-row">
        <div class="file-info-group">
          <span class="file-glyph">${getFileIcon(file.name)}</span>
          <span class="file-name-text" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="file-size-text">${escapeHtml(file.formattedSize)}</span>
        </div>
        <a href="/api/share/${encodeURIComponent(share.shareId)}/file/${encodeURIComponent(file.id)}" class="btn btn-small btn-secondary" download="${escapeHtml(file.name)}">
          ⬇ Download
        </a>
      </div>
    `).join('');

    // Start Live Countdown
    startCountdown(share.remainingSeconds);
  }

  function startCountdown(initialSeconds) {
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
    }

    let remaining = Math.max(0, initialSeconds);

    function updateDisplay() {
      if (remaining <= 0) {
        els.countdownText.textContent = 'Expired';
        els.countdownBadge.style.color = 'var(--danger)';
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        showToast('This share has expired. Files are no longer available.', 'error');
        return;
      }

      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      els.countdownText.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      remaining--;
    }

    updateDisplay();
    state.countdownTimer = setInterval(updateDisplay, 1000);
  }

  // --------------------------------------------------------------------------
  // Camera QR Scanner Flow
  // --------------------------------------------------------------------------
  function startCameraScanner() {
    if (!state.qrScannerInstance) {
      state.qrScannerInstance = new QRScanner(
        els.scannerVideo,
        (scannedText) => {
          showToast('QR Code detected!', 'success');
          stopCameraScanner();
          findAndDisplayShare(scannedText);
        },
        (err) => {
          els.scannerPrompt.textContent = err.message;
        }
      );
    }

    els.scannerPrompt.textContent = 'Point camera at sender\'s QR code';
    state.qrScannerInstance.start().catch((err) => {
      els.scannerPrompt.innerHTML = `<span style="color:var(--danger);">${escapeHtml(err.message)}</span>`;
      showToast(err.message, 'error');
    });
  }

  function stopCameraScanner() {
    if (state.qrScannerInstance) {
      state.qrScannerInstance.stop();
    }
  }

  // --------------------------------------------------------------------------
  // Event Bindings
  // --------------------------------------------------------------------------
  function bindEvents() {
    // Brand header button
    els.brandBtn.addEventListener('click', () => showView('landingView'));
    els.brandBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') showView('landingView');
    });

    // Landing choices
    els.chooseSendBtn.addEventListener('click', () => {
      resetSenderForm();
      showView('senderView');
    });
    els.chooseReceiveBtn.addEventListener('click', () => {
      showView('receiverView');
      switchReceiveTab('enterCode');
    });

    // Generic Back buttons
    document.querySelectorAll('[data-back]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetView = btn.dataset.back || 'landingView';
        showView(targetView);
      });
    });

    // Dropzone & File browse
    els.browseFilesBtn.addEventListener('click', () => els.fileInput.click());
    els.dropzone.addEventListener('click', (e) => {
      if (e.target !== els.browseFilesBtn) els.fileInput.click();
    });

    els.fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        addFiles(Array.from(e.target.files));
      }
    });

    // Drag and Drop
    ['dragenter', 'dragover'].forEach((eventName) => {
      els.dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        els.dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      els.dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        els.dropzone.classList.remove('dragover');
      });
    });

    els.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) {
        addFiles(Array.from(e.dataTransfer.files));
      }
    });

    // Selected files list: delete item
    els.selectedFilesList.addEventListener('click', (e) => {
      const rmBtn = e.target.closest('[data-remove-index]');
      if (rmBtn) {
        const idx = parseInt(rmBtn.dataset.removeIndex, 10);
        removeFile(idx);
      }
    });

    els.clearFilesBtn.addEventListener('click', clearSelectedFiles);
    els.uploadAndShareBtn.addEventListener('click', uploadFilesAndCreateShare);

    // Sender Result Actions
    els.copyCodeBtn.addEventListener('click', () => {
      const code = els.resultShareCode.textContent.trim();
      navigator.clipboard.writeText(code).then(() => {
        showToast('Share code copied to clipboard!', 'success');
      });
    });

    els.copyLinkBtn.addEventListener('click', () => {
      const link = els.resultShareUrl.value;
      navigator.clipboard.writeText(link).then(() => {
        showToast('Share link copied to clipboard!', 'success');
      });
    });

    els.downloadQrBtn.addEventListener('click', () => {
      const canvas = els.resultQrCanvas;
      const code = els.resultShareCode.textContent.trim() || 'share';
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `share-qr-${code}.png`;
      a.click();
    });

    els.nativeShareBtn.addEventListener('click', () => {
      const code = els.resultShareCode.textContent.trim();
      const link = els.resultShareUrl.value;
      if (navigator.share) {
        navigator.share({
          title: `ShareLocal File Transfer: ${code}`,
          text: `Download files with share code: ${code}`,
          url: link
        }).catch(() => {});
      }
    });

    els.createNewShareBtn.addEventListener('click', resetSenderForm);
    els.newShareTopBtn.addEventListener('click', resetSenderForm);

    // Receiver Tabs
    function switchReceiveTab(tab) {
      if (tab === 'enterCode') {
        els.tabEnterCode.classList.add('active');
        els.tabScanQr.classList.remove('active');
        els.contentEnterCode.classList.add('active');
        els.contentScanQr.classList.remove('active');
        stopCameraScanner();
        els.manualCodeInput.focus();
      } else {
        els.tabScanQr.classList.add('active');
        els.tabEnterCode.classList.remove('active');
        els.contentScanQr.classList.add('active');
        els.contentEnterCode.classList.remove('active');
        startCameraScanner();
      }
    }

    els.tabEnterCode.addEventListener('click', () => switchReceiveTab('enterCode'));
    els.tabScanQr.addEventListener('click', () => switchReceiveTab('scanQr'));
    els.stopCameraBtn.addEventListener('click', () => switchReceiveTab('enterCode'));

    // Upload QR Code Image File
    const uploadQrImageBtn = $('uploadQrImageBtn');
    const qrImageInput = $('qrImageInput');
    if (uploadQrImageBtn && qrImageInput) {
      uploadQrImageBtn.addEventListener('click', () => qrImageInput.click());
      qrImageInput.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files[0]) {
          const file = e.target.files[0];
          try {
            showToast('Scanning QR from image…', 'info');
            const decodedUrl = await QRScanner.scanImageFile(file);
            showToast('QR code detected successfully!', 'success');
            stopCameraScanner();
            findAndDisplayShare(decodedUrl);
          } catch (err) {
            showToast(err.message || 'No QR code found in the image', 'error');
          }
          e.target.value = '';
        }
      });
    }

    // Find Share Form
    els.findShareForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = els.manualCodeInput.value.trim();
      findAndDisplayShare(code);
    });

    // Check direct URL on initial load (e.g. /receive/X7K92P or ?receive=X7K92P)
    checkDirectUrlRouting();
  }

  function checkDirectUrlRouting() {
    const path = window.location.pathname;
    const match = path.match(/\/receive\/([A-Za-z0-9]+)/i);

    if (match && match[1]) {
      const code = match[1].toUpperCase();
      findAndDisplayShare(code);
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const queryCode = params.get('receive') || params.get('code');
    if (queryCode) {
      findAndDisplayShare(queryCode);
    }
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  function init() {
    initTheme();
    bindEvents();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
