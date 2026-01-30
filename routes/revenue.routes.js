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
  exportRevenueData
} = require('../controllers/revenue.controller');

// Revenue routes
router.get('/', calculateHospitalRevenue);        // Overview with all filters
router.get('/daily', getDailyRevenueReport);      // Daily report
router.get('/monthly', getMonthlyRevenueReport);  // Monthly report
router.get('/doctor', getDoctorRevenue);          // Doctor-wise revenue
router.get('/department', getDepartmentRevenue);  // Department-wise revenue
router.get('/detailed', getDetailedRevenueReport);// Detailed transactions (paginated)
router.get('/export', exportRevenueData);         // Export CSV/JSON

module.exports = router;
