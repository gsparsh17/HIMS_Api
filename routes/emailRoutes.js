const express = require('express');
const router = express.Router();
const emailController = require('../controllers/emailController');
const { validateDemoRequest } = require('../middlewares/validation');
const rateLimit = require('express-rate-limit');

// Rate limiting: max 5 requests per IP per hour
const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { 
    success: false, 
    message: "Too many requests. Please try again after an hour." 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/send-demo-request', demoLimiter, validateDemoRequest, emailController.sendDemoRequest);
router.get('/health', emailController.healthCheck);

module.exports = router;