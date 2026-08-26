const Appointment = require('../models/Appointment');
const Calendar = require('../models/Calendar');
const Doctor = require('../models/Doctor');
const {
  DEFAULT_HOSPITAL_TIME_ZONE,
  hospitalDateKey,
  hospitalDayBounds,
  calendarDayKey,
  parseHospitalDateTime,
  hospitalTodayKey,
} = require('../utils/hospitalDateTime');

function httpError(message, statusCode = 400, code = 'APPOINTMENT_CALENDAR_INVALID', details = {}) {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function durationMinutes(row) {
  const explicit = Number(row?.duration);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (row?.start_time && row?.end_time) {
    return Math.max(1, Math.round((new Date(row.end_time) - new Date(row.start_time)) / 60000));
  }
  return 10;
}

function timeMinutes(date, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function parseClock(value) {
  const [hour, minute] = String(value || '00:00').slice(0, 5).split(':').map(Number);
  return hour * 60 + minute;
}

function inWorkingHours(start, end, doctor, timeZone) {
  const blocks = Array.isArray(doctor?.timeSlots) ? doctor.timeSlots : [];
  if (!blocks.length) return true;
  const startMinutes = timeMinutes(start, timeZone);
  const endMinutes = timeMinutes(end, timeZone);
  return blocks.some((block) => {
    const blockStart = parseClock(block.start);
    const blockEnd = parseClock(block.end);
    return startMinutes >= blockStart && endMinutes <= blockEnd;
  });
}

function overlaps(startA, endA, startB, endB) {
  return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB);
}

function calendarStatus(status) {
  return status === 'In Progress' ? 'InProgress' : status;
}

async function context({ hospitalId, doctorId, date }) {
  const [calendar, doctor] = await Promise.all([
    Calendar.findOne({ hospitalId }),
    Doctor.findOne({ _id: doctorId, hospitalId, is_active: { $ne: false } })
      .select('_id doctorId firstName lastName department specialization timeSlots workingDaysPerWeek shift isFullTime')
      .populate('department', 'name')
      .lean(),
  ]);
  if (!calendar) throw httpError('Hospital calendar not found', 404, 'CALENDAR_NOT_FOUND');
  if (!doctor) throw httpError('Doctor not found for this hospital', 404, 'DOCTOR_NOT_FOUND');
  const timeZone = calendar.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const dateKey = hospitalDateKey(date, timeZone);
  const day = calendar.days.find((row) => calendarDayKey(row, timeZone) === dateKey);
  if (!day) throw httpError('Date is not available in the hospital calendar', 404, 'CALENDAR_DAY_NOT_FOUND');
  const doctorDay = day.doctors.find((row) => String(row.doctorId) === String(doctorId));
  if (!doctorDay) throw httpError('Doctor is not scheduled on this date', 404, 'DOCTOR_DAY_NOT_FOUND');
  return { calendar, doctor, day, doctorDay, timeZone, dateKey };
}

function assertCandidate({ start, end, dateKey, timeZone, doctor, breaks = [], unaffected = [] }) {
  if (hospitalDateKey(start, timeZone) !== dateKey || hospitalDateKey(new Date(end.getTime() - 1), timeZone) !== dateKey) {
    throw httpError('Shift would move an appointment outside the selected hospital day', 409, 'SHIFT_OUTSIDE_DAY');
  }
  if (dateKey === hospitalTodayKey(timeZone) && start.getTime() < Date.now()) {
    throw httpError('Shift would move an appointment into the past', 409, 'SHIFT_INTO_PAST');
  }
  if (!inWorkingHours(start, end, doctor, timeZone)) {
    throw httpError('Shift would move an appointment outside the doctor working hours', 409, 'SHIFT_OUTSIDE_WORKING_HOURS');
  }
  const breakHit = breaks.find((row) => overlaps(start, end, row.startTime, row.endTime));
  if (breakHit) throw httpError('Shift would overlap a doctor calendar block', 409, 'SHIFT_BREAK_CONFLICT');
  const appointmentHit = unaffected.find((row) => overlaps(start, end, row.start_time, row.end_time));
  if (appointmentHit) {
    throw httpError('Shift would collide with another appointment', 409, 'SHIFT_APPOINTMENT_CONFLICT', {
      appointmentId: appointmentHit._id,
    });
  }
}

function updateCalendarReservation(doctorDay, appointment) {
  let row = doctorDay.bookedAppointments.find((item) => String(item.appointmentId) === String(appointment._id));
  if (!row) {
    doctorDay.bookedAppointments.push({
      startTime: appointment.start_time,
      endTime: appointment.end_time,
      duration: durationMinutes(appointment),
      appointmentId: appointment._id,
      status: calendarStatus(appointment.status),
    });
    return;
  }
  row.startTime = appointment.start_time;
  row.endTime = appointment.end_time;
  row.duration = durationMinutes(appointment);
  row.status = calendarStatus(appointment.status);
}

async function dayAppointments({ hospitalId, doctorId, dateKey, timeZone }) {
  const { start, end } = hospitalDayBounds(dateKey, timeZone);
  return Appointment.find({
    hospital_id: hospitalId,
    doctor_id: doctorId,
    type: 'time-based',
    is_active: { $ne: false },
    status: { $in: ['Scheduled', 'In Progress'] },
    $or: [
      { appointment_date_key: dateKey },
      { appointment_date: { $gte: start, $lt: end } },
    ],
  }).sort({ start_time: 1 });
}

async function getDoctorDay({ hospitalId, doctorId, date }) {
  const ctx = await context({ hospitalId, doctorId, date });
  const { start, end } = hospitalDayBounds(ctx.dateKey, ctx.timeZone);
  const appointments = await Appointment.find({
    hospital_id: hospitalId,
    doctor_id: doctorId,
    is_active: { $ne: false },
    $or: [
      { appointment_date_key: ctx.dateKey },
      { appointment_date: { $gte: start, $lt: end } },
    ],
  })
    .populate('patient_id', 'first_name last_name patientId uhid phone')
    .populate('department_id', 'name')
    .sort({ start_time: 1, serial_number: 1 })
    .lean();

  return {
    date: ctx.dateKey,
    timezone: ctx.timeZone,
    doctor: ctx.doctor,
    breaks: (ctx.doctorDay.breaks || []).map((row) => row.toObject ? row.toObject() : row),
    appointments,
  };
}

async function bulkShift({ hospitalId, doctorId, date, direction = 'later', minutes = 10, scope = 'all', anchorAppointmentId, includeAnchor = false }) {
  const ctx = await context({ hospitalId, doctorId, date });
  const magnitude = Number(minutes);
  if (!Number.isFinite(magnitude) || magnitude <= 0 || magnitude > 240) {
    throw httpError('Shift minutes must be between 1 and 240', 400, 'SHIFT_MINUTES_INVALID');
  }
  if (!['earlier', 'later'].includes(direction)) throw httpError('direction must be earlier or later');
  if (!['all', 'following'].includes(scope)) throw httpError('scope must be all or following');

  const rows = await dayAppointments({ hospitalId, doctorId, dateKey: ctx.dateKey, timeZone: ctx.timeZone });
  let anchor = null;
  if (scope === 'following') {
    anchor = rows.find((row) => String(row._id) === String(anchorAppointmentId));
    if (!anchor) {
      anchor = await Appointment.findOne({ _id: anchorAppointmentId, hospital_id: hospitalId, doctor_id: doctorId });
    }
    if (!anchor?.start_time) throw httpError('Select a valid appointment anchor', 400, 'SHIFT_ANCHOR_REQUIRED');
  }

  const selected = rows.filter((row) => {
    if (row.status !== 'Scheduled') return false;
    if (scope === 'all') return true;
    const relation = new Date(row.start_time).getTime() - new Date(anchor.start_time).getTime();
    return includeAnchor ? relation >= 0 : relation > 0;
  });
  if (!selected.length) return { changed: [], date: ctx.dateKey, direction, minutes: magnitude, scope };

  const selectedIds = new Set(selected.map((row) => String(row._id)));
  const unaffected = rows.filter((row) => !selectedIds.has(String(row._id)));
  const delta = (direction === 'earlier' ? -1 : 1) * magnitude * 60000;
  const plans = selected.map((row) => {
    const start = new Date(new Date(row.start_time).getTime() + delta);
    const end = new Date(start.getTime() + durationMinutes(row) * 60000);
    return { row, start, end };
  });

  for (const plan of plans) {
    const otherPlanned = plans
      .filter((candidate) => String(candidate.row._id) !== String(plan.row._id))
      .map((candidate) => ({ _id: candidate.row._id, start_time: candidate.start, end_time: candidate.end }));
    assertCandidate({
      start: plan.start,
      end: plan.end,
      dateKey: ctx.dateKey,
      timeZone: ctx.timeZone,
      doctor: ctx.doctor,
      breaks: ctx.doctorDay.breaks || [],
      unaffected: [...unaffected, ...otherPlanned],
    });
  }

  for (const plan of plans) {
    plan.row.start_time = plan.start;
    plan.row.end_time = plan.end;
    plan.row.duration = durationMinutes(plan.row);
    updateCalendarReservation(ctx.doctorDay, plan.row);
  }
  await Promise.all(selected.map((row) => row.save()));
  await ctx.calendar.save();

  return {
    changed: selected.map((row) => ({ _id: row._id, department_id: row.department_id, start_time: row.start_time, end_time: row.end_time, duration: row.duration })),
    date: ctx.dateKey,
    direction,
    minutes: magnitude,
    scope,
  };
}

async function shiftFollowingIntoCancelledSlot({ hospitalId, appointment }) {
  if (!appointment?.start_time || appointment.type !== 'time-based') return { changed: [] };
  const minutes = durationMinutes(appointment);
  return bulkShift({
    hospitalId,
    doctorId: appointment.doctor_id,
    date: appointment.appointment_date_key || appointment.appointment_date,
    direction: 'earlier',
    minutes,
    scope: 'following',
    anchorAppointmentId: appointment._id,
    includeAnchor: false,
  });
}

async function createBlock({ hospitalId, doctorId, date, startTime, endTime, reason, conflictStrategy = 'move_later', userId = null }) {
  const ctx = await context({ hospitalId, doctorId, date });
  let breakStart;
  let breakEnd;
  try {
    breakStart = parseHospitalDateTime(startTime, ctx.dateKey, ctx.timeZone);
    breakEnd = parseHospitalDateTime(endTime, ctx.dateKey, ctx.timeZone);
  } catch (error) {
    throw httpError(error.message, 400, error.code || 'BLOCK_TIME_INVALID');
  }
  if (!(breakEnd > breakStart)) throw httpError('Block end time must be after start time', 400, 'BLOCK_RANGE_INVALID');
  if (hospitalDateKey(new Date(breakEnd.getTime() - 1), ctx.timeZone) !== ctx.dateKey) {
    throw httpError('Calendar block must remain within the selected day', 400, 'BLOCK_OUTSIDE_DAY');
  }
  if ((ctx.doctorDay.breaks || []).some((row) => overlaps(breakStart, breakEnd, row.startTime, row.endTime))) {
    throw httpError('Calendar block overlaps an existing doctor block', 409, 'BLOCK_CONFLICT');
  }
  if (!['reject', 'cancel', 'move_later'].includes(conflictStrategy)) {
    throw httpError('Invalid conflict strategy', 400, 'BLOCK_STRATEGY_INVALID');
  }

  const rows = await dayAppointments({ hospitalId, doctorId, dateKey: ctx.dateKey, timeZone: ctx.timeZone });
  const overlapping = rows.filter((row) => overlaps(row.start_time, row.end_time, breakStart, breakEnd));
  const activeOverlap = overlapping.find((row) => row.status === 'In Progress');
  if (activeOverlap) {
    throw httpError('An in-progress consultation overlaps this block', 409, 'BLOCK_ACTIVE_CONSULTATION');
  }
  if (conflictStrategy === 'reject' && overlapping.length) {
    throw httpError('Appointments overlap this proposed calendar block', 409, 'BLOCK_APPOINTMENT_CONFLICT', {
      appointmentIds: overlapping.map((row) => row._id),
    });
  }

  const changed = [];
  const cancelled = [];
  if (conflictStrategy === 'cancel') {
    for (const row of overlapping.filter((item) => item.status === 'Scheduled')) {
      row.status = 'Cancelled';
      row.cancellationReason = `Doctor unavailable: ${String(reason || 'Calendar block').trim()}`;
      row.cancelledAt = new Date();
      row.cancelledBy = userId || undefined;
      row.lifecycleTimestamps = row.lifecycleTimestamps || {};
      row.lifecycleTimestamps.cancelledAt = row.cancelledAt;
      row.cancellationHistory = Array.isArray(row.cancellationHistory) ? row.cancellationHistory : [];
      row.cancellationHistory.push({
        reason: row.cancellationReason,
        cancelledAt: row.cancelledAt,
        cancelledBy: userId || undefined,
      });
      cancelled.push(row);
    }
  }

  if (cancelled.length) {
    const cancelledIds = new Set(cancelled.map((row) => String(row._id)));
    ctx.doctorDay.bookedAppointments = ctx.doctorDay.bookedAppointments.filter(
      (item) => !cancelledIds.has(String(item.appointmentId))
    );
  }

  if (conflictStrategy === 'move_later') {
    const movable = rows.filter((row) => row.status === 'Scheduled' && new Date(row.end_time) > breakStart);
    if (movable.length) {
      const earliest = movable.reduce((min, row) => Math.min(min, new Date(row.start_time).getTime()), Number.POSITIVE_INFINITY);
      const delta = Math.max(breakEnd.getTime() - earliest, breakEnd.getTime() - breakStart.getTime());
      const selectedIds = new Set(movable.map((row) => String(row._id)));
      const unaffected = rows.filter((row) => !selectedIds.has(String(row._id)));
      const plans = movable.map((row) => {
        const start = new Date(new Date(row.start_time).getTime() + delta);
        const end = new Date(start.getTime() + durationMinutes(row) * 60000);
        return { row, start, end };
      });
      const futureBreaks = [...(ctx.doctorDay.breaks || []), { startTime: breakStart, endTime: breakEnd }];
      for (const plan of plans) {
        const otherPlanned = plans
          .filter((candidate) => String(candidate.row._id) !== String(plan.row._id))
          .map((candidate) => ({ _id: candidate.row._id, start_time: candidate.start, end_time: candidate.end }));
        assertCandidate({
          start: plan.start,
          end: plan.end,
          dateKey: ctx.dateKey,
          timeZone: ctx.timeZone,
          doctor: ctx.doctor,
          breaks: futureBreaks,
          unaffected: [...unaffected, ...otherPlanned],
        });
      }
      for (const plan of plans) {
        plan.row.start_time = plan.start;
        plan.row.end_time = plan.end;
        plan.row.duration = durationMinutes(plan.row);
        updateCalendarReservation(ctx.doctorDay, plan.row);
        changed.push(plan.row);
      }
    }
  }

  ctx.doctorDay.breaks.push({ startTime: breakStart, endTime: breakEnd, reason: String(reason || 'Doctor unavailable').trim() || 'Doctor unavailable' });
  await Promise.all([...changed, ...cancelled].map((row) => row.save()));
  await ctx.calendar.save();

  return {
    date: ctx.dateKey,
    block: { startTime: breakStart, endTime: breakEnd, reason: String(reason || 'Doctor unavailable').trim() || 'Doctor unavailable' },
    moved: changed.map((row) => ({ _id: row._id, department_id: row.department_id, start_time: row.start_time, end_time: row.end_time })),
    cancelled: cancelled.map((row) => ({ _id: row._id, department_id: row.department_id })),
  };
}

module.exports = {
  getDoctorDay,
  bulkShift,
  createBlock,
  shiftFollowingIntoCancelledSlot,
};
