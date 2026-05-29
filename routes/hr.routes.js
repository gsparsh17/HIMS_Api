const express = require('express');
const router = express.Router();
const hrController = require('../controllers/hr.controller');
const { verifyToken, authorize } = require('../middlewares/auth');

const hrAccess = [verifyToken, authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager')];
const staffSelfAccess = [verifyToken, authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager', 'doctor', 'nurse', 'staff', 'pharmacy', 'pathology_staff', 'radiology_staff', 'ot_staff', 'receptionist', 'registrar', 'store', 'store_manager')];

router.post('/auth/login', hrController.hrLogin);

router.get('/dashboard', hrAccess, hrController.getDashboard);

router.post('/employees', hrAccess, hrController.createEmployee);
router.get('/employees', hrAccess, hrController.getEmployees);
router.get('/employees/:id', hrAccess, hrController.getEmployeeById);
router.put('/employees/:id', hrAccess, hrController.updateEmployee);
router.put('/employees/:id/login', hrAccess, hrController.setEmployeeLogin);
router.put('/employees/:id/deactivate', hrAccess, hrController.deactivateEmployee);

router.post('/attendance', hrAccess, hrController.markAttendance);
router.post('/attendance/bulk', hrAccess, hrController.bulkMarkAttendance);
router.get('/attendance', hrAccess, hrController.getAttendance);
router.post('/attendance/:employeeId/check-in', staffSelfAccess, hrController.checkIn);
router.post('/attendance/:employeeId/check-out', staffSelfAccess, hrController.checkOut);

router.get('/availability', staffSelfAccess, hrController.getAvailability);
router.post('/availability/:employeeId', staffSelfAccess, hrController.setAvailability);

router.post('/leaves', staffSelfAccess, hrController.createLeaveRequest);
router.get('/leaves', hrAccess, hrController.getLeaveRequests);
router.put('/leaves/:id/status', hrAccess, hrController.updateLeaveStatus);

module.exports = router;
