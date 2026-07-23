const express = require('express');
const router = express.Router();
const hrController = require('../controllers/hr.controller');
const { protect, authorize, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

const hrAccess = [protect, authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'), requireModuleAccess('hr_staff', 'manage')];
const selfRoles = ['admin', 'mediqliq_super_admin', 'hr', 'hr_manager', 'doctor', 'nurse', 'staff', 'pharmacy', 'pathology_staff', 'radiology_staff', 'ot_staff', 'receptionist', 'registrar', 'store', 'store_manager', 'inventory_manager', 'accountant', 'insurance_desk', 'equipment_manager', 'bed_manager'];
const staffSelfAccess = [protect, authorize(...selfRoles)];

router.post('/auth/login', hrController.hrLogin);

// Employee-owned endpoints. The employee identity always comes from req.user.
router.get('/me', ...staffSelfAccess, hrController.getMe);
router.get('/me/attendance', ...staffSelfAccess, hrController.getMyAttendance);
router.post('/me/check-in', ...staffSelfAccess, hrController.myCheckIn);
router.post('/me/check-out', ...staffSelfAccess, hrController.myCheckOut);
router.get('/me/leaves', ...staffSelfAccess, hrController.getMyLeaves);
router.post('/me/leaves', ...staffSelfAccess, hrController.createMyLeave);
router.patch('/me/leaves/:id/cancel', ...staffSelfAccess, hrController.cancelMyLeave);
router.get('/me/leave-balances', ...staffSelfAccess, hrController.getMyLeaveBalances);
router.get('/me/payrolls', ...staffSelfAccess, hrController.getMyPayrolls);
router.get('/me/payrolls/:id/payslip', ...staffSelfAccess, hrController.downloadMyPayslip);
router.patch('/me/availability', ...staffSelfAccess, hrController.updateMyAvailability);

router.get('/dashboard', hrAccess, hrController.getDashboard);
router.post('/sync-profiles', hrAccess, hrController.syncHRProfiles);
router.post('/employees', hrAccess, hrController.createEmployee);
router.get('/employees', hrAccess, hrController.getEmployees);
router.get('/employees/:id', hrAccess, hrController.getEmployeeById);
router.put('/employees/:id', hrAccess, hrController.updateEmployee);
router.put('/employees/:id/login', hrAccess, hrController.setEmployeeLogin);
router.put('/employees/:id/deactivate', hrAccess, hrController.deactivateEmployee);
router.put('/employees/:id/salary', hrAccess, hrController.updateEmployeeSalaryConfig);

router.post('/attendance', hrAccess, hrController.markAttendance);
router.post('/attendance/bulk', hrAccess, hrController.bulkMarkAttendance);
router.get('/attendance', hrAccess, hrController.getAttendance);
// Legacy employee-ID endpoints are retained as explicit HR overrides only.
router.post('/attendance/:employeeId/check-in', hrAccess, hrController.checkIn);
router.post('/attendance/:employeeId/check-out', hrAccess, hrController.checkOut);
router.get('/availability', hrAccess, hrController.getAvailability);
router.post('/availability/:employeeId', hrAccess, hrController.setAvailability);
router.post('/leaves', hrAccess, hrController.createLeaveRequest);
router.get('/leaves', hrAccess, hrController.getLeaveRequests);
router.put('/leaves/:id/status', hrAccess, hrController.updateLeaveStatus);
router.get('/leave-balances', hrAccess, hrController.getLeaveBalances);
router.put('/leave-balances/:employeeId', hrAccess, hrController.upsertLeaveBalance);
router.post('/leave-balances', hrAccess, hrController.upsertLeaveBalance);
router.get('/payrolls', hrAccess, hrController.getPayrolls);
router.post('/payrolls/generate', hrAccess, hrController.generatePayroll);
router.put('/payrolls/:id', hrAccess, hrController.updatePayroll);
router.put('/payrolls/:id/clearance', hrAccess, hrController.updatePayrollClearance);
router.post('/payrolls/:id/publish', hrAccess, requireActionPermission('payroll_publish'), hrController.updatePayroll);
router.post('/payrolls/bulk-pay', hrAccess, hrController.bulkPayPayrolls);
router.get('/payrolls/pending-salaries', hrAccess, hrController.getPendingSalaries);
router.get('/payrolls/pending-commissions', hrAccess, hrController.getPendingCommissions);
router.post('/payrolls/create', hrAccess, hrController.createPayrollForEmployee);
module.exports = router;
