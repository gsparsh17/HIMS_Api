'use strict';

const StaffSchedule = require('../models/StaffSchedule');
const HRStaffProfile = require('../models/HRStaffProfile');
const Doctor = require('../models/Doctor');
const Shift = require('../models/Shift');
const Hospital = require('../models/Hospital');
const StaffLeaveRequest = require('../models/StaffLeaveRequest');
const CalendarEvent = require('../models/CalendarEvent');
const Appointment = require('../models/Appointment');
const Calendar = require('../models/Calendar');
const {
  DEFAULT_HOSPITAL_TIME_ZONE,
  hospitalDayBounds,
  hospitalDateKey,
  parseHospitalDateTime,
  dateKeyDayName,
  addDateKeyDays,
  calendarDayKey
} = require('../utils/hospitalDateTime');

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function normalizeDayName(value) {
  const day = String(value || '').trim().toLowerCase();
  const aliases = { mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' };
  return aliases[day] || day;
}

function normalizeWallTime(value) {
  const text = String(value || '').trim().slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    const error = new Error(`Invalid working-hour time: ${value}`);
    error.statusCode = 400;
    error.code = 'INVALID_WORKING_HOUR';
    throw error;
  }
  return text;
}

function minutesOfDay(value) {
  const [hour, minute] = normalizeWallTime(value).split(':').map(Number);
  return hour * 60 + minute;
}

function normalizeWeeklySchedule(input = []) {
  const rows = Array.isArray(input) ? input : [];
  const byDay = new Map();
  for (const row of rows) {
    const day = normalizeDayName(row?.day);
    if (!DAY_ORDER.includes(day)) continue;
    const intervals = Array.isArray(row?.intervals)
      ? row.intervals.map((interval) => {
        const start = normalizeWallTime(interval?.start);
        const end = normalizeWallTime(interval?.end);
        const spansNextDay = interval?.spans_next_day === true || minutesOfDay(end) <= minutesOfDay(start);
        return {
          start,
          end,
          shift_id: interval?.shift_id || undefined,
          label: String(interval?.label || '').trim() || undefined,
          spans_next_day: spansNextDay
        };
      })
      : [];
    byDay.set(day, { day, enabled: row?.enabled !== false && intervals.length > 0, intervals });
  }
  return DAY_ORDER.map((day) => byDay.get(day) || { day, enabled: false, intervals: [] });
}

async function findEmployeeForDoctor({ hospitalId, doctorId }) {
  return HRStaffProfile.findOne({
    hospital_id: hospitalId,
    is_active: { $ne: false },
    $or: [
      { doctor_id: doctorId },
      { source_model: 'Doctor', source_id: doctorId }
    ]
  });
}

async function upsertScheduleForEmployee({ hospitalId, employeeId, weekly, timezone, userId, source = 'manual', effectiveFrom, effectiveTo }) {
  const normalized = normalizeWeeklySchedule(weekly);
  const hospital = await Hospital.findById(hospitalId).select('timezone');
  const zone = timezone || hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  return StaffSchedule.findOneAndUpdate(
    { hospital_id: hospitalId, employee_id: employeeId, is_active: true },
    {
      $set: {
        weekly: normalized,
        timezone: zone,
        effective_from: effectiveFrom || undefined,
        effective_to: effectiveTo || undefined,
        source,
        updated_by: userId
      },
      $setOnInsert: { created_by: userId }
    },
    { new: true, upsert: true, runValidators: true }
  );
}

async function upsertScheduleForDoctor({ hospitalId, doctorId, weekly, timezone, userId, source = 'manual' }) {
  const employee = await findEmployeeForDoctor({ hospitalId, doctorId });
  if (!employee) {
    const error = new Error('HR staff profile for this doctor is not available');
    error.statusCode = 409;
    error.code = 'DOCTOR_HR_PROFILE_REQUIRED';
    throw error;
  }
  return upsertScheduleForEmployee({ hospitalId, employeeId: employee._id, weekly, timezone, userId, source });
}

function intervalToInstants(interval, dateKey, timeZone) {
  const start = parseHospitalDateTime(interval.start, dateKey, timeZone);
  let end = parseHospitalDateTime(interval.end, dateKey, timeZone);
  if (interval.spans_next_day || end <= start) {
    end = parseHospitalDateTime(interval.end, addDateKeyDays(dateKey, 1), timeZone);
  }
  return { start, end };
}

function intersects(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function subtractBlocks(intervals, blocks) {
  let output = intervals.map((row) => ({ ...row }));
  for (const block of blocks) {
    const next = [];
    for (const interval of output) {
      if (!intersects(interval.start, interval.end, block.start, block.end)) {
        next.push(interval);
        continue;
      }
      if (block.start > interval.start) next.push({ ...interval, end: block.start });
      if (block.end < interval.end) next.push({ ...interval, start: block.end });
    }
    output = next;
  }
  return output.filter((row) => row.end > row.start);
}

async function resolveLegacyDoctorIntervals({ doctor, dateKey, timeZone }) {
  const dayName = normalizeDayName(dateKeyDayName(dateKey));
  const configuredDays = (doctor?.workingDaysPerWeek || []).map(normalizeDayName).filter(Boolean);
  if (configuredDays.length && !configuredDays.includes(dayName)) return [];
  const slots = Array.isArray(doctor?.timeSlots) ? doctor.timeSlots : [];
  return slots
    .filter((slot) => slot?.start && slot?.end)
    .map((slot) => intervalToInstants({ start: slot.start, end: slot.end }, dateKey, timeZone));
}

async function getLegacyShiftIntervals({ employee, dateKey, timeZone }) {
  if (!employee?.shift) return [];
  const shiftId = employee.shift?._id || employee.shift;
  const shift = await Shift.findOne({ _id: shiftId, is_active: { $ne: false } }).lean();
  if (!shift?.start_time || !shift?.end_time) return [];
  return [intervalToInstants({ start: shift.start_time, end: shift.end_time, spans_next_day: shift.spans_next_day }, dateKey, timeZone)];
}


async function getEmployeeScheduleIntervals({ hospitalId, employeeId, dateKey, timeZone }) {
  const [hospital, employee] = await Promise.all([
    Hospital.findById(hospitalId).select('timezone'),
    HRStaffProfile.findOne({ _id: employeeId, hospital_id: hospitalId, is_active: { $ne: false } }).lean()
  ]);
  if (!hospital) { const error = new Error('Hospital not found'); error.statusCode = 404; throw error; }
  if (!employee) { const error = new Error('Employee not found'); error.statusCode = 404; throw error; }

  const zone = timeZone || hospital.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const key = hospitalDateKey(dateKey, zone);
  const dayName = normalizeDayName(dateKeyDayName(key));
  const schedule = await StaffSchedule.findOne({ hospital_id: hospitalId, employee_id: employeeId, is_active: true }).lean();

  let intervals = [];
  let scheduleSource = 'unconfigured';
  if (schedule) {
    scheduleSource = 'staff_schedule';
    const exception = (schedule.exceptions || []).find((row) => row.date_key === key);
    if (exception?.type === 'OFF') {
      intervals = [];
    } else if (exception && ['OVERRIDE', 'EXTRA_AVAILABILITY'].includes(exception.type)) {
      intervals = (exception.intervals || []).map((row) => intervalToInstants(row, key, schedule.timezone || zone));
    } else {
      const day = (schedule.weekly || []).find((row) => normalizeDayName(row.day) === dayName);
      intervals = day?.enabled
        ? (day.intervals || []).map((row) => intervalToInstants(row, key, schedule.timezone || zone))
        : [];
    }
  } else if (employee.shift) {
    intervals = await getLegacyShiftIntervals({ employee, dateKey: key, timeZone: zone });
    if (intervals.length) scheduleSource = 'legacy_shift';
  }

  const { start: dayStart, end: dayEnd } = hospitalDayBounds(key, zone);
  const onApprovedLeave = Boolean(await StaffLeaveRequest.exists({
    employee_id: employeeId,
    hospital_id: hospitalId,
    status: 'approved',
    $or: [
      { start_date_key: { $lte: key }, end_date_key: { $gte: key } },
      { start_date_key: { $exists: false }, start_date: { $lt: dayEnd }, end_date: { $gte: dayStart } }
    ]
  }));
  if (onApprovedLeave) intervals = [];

  const events = await CalendarEvent.find({
    hospital_id: hospitalId,
    employee_id: employeeId,
    date_key: key,
    is_active: { $ne: false }
  }).lean();
  const overrides = events.filter((row) => row.type === 'SCHEDULE_OVERRIDE');
  if (overrides.length) {
    intervals = overrides
      .filter((row) => row.start_time && row.end_time)
      .map((row) => intervalToInstants({ start: row.start_time, end: row.end_time }, key, row.timezone || zone));
    scheduleSource = 'calendar_override';
  }
  const extra = events
    .filter((row) => row.type === 'EXTRA_AVAILABILITY' && row.start_time && row.end_time)
    .map((row) => intervalToInstants({ start: row.start_time, end: row.end_time }, key, row.timezone || zone));
  intervals = [...intervals, ...extra].sort((a, b) => a.start - b.start);

  const blocks = events
    .filter((row) => ['BREAK', 'BLOCK'].includes(row.type) && row.start_time && row.end_time)
    .map((row) => intervalToInstants({ start: row.start_time, end: row.end_time }, key, row.timezone || zone));

  return {
    employeeId,
    dateKey: key,
    timezone: zone,
    dayName,
    scheduleSource,
    onApprovedLeave,
    availableIntervals: subtractBlocks(intervals, blocks),
    blockedIntervals: blocks
  };
}

async function isEmployeeScheduledAt({ hospitalId, employeeId, instant }) {
  const hospital = await Hospital.findById(hospitalId).select('timezone').lean();
  if (!hospital) return false;
  const zone = hospital.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const target = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(target.getTime())) return false;
  const key = hospitalDateKey(target, zone);
  const previousKey = addDateKeyDays(key, -1);
  const [today, previous] = await Promise.all([
    getEmployeeScheduleIntervals({ hospitalId, employeeId, dateKey: key, timeZone: zone }),
    getEmployeeScheduleIntervals({ hospitalId, employeeId, dateKey: previousKey, timeZone: zone })
  ]);
  return [...previous.availableIntervals, ...today.availableIntervals].some((row) => target >= row.start && target < row.end);
}

async function getDoctorAvailability({ hospitalId, doctorId, dateKey, slotMinutes = 10 }) {
  const [hospital, doctor, employee] = await Promise.all([
    Hospital.findById(hospitalId).select('timezone'),
    Doctor.findOne({ _id: doctorId, hospitalId, is_active: { $ne: false } }).lean(),
    findEmployeeForDoctor({ hospitalId, doctorId })
  ]);
  if (!hospital) {
    const error = new Error('Hospital not found'); error.statusCode = 404; throw error;
  }
  if (!doctor) {
    const error = new Error('Doctor not found'); error.statusCode = 404; throw error;
  }
  const zone = hospital.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const key = hospitalDateKey(dateKey, zone);
  const dayName = normalizeDayName(dateKeyDayName(key));

  let schedule = null;
  if (employee) {
    schedule = await StaffSchedule.findOne({ hospital_id: hospitalId, employee_id: employee._id, is_active: true }).lean();
  }

  let baseIntervals = [];
  let scheduleSource = 'unconfigured';
  if (schedule) {
    scheduleSource = 'staff_schedule';
    const exception = (schedule.exceptions || []).find((row) => row.date_key === key);
    if (exception?.type === 'OFF') {
      baseIntervals = [];
    } else if (exception && ['OVERRIDE', 'EXTRA_AVAILABILITY'].includes(exception.type)) {
      baseIntervals = (exception.intervals || []).map((row) => intervalToInstants(row, key, schedule.timezone || zone));
    } else {
      const day = (schedule.weekly || []).find((row) => normalizeDayName(row.day) === dayName);
      baseIntervals = day?.enabled
        ? (day.intervals || []).map((row) => intervalToInstants(row, key, schedule.timezone || zone))
        : [];
    }
  } else {
    baseIntervals = await resolveLegacyDoctorIntervals({ doctor, dateKey: key, timeZone: zone });
    if (baseIntervals.length) scheduleSource = 'legacy_doctor_timeslots';
    if (!baseIntervals.length && employee?.shift) {
      baseIntervals = await getLegacyShiftIntervals({ employee, dateKey: key, timeZone: zone });
      if (baseIntervals.length) scheduleSource = 'legacy_shift';
    }
  }

  const { start: dayStart, end: dayEnd } = hospitalDayBounds(key, zone);
  let onApprovedLeave = false;
  if (employee) {
    onApprovedLeave = Boolean(await StaffLeaveRequest.exists({
      employee_id: employee._id,
      hospital_id: hospitalId,
      status: 'approved',
      $or: [
        { start_date_key: { $lte: key }, end_date_key: { $gte: key } },
        { start_date_key: { $exists: false }, start_date: { $lt: dayEnd }, end_date: { $gte: dayStart } }
      ]
    }));
  }
  if (onApprovedLeave) baseIntervals = [];

  const events = await CalendarEvent.find({
    hospital_id: hospitalId,
    doctor_id: doctorId,
    date_key: key,
    is_active: { $ne: false }
  }).lean();

  const overrideEvents = events.filter((row) => row.type === 'SCHEDULE_OVERRIDE');
  if (overrideEvents.length) {
    baseIntervals = overrideEvents
      .filter((row) => row.start_time && row.end_time)
      .map((row) => intervalToInstants({ start: row.start_time, end: row.end_time }, key, row.timezone || zone));
    scheduleSource = 'calendar_override';
  }
  const extra = events
    .filter((row) => row.type === 'EXTRA_AVAILABILITY' && row.start_time && row.end_time)
    .map((row) => intervalToInstants({ start: row.start_time, end: row.end_time }, key, row.timezone || zone));
  baseIntervals = [...baseIntervals, ...extra].sort((a, b) => a.start - b.start);

  const eventBlocks = events
    .filter((row) => ['BREAK', 'BLOCK'].includes(row.type) && row.start_time && row.end_time)
    .map((row) => intervalToInstants({ start: row.start_time, end: row.end_time }, key, row.timezone || zone));

  // Legacy Calendar breaks remain readable during the migration window.
  const legacyCalendar = await Calendar.findOne({ hospitalId }).lean();
  const legacyDay = legacyCalendar?.days?.find((row) => calendarDayKey(row, legacyCalendar.timezone || zone) === key);
  const legacyDoctorDay = legacyDay?.doctors?.find((row) => String(row.doctorId) === String(doctorId));
  const legacyBreaks = (legacyDoctorDay?.breaks || []).map((row) => ({ start: new Date(row.startTime), end: new Date(row.endTime) }));
  const workableIntervals = subtractBlocks(baseIntervals, [...eventBlocks, ...legacyBreaks]);

  const appointments = await Appointment.find({
    hospital_id: hospitalId,
    doctor_id: doctorId,
    status: { $nin: ['Cancelled'] },
    is_active: { $ne: false },
    $or: [
      { appointment_date_key: key },
      { appointment_date: { $gte: dayStart, $lt: dayEnd } }
    ]
  }).select('_id start_time end_time duration status type patient_id').lean();

  const bookedIntervals = appointments
    .filter((row) => row.type === 'time-based' && row.start_time && row.end_time)
    .map((row) => ({ start: new Date(row.start_time), end: new Date(row.end_time), appointment_id: row._id, status: row.status }));

  const slotSize = Math.max(5, Math.min(240, Number(slotMinutes) || 10));
  const availableSlots = [];
  for (const interval of workableIntervals) {
    for (let cursor = new Date(interval.start); cursor.getTime() + slotSize * 60000 <= interval.end.getTime(); cursor = new Date(cursor.getTime() + slotSize * 60000)) {
      const slotEnd = new Date(cursor.getTime() + slotSize * 60000);
      if (!bookedIntervals.some((row) => intersects(cursor, slotEnd, row.start, row.end))) {
        availableSlots.push({ start: cursor, end: slotEnd });
      }
    }
  }

  return {
    doctorId,
    employeeId: employee?._id || null,
    dateKey: key,
    timezone: zone,
    dayName,
    configured: Boolean(schedule || baseIntervals.length),
    scheduleSource,
    onApprovedLeave,
    availableIntervals: workableIntervals,
    blockedIntervals: [...eventBlocks, ...legacyBreaks],
    bookedAppointments: bookedIntervals,
    availableSlots
  };
}

async function assertDoctorAvailable({ hospitalId, doctorId, dateKey, startTime, endTime }) {
  const availability = await getDoctorAvailability({ hospitalId, doctorId, dateKey, slotMinutes: Math.max(5, Math.round((endTime - startTime) / 60000)) });
  if (availability.onApprovedLeave) {
    const error = new Error('Doctor is on approved leave for this date');
    error.statusCode = 409; error.code = 'DOCTOR_ON_LEAVE'; throw error;
  }
  // Compatibility: truly unconfigured legacy doctors keep their current booking behavior.
  if (availability.scheduleSource === 'unconfigured') return availability;
  const insideWorkingHours = availability.availableIntervals.some((row) => startTime >= row.start && endTime <= row.end);
  if (!insideWorkingHours) {
    const error = new Error('Requested appointment is outside the doctor working schedule or overlaps a blocked period');
    error.statusCode = 409; error.code = 'OUTSIDE_DOCTOR_WORKING_HOURS'; throw error;
  }
  const conflict = availability.bookedAppointments.some((row) => intersects(startTime, endTime, row.start, row.end));
  if (conflict) {
    const error = new Error('Time slot is already booked');
    error.statusCode = 409; error.code = 'SLOT_CONFLICT'; throw error;
  }
  return availability;
}

async function assertDoctorWorkingDay({ hospitalId, doctorId, dateKey }) {
  const availability = await getDoctorAvailability({ hospitalId, doctorId, dateKey, slotMinutes: 10 });
  if (availability.onApprovedLeave) {
    const error = new Error('Doctor is on approved leave for this date');
    error.statusCode = 409; error.code = 'DOCTOR_ON_LEAVE'; throw error;
  }
  if (availability.scheduleSource !== 'unconfigured' && availability.availableIntervals.length === 0) {
    const error = new Error('Doctor is not scheduled to work on this date');
    error.statusCode = 409; error.code = 'DOCTOR_NOT_WORKING'; throw error;
  }
  return availability;
}

module.exports = {
  DAY_ORDER,
  normalizeWeeklySchedule,
  findEmployeeForDoctor,
  upsertScheduleForEmployee,
  upsertScheduleForDoctor,
  getEmployeeScheduleIntervals,
  isEmployeeScheduledAt,
  getDoctorAvailability,
  assertDoctorAvailable,
  assertDoctorWorkingDay
};
