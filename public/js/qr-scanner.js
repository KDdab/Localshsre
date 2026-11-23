/**
 * Camera QR Scanner Module
 * Uses native browser BarcodeDetector API when available,
 * with graceful permission error handling and manual code fallback.
 */
class QRScanner {
  constructor(videoElement, onScanSuccess, onScanError) {
    this.video = videoElement;
    this.onSuccess = onScanSuccess;
    this.onError = onScanError;
    this.stream = null;
    this.scanning = false;
    this.animationFrameId = null;
    this.barcodeDetector = null;

    if ('BarcodeDetector' in window) {
      try {
        this.barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
        this.barcodeDetector = null;
      }
    }
  }

  /**
   * Requests device camera stream and initiates scanning loop.
   */
  async start() {
    this.stop();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access is not supported by your browser.');
    }

    try {
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      await this.video.play();

      this.scanning = true;
      this.scanLoop();
    } catch (err) {
      console.warn('[QRScanner] Camera stream error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        throw new Error('Camera permission was denied. Please allow camera access or enter the share code manually.');
      }
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        throw new Error('No camera found on this device. Please enter the share code manually.');
      }
      throw new Error('Unable to access camera: ' + (err.message || 'Unknown error'));
    }
  }

  /**
   * Continuous scanning loop
   */
  async scanLoop() {
    if (!this.scanning || !this.video) return;

    if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
      if (this.barcodeDetector) {
        try {
          const barcodes = await this.barcodeDetector.detect(this.video);
          if (barcodes && barcodes.length > 0) {
            const rawValue = barcodes[0].rawValue;
            if (rawValue) {
              this.scanning = false;
              this.stop();
              if (this.onSuccess) this.onSuccess(rawValue);
              return;
            }
          }
        } catch (e) {
          // Frame detection transient error, continue scanning
        }
      }
    }

    if (this.scanning) {
      this.animationFrameId = requestAnimationFrame(() => this.scanLoop());
    }
  }

  /**
   * Stops video tracks and scanning loop
   */
  stop() {
    this.scanning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}

window.QRScanner = QRScanner;
