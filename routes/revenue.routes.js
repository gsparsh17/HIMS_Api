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

// Enhanced revenue routes with detailed bifurcation
router.get('/', calculateHospitalRevenue); // Main overview with all filters
router.get('/daily', getDailyRevenueReport); // Daily detailed report
router.get('/monthly', getMonthlyRevenueReport); // Monthly detailed report
router.get('/doctor', getDoctorRevenue); // Doctor-wise revenue
router.get('/department', getDepartmentRevenue); // Department-wise revenue
router.get('/detailed', getDetailedRevenueReport); // Detailed transaction report
router.get('/export', exportRevenueData); // Export revenue data

module.exports = router;