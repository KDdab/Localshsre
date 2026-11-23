const path = require('path');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || '',
  shareExpirationMinutes: parseInt(process.env.SHARE_EXPIRATION_MINUTES, 10) || 30,
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 500 * 1024 * 1024, // 500 MB default
  storagePath: path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '../uploads')),
  cleanupIntervalMs: (parseInt(process.env.CLEANUP_INTERVAL_MINUTES, 10) || 2) * 60 * 1000
};

module.exports = config;
