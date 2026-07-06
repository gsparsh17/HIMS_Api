const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/bulkImport.controller');
const { protect, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1
  }
});

// ============== TEMPLATES ==============
router.get(
  '/templates/:entity',
  protect,
  c.template
);

// ============== PREVIEW ==============
router.post(
  '/:entity/preview',
  protect,
  upload.single('file'),
  c.preview
);

// ============== HISTORY ==============
router.get(
  '/history',
  protect,
  c.history
);

// ============== ERRORS ==============
router.get(
  '/:jobId/errors',
  protect,
  c.errors
);

// ============== COMMIT ==============
router.post(
  '/:jobId/commit',
  protect,
  c.commit
);

// ============== ROLLBACK ==============
router.post(
  '/:jobId/rollback',
  protect,
  c.rollback
);

module.exports = router;