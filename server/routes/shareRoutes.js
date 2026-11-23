const express = require('express');
const router = express.Router();
const shareController = require('../controllers/shareController');
const { handleUpload } = require('../middleware/uploadMiddleware');

// POST /api/share - Upload files and create a temporary share
router.post('/', handleUpload, (req, res) => shareController.createShare(req, res));

// GET /api/share/:shareId - Retrieve share metadata
router.get('/:shareId', (req, res) => shareController.getShare(req, res));

// GET /api/share/:shareId/file/:fileId - Download specific file
router.get('/:shareId/file/:fileId', (req, res) => shareController.downloadFile(req, res));

// GET /api/share/:shareId/download-all - Download all files as a streaming ZIP
router.get('/:shareId/download-all', (req, res) => shareController.downloadAll(req, res));

// DELETE /api/share/:shareId - Invalidate and delete share
router.delete('/:shareId', (req, res) => shareController.deleteShare(req, res));

module.exports = router;
