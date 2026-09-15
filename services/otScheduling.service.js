'use strict';

const { currentContext } = require('../utils/operationTimeContext');

const ACTIVE_CASE_STATUSES = Object.freeze(['Scheduled', 'Patient Received', 'In Progress', 'Recovery']);
const ACTIVE_TEAM_STATUSES = Object.freeze(['Scheduled', 'Patient Received', 'In Progress']);
const MAX_BUFFER_MINUTES = 240;
const MAX_DURATION_MINUTES = 24 * 60;

function idString(value) {
  if (!value) return '';
  return String(value?._id || value);
}

function clampMinutes(value, fallback = 0, max = MAX_BUFFER_MINUTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.round(parsed)));
}

function blockedInterval({ scheduledStart, scheduledEnd, setupBufferMinutes = 0, cleaningBufferMinutes = 0 }) {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw Object.assign(new Error('Valid surgery start and end are required'), { statusCode: 400 });
  }
  const setup = clampMinutes(setupBufferMinutes);
  const cleaning = clampMinutes(cleaningBufferMinutes);
  return {
    scheduledStart: start,
    scheduledEnd: end,
    setupBufferMinutes: setup,
    cleaningBufferMinutes: cleaning,
    blockedStart: new Date(start.getTime() - setup * 60000),
    blockedEnd: new Date(end.getTime() + cleaning * 60000)
  };
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart).getTime() < new Date(bEnd).getTime()
    && new Date(aEnd).getTime() > new Date(bStart).getTime();
}

function caseBlockedInterval(row) {
  return blockedInterval({
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    setupBufferMinutes: row.setupBufferMinutes,
    cleaningBufferMinutes: row.cleaningBufferMinutes
  });
}

function teamAssignments(payload = {}, existing = {}) {
  const source = { ...existing, ...payload };
  return [
    ['doctor', 'Primary Surgeon', 'primarySurgeonId'],
    ['doctor', 'Assistant Surgeon', 'assistantSurgeonId'],
    ['doctor', 'Anaesthetist', 'anesthetistId'],
    ['nurse', 'Scrub Nurse', 'scrubNurseId'],
    ['nurse', 'Circulating Nurse', 'circulatingNurseId'],
    ['otstaff', 'OT Roster Staff', 'otStaffId']
  ].map(([kind, role, field]) => ({ kind, role, field, id: idString(source[field]) })).filter((row) => row.id);
}

function sameResource(a, b) {
  return a.kind === b.kind && a.id && b.id && a.id === b.id;
}

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dayOfWeek: dayMap[parts.weekday],
    minutes: Number(parts.hour || 0) * 60 + Number(parts.minute || 0)
  };
}

