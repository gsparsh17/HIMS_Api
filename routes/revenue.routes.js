// routes/revenue.routes.js
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
  exportProcedureRevenue
} = require('../controllers/revenue.controller');

// Revenue routes
router.get('/', calculateHospitalRevenue);          // Overview with all filters
router.get('/daily', getDailyRevenueReport);        // Daily report
router.get('/monthly', getMonthlyRevenueReport);    // Monthly report
router.get('/doctor', getDoctorRevenue);            // Doctor-wise revenue
router.get('/department', getDepartmentRevenue);    // Department-wise revenue
router.get('/detailed', getDetailedRevenueReport);  // Detailed transactions (paginated)

router.get('/procedures', getProcedureRevenueAnalytics);


// Export routes
router.get('/export', exportRevenueData);           // Main export (CSV/Excel/PDF/JSON)
router.get('/export/overview', exportOverview);     // Overview export
router.get('/export/daily', exportDaily);           // Daily export
router.get('/export/monthly', exportMonthly);       // Monthly export
router.get('/export/doctor', exportDoctor);         // Doctor export
router.get('/export/department', exportDepartment); // Department export
router.get('/export/detailed', exportDetailed);     // Detailed export
router.get('/export/procedures', exportProcedureRevenue);

module.exports = router;