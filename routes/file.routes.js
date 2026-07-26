const express = require('express');
const { optionalAuth, protect } = require('../middlewares/auth');
const controller = require('../controllers/file.controller');

const router = express.Router();
router.get('/:fileId', optionalAuth, controller.streamFile);
router.delete('/:fileId', protect, controller.deleteFile);

module.exports = router;
