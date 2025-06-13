const express = require('express');
const router = express.Router();
const controller = require('../controllers/labreport.controller');

router.post('/', controller.createLabReport);
router.get('/', controller.getAllLabReports);
router.get('/:id', controller.getReportById);
router.delete('/:id', controller.deleteReport);

module.exports = router;
