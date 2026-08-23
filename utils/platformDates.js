function invalidDateError(fieldName) {
  const error = new Error(`${fieldName} must be a valid ISO date`);
  error.statusCode = 400;
  error.code = 'INVALID_PLATFORM_DATE';
  return error;
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalidDateError(fieldName);
  return date;
}

function parseDateOrNow(value, fieldName) {
  return parseOptionalDate(value, fieldName) || new Date();
}

module.exports = { parseOptionalDate, parseDateOrNow };
