const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middlewares/auth');
const controller = require('../controllers/auditLog.controller');

router.get('/', protect, isAdmin, controller.listHospitalAuditLogs);
router.get('/:auditLogId', protect, isAdmin, controller.getHospitalAuditLog);

module.exports = router;
