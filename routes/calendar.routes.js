const express = require('express');
const router = express.Router();
const Calendar = require('../models/Calendar');
const { default: mongoose, Mongoose } = require('mongoose');

// Book a slot
router.patch('/book', async (req, res) => {
  try {
    const { hospitalId, date, doctorId, slot } = req.body;
    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === date);
    if (!day) return res.status(404).json({ message: 'Date not found' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });

    if (!doctor.availableSlots.includes(slot)) {
      return res.status(400).json({ message: 'Slot not available' });
    }

    doctor.availableSlots = doctor.availableSlots.filter(s => s !== slot);
    doctor.bookedSlots.push(slot);

    await calendar.save();
    res.json({ message: 'Slot booked successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Cancel a booking
router.patch('/cancel', async (req, res) => {
  try {
    const { hospitalId, date, doctorId, slot } = req.body;
    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === date);
    if (!day) return res.status(404).json({ message: 'Date not found' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });

    if (!doctor.bookedSlots.includes(slot)) {
      return res.status(400).json({ message: 'Slot not booked' });
    }

    doctor.bookedSlots = doctor.bookedSlots.filter(s => s !== slot);
    doctor.availableSlots.push(slot);

    await calendar.save();
    res.json({ message: 'Booking cancelled successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get full doctor's calendar across all days
// router.get('/doctor/:doctorId', async (req, res) => {
//   try {
//     const { doctorId } = req.params;

//     // Find all calendars where this doctor is scheduled
//     const calendars = await Calendar.find({
//       'days.doctors.doctorId': new mongoose.Types.ObjectId(doctorId)
//     }).populate('days.doctors.doctorId');

//     if (!calendars || calendars.length === 0) {
//       return res.status(404).json({ message: 'No calendar found for this doctor' });
//     }

//     console.log("doctorId param:", doctorId);
// console.log("Calendars found:", calendars.length);
// calendars.forEach(c => {
//   console.log("Hospital:", c.hospitalId);
//   c.days.forEach(d => {
//     console.log("Date:", d.date, "Doctors:", d.doctors.map(doc => doc.doctorId));
//   });
// });
// Extract only days for this doctor
//     const doctorSchedule = calendars.map(calendar => ({
//       hospitalId: calendar.hospitalId,
//       days: calendar.days
//         .filter(day => day.doctors.some(doc => doc.doctorId.toString() === doctorId))
//         .map(day => ({
//           date: day.date,
//           dayName: day.dayName,
//           doctor: day.doctors.find(doc => doc.doctorId.toString() === doctorId)
//         }))
//     }));
//     res.json(doctorSchedule);
//   } catch (err) {
//     res.status(500).json({ message: err.message });
//   }
// });

router.get('/doctor/:doctorId', async (req, res) => {
  try {
    const { doctorId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ message: 'Invalid doctorId format' });
    }

    console.log(doctorId)
    console.log(new mongoose.Types.ObjectId(doctorId))

    const calendars = await Calendar.find({
      'days.doctors.doctorId': new mongoose.Types.ObjectId(doctorId)
    }).populate('days.doctors.doctorId');

    if (!calendars.length) {
      return res.status(404).json({ message: 'No calendar found for this doctor' });
    }

    const doctorSchedule = calendars.map(calendar => ({
      hospitalId: calendar.hospitalId,
      days: calendar.days
        // Optional: keep all days instead of filtering
        .map(day => ({
          date: day.date,
          dayName: day.dayName,
          doctor: day.doctors.find(doc => {
      const id = doc.doctorId?._id || doc.doctorId; // works for populated & unpopulated
      return id.toString() === doctorId;
    }) || null
  }))
    }));

    res.json(doctorSchedule);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// GET all calendar data for a hospital
router.get('/:hospitalId', async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const calendar = await Calendar.findOne({ hospitalId }).populate('days.doctors.doctorId');
    res.json(calendar);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:hospitalId/doctor/:doctorId', async (req, res) => {
  try {
    const { hospitalId, doctorId } = req.params;

    const today = new Date().toISOString().split('T')[0]; // "2025-07-20"
    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

    const todayData = calendar.days.find(d => d.date.toISOString().split('T')[0] === today);
    if (!todayData) return res.status(404).json({ message: 'No data for today' });

    const doctorData = todayData.doctors.find(d => d.doctorId.toString() === doctorId);
    if (!doctorData) return res.status(404).json({ message: 'Doctor not available today' });

    res.json(doctorData);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET specific day
router.get('/:hospitalId/:date', async (req, res) => {
  try {
    const { hospitalId, date } = req.params;
    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

    const dayData = calendar.days.find(d => d.date.toISOString().split('T')[0] === date);
    res.json(dayData || { message: 'No data for this date' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