function parseClock(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

function shiftContains(shift, startParts, endParts) {
  if (Number(shift.dayOfWeek) !== Number(startParts.dayOfWeek)) return false;
  const from = parseClock(shift.startTime);
  const to = parseClock(shift.endTime);
  if (from === null || to === null) return false;
  if (startParts.dayOfWeek === endParts.dayOfWeek) {
    if (to >= from) return startParts.minutes >= from && endParts.minutes <= to;
    // Overnight shift declared on start day.
    return startParts.minutes >= from || endParts.minutes <= to;
  }
  // A schedule crossing midnight is valid only for an overnight shift.
  return to < from && startParts.minutes >= from && endParts.minutes <= to;
}

function staffAvailabilityConflicts(staff, interval, timeZone) {
  const conflicts = [];
  for (const range of staff?.unavailableRanges || []) {
    if (range?.from && range?.to && intervalsOverlap(interval.blockedStart, interval.blockedEnd, range.from, range.to)) {
      conflicts.push({
        type: 'STAFF_UNAVAILABLE',
        resourceType: 'otstaff',
        resourceId: idString(staff._id),
        role: staff.designation || 'OT Staff',
        reason: range.reason || 'Marked unavailable',
        unavailableFrom: range.from,
        unavailableTo: range.to
      });
    }
  }
  if (Array.isArray(staff?.shiftAvailability) && staff.shiftAvailability.length) {
    const startParts = localParts(interval.blockedStart, timeZone);
    const endParts = localParts(interval.blockedEnd, timeZone);
    if (!staff.shiftAvailability.some((shift) => shiftContains(shift, startParts, endParts))) {
      conflicts.push({
        type: 'OUTSIDE_SHIFT',
        resourceType: 'otstaff',
        resourceId: idString(staff._id),
        role: staff.designation || 'OT Staff',
        reason: 'Selected slot is outside configured OT staff shift availability'
      });
    }
  }
  return conflicts;
}

async function findSchedulingConflicts({
  hospitalId,
  requestId,
  roomId,
  scheduledStart,
  scheduledEnd,
  setupBufferMinutes,
  cleaningBufferMinutes,
  team = {},
  session
}) {
  // Lazy model imports keep the interval/availability helpers independently testable.
  const OTRequest = require('../models/OTRequest');
  const OTStaff = require('../models/OTStaff');
  const requested = blockedInterval({ scheduledStart, scheduledEnd, setupBufferMinutes, cleaningBufferMinutes });
  const padMs = MAX_BUFFER_MINUTES * 60000;
  const query = OTRequest.find({
    hospitalId,
    _id: { $ne: requestId },
    status: { $in: ACTIVE_CASE_STATUSES },
    scheduledStart: { $lt: new Date(requested.blockedEnd.getTime() + padMs) },
    scheduledEnd: { $gt: new Date(requested.blockedStart.getTime() - padMs) }
  }).select('_id requestNumber status otRoomId scheduledStart scheduledEnd setupBufferMinutes cleaningBufferMinutes primarySurgeonId assistantSurgeonId anesthetistId scrubNurseId circulatingNurseId otStaffId');
  if (session) query.session(session);
  const existingCases = await query.lean();
  const requestedTeam = teamAssignments(team);
  const conflicts = [];

  for (const existing of existingCases) {
    let existingInterval;
    try { existingInterval = caseBlockedInterval(existing); }
    catch (_) { continue; }
    if (!intervalsOverlap(requested.blockedStart, requested.blockedEnd, existingInterval.blockedStart, existingInterval.blockedEnd)) continue;

    if (roomId && idString(existing.otRoomId) === idString(roomId)) {
      conflicts.push({
        type: 'ROOM_BUSY',
        resourceType: 'room',
        resourceId: idString(roomId),
        conflictingCaseId: idString(existing._id),
        conflictingRequestNumber: existing.requestNumber,
        conflictingStatus: existing.status,
        blockedStart: existingInterval.blockedStart,
        blockedEnd: existingInterval.blockedEnd
      });
    }

    const existingTeam = ACTIVE_TEAM_STATUSES.includes(existing.status) ? teamAssignments(existing) : [];
    for (const requestedMember of requestedTeam) {
      const matched = existingTeam.find((member) => sameResource(member, requestedMember));
      if (!matched) continue;
      conflicts.push({
        type: 'STAFF_BUSY',
        resourceType: requestedMember.kind,
        resourceId: requestedMember.id,
        role: requestedMember.role,
        conflictingRole: matched.role,
        conflictingCaseId: idString(existing._id),
        conflictingRequestNumber: existing.requestNumber,
        conflictingStatus: existing.status,
        blockedStart: existingInterval.blockedStart,
        blockedEnd: existingInterval.blockedEnd
      });
    }
  }

  const otStaffAssignment = requestedTeam.find((row) => row.kind === 'otstaff');
  if (otStaffAssignment) {
    const staffQuery = OTStaff.findOne({ _id: otStaffAssignment.id, hospitalId, is_active: { $ne: false }, is_deleted: { $ne: true } });
    if (session) staffQuery.session(session);
    const staff = await staffQuery.lean();
    if (!staff) {
      conflicts.push({ type: 'STAFF_NOT_AVAILABLE', resourceType: 'otstaff', resourceId: otStaffAssignment.id, role: otStaffAssignment.role, reason: 'OT staff record is inactive or unavailable' });
    } else {
      conflicts.push(...staffAvailabilityConflicts(staff, requested, currentContext()?.timeZone));
      const simultaneous = existingCases.filter((row) => {
        if (!ACTIVE_TEAM_STATUSES.includes(row.status) || idString(row.otStaffId) !== otStaffAssignment.id) return false;
        try {
          const interval = caseBlockedInterval(row);
          return intervalsOverlap(requested.blockedStart, requested.blockedEnd, interval.blockedStart, interval.blockedEnd);
        } catch (_) { return false; }
      }).length;
      if (simultaneous >= Number(staff.maxSimultaneousCases || 1)) {
        conflicts.push({
          type: 'STAFF_CAPACITY',
          resourceType: 'otstaff',
          resourceId: otStaffAssignment.id,
          role: staff.designation || otStaffAssignment.role,
          maxSimultaneousCases: Number(staff.maxSimultaneousCases || 1),
          activeConflicts: simultaneous
        });
      }
    }
  }

  return { ...requested, conflicts };
}

function validateDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_MINUTES) {
    throw Object.assign(new Error(`Duration must be between 1 and ${MAX_DURATION_MINUTES} minutes`), { statusCode: 400 });
  }
  return Math.round(duration);
}

module.exports = {
  ACTIVE_CASE_STATUSES,
  ACTIVE_TEAM_STATUSES,
  MAX_BUFFER_MINUTES,
  MAX_DURATION_MINUTES,
  idString,
  clampMinutes,
  blockedInterval,
  intervalsOverlap,
  teamAssignments,
  staffAvailabilityConflicts,
  findSchedulingConflicts,
  validateDuration
};
