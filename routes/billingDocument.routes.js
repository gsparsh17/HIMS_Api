'use strict';

const express = require('express');
const c = require('../controllers/billingDocument.controller');

const router = express.Router();

// Print template routes
router.post('/templates', c.createTemplate);
router.get('/templates', c.listTemplates);

// Invoice duplication and printing
router.post('/invoices/:invoiceId/duplicate-print', c.duplicatePrint);

module.exports = router;