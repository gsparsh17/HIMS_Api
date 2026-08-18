'use strict';

const {
  parts,
  dateKey: instantDateKey,
  addDays,
  zonedUtc
} = require('./clinicalDate');

const DEFAULT_HOSPITAL_TIME_ZONE =
  process.env.HOSPITAL_TIMEZONE ||
  process.env.HOSPITAL_TIME_ZONE ||
  'Asia/Kolkata';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const EXPLICIT_OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;

function assertTimeZone(timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return timeZone;
  } catch (_error) {
    const error = new Error(`Invalid hospital timezone: ${timeZone}`);
    error.code = 'INVALID_HOSPITAL_TIMEZONE';
    throw error;
  }
}

function isDateKey(value) {
  return typeof value === 'string' && DATE_KEY_PATTERN.test(value);
}

function validateDateKey(value) {
  if (!isDateKey(value)) {
    const error = new Error(`Invalid date key: ${value}`);
    error.code = 'INVALID_DATE_KEY';
    throw error;
  }

  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    const error = new Error(`Invalid calendar date: ${value}`);
    error.code = 'INVALID_DATE_KEY';
    throw error;
  }

  return value;
}

/**
 * Return the hospital-local calendar key (YYYY-MM-DD).
 * Date-only strings are semantic dates and are never passed through Date parsing.
 */
function hospitalDateKey(value = new Date(), timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  assertTimeZone(timeZone);
  if (isDateKey(value)) return validateDateKey(value);

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Invalid date/time value: ${value}`);
    error.code = 'INVALID_DATE_TIME';
    throw error;
  }

  return instantDateKey(parsed, timeZone);
}

/**
 * Store semantic calendar dates at UTC midnight. The Date value is a sentinel,
 * not an instant to display in the user's local timezone.
 */
function dateKeyToStorageDate(dateKey) {
  const key = validateDateKey(dateKey);
  return new Date(`${key}T00:00:00.000Z`);
}

function addDateKeyDays(dateKey, count) {
  return addDays(validateDateKey(dateKey), Number(count || 0));
}

function hospitalTodayKey(timeZone = DEFAULT_HOSPITAL_TIME_ZONE, now = new Date()) {
  return hospitalDateKey(now, timeZone);
}

function dateKeyDayName(dateKey) {
  const key = validateDateKey(dateKey);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: 'UTC'
  }).format(new Date(`${key}T12:00:00.000Z`));
}

function hospitalDayBounds(dateKey, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  const key = validateDateKey(dateKey);
  const zone = assertTimeZone(timeZone);
  return {
    start: zonedUtc(key, 0, 0, zone),
    end: zonedUtc(addDateKeyDays(key, 1), 0, 0, zone)
  };
}

function parseWallClock(timeText) {
  const match = WALL_CLOCK_PATTERN.exec(String(timeText || '').trim());
  if (!match) {
    const error = new Error(`Invalid wall-clock time: ${timeText}`);
    error.code = 'INVALID_WALL_CLOCK_TIME';
    throw error;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    const error = new Error(`Invalid wall-clock time: ${timeText}`);
    error.code = 'INVALID_WALL_CLOCK_TIME';
    throw error;
  }

  return { hour, minute, second };
}

/**
 * Convert hospital wall time to a UTC instant.
 *
 * Accepted inputs:
 * - Date / timestamp with Z or explicit offset: treated as an absolute instant.
 * - HH:mm[:ss]: interpreted on appointmentDateKey in hospital timezone.
 * - YYYY-MM-DDTHH:mm[:ss] with no offset: interpreted as hospital wall time.
 *
 * This deliberately avoids JavaScript's environment-dependent parsing of a
 * timezone-less datetime string.
 */
function parseHospitalDateTime(value, appointmentDateKey, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  const zone = assertTimeZone(timeZone);
  const fallbackDateKey = appointmentDateKey ? validateDateKey(appointmentDateKey) : null;

  if (value instanceof Date || typeof value === 'number') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      const error = new Error(`Invalid date/time value: ${value}`);
      error.code = 'INVALID_DATE_TIME';
      throw error;
    }
    return parsed;
  }

  const text = String(value || '').trim();
  if (!text) {
    const error = new Error('Date/time value is required');
    error.code = 'INVALID_DATE_TIME';
    throw error;
  }

  if (EXPLICIT_OFFSET_PATTERN.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      const error = new Error(`Invalid date/time value: ${value}`);
      error.code = 'INVALID_DATE_TIME';
      throw error;
    }
    return parsed;
  }

  const wallClockMatch = WALL_CLOCK_PATTERN.exec(text);
  if (wallClockMatch) {
    if (!fallbackDateKey) {
      const error = new Error('A hospital date is required for a wall-clock time');
      error.code = 'DATE_KEY_REQUIRED';
      throw error;
    }
    const { hour, minute, second } = parseWallClock(text);
    const instant = zonedUtc(fallbackDateKey, hour, minute, zone);
    if (second) instant.setUTCSeconds(instant.getUTCSeconds() + second);
    return instant;
  }

  const localDateTimeMatch = LOCAL_DATE_TIME_PATTERN.exec(text);
  if (localDateTimeMatch) {
    const localDateKey = validateDateKey(localDateTimeMatch[1]);
    if (fallbackDateKey && localDateKey !== fallbackDateKey) {
      const error = new Error(
        `Date/time ${text} does not belong to appointment date ${fallbackDateKey}`
      );
      error.code = 'DATE_TIME_DATE_MISMATCH';
      throw error;
    }
    const hour = Number(localDateTimeMatch[2]);
    const minute = Number(localDateTimeMatch[3]);
    const second = Number(localDateTimeMatch[4] || 0);
    if (hour > 23 || minute > 59 || second > 59) {
      const error = new Error(`Invalid date/time value: ${value}`);
      error.code = 'INVALID_DATE_TIME';
      throw error;
    }
    const instant = zonedUtc(localDateKey, hour, minute, zone);
    if (second) instant.setUTCSeconds(instant.getUTCSeconds() + second);
    return instant;
  }

  // Date-only values are not valid appointment times.
  if (isDateKey(text)) {
    const error = new Error(`A time is required: ${text}`);
    error.code = 'TIME_REQUIRED';
    throw error;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Invalid date/time value: ${value}`);
    error.code = 'INVALID_DATE_TIME';
    throw error;
  }
  return parsed;
}

function hospitalTimeParts(value, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Invalid date/time value: ${value}`);
    error.code = 'INVALID_DATE_TIME';
    throw error;
  }
  return parts(parsed, assertTimeZone(timeZone));
}

function formatHospitalTime(value, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  const p = hospitalTimeParts(value, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function assertInstantOnHospitalDate(value, dateKey, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  const key = validateDateKey(dateKey);
  const actualKey = hospitalDateKey(value, timeZone);
  if (actualKey !== key) {
    const error = new Error(
      `Scheduled time belongs to ${actualKey}, not appointment date ${key}`
    );
    error.code = 'DATE_TIME_DATE_MISMATCH';
    error.expectedDate = key;
    error.actualDate = actualKey;
    throw error;
  }
  return true;
}

function calendarDayKey(dayOrDate, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  if (dayOrDate && typeof dayOrDate === 'object' && !(dayOrDate instanceof Date)) {
    if (isDateKey(dayOrDate.dateKey)) return validateDateKey(dayOrDate.dateKey);
    if (dayOrDate.date !== undefined) return hospitalDateKey(dayOrDate.date, timeZone);
  }
  return hospitalDateKey(dayOrDate, timeZone);
}

function canonicalBookingFingerprint({
  hospitalId,
  patientId,
  doctorId,
  appointmentDateKey,
  type,
  startTime
}) {
  const partsOut = [
    String(hospitalId || ''),
    String(patientId || ''),
    String(doctorId || ''),
    validateDateKey(appointmentDateKey),
    String(type || '')
  ];
  if (type === 'time-based') {
    partsOut.push(startTime ? new Date(startTime).toISOString() : '');
  }
  return partsOut.join('|');
}

module.exports = {
  DEFAULT_HOSPITAL_TIME_ZONE,
  isDateKey,
  validateDateKey,
  hospitalDateKey,
  dateKeyToStorageDate,
  addDateKeyDays,
  hospitalTodayKey,
  dateKeyDayName,
  hospitalDayBounds,
  parseHospitalDateTime,
  hospitalTimeParts,
  formatHospitalTime,
  assertInstantOnHospitalDate,
  calendarDayKey,
  canonicalBookingFingerprint
};
