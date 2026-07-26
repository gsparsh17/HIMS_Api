const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth');

const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');
const rateLimit = require('express-rate-limit');

// Configure Multer for disk storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error('Hospital logo must be a PNG, JPEG, or WebP image.'));
    }
    cb(null, true);
  }
});


const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_PER_15_MINUTES || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.PASSWORD_RECOVERY_RATE_LIMIT_PER_HOUR || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password recovery attempts. Please try again later.' }
});

router.post('/register', upload.single('logo'), authController.registerUser);
router.post('/login', loginLimiter, authController.loginUser);
router.post('/logout', authController.logoutUser);
router.get('/me', protect, authController.getCurrentUser);
router.post('/forgot-password', recoveryLimiter, authController.forgotPassword);
router.post('/reset-password/:token', recoveryLimiter, authController.resetPassword);

// Demo route - allows demo user to login as any staff member without password
router.post('/demo-login', loginLimiter, authController.demoLogin);

module.exports = router;