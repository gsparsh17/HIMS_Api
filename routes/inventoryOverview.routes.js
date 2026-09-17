'use strict';

const express = require('express');
const router = express.Router();
const { protect, requireAnyModuleAccess } = require('../middlewares/auth');
const controller = require('../controllers/inventoryOverview.controller');

router.use(protect);
router.get(
  '/overview',
  requireAnyModuleAccess(['store_inventory', 'masters.medicine', 'pharmacy']),
  controller.getInventoryOverview
);

module.exports = router;
