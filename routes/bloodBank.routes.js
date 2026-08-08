'use strict';

const express = require('express');
const c = require('../controllers/bloodBank.controller');

const router = express.Router();

// Donor management
router.post('/donors', c.registerDonor);
router.get('/donors', c.listDonors);

// Blood unit management
router.post('/units', c.addUnit);
router.get('/inventory', c.inventory);

// Component requests
router.post('/component-requests', c.requestComponents);
router.post('/component-requests/:id/dispatch', c.dispatch);

// UHI (Universal Health Interface) endpoints
router.get('/uhi/stock', c.uhiStock);
router.post('/uhi/stock-publish', c.publishUhiStock);
router.get('/uhi/history', c.uhiHistory);

module.exports = router;