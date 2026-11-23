const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const shareRoutes = require('./routes/shareRoutes');
const cleanupWorker = require('./utils/cleanupWorker');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// Mount API routes
app.use('/api/share', shareRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    maxFileSize: config.maxFileSize,
    shareExpirationMinutes: config.shareExpirationMinutes
  });
});

// SPA Route handling: /receive/:shareId serves index.html
app.get('/receive/:shareId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Fallback for any other page route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Start Server
const server = app.listen(config.port, config.host, () => {
  console.log('='.repeat(60));
  console.log(`  🚀 ShareLocal Web Server is Running!`);
  console.log(`  • Local URL  : http://localhost:${config.port}`);
  console.log(`  • Expiration : ${config.shareExpirationMinutes} minutes`);
  console.log(`  • Max Size   : ${Math.round(config.maxFileSize / (1024 * 1024))} MB`);
  console.log(`  • Storage    : ${config.storagePath}`);
  console.log('='.repeat(60));

  // Start periodic cleanup worker
  cleanupWorker.start();
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  cleanupWorker.stop();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  cleanupWorker.stop();
  server.close(() => process.exit(0));
});

module.exports = app;
