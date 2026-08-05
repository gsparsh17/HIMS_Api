const express = require('express');
const multer = require('multer');
const router = express.Router();
const c = require('../controllers/bulkImport.controller');
const { protect, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const view = requireModuleAccess('masters_settings', 'view');
const manage = requireModuleAccess('masters_settings', 'manage');

router.get('/templates/:entity', protect, view, c.template);
router.post('/:entity/preview', protect, manage, upload.single('file'), c.preview);
router.get('/history', protect, view, c.history);
router.get('/:jobId/errors', protect, view, c.errors);
router.post('/:jobId/commit', protect, manage, requireActionPermission('bulk_import_commit'), c.commit);
router.post('/:jobId/rollback', protect, manage, requireActionPermission('bulk_import_commit'), c.rollback);

module.exports = router;
