const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const controller = require('../controllers/supportTicket.controller');

router.post('/', protect, authorize('admin'), controller.submitSupportTicket);

module.exports = router;
