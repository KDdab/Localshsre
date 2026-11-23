/**
 * Camera QR Scanner Module
 * Dual-Engine:
 * 1. Native BarcodeDetector API (fastest, hardware accelerated on Android/Chrome/Edge/Safari 17+)
 * 2. jsQR software engine fallback (universal, works on 100% of browsers including desktop & older phones)
 * 3. Static image/screenshot file QR scanner
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

    // Off-screen canvas for frame capture with jsQR
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

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
      const videoWidth = this.video.videoWidth;
      const videoHeight = this.video.videoHeight;

      let detectedValue = null;

      // 1. Try Hardware BarcodeDetector first
      if (this.barcodeDetector) {
        try {
          const barcodes = await this.barcodeDetector.detect(this.video);
          if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
            detectedValue = barcodes[0].rawValue;
          }
        } catch (e) {}
      }

      // 2. If not detected yet and jsQR is available, decode video frame
      if (!detectedValue && window.jsQR && videoWidth > 0 && videoHeight > 0) {
        try {
          if (this.canvas.width !== videoWidth || this.canvas.height !== videoHeight) {
            this.canvas.width = videoWidth;
            this.canvas.height = videoHeight;
          }
          this.ctx.drawImage(this.video, 0, 0, videoWidth, videoHeight);
          const imageData = this.ctx.getImageData(0, 0, videoWidth, videoHeight);
          const qrCode = window.jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          });
          if (qrCode && qrCode.data) {
            detectedValue = qrCode.data;
          }
        } catch (e) {}
      }

      // If a code was successfully detected:
      if (detectedValue) {
        this.scanning = false;
        this.stop();
        if (this.onSuccess) this.onSuccess(detectedValue);
        return;
      }
    }

    if (this.scanning) {
      this.animationFrameId = requestAnimationFrame(() => this.scanLoop());
    }
  }

  /**
   * Decodes a QR code directly from an Image File or Blob.
   * Useful when camera permission is unavailable or user uploads a screenshot.
   * @param {File|Blob} file 
   * @returns {Promise<string>} Decoded QR code text
   */
  static scanImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!window.jsQR) {
        return reject(new Error('jsQR decoder engine is not loaded.'));
      }

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const qrCode = window.jsQR(imageData.data, imageData.width, imageData.height);
          if (qrCode && qrCode.data) {
            resolve(qrCode.data);
          } else {
            reject(new Error('No QR code could be found in the uploaded image.'));
          }
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(img.src);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        reject(new Error('Failed to load image file.'));
      };
      img.src = URL.createObjectURL(file);
    });
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
