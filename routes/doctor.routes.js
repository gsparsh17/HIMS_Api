const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');

router.use(protect, requireModuleAccess('registration_opd'));
router.get('/', doctorController.getAllDoctors);
router.get('/department/:departmentId', doctorController.getDoctorsByDepartmentId);
router.get('/:id/login-access', authorize('admin', 'mediqliq_super_admin'), doctorController.getDoctorLoginAccess);
router.put('/:id/login-access', authorize('admin', 'mediqliq_super_admin'), doctorController.updateDoctorLoginAccess);
router.get('/:id', doctorController.getDoctorById);
router.post('/', authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'), doctorController.createDoctor);
router.post('/bulk-add', authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'), doctorController.bulkCreateDoctors);
router.put('/:id', authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'), doctorController.updateDoctor);
router.delete('/:id', authorize('admin', 'mediqliq_super_admin'), doctorController.deleteDoctor);
module.exports = router;
