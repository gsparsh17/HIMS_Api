'use strict';

const express = require('express');
const c = require('../controllers/financialCommunication.controller');

const router = express.Router();

// Payer notice management
router.post('/payer-notices', c.payerNotice);
router.get('/payer-notices', c.payerNotices);

// Claim notifications
router.post('/claims/:claimId/notify', c.notifyClaim);
router.get('/claims/:claimId/notifications', c.claimNotificationHistory);

// Payer reconciliation
router.post('/payer-reconciliation', c.payerReconciliation);

module.exports = router;