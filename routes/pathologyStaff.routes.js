// routes/pathologyStaff.routes.js
const express = require('express');
const router = express.Router();
const pathologyStaffController = require('../controllers/pathologystaff.controller');
const { protect, authorize } = require('../middlewares/auth');
// ============== PUBLIC ROUTES (WITH PROTECTION) ==============
// All routes below require authentication
// router.use(protect);

// ============== PATHOLOGY STAFF ROUTES ==============
// Routes accessible by pathology staff themselves
router.get('/profile/me', authorize('pathology_staff'), pathologyStaffController.getMyProfile);
router.put('/profile/me', authorize('pathology_staff'), pathologyStaffController.updateMyProfile);
router.put('/change-password', authorize('pathology_staff'), pathologyStaffController.changePassword);

// ============== ADMIN ONLY ROUTES ==============
// All routes below require admin role
// router.use(authorize('admin'));

// Statistics route
router.get('/stats/overview', pathologyStaffController.getStaffStatistics);

// Get staff by role
router.get('/role/:role', pathologyStaffController.getStaffByRole);

// Password update route for admin to set staff passwords
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