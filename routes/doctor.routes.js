const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');
const { protect, authorize } = require('../middlewares/auth');

// Specific routes first.
router.post('/', doctorController.createDoctor);
router.post('/bulk-add', doctorController.bulkCreateDoctors);
router.get('/', doctorController.getAllDoctors);
router.get('/department/:departmentId', doctorController.getDoctorsByDepartmentId);

// Admin-only credential and main-feature access endpoints.
router.get('/:id/login-access', protect, authorize('admin', 'mediqliq_super_admin'), doctorController.getDoctorLoginAccess);
router.put('/:id/login-access', protect, authorize('admin', 'mediqliq_super_admin'), doctorController.updateDoctorLoginAccess);

router.get('/:id', doctorController.getDoctorById);
router.put('/:id', doctorController.updateDoctor);
router.delete('/:id', doctorController.deleteDoctor);

module.exports = router;
