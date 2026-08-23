const express = require('express');
const router = express.Router();
const { protect, requirePrivilegedAction } = require('../middlewares/auth');
const controller = require('../controllers/auditLog.controller');

router.get('/', protect, requirePrivilegedAction('audit_log_view'), controller.listHospitalAuditLogs);
router.get('/:auditLogId', protect, requirePrivilegedAction('audit_log_view'), controller.getHospitalAuditLog);

module.exports = router;
