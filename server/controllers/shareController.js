const shareService = require('../services/shareService');
const storageService = require('../services/storageService');
const fileService = require('../services/fileService');
const config = require('../config');

class ShareController {
  /**
   * Helper to construct canonical share URL
   */
  getShareUrl(req, shareId) {
    if (config.baseUrl) {
      return `${config.baseUrl.replace(/\/+$/, '')}/receive/${shareId}`;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.get('host');
    return `${protocol}://${host}/receive/${shareId}`;
  }

  /**
   * POST /api/share
   * Creates a new temporary share from uploaded files.
   */
  async createShare(req, res) {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Please select at least one file to upload.' });
      }

      const expirationMinutes = req.body.expirationMinutes || config.shareExpirationMinutes;
      const share = await shareService.createShare(req.files, expirationMinutes);
      const shareUrl = this.getShareUrl(req, share.shareId);

      return res.status(201).json({
        success: true,
        shareId: share.shareId,
        shareUrl: shareUrl,
        expiresAt: share.expiresAt,
        totalFiles: share.totalFiles,
        totalSize: share.totalSize,
        formattedTotalSize: fileService.formatBytes(share.totalSize),
        files: share.files.map(f => ({
          id: f.id,
          name: f.originalName,
          size: f.size,
          formattedSize: fileService.formatBytes(f.size),
          type: f.mimeType
        }))
      });
    } catch (err) {
      console.error('[ShareController] createShare error:', err);
      return res.status(500).json({ error: err.message || 'Failed to create file share.' });
    }
  }

  /**
   * GET /api/share/:shareId
   * Retrieves active share metadata.
   */
  getShare(req, res) {
    try {
      const { shareId } = req.params;
      const share = shareService.getShare(shareId);

      if (!share) {
        return res.status(404).json({
          error: 'Share not found or has expired. Please check the code.'
        });
      }

      return res.json({
        success: true,
        shareId: share.shareId,
        shareUrl: this.getShareUrl(req, share.shareId),
        totalFiles: share.totalFiles,
        totalSize: share.totalSize,
        formattedTotalSize: share.formattedTotalSize,
        expiresAt: share.expiresAt,
        remainingSeconds: share.remainingSeconds,
        files: share.files
      });
    } catch (err) {
      console.error('[ShareController] getShare error:', err);
      return res.status(500).json({ error: 'Internal server error retrieving share.' });
    }
  }

  /**
   * GET /api/share/:shareId/file/:fileId
   * Streams an individual file download.
   */
  downloadFile(req, res) {
    try {
      const { shareId, fileId } = req.params;
      const file = shareService.getFile(shareId, fileId);

      if (!file) {
        return res.status(404).json({ error: 'File not found or share has expired.' });
      }

      if (!storageService.exists(file.storedName)) {
        return res.status(404).json({ error: 'Stored file is missing.' });
      }

      const encodedFilename = encodeURIComponent(file.originalName);
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', file.size);
      res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);

      const readStream = storageService.createReadStream(file.storedName);
      readStream.on('error', (streamErr) => {
        console.error('[ShareController] Stream error:', streamErr);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error streaming file.' });
        }
      });

      readStream.pipe(res);
    } catch (err) {
      console.error('[ShareController] downloadFile error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file.' });
      }
    }
  }

  /**
   * GET /api/share/:shareId/download-all
   * Streams a ZIP archive containing all files in the share.
   */
  downloadAll(req, res) {
    try {
      const { shareId } = req.params;
      const share = shareService.getShare(shareId);

      if (!share) {
        return res.status(404).json({ error: 'Share not found or has expired.' });
      }

      const rawShare = shareService.shares.get(share.shareId);
      const zipName = `share-${share.shareId}.zip`;

      fileService.streamZipArchive(rawShare.files, res, zipName);
    } catch (err) {
      console.error('[ShareController] downloadAll error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate archive.' });
      }
    }
  }

  /**
   * DELETE /api/share/:shareId
   * Manually invalidates and deletes a share.
   */
  async deleteShare(req, res) {
    try {
      const { shareId } = req.params;
      const deleted = await shareService.deleteShare(shareId);

      if (!deleted) {
        return res.status(404).json({ error: 'Share not found or already deleted.' });
      }

      return res.json({ success: true, message: 'Share deleted successfully.' });
    } catch (err) {
      console.error('[ShareController] deleteShare error:', err);
      return res.status(500).json({ error: 'Failed to delete share.' });
    }
  }
}

module.exports = new ShareController();
