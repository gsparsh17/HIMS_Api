const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');

const {
  calculateHospitalRevenue,
  getDailyRevenueReport,
  getMonthlyRevenueReport,
  getDoctorRevenue,
  getDepartmentRevenue,
  getDetailedRevenueReport,
  exportRevenueData,
  exportOverview,
  exportDaily,
  exportMonthly,
  exportDoctor,
  exportDepartment,
  exportDetailed,
  getProcedureRevenueAnalytics,
  exportProcedureRevenue,
  getLabTestRevenueAnalytics,
  exportLabTestRevenue,
  getRadiologyRevenueAnalytics,
  exportRadiologyRevenue,
  getIpdRevenueAnalytics,
  exportIpdRevenue,
  getPharmacyRevenueAnalytics,
  exportPharmacyRevenue,
  getMedicineWiseRevenue,
  getPharmacyOutstandingReport
} = require('../controllers/revenue.controller');

/**
 * Legacy revenue endpoints are still used by IncomePage. They are retained for
 * UI compatibility, but now require a session and an authorised finance role.
 */
const reportUsers = ['admin', 'accountant', 'demo'];
const pharmacyReportUsers = ['admin', 'accountant', 'pharmacy', 'demo'];

router.use(protect);

router.get('/', authorize(...reportUsers), calculateHospitalRevenue);
router.get('/daily', authorize(...reportUsers), getDailyRevenueReport);
router.get('/monthly', authorize(...reportUsers), getMonthlyRevenueReport);
router.get('/doctor', authorize(...reportUsers), getDoctorRevenue);
router.get('/department', authorize(...reportUsers), getDepartmentRevenue);
router.get('/detailed', authorize(...reportUsers), getDetailedRevenueReport);

router.get('/procedures', authorize(...reportUsers), getProcedureRevenueAnalytics);
router.get('/labtests', authorize(...reportUsers), getLabTestRevenueAnalytics);
router.get('/radiology', authorize(...reportUsers), getRadiologyRevenueAnalytics);
router.get('/ipd', authorize(...reportUsers), getIpdRevenueAnalytics);

router.get('/pharmacy', authorize(...pharmacyReportUsers), getPharmacyRevenueAnalytics);
router.get('/pharmacy/medicines', authorize(...pharmacyReportUsers), getMedicineWiseRevenue);
router.get('/pharmacy/outstanding', authorize(...pharmacyReportUsers), getPharmacyOutstandingReport);

router.get('/export', authorize(...reportUsers), exportRevenueData);
router.get('/export/overview', authorize(...reportUsers), exportOverview);
router.get('/export/daily', authorize(...reportUsers), exportDaily);
router.get('/export/monthly', authorize(...reportUsers), exportMonthly);
router.get('/export/doctor', authorize(...reportUsers), exportDoctor);
router.get('/export/department', authorize(...reportUsers), exportDepartment);
router.get('/export/detailed', authorize(...reportUsers), exportDetailed);
router.get('/export/procedures', authorize(...reportUsers), exportProcedureRevenue);
router.get('/export/labtests', authorize(...reportUsers), exportLabTestRevenue);
router.get('/export/radiology', authorize(...reportUsers), exportRadiologyRevenue);
router.get('/export/ipd', authorize(...reportUsers), exportIpdRevenue);
router.get('/export/pharmacy', authorize(...pharmacyReportUsers), exportPharmacyRevenue);

module.exports = router;
