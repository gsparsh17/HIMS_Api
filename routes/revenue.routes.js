const express = require('express');
const router = express.Router();

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

  // ========== NEW RADIOLOGY ANALYTICS ==========
  getRadiologyRevenueAnalytics,
  exportRadiologyRevenue,

  // ========== NEW IPD ANALYTICS ==========
  getIpdRevenueAnalytics,
  exportIpdRevenue
} = require('../controllers/revenue.controller');

// ========== BASE REVENUE ROUTES ==========
router.get('/', calculateHospitalRevenue);          // Overview with all filters
router.get('/daily', getDailyRevenueReport);        // Daily report
router.get('/monthly', getMonthlyRevenueReport);    // Monthly report
router.get('/doctor', getDoctorRevenue);            // Doctor-wise revenue
router.get('/department', getDepartmentRevenue);    // Department-wise revenue
router.get('/detailed', getDetailedRevenueReport);  // Detailed transactions (paginated)

// ========== ANALYTICS ==========
router.get('/procedures', getProcedureRevenueAnalytics);
router.get('/labtests', getLabTestRevenueAnalytics);
router.get('/radiology', getRadiologyRevenueAnalytics);  // NEW
router.get('/ipd', getIpdRevenueAnalytics);               // NEW

// ========== EXPORT ROUTES ==========
router.get('/export', exportRevenueData);
router.get('/export/overview', exportOverview);
router.get('/export/daily', exportDaily);
router.get('/export/monthly', exportMonthly);
router.get('/export/doctor', exportDoctor);
router.get('/export/department', exportDepartment);
router.get('/export/detailed', exportDetailed);

router.get('/export/procedures', exportProcedureRevenue);
router.get('/export/labtests', exportLabTestRevenue);
router.get('/export/radiology', exportRadiologyRevenue);   // NEW
router.get('/export/ipd', exportIpdRevenue);               // NEW

module.exports = router;