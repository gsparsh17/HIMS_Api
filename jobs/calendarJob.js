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

      const allDoctors = await Doctor.find();
      let needsUpdate = false;

      for (const targetDate of datesToUpdate) {
        const dateStr = targetDate.toISOString().split('T')[0];
        const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
        
        const existingDayIndex = calendar.days.findIndex(
          d => d.date.toISOString().split('T')[0] === dateStr
        );

        if (existingDayIndex !== -1) {
          // Case 1: Day exists, check for new doctors
          const existingDay = calendar.days[existingDayIndex];
          const existingDoctorIds = new Set(existingDay.doctors.map(d => d.doctorId.toString()));
          let dayNeedsUpdate = false;

          for (const doc of allDoctors) {
            const docIdStr = doc._id.toString();
            // Check if the doctor is new to this day's entry
            if (!existingDoctorIds.has(docIdStr)) {
              console.log(`➕ ${hospital.name} — Adding new doctor ${doc.name} to ${dateStr}`);
              needsUpdate = true;
              dayNeedsUpdate = true;

              const shifts = doc.isFullTime
                ? [getShiftTimeRange(doc.shift, existingDayIndex, targetDate)].filter(Boolean)
                : getPartTimeRanges(doc.timeSlots, targetDate);

              existingDay.doctors.push({
                doctorId: doc._id,
                bookedAppointments: [],
                bookedPatients: [],
                breaks: []
              });
            }
          }
          if (dayNeedsUpdate) {
            console.log(`✅ ${hospital.name} — ${dateStr} updated with new doctors.`);
          }
        } else {
          // Case 2: New day, add it with all doctors
          console.log(`➕ ${hospital.name} — Adding new day ${dateStr} to calendar`);
          needsUpdate = true;
          
          const doctorEntries = allDoctors
            .filter(doc => {
              // Ensure doc meets part-time contract dates if applicable
              if (doc.isFullTime) return true;
              return targetDate >= new Date(doc.contractStartDate) && targetDate <= new Date(doc.contractEndDate);
            })
            .map(doc => {
              // Shifts are not initialized here since you commented out the logic
              return {
                doctorId: doc._id,
                bookedAppointments: [],
                bookedPatients: [],
                breaks: []
              };
            });

          calendar.days.push({
            date: targetDate,
            dayName,
            doctors: doctorEntries
          });
        }
      }

      if (needsUpdate) {
        // Filter and sort as before
        const todayStr = today.toISOString().split('T')[0];
        calendar.days = calendar.days.filter(day => {
          const dayDate = new Date(day.date);
          const diffDays = Math.floor((dayDate - today) / (1000 * 60 * 60 * 24));
          return diffDays >= -15 && diffDays <= 15;
        });

        calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));

        await calendar.save();
        
        console.log(`✅ ${hospital.name} — Calendar updated successfully!`);
      } else {
        console.log(`✅ ${hospital.name} — No updates needed`);
      }
    }

    console.log('✅ All hospital calendars processed.');
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