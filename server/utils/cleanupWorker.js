const config = require('../config');
const shareService = require('../services/shareService');

class CleanupWorker {
  constructor(intervalMs = config.cleanupIntervalMs) {
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    console.log(`[CleanupWorker] Started background worker (running every ${Math.round(this.intervalMs / 1000)}s)`);

    this.timer = setInterval(async () => {
      try {
        await shareService.cleanupExpiredShares();
      } catch (err) {
        console.error('[CleanupWorker] Error during automatic cleanup:', err);
      }
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[CleanupWorker] Background worker stopped');
    }
  }
}

module.exports = new CleanupWorker();
