const { DEFAULT_TIMEZONE } = require('../config/clinicalScoring');

function formatter(timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
}

function parts(date, timeZone = DEFAULT_TIMEZONE) {
  const values = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(date))
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value])
  );
  
  return {
    year: +values.year,
    month: +values.month,
    day: +values.day,
    hour: +values.hour,
    minute: +values.minute,
    second: +values.second
  };
}

function dateKey(date, timeZone = DEFAULT_TIMEZONE) {
  const p = parts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function addDays(key, count) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

// Convert a local YYYY-MM-DD HH:mm wall time in an IANA zone to UTC.
// Iterating against Intl-formatted parts handles non-UTC offsets and DST transitions.
function zonedUtc(key, hour, minute = 0, timeZone = DEFAULT_TIMEZONE) {
  const [y, m, d] = key.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour, minute, 0);
  let guess = target;
  
  for (let i = 0; i < 4; i += 1) {
    const local = parts(new Date(guess), timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const delta = target - localAsUtc;
    
    if (delta === 0) break;
    guess += delta;
  }
  
  return new Date(guess);
}

function clinicalContext(recordedAt, timeZone = DEFAULT_TIMEZONE) {
  const p = parts(recordedAt, timeZone);
  let key = dateKey(recordedAt, timeZone);
  
  if (p.hour < 6) {
    key = addDays(key, -1);
  }
  
  const clinicalShift = p.hour >= 6 && p.hour < 14
    ? 'M'
    : p.hour >= 14 && p.hour < 22
      ? 'E'
      : 'N';
  
  return {
    chartDate: key,
    clinicalShift,
    timezone: timeZone
  };
}

function clinicalDayBounds(chartDate, timeZone = DEFAULT_TIMEZONE) {
  const start = zonedUtc(chartDate, 6, 0, timeZone);
  const end = zonedUtc(addDays(chartDate, 1), 6, 0, timeZone);
  
  return { start, end };
}

function formatClinicalTime(date, timeZone = DEFAULT_TIMEZONE) {
  const p = parts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

module.exports = {
  parts,
  dateKey,
  addDays,
  zonedUtc,
  clinicalContext,
  clinicalDayBounds,
  formatClinicalTime
};