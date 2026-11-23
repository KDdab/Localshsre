const config = require('../config');
const { generateShareId, generateFileId } = require('../utils/idGenerator');
const storageService = require('./storageService');
const fileService = require('./fileService');

class ShareService {
  constructor() {
    // In-memory Map: shareId -> shareData
    this.shares = new Map();
  }

  /**
   * Creates a new temporary share from uploaded files.
   * @param {Array} multerFiles - Array of Multer file objects
   * @param {number} expirationMinutes - Custom or default expiration in minutes
   * @returns {object} Created share metadata
   */
  async createShare(multerFiles, expirationMinutes = config.shareExpirationMinutes) {
    if (!multerFiles || multerFiles.length === 0) {
      throw new Error('No files provided for share');
    }

    const shareId = generateShareId(this.shares);
    const now = Date.now();
    const durationMinutes = Math.max(0.01, parseFloat(expirationMinutes) || config.shareExpirationMinutes);
    const durationMs = Math.round(durationMinutes * 60 * 1000);
    const expiresAt = new Date(now + durationMs);

    const files = multerFiles.map(file => ({
      id: generateFileId(),
      originalName: fileService.sanitizeFilename(file.originalname),
      storedName: file.filename,
      size: file.size,
      mimeType: file.mimetype || 'application/octet-stream'
    }));

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    const shareData = {
      shareId,
      files,
      totalSize,
      totalFiles: files.length,
      createdAt: new Date(now),
      expiresAt: expiresAt
    };

    this.shares.set(shareId, shareData);
    return shareData;
  }

  /**
   * Retrieves an active share by its ID.
   * If expired, automatically deletes the share and returns null.
   * @param {string} rawShareId 
   * @returns {object|null}
   */
  getShare(rawShareId) {
    if (!rawShareId || typeof rawShareId !== 'string') return null;
    const shareId = rawShareId.trim().toUpperCase();
    const share = this.shares.get(shareId);

    if (!share) return null;

    const now = Date.now();
    if (now >= new Date(share.expiresAt).getTime()) {
      // Lazy cleanup if accessed after expiration
      this.deleteShare(shareId);
      return null;
    }

    const remainingSeconds = Math.max(0, Math.floor((new Date(share.expiresAt).getTime() - now) / 1000));

    return {
      shareId: share.shareId,
      files: share.files.map(f => ({
        id: f.id,
        name: f.originalName,
        size: f.size,
        formattedSize: fileService.formatBytes(f.size),
        type: f.mimeType
      })),
      totalSize: share.totalSize,
      formattedTotalSize: fileService.formatBytes(share.totalSize),
      totalFiles: share.totalFiles,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      remainingSeconds
    };
  }

  /**
   * Retrieves file details for a specific file inside an active share.
   * @param {string} shareId 
   * @param {string} fileId 
   * @returns {object|null}
   */
  getFile(shareId, fileId) {
    const share = this.getShare(shareId);
    if (!share) return null;

    const rawShare = this.shares.get(share.shareId);
    const file = rawShare.files.find(f => f.id === fileId);
    return file || null;
  }

  /**
   * Deletes a share and removes all associated files from storage.
   * @param {string} rawShareId 
   * @returns {boolean}
   */
  async deleteShare(rawShareId) {
    if (!rawShareId) return false;
    const shareId = rawShareId.trim().toUpperCase();
    const share = this.shares.get(shareId);

    if (share) {
      const storedNames = share.files.map(f => f.storedName);
      await storageService.deleteFiles(storedNames);
      this.shares.delete(shareId);
      return true;
    }
    return false;
  }

  /**
   * Scans and purges all expired shares from memory and disk.
   * Invoked periodically by the cleanupWorker.
   * @returns {number} Count of removed shares
   */
  async cleanupExpiredShares() {
    const now = Date.now();
    let removedCount = 0;
    const activeStoredNames = new Set();

    for (const [shareId, share] of this.shares.entries()) {
      if (now >= new Date(share.expiresAt).getTime()) {
        const storedNames = share.files.map(f => f.storedName);
        await storageService.deleteFiles(storedNames);
        this.shares.delete(shareId);
        removedCount++;
      } else {
        // Collect active files
        share.files.forEach(f => activeStoredNames.add(f.storedName));
      }
    }

    // Clean up any unreferenced orphan files in storage directory
    await storageService.purgeOrphanedFiles(activeStoredNames);

    if (removedCount > 0) {
      console.log(`[ShareService] Cleaned up ${removedCount} expired share(s)`);
    }

    return removedCount;
  }
}

module.exports = new ShareService();
