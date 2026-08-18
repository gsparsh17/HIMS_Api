const express = require('express');
const router = express.Router();
const {
  updateAppointmentStatus,
  addDoctorBreak,
  getDoctorDaySchedule,
  getHospitalCalendar,
  getDoctorCalendar,
  getTodayDoctorData,
  getDayData,
  initializeDay
} = require('../controllers/calendarController');

// // Book a slot
// router.patch('/book', bookSlot);

// // Cancel a booking
// router.patch('/cancel', cancelBooking);

// Update appointment status (Scheduled → InProgress → Completed → Cancelled)
router.patch('/appointment/status', updateAppointmentStatus);

// Add a doctor break
router.post('/doctor/break', addDoctorBreak);

// Static/specific routes must precede the parameterized date route.
// Otherwise `/today` is consumed as `:date` and never reaches getTodayDoctorData.
router.get('/:hospitalId/doctor/:doctorId/today', getTodayDoctorData);
router.get('/:hospitalId/day/:date', getDayData);
router.get('/:hospitalId/doctor/:doctorId/:date', getDoctorDaySchedule);

// Get full doctor's calendar across all days
router.get('/doctor/:doctorId', getDoctorCalendar);

// Get all calendar data for a hospital
router.get('/:hospitalId', getHospitalCalendar);

// Initialize a new day for hospital calendar
router.post('/initialize', initializeDay);

module.exports = router;
