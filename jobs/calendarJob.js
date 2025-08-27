// jobs/calendarJob.js
// const cron = require('node-cron');
// const Calendar = require('../models/Calendar');
// const Doctor = require('../models/Doctor');
// const Hospital = require('../models/Hospital');
// const { getShiftSlots, getPartTimeSlots } = require('../utils/calendarUtils');

// async function updateCalendar() {
//   console.log('🕒 Running calendar update...');

//   const today = new Date();
//   const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
//   const hospitals = await Hospital.find();

//   for (const hospital of hospitals) {
//     let calendar = await Calendar.findOne({ hospitalId: hospital._id });
//     if (!calendar) {
//       calendar = new Calendar({ hospitalId: hospital._id, days: [] });
//     }

//     const dayExists = calendar.days.some(
//       d => new Date(d.date).setHours(0, 0, 0, 0) === today.getTime()
//     );

//     if (dayExists) {
//       console.log(`⚠️ Skipping ${hospital.name} — today's entry already exists`);
//       continue; // move to next hospital
//     }

//     // Keep only latest 30 days
//     if (calendar.days.length >= 30) {
//       calendar.days.shift();
//     }

//     const doctors = await Doctor.find();
//     const dayIndex = calendar.days.length;

//     const doctorSlots = doctors
//       .filter(doc => {
//         if (doc.isFullTime === true) return true;
//         if (doc.isFullTime === false) {
//           return today >= new Date(doc.contractStartDate) && today <= new Date(doc.contractEndDate);
//         }
//         return false;
//       })
//       .map(doc => ({
//         doctorId: doc._id,
//         availableSlots:
//           doc.isFullTime === true
//             ? getShiftSlots(doc.shift, dayIndex)
//             : getPartTimeSlots(doc.timeSlots),
//         bookedSlots: []
//       }));

//     calendar.days.push({
//       date: today,
//       dayName,
//       doctors: doctorSlots
//     });

//     await calendar.save();
//   }

//   console.log('✅ Calendar updated successfully!');
// }

// // Schedule the update to run every day at midnight
// cron.schedule('0 0 * * *', updateCalendar);

// module.exports = updateCalendar;

const cron = require('node-cron');
const Calendar = require('../models/Calendar');
const Doctor = require('../models/Doctor');
const Hospital = require('../models/Hospital');
const { getShiftTimeRange, getPartTimeRanges } = require('../utils/calendarUtils');

let isUpdating = false;

async function updateCalendar() {
  // Prevent concurrent execution
  if (isUpdating) {
    console.log('⏸️ Calendar update already in progress, skipping...');
    return;
  }

  isUpdating = true;
  console.log('🕒 Running calendar update...');

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const hospitals = await Hospital.find();

    for (const hospital of hospitals) {
      // Use findOneAndUpdate with versioning to avoid conflicts
      let calendar = await Calendar.findOne({ hospitalId: hospital._id });
      if (!calendar) {
        calendar = new Calendar({ hospitalId: hospital._id, days: [] });
        await calendar.save();
      }

      // Generate dates for previous 15 days and next 15 days
      const datesToUpdate = [];
      for (let i = -15; i <= 15; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        date.setHours(0, 0, 0, 0);
        datesToUpdate.push(date);
      }

      const doctors = await Doctor.find();
      let needsUpdate = false;

      for (const targetDate of datesToUpdate) {
        const dateStr = targetDate.toISOString().split('T')[0];
        const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
        
        // Check if this date already exists in calendar
        const existingDayIndex = calendar.days.findIndex(
          d => d.date.toISOString().split('T')[0] === dateStr
        );

        if (existingDayIndex !== -1) {
          console.log(`✅ ${hospital.name} — ${dateStr} already exists`);
          continue;
        }

        console.log(`➕ ${hospital.name} — Adding ${dateStr} to calendar`);
        needsUpdate = true;

        const dayIndex = calendar.days.length;

        const doctorEntries = doctors
          .filter(doc => {
            if (doc.isFullTime) return true;
            if (!doc.isFullTime) {
              return targetDate >= new Date(doc.contractStartDate) &&
                     targetDate <= new Date(doc.contractEndDate);
            }
            return false;
          })
          .map(doc => {
            let shifts = [];

            if (doc.isFullTime) {
              const range = getShiftTimeRange(doc.shift, dayIndex, targetDate);
              if (range) shifts.push(range);
            } else {
              shifts = getPartTimeRanges(doc.timeSlots, targetDate);
            }

            return {
              doctorId: doc._id,
              // bookedAppointments: shifts.map(s => ({
              //   startTime: s.startTime,
              //   endTime: s.endTime,
              //   duration: s.duration,
              //   status: 'Available'
              // })),
              bookedAppointments: [],
              bookedPatients: [],
              breaks: []
            };
          });

        // Add new day to calendar
        calendar.days.push({
          date: targetDate,
          dayName,
          doctors: doctorEntries
        });
      }

      if (needsUpdate) {
        // Remove days older than 15 days before today and newer than 15 days after today
        calendar.days = calendar.days.filter(day => {
          const dayDate = new Date(day.date);
          const diffDays = Math.floor((dayDate - today) / (1000 * 60 * 60 * 24));
          return diffDays >= -15 && diffDays <= 15;
        });

        // Sort days by date
        calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));

        // Use findOneAndUpdate to handle version conflicts
        await Calendar.findOneAndUpdate(
          { _id: calendar._id },
          { $set: { days: calendar.days } },
          { new: true }
        );
        
        console.log(`✅ ${hospital.name} — Calendar updated with 30-day rolling window`);
      } else {
        console.log(`✅ ${hospital.name} — No updates needed`);
      }
    }

    console.log('✅ All hospital calendars updated successfully!');
  } catch (err) {
    console.error('❌ Error updating calendar:', err);
  } finally {
    isUpdating = false;
  }
}

// Schedule the update to run every day at midnight
cron.schedule('0 0 * * *', updateCalendar);

// Run on startup but with a delay to avoid immediate concurrent execution
setTimeout(() => {
  updateCalendar().catch(console.error);
}, 5000);

module.exports = updateCalendar;