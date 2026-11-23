const path = require('path');
const archiver = require('archiver');
const storageService = require('./storageService');

class FileService {
  /**
   * Sanitizes user-provided filenames to prevent path traversal,
   * illegal characters, and hidden file exploits.
   * @param {string} rawName 
   * @returns {string} Sanitized filename
   */
  sanitizeFilename(rawName) {
    if (!rawName || typeof rawName !== 'string') return 'file';
    let clean = path.basename(rawName.replace(/\\/g, '/'));
    // Remove control characters, null bytes, and illegal characters
    clean = clean.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    // Prevent leading dots (hidden files)
    clean = clean.replace(/^\.+/, '');
    return clean.slice(0, 200) || 'file';
  }

  /**
   * Formats raw bytes into human-readable sizes (e.g. 12 MB, 84 KB).
   * @param {number} bytes 
   * @returns {string}
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 1) + ' ' + units[i];
  }

  /**
   * Streams a ZIP archive containing all files in the share directly to the response.
   * Uses streaming so the ZIP file is never written to disk or held in RAM.
   * @param {Array} filesList - Array of { originalName, storedName }
   * @param {object} res - Express HTTP response object
   * @param {string} zipFilename - Output name for Content-Disposition header
   */
  streamZipArchive(filesList, res, zipFilename = 'files.zip') {
    const archive = archiver('zip', {
      zlib: { level: 5 } // Balanced compression speed vs CPU
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFilename)}"`);

    archive.on('error', (err) => {
      console.error('[FileService] Archiver error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Archive packaging failed' });
      }
    });

    archive.pipe(res);

    for (const file of filesList) {
      if (storageService.exists(file.storedName)) {
        const fileStream = storageService.createReadStream(file.storedName);
        archive.append(fileStream, { name: file.originalName });
      }
    }

    archive.finalize();
  }
}

module.exports = new FileService();
