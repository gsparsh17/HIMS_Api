const express = require('express');
const multer = require('multer');
const router = express.Router();
const controller = require('../controllers/configurationImport.controller');
const { requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
const manage = requireModuleAccess('masters_settings', 'manage');
router.get('/templates/:entity', manage, controller.template);
router.post('/:entity/preview', manage, upload.single('file'), controller.preview);
router.post('/:jobId/commit', manage, requireActionPermission('bulk_import_commit'), controller.commit);
router.get('/history', manage, controller.history);
module.exports = router;
