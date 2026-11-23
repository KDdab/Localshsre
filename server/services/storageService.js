const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * StorageService
 * Provides an abstract storage interface decoupled from the local filesystem.
 * Can later be swapped with AWS S3 / Cloudflare R2 / MinIO without modifying
 * controllers or share services.
 */
class StorageService {
  constructor(basePath = config.storagePath) {
    this.basePath = path.resolve(basePath);
    this.init();
  }

  /**
   * Initializes the storage directory if it doesn't already exist.
   */
  init() {
    try {
      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true });
      }
    } catch (err) {
      console.error('[StorageService] Failed to initialize storage directory:', err);
    }
  }

  /**
   * Resolves a stored filename safely, preventing directory traversal.
   * @param {string} storedName 
   * @returns {string} Absolute path
   */
  getSafePath(storedName) {
    const filename = path.basename(storedName);
    const resolvedPath = path.join(this.basePath, filename);
    if (!resolvedPath.startsWith(this.basePath)) {
      throw new Error('Invalid file path (directory traversal detected)');
    }
    return resolvedPath;
  }

  /**
   * Checks if a file exists in storage.
   * @param {string} storedName 
   * @returns {boolean}
   */
  exists(storedName) {
    try {
      const filePath = this.getSafePath(storedName);
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Returns a readable stream for the requested file.
   * Enables streaming downloads directly to client without buffering in RAM.
   * @param {string} storedName 
   * @returns {fs.ReadStream}
   */
  createReadStream(storedName) {
    const filePath = this.getSafePath(storedName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${storedName}`);
    }
    return fs.createReadStream(filePath);
  }

  /**
   * Retrieves file stat information (size, mtime, etc.).
   * @param {string} storedName 
   * @returns {fs.Stats}
   */
  getStats(storedName) {
    const filePath = this.getSafePath(storedName);
    return fs.statSync(filePath);
  }

  /**
   * Deletes a single file from storage.
   * @param {string} storedName 
   */
  async deleteFile(storedName) {
    try {
      const filePath = this.getSafePath(storedName);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (err) {
      console.warn(`[StorageService] Failed to delete ${storedName}:`, err.message);
    }
  }

  /**
   * Deletes a batch of files from storage.
   * @param {string[]} storedNames 
   */
  async deleteFiles(storedNames = []) {
    if (!Array.isArray(storedNames)) return;
    await Promise.all(storedNames.map(name => this.deleteFile(name)));
  }

  /**
   * Purges orphaned or expired files from the storage folder.
   * Any file in storage not present in activeStoredNames set is unlinked.
   * @param {Set<string>} activeStoredNames 
   */
  async purgeOrphanedFiles(activeStoredNames = new Set()) {
    try {
      if (!fs.existsSync(this.basePath)) return;
      const files = await fs.promises.readdir(this.basePath);
      for (const file of files) {
        if (!activeStoredNames.has(file)) {
          const filePath = path.join(this.basePath, file);
          try {
            await fs.promises.unlink(filePath);
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[StorageService] Error during orphan cleanup:', err.message);
    }
  }
}

module.exports = new StorageService();
