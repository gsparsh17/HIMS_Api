const express = require('express');
const router = express.Router();
const controller = require('../controllers/department.controller');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');

router.use(protect, requireModuleAccess('hr_staff'));
router.get('/', controller.getAllDepartments);
router.get('/hods/all', controller.getAllHods);
router.get('/id/:name', controller.getDepartmentIdByName);
router.get('/:id', controller.getDepartmentById);
router.get('/head/:headDoctorId', controller.getDepartmentsByHeadDoctor);
router.post('/', authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'), controller.createDepartment);
router.put('/:id', authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'), controller.updateDepartment);
router.delete('/:id', authorize('admin', 'mediqliq_super_admin'), controller.deleteDepartment);

module.exports = router;
