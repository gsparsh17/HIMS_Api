// jobs/calendarJob.js
const cron = require('node-cron');
const Calendar = require('../models/Calendar');
const Doctor = require('../models/Doctor');
const Hospital = require('../models/Hospital');
const { getShiftSlots, getPartTimeSlots } = require('../utils/calendarUtils');

async function updateCalendar() {
  console.log('🕒 Running calendar update...');

  const today = new Date();
  const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
  const hospitals = await Hospital.find();

  for (const hospital of hospitals) {
    let calendar = await Calendar.findOne({ hospitalId: hospital._id });
    if (!calendar) {
      calendar = new Calendar({ hospitalId: hospital._id, days: [] });
    }

    const dayExists = calendar.days.some(
      d => new Date(d.date).setHours(0, 0, 0, 0) === today.getTime()
    );

    if (dayExists) {
      console.log(`⚠️ Skipping ${hospital.name} — today's entry already exists`);
      continue; // move to next hospital
    }

    // Keep only latest 30 days
    if (calendar.days.length >= 30) {
      calendar.days.shift();
    }

    const doctors = await Doctor.find();
    const dayIndex = calendar.days.length;

    const doctorSlots = doctors
      .filter(doc => {
        if (doc.isFullTime === true) return true;
        if (doc.isFullTime === false) {
          return today >= new Date(doc.contractStartDate) && today <= new Date(doc.contractEndDate);
        }
        return false;
      })
      .map(doc => ({
        doctorId: doc._id,
        availableSlots:
          doc.isFullTime === true
            ? getShiftSlots(doc.shift, dayIndex)
            : getPartTimeSlots(doc.timeSlots),
        bookedSlots: []
      }));

    calendar.days.push({
      date: today,
      dayName,
      doctors: doctorSlots
    });

    await calendar.save();
  }

  console.log('✅ Calendar updated successfully!');
}

// Schedule the update to run every day at midnight
cron.schedule('0 0 * * *', updateCalendar);

module.exports = updateCalendar;
