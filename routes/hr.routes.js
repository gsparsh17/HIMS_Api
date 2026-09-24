const express = require('express');
const router = express.Router();
const hrController = require('../controllers/hr.controller');
const hrDevelopment = require('../controllers/hrDevelopment.controller');
const { protect, authorize, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

// The employee's explicit HR module permission is authoritative. Role remains
// useful for defaults/professional identity, but it is not a ceiling on an
// administrator-delegated HR module grant.
const hrView = [protect, requireModuleAccess('hr_staff', 'view')];
const hrManage = [protect, requireModuleAccess('hr_staff', 'manage')];
const loginAccess = [...hrManage, requireActionPermission('user_access_manage')];
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

router.get('/dashboard', hrView, hrController.getDashboard);
router.post('/sync-profiles', hrManage, hrController.syncHRProfiles);
router.post('/employees', hrManage, hrController.createEmployee);
router.get('/employees', hrView, hrController.getEmployees);
router.get('/employees/options', hrView, hrController.getEmployeeOptions);
router.get('/employees/:id', hrView, hrController.getEmployeeById);
router.put('/employees/:id', hrManage, hrController.updateEmployee);
router.put('/employees/:id/login', loginAccess, hrController.setEmployeeLogin);
router.put('/employees/:id/deactivate', hrManage, hrController.deactivateEmployee);
router.put('/employees/:id/activate', hrManage, hrController.activateEmployee);
router.put('/employees/:id/salary', hrManage, hrController.updateEmployeeSalaryConfig);

router.post('/attendance', hrManage, hrController.markAttendance);
router.post('/attendance/bulk', hrManage, hrController.bulkMarkAttendance);
router.get('/attendance', hrView, hrController.getAttendance);
// Legacy employee-ID endpoints are retained as explicit HR overrides only.
router.post('/attendance/:employeeId/check-in', hrManage, hrController.checkIn);
router.post('/attendance/:employeeId/check-out', hrManage, hrController.checkOut);
router.get('/availability', hrView, hrController.getAvailability);
router.post('/availability/:employeeId', hrManage, hrController.setAvailability);
router.post('/leaves', hrManage, hrController.createLeaveRequest);
router.get('/leaves', hrView, hrController.getLeaveRequests);
router.put('/leaves/:id/status', hrManage, hrController.updateLeaveStatus);
router.get('/leave-balances', hrView, hrController.getLeaveBalances);
router.put('/leave-balances/:employeeId', hrManage, hrController.upsertLeaveBalance);
router.post('/leave-balances', hrManage, hrController.upsertLeaveBalance);
router.delete('/leave-balances/:id', hrManage, hrController.deleteLeaveBalance);
router.get('/payrolls', hrView, hrController.getPayrolls);
router.post('/payrolls/generate', hrManage, hrController.generatePayroll);
router.put('/payrolls/:id', hrManage, hrController.updatePayroll);
router.put('/payrolls/:id/clearance', hrManage, hrController.updatePayrollClearance);
router.post('/payrolls/:id/publish', hrManage, requireActionPermission('payroll_publish'), hrController.updatePayroll);
router.post('/payrolls/bulk-pay', hrManage, hrController.bulkPayPayrolls);
router.get('/payrolls/pending-salaries', hrView, hrController.getPendingSalaries);
router.get('/payrolls/pending-commissions', hrView, hrController.getPendingCommissions);
router.post('/payrolls/create', hrManage, hrController.createPayrollForEmployee);

// Development lifecycle additions that reuse HRStaffProfile as the staff master.
router.post('/appraisals', hrManage, hrDevelopment.appraisal);
router.get('/appraisals', hrView, hrDevelopment.appraisals);
router.post('/workflow-rules', hrManage, hrDevelopment.createRule);
router.post('/workflow-rules/:id/evaluate', hrManage, hrDevelopment.evaluateRule);
router.post('/inductions', hrManage, hrDevelopment.induction);
router.get('/inductions/report', hrView, hrDevelopment.inductionReport);
router.post('/training-events', hrManage, hrDevelopment.createTraining);
router.get('/training-events', hrView, hrDevelopment.listTraining);
router.put('/training-events/:id', hrManage, hrDevelopment.updateTraining);
router.delete('/training-events/:id', hrManage, hrDevelopment.cancelTraining);
router.post('/training-attendance', hrManage, hrDevelopment.attendance);
router.get('/training-reports', hrView, hrDevelopment.trainingReport);

module.exports = router;
