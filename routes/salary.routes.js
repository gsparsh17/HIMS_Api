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
  generateSalaryPaymentReport,
  calculatePartTimeSalary,
  calculateAppointmentSalary
} = require('../controllers/salary.controller');

// Salary routes
router.get('/doctor/:doctorId', getDoctorSalaryHistory);
router.post('/calculate-appointment/:appointmentId', calculateAppointmentSalary);
router.get('/', getAllSalaries);
router.get('/pending', getPendingSalaries);
router.get('/report', generateSalaryPaymentReport);
router.put('/:id/status', updateSalaryStatus);
router.post('/bulk-calculate', bulkCalculateAndPayPartTimeSalaries);
router.post('/bulk-pay', bulkPaySalaries);
router.get('/stats', getSalaryStatistics);

module.exports = router;