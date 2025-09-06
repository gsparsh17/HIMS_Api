const express = require('express');
const router = express.Router();
const {
  calculateHospitalRevenue,
  getDailyRevenueReport,
  getMonthlyRevenueReport
} = require('../controllers/revenue.controller');

// Revenue routes
router.get('/', calculateHospitalRevenue);
router.get('/daily', getDailyRevenueReport);
router.get('/monthly', getMonthlyRevenueReport);

module.exports = router;