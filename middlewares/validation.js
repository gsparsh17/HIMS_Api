const { body, validationResult } = require('express-validator');

const validateDemoRequest = [
  body('hospitalName')
    .trim()
    .notEmpty()
    .withMessage('Hospital name is required')
    .isLength({ min: 2, max: 200 })
    .withMessage('Hospital name must be between 2 and 200 characters'),
  
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s\-']+$/)
    .withMessage('Name can only contain letters, spaces, hyphens, and apostrophes'),
  
  body('whatsapp')
    .trim()
    .notEmpty()
    .withMessage('WhatsApp number is required')
    .matches(/^[+]?[0-9]{10,15}$/)
    .withMessage('Please provide a valid WhatsApp number with 10-15 digits'),
  
  body('city')
    .trim()
    .notEmpty()
    .withMessage('City is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('City name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s\-]+$/)
    .withMessage('City name can only contain letters, spaces, and hyphens'),
  
  body('pincode')
    .trim()
    .notEmpty()
    .withMessage('Pincode is required')
    .matches(/^[1-9][0-9]{5}$/)
    .withMessage('Please provide a valid 6-digit Indian pincode'),
  
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array(),
        message: 'Validation failed. Please check your inputs.'
      });
    }
    next();
  }
];

module.exports = { validateDemoRequest };