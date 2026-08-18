const cron = require('node-cron');
const Calendar = require('../models/Calendar');
const Doctor = require('../models/Doctor');
const Hospital = require('../models/Hospital');
const {
  DEFAULT_HOSPITAL_TIME_ZONE,
  hospitalTodayKey,
  addDateKeyDays,
  dateKeyToStorageDate,
  dateKeyDayName,
  calendarDayKey,
  hospitalDateKey
} = require('../utils/hospitalDateTime');

let isUpdating = false;

async function updateCalendar() {
  if (isUpdating) {
    console.log('⏸️ Calendar update already in progress, skipping...');
    return;
  }

  isUpdating = true;
  console.log('🕒 Running calendar update...');

  try {
    const hospitals = await Hospital.find();

    for (const hospital of hospitals) {
      const timeZone = hospital.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
      const todayKey = hospitalTodayKey(timeZone);
      const wantedKeys = new Set();
      const datesToUpdate = [];

      for (let offset = -15; offset <= 15; offset += 1) {
        const dateKey = addDateKeyDays(todayKey, offset);
        wantedKeys.add(dateKey);
        datesToUpdate.push({
          dateKey,
          date: dateKeyToStorageDate(dateKey),
          dayName: dateKeyDayName(dateKey)
        });
      }

      let calendar = await Calendar.findOne({ hospitalId: hospital._id });
      if (!calendar) {
        calendar = new Calendar({
          hospitalId: hospital._id,
          timezone: timeZone,
          days: []
        });
      }
      calendar.timezone = timeZone;

      // Never leak doctors from another tenant into this hospital's calendar.
      const allDoctors = await Doctor.find({ hospitalId: hospital._id });
      let needsUpdate = false;

      // Collapse any legacy duplicate days first (for example 18:30Z and 00:00Z
      // representing the same Asia/Kolkata calendar date).
      const uniqueDays = [];
      const seenKeys = new Map();
      for (const legacyDay of calendar.days) {
        const key = calendarDayKey(legacyDay, timeZone);
        const existing = seenKeys.get(key);
        if (!existing) {
          legacyDay.dateKey = key;
          legacyDay.date = dateKeyToStorageDate(key);
          legacyDay.dayName = dateKeyDayName(key);
          seenKeys.set(key, legacyDay);
          uniqueDays.push(legacyDay);
          continue;
        }

        const doctorById = new Map(existing.doctors.map((row) => [String(row.doctorId), row]));
        for (const sourceDoctor of legacyDay.doctors) {
          const doctorId = String(sourceDoctor.doctorId);
          let targetDoctor = doctorById.get(doctorId);
          if (!targetDoctor) {
            existing.doctors.push(sourceDoctor);
            doctorById.set(doctorId, sourceDoctor);
            continue;
          }

          const appointmentIds = new Set(targetDoctor.bookedAppointments.map((row) => String(row.appointmentId || '')));
          for (const row of sourceDoctor.bookedAppointments || []) {
            const id = String(row.appointmentId || '');
            if (!appointmentIds.has(id)) {
              targetDoctor.bookedAppointments.push(row);
              appointmentIds.add(id);
            }
          }

          const patientAppointmentIds = new Set(targetDoctor.bookedPatients.map((row) => String(row.appointmentId || '')));
          for (const row of sourceDoctor.bookedPatients || []) {
            const id = String(row.appointmentId || '');
            if (!patientAppointmentIds.has(id)) {
              targetDoctor.bookedPatients.push(row);
              patientAppointmentIds.add(id);
            }
          }

          const breakKeys = new Set((targetDoctor.breaks || []).map((row) => `${row.startTime?.toISOString?.() || row.startTime}|${row.endTime?.toISOString?.() || row.endTime}|${row.reason || ''}`));
          for (const row of sourceDoctor.breaks || []) {
            const rowKey = `${row.startTime?.toISOString?.() || row.startTime}|${row.endTime?.toISOString?.() || row.endTime}|${row.reason || ''}`;
            if (!breakKeys.has(rowKey)) {
              targetDoctor.breaks.push(row);
              breakKeys.add(rowKey);
            }
          }
        }
        needsUpdate = true;
      }
      if (uniqueDays.length !== calendar.days.length) {
        calendar.days = uniqueDays;
      }

      for (const target of datesToUpdate) {
        const existingDay = calendar.days.find(
          (day) => calendarDayKey(day, timeZone) === target.dateKey
        );

        if (existingDay) {
          existingDay.dateKey = target.dateKey;
          existingDay.date = target.date;
          existingDay.dayName = target.dayName;

          const existingDoctorIds = new Set(existingDay.doctors.map((row) => String(row.doctorId)));
          let dayNeedsUpdate = false;

          for (const doctor of allDoctors) {
            const doctorId = String(doctor._id);
            if (!existingDoctorIds.has(doctorId) && shouldDoctorBeAvailable(doctor, target.dateKey, timeZone)) {
              existingDay.doctors.push({
                doctorId: doctor._id,
                bookedAppointments: [],
                bookedPatients: [],
                breaks: []
              });
              existingDoctorIds.add(doctorId);
              dayNeedsUpdate = true;
            }
          }

          for (let index = existingDay.doctors.length - 1; index >= 0; index -= 1) {
            const doctorEntry = existingDay.doctors[index];
            const doctor = allDoctors.find((row) => String(row._id) === String(doctorEntry.doctorId));
            if (!doctor || !shouldDoctorBeAvailable(doctor, target.dateKey, timeZone)) {
              // Preserve a doctor entry that still has booked clinical work; deleting it
              // would orphan existing appointments. The migration script can reconcile
              // stale entries explicitly.
              const hasClinicalData = (doctorEntry.bookedAppointments?.length || 0)
                + (doctorEntry.bookedPatients?.length || 0)
                + (doctorEntry.breaks?.length || 0) > 0;
              if (!hasClinicalData) {
                existingDay.doctors.splice(index, 1);
                dayNeedsUpdate = true;
              }
            }
          }

          if (dayNeedsUpdate) needsUpdate = true;
          continue;
        }

        const doctorEntries = allDoctors
          .filter((doctor) => shouldDoctorBeAvailable(doctor, target.dateKey, timeZone))
          .map((doctor) => ({
            doctorId: doctor._id,
            bookedAppointments: [],
            bookedPatients: [],
            breaks: []
          }));

        calendar.days.push({
          dateKey: target.dateKey,
          date: target.date,
          dayName: target.dayName,
          doctors: doctorEntries
        });
        needsUpdate = true;
      }

      const beforeFilter = calendar.days.length;
      calendar.days = calendar.days.filter((day) => wantedKeys.has(calendarDayKey(day, timeZone)));
      if (calendar.days.length !== beforeFilter) needsUpdate = true;

      calendar.days.sort((left, right) =>
        calendarDayKey(left, timeZone).localeCompare(calendarDayKey(right, timeZone))
      );

      if (calendar.isNew || needsUpdate || calendar.isModified()) {
        await calendar.save();
        console.log(`✅ ${hospital.name} — Calendar normalized/updated successfully!`);
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

function shouldDoctorBeAvailable(doctor, targetDateOrKey, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  if (doctor.isFullTime) return true;

  const targetKey = hospitalDateKey(targetDateOrKey, timeZone);
  const contractStartKey = doctor.contractStartDate
    ? hospitalDateKey(doctor.contractStartDate, timeZone)
    : null;
  const contractEndKey = doctor.contractEndDate
    ? hospitalDateKey(doctor.contractEndDate, timeZone)
    : null;

  if (contractStartKey && targetKey < contractStartKey) return false;
  if (contractEndKey && targetKey > contractEndKey) return false;
  return true;
}

function startCalendarJob() {
  cron.schedule('0 0 * * *', updateCalendar);

  setTimeout(() => {
    updateCalendar().catch(console.error);
  }, 5000);
}

module.exports = {
  updateCalendar,
  startCalendarJob,
  shouldDoctorBeAvailable
};
