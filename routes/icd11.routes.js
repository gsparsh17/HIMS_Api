const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const {
  searchICD,
  getICDByCode,
  importICD11Data
} = require('../controllers/icd11.controller');

router.get('/search', searchICD);
router.get('/code/:code', getICDByCode);
router.post('/import', upload.single('file'), importICD11Data);

module.exports = router;