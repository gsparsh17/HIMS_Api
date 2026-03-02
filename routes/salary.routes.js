// routes/salary.routes.js  ✅ FULL UPDATED
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
  calculateAppointmentSalary
} = require('../controllers/salary.controller');

// Salary / Commission routes
router.get('/doctor/:doctorId', getDoctorSalaryHistory);

// Calculate commission for a single completed appointment (part-time doctors)
router.post('/calculate-appointment/:appointmentId', calculateAppointmentSalary);

// Lists
router.get('/pending', getPendingSalaries);
router.get('/report', generateSalaryPaymentReport);
router.get('/stats', getSalaryStatistics);
router.get('/', getAllSalaries);

// Actions
router.put('/:id/status', updateSalaryStatus);
router.post('/bulk-calculate', bulkCalculateAndPayPartTimeSalaries);
router.post('/bulk-pay', bulkPaySalaries);

module.exports = router;