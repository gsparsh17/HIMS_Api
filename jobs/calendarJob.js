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
          // Case 1: Day exists, check for new doctors and remove outdated ones
          const existingDay = calendar.days[existingDayIndex];
          const existingDoctorIds = new Set(existingDay.doctors.map(d => d.doctorId.toString()));
          let dayNeedsUpdate = false;

          // Add new doctors
          for (const doc of allDoctors) {
            const docIdStr = doc._id.toString();
            
            if (!existingDoctorIds.has(docIdStr)) {
              // Check if doctor should be available on this date
              if (shouldDoctorBeAvailable(doc, targetDate)) {
                console.log(`➕ ${hospital.name} — Adding new doctor ${doc.firstName} ${doc.lastName} to ${dateStr}`);
                needsUpdate = true;
                dayNeedsUpdate = true;

                existingDay.doctors.push({
                  doctorId: doc._id,
                  bookedAppointments: [],
                  bookedPatients: [],
                  breaks: [],
                  workingHours: doc.isFullTime ? [] : doc.timeSlots || []
                });
              }
            }
          }

          // Remove doctors who are no longer available (for part-time doctors with expired contracts)
          for (let i = existingDay.doctors.length - 1; i >= 0; i--) {
            const doctorEntry = existingDay.doctors[i];
            const doctor = allDoctors.find(d => d._id.toString() === doctorEntry.doctorId.toString());
            
            if (!doctor) {
              // Doctor no longer exists in database, remove from calendar
              console.log(`➖ ${hospital.name} — Removing deleted doctor from ${dateStr}`);
              existingDay.doctors.splice(i, 1);
              needsUpdate = true;
              dayNeedsUpdate = true;
            } else if (!shouldDoctorBeAvailable(doctor, targetDate)) {
              // Doctor exists but shouldn't be available on this date
              console.log(`➖ ${hospital.name} — Removing ${doctor.firstName} ${doctor.lastName} from ${dateStr} (outside availability)`);
              existingDay.doctors.splice(i, 1);
              needsUpdate = true;
              dayNeedsUpdate = true;
            }
          }

          if (dayNeedsUpdate) {
            console.log(`✅ ${hospital.name} — ${dateStr} updated with current doctor list.`);
          }
        } else {
          // Case 2: New day, add it with all doctors who should be available
          console.log(`➕ ${hospital.name} — Adding new day ${dateStr} to calendar`);
          needsUpdate = true;
          
          const doctorEntries = allDoctors
            .filter(doc => shouldDoctorBeAvailable(doc, targetDate))
            .map(doc => ({
              doctorId: doc._id,
              bookedAppointments: [],
              bookedPatients: [],
              breaks: [],
              workingHours: doc.isFullTime ? [] : doc.timeSlots || []
            }));

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

// Helper function to check if doctor should be available on a specific date
function shouldDoctorBeAvailable(doctor, targetDate) {
  // Full-time doctors are always available
  if (doctor.isFullTime) return true;
  
  // Part-time doctors: check contract dates
  const contractStart = doctor.contractStartDate ? new Date(doctor.contractStartDate) : null;
  const contractEnd = doctor.contractEndDate ? new Date(doctor.contractEndDate) : null;
  
  // If no contract dates are set, assume available
  if (!contractStart && !contractEnd) return true;
  
  // Check if target date is within contract period
  if (contractStart && targetDate < contractStart) return false;
  if (contractEnd && targetDate > contractEnd) return false;
  
  return true;
}

// Schedule the update to run every day at midnight
cron.schedule('0 0 * * *', updateCalendar);

// Run on startup but with a delay to avoid immediate concurrent execution
setTimeout(() => {
  updateCalendar().catch(console.error);
}, 5000);

// Export the function for manual triggering if needed
module.exports = {
  updateCalendar,
  shouldDoctorBeAvailable
};