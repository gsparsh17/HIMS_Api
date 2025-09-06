const express = require('express');
const router = express.Router();
const {
  getDoctorSalaryHistory,
  getAllSalaries,
  updateSalaryStatus,
  getSalaryStatistics,
  bulkCalculateAndPayPartTimeSalaries,
  bulkPaySalaries,
  getPendingSalaries,
  generateSalaryPaymentReport
} = require('../controllers/salary.controller');

// Salary routes
router.get('/doctor/:doctorId', getDoctorSalaryHistory);
router.get('/', getAllSalaries);
router.get('/pending', getPendingSalaries);
router.get('/report', generateSalaryPaymentReport);
router.put('/:id/status', updateSalaryStatus);
router.post('/bulk-calculate', bulkCalculateAndPayPartTimeSalaries);
router.post('/bulk-pay', bulkPaySalaries);
router.get('/stats', getSalaryStatistics);

module.exports = router;