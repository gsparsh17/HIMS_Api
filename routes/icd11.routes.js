const express = require('express');
const router = express.Router();
const multer = require('multer');
const { tempDir } = require('../config/upload.config');
const { authorize } = require('../middlewares/auth');
const upload = multer({ dest: tempDir, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
const {
  searchICD,
  getICDByCode,
  importICD11Data
} = require('../controllers/icd11.controller');

router.get('/search', searchICD);
router.get('/code/:code', getICDByCode);
router.post('/import', authorize('admin', 'mediqliq_super_admin'), upload.single('file'), importICD11Data);

module.exports = router;