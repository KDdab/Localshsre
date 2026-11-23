const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// Configure disk storage with cryptographically random filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.storagePath);
  },
  filename: (req, file, cb) => {
    const randomHex = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname).slice(0, 20) || '';
    cb(null, `${randomHex}${ext}`);
  }
});

// Create Multer instance with streaming limits
const upload = multer({
  storage: storage,
  limits: {
    fileSize: config.maxFileSize,
    files: 50 // Max 50 files per share
  }
});

/**
 * Express middleware wrapper to handle Multer upload errors cleanly
 */
function handleUpload(req, res, next) {
  const uploadHandler = upload.array('files', 50);

  uploadHandler(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: `File exceeds maximum allowed size (${Math.round(config.maxFileSize / (1024 * 1024))} MB)`
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            error: 'Too many files uploaded (maximum 50 files per share)'
          });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(500).json({ error: `Server upload failure: ${err.message}` });
    }
    next();
  });
}

module.exports = {
  handleUpload
};
