const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staff.controller');

// Create
router.post('/', staffController.createStaff);

// Read
router.get('/', staffController.getAllStaff);
router.get('/:id', staffController.getStaffById);

// Update
router.put('/:id', staffController.updateStaff);

// Delete
router.delete('/:id', staffController.deleteStaff);

module.exports = router;
