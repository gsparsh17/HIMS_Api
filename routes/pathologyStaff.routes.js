// routes/pathologyStaff.routes.js
const express = require('express');
const router = express.Router();
const pathologyStaffController = require('../controllers/pathologystaff.controller');

// Profile routes (for logged in staff)
router.get('/profile/me', pathologyStaffController.getMyProfile);
router.put('/profile/me', pathologyStaffController.updateMyProfile);

// Statistics route (keep before /:id routes)
router.get('/stats/overview', pathologyStaffController.getStaffStatistics);

// Get staff by role
router.get('/role/:role', pathologyStaffController.getStaffByRole);

// Password update route (specific action)
router.put('/:id/password', pathologyStaffController.updateStaffPassword);

// CRUD routes
router.route('/')
  .get(pathologyStaffController.getAllPathologyStaff)
  .post(pathologyStaffController.createPathologyStaff);

router.route('/:id')
  .get(pathologyStaffController.getPathologyStaffById)
  .put(pathologyStaffController.updatePathologyStaff)
  .delete(pathologyStaffController.deletePathologyStaff);

// Assign lab tests to staff
router.post('/:id/assign-tests', pathologyStaffController.assignLabTests);

// Update performance metrics
router.put('/:id/performance', pathologyStaffController.updatePerformanceMetrics);

module.exports = router;