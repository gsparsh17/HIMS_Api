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
  requireModuleAccess('imports', 'view'),
  c.template
);

// ============== PREVIEW ==============
router.post(
  '/:entity/preview',
  protect,
  requireModuleAccess('imports', 'view'),
  upload.single('file'),
  c.preview
);

// ============== HISTORY ==============
router.get(
  '/history',
  protect,
  requireModuleAccess('imports', 'view'),
  c.history
);

// ============== ERRORS ==============
router.get(
  '/:jobId/errors',
  protect,
  requireModuleAccess('imports', 'view'),
  c.errors
);

// ============== COMMIT ==============
router.post(
  '/:jobId/commit',
  protect,
  requireModuleAccess('imports', 'edit'),
  requireActionPermission('bulk_import_commit'),
  c.commit
);

// ============== ROLLBACK ==============
router.post(
  '/:jobId/rollback',
  protect,
  requireModuleAccess('imports', 'edit'),
  requireActionPermission('bulk_import_commit'),
  c.rollback
);

module.exports = router;