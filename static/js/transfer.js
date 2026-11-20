/**
 * LocalShare Transfer Engine
 * Supports WebRTC P2P DataChannel transfers with automatic fallback to HTTP chunk relay.
 * Features backpressure management, real-time speed/ETA calculation, and native browser downloads.
 */
class TransferEngine {
  constructor(myPeerId, options = {}) {
    this.myPeerId = myPeerId;
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
    this.CHUNK_SIZE = 64 * 1024; // 64 KB per WebRTC message
    this.HTTP_CHUNK_SIZE = 512 * 1024; // 512 KB per HTTP relay chunk
    this.activeTransfers = new Map();
    this.peerConnections = new Map();
  }

  // Helper formatting methods
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 1) + ' ' + units[i];
  }

  static formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return 'Calculating…';
    if (seconds < 60) return `About ${Math.round(seconds)}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `About ${mins}m ${secs}s remaining`;
  }

  static triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // --------------------------------------------------------------------------
  // WebRTC Connection Setup & Signaling
  // --------------------------------------------------------------------------
  async getOrCreatePeerConnection(targetId, isInitiator, onSignal) {
    if (this.peerConnections.has(targetId)) {
      return this.peerConnections.get(targetId);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(targetId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate && onSignal) {
        onSignal({
          target_id: targetId,
          from_id: this.myPeerId,
          type: 'candidate',
          data: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.peerConnections.delete(targetId);
      }
    };

    return pc;
  }

  async handleSignalingMessage(signal, onSignal) {
    const { from_id, type, data } = signal;
    let pc = await this.getOrCreatePeerConnection(from_id, false, onSignal);

    if (type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (onSignal) {
        onSignal({
          target_id: from_id,
          from_id: this.myPeerId,
          type: 'answer',
          data: answer
        });
      }
    } else if (type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (type === 'candidate') {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data));
      } catch (e) {
        console.warn('ICE Candidate error', e);
      }
    }
  }

  // --------------------------------------------------------------------------
  // SENDER FLOW: Send Files
  // --------------------------------------------------------------------------
  async sendFiles(targetPeer, offerId, files, onProgress, onStatus, onSignal) {
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    const transferState = {
      offerId,
      targetId: targetPeer.id,
      files,
      totalBytes,
      sentBytes: 0,
      startTime: Date.now(),
      cancelled: false,
      channel: null,
      httpAbort: null
    };
    this.activeTransfers.set(offerId, transferState);

    onStatus({ phase: 'connecting', mode: 'p2p' });

    // Try WebRTC P2P first
    let p2pSuccess = false;
    try {
      const pc = await this.getOrCreatePeerConnection(targetPeer.id, true, onSignal);
      const dataChannel = pc.createDataChannel('fileTransfer_' + offerId, { ordered: true });
      dataChannel.binaryType = 'arraybuffer';
      transferState.channel = dataChannel;

      const channelReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('P2P Timeout')), 4500);
        dataChannel.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        dataChannel.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      onSignal({
        target_id: targetPeer.id,
        from_id: this.myPeerId,
        type: 'offer',
        data: offer
      });

      await channelReady;
      p2pSuccess = true;
      onStatus({ phase: 'transferring', mode: 'Direct P2P' });
      await this.streamFilesViaDataChannel(transferState, onProgress);

    } catch (err) {
      console.log('WebRTC connection not available, falling back to HTTP Chunk Relay', err);
    }

    // Fallback to HTTP Relay if WebRTC fails
    if (!p2pSuccess && !transferState.cancelled) {
      onStatus({ phase: 'transferring', mode: 'Relay Stream' });
      await this.streamFilesViaHttpRelay(transferState, onProgress);
    }

    if (!transferState.cancelled) {
      onStatus({ phase: 'done', totalBytes });
    }
  }

  async streamFilesViaDataChannel(transferState, onProgress) {
    const { channel, files, totalBytes } = transferState;
    channel.bufferedAmountLowThreshold = 256 * 1024; // 256 KB backpressure limit

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      if (transferState.cancelled) break;
      const file = files[fIdx];

      // Send file metadata header
      channel.send(JSON.stringify({
        type: 'file_start',
        fileIdx: fIdx,
        name: file.name,
        size: file.size,
        mime: file.type
      }));

      let offset = 0;
      while (offset < file.size) {
        if (transferState.cancelled) break;

        // Manage buffer backpressure
        if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
          await new Promise((resolve) => {
            channel.onbufferedamountlow = () => {
              channel.onbufferedamountlow = null;
              resolve();
            };
          });
        }

        const slice = file.slice(offset, offset + this.CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();
        channel.send(buffer);

        offset += buffer.byteLength;
        transferState.sentBytes += buffer.byteLength;

        const elapsed = (Date.now() - transferState.startTime) / 1000;
        const speed = transferState.sentBytes / Math.max(elapsed, 0.1);
        const remainingBytes = totalBytes - transferState.sentBytes;
        const eta = remainingBytes / Math.max(speed, 1);

        onProgress({
          done: transferState.sentBytes,
          total: totalBytes,
          speed,
          eta,
          currentFile: file.name,
          fileIndex: fIdx,
          fileCount: files.length
        });
      }

      channel.send(JSON.stringify({ type: 'file_end', fileIdx: fIdx }));
    }

    channel.send(JSON.stringify({ type: 'all_done' }));
  }

  async streamFilesViaHttpRelay(transferState, onProgress) {
    const { offerId, files, totalBytes } = transferState;

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      if (transferState.cancelled) break;
      const file = files[fIdx];
      let offset = 0;

      while (offset < file.size) {
        if (transferState.cancelled) break;
        const end = Math.min(offset + this.HTTP_CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);
        const isLast = end >= file.size;

        const controller = new AbortController();
        transferState.httpAbort = controller;

        const resp = await fetch(`/api/transfer/${offerId}/${fIdx}/chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Offset': String(offset),
            'X-Chunk-Last': isLast ? 'true' : 'false'
          },
          body: chunk,
          signal: controller.signal
        });

        if (!resp.ok) {
          throw new Error(`Upload failed with status ${resp.status}`);
        }

        const chunkLen = end - offset;
        offset = end;
        transferState.sentBytes += chunkLen;

        const elapsed = (Date.now() - transferState.startTime) / 1000;
        const speed = transferState.sentBytes / Math.max(elapsed, 0.1);
        const remainingBytes = totalBytes - transferState.sentBytes;
        const eta = remainingBytes / Math.max(speed, 1);

        onProgress({
          done: transferState.sentBytes,
          total: totalBytes,
          speed,
          eta,
          currentFile: file.name,
          fileIndex: fIdx,
          fileCount: files.length
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // RECEIVER FLOW: Receive Files
  // --------------------------------------------------------------------------
  listenForIncomingDataChannel(targetId, offer, onProgress, onFileComplete, onAllComplete) {
    const pcPromise = this.getOrCreatePeerConnection(targetId, false);
    pcPromise.then((pc) => {
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';

        let currentFileMeta = null;
        let receivedBuffers = [];
        let totalTransferred = 0;
        const totalSize = offer.files.reduce((a, f) => a + f.size, 0);
        const startTime = Date.now();

        channel.onmessage = (msgEvent) => {
          if (typeof msgEvent.data === 'string') {
            try {
              const meta = JSON.parse(msgEvent.data);
              if (meta.type === 'file_start') {
                currentFileMeta = meta;
                receivedBuffers = [];
              } else if (meta.type === 'file_end') {
                if (currentFileMeta) {
                  const blob = new Blob(receivedBuffers, { type: currentFileMeta.mime || 'application/octet-stream' });
                  TransferEngine.triggerDownload(blob, currentFileMeta.name);
                  onFileComplete({ name: currentFileMeta.name, size: currentFileMeta.size, blob });
                  currentFileMeta = null;
                  receivedBuffers = [];
                }
              } else if (meta.type === 'all_done') {
                onAllComplete();
              }
            } catch (e) {
              console.error('Error parsing channel message', e);
            }
          } else {
            // Binary Chunk
            receivedBuffers.push(msgEvent.data);
            totalTransferred += msgEvent.data.byteLength;

            const elapsed = (Date.now() - startTime) / 1000;
            const speed = totalTransferred / Math.max(elapsed, 0.1);
            onProgress({
              done: totalTransferred,
              total: totalSize,
              speed
            });
          }
        };
      };
    });
  }

  // Handle HTTP Relay file completion for receiver
  async downloadRelayedFile(offerId, fileIdx, filename) {
    const a = document.createElement('a');
    a.href = `/api/transfer/${offerId}/${fileIdx}/download`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 1000);
  }

  cancelTransfer(offerId) {
    const t = this.activeTransfers.get(offerId);
    if (t) {
      t.cancelled = true;
      if (t.channel) {
        try { t.channel.close(); } catch (e) {}
      }
      if (t.httpAbort) {
        try { t.httpAbort.abort(); } catch (e) {}
      }
      this.activeTransfers.delete(offerId);
    }
  }
}

window.TransferEngine = TransferEngine;
