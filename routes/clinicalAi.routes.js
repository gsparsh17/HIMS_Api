const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middlewares/auth');
const controller = require('../controllers/clinicalAi.controller');

const router = express.Router();

const clinicalAiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many clinical AI requests. Please try again shortly.' },
});

router.use(protect, clinicalAiLimiter);
router.post('/format-field', controller.formatField);
router.post('/parse-section', controller.parseSection);
router.post('/parse-orders', controller.parseOrders);

module.exports = router;
