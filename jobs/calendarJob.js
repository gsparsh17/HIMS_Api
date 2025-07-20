const cron = require('node-cron');
const Calendar = require('../models/Calendar');
const Doctor = require('../models/Doctor');
const Hospital = require('../models/Hospital');
const { getShiftSlots, getPartTimeSlots } = require('../utils/calendarUtils');

cron.schedule('0 0 * * *', async () => {
  console.log('🕒 Running daily calendar update...');

  const today = new Date();
  const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
  const hospitals = await Hospital.find();

  for (const hospital of hospitals) {
    let calendar = await Calendar.findOne({ hospitalId: hospital._id });
    if (!calendar) {
      calendar = new Calendar({ hospitalId: hospital._id, days: [] });
    }

    if (calendar.days.length >= 30) {
      calendar.days.shift(); // Remove oldest day
    }

    const doctors = await Doctor.find({ hospitalId: hospital._id });
    const dayIndex = calendar.days.length;

    const doctorSlots = doctors
      .filter(doc => {
        if (doc.type === 'full-time') return true;
        if (doc.type === 'part-time') {
          return today >= new Date(doc.contractStartDate) && today <= new Date(doc.contractEndDate);
        }
        return false;
      })
      .map(doc => ({
        doctorId: doc._id,
        availableSlots: doc.type === 'full-time'
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
});
