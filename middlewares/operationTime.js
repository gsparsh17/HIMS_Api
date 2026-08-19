'use strict';

const Hospital = require('../models/Hospital');
const { userHospitalId } = require('../utils/hospitalScope');
const { DEFAULT_HOSPITAL_TIME_ZONE, parseHospitalDateTime } = require('../utils/hospitalDateTime');
const {
  HEADER,
  SOURCE_HEADER,
  featureEnabled,
  parseEffectiveHeader,
  runWithOperationTime
} = require('../utils/operationTimeContext');

const zoneCache = new Map();

const WALL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const BUSINESS_DATETIME_FIELDS = new Set([
  'admissionDate', 'dischargeDate', 'roundDateTime', 'noteDateTime', 'recordedAt', 'recorded_at',
  'assessmentTime', 'arrivalDateTime', 'requestedDate', 'scheduledDate', 'scheduledStart', 'scheduledEnd',
  'startedAt', 'completedAt', 'performedAt', 'reportedAt', 'releasedAt', 'resultEnteredAt', 'verifiedAt',
  'collectedAt', 'sample_collected_at', 'processing_started_at', 'processing_completed_at',
  'issue_date', 'sale_date', 'bill_date', 'chargeDate', 'serviceDate', 'paymentDate', 'paid_at',
  'dispensedAt', 'dispensed_at', 'dispensed_date', 'dispensing_date', 'administeredAt',
  'return_date', 'returned_at', 'settled_at', 'receivedAt', 'received_date', 'request_date',
  'transferDateTime', 'documentDate', 'occurredAt', 'incidentAt', 'screenedAt', 'entryDate'
]);

function normalizeBusinessDateTimes(value, timeZone, key = '') {
  if (Array.isArray(value)) {
    value.forEach((item) => normalizeBusinessDateTimes(item, timeZone, key));
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  Object.entries(value).forEach(([field, fieldValue]) => {
    if (typeof fieldValue === 'string' && BUSINESS_DATETIME_FIELDS.has(field) && WALL_DATETIME_RE.test(fieldValue)) {
      const dateKey = fieldValue.slice(0, 10);
      value[field] = parseHospitalDateTime(fieldValue, dateKey, timeZone).toISOString();
      return;
    }
    if (fieldValue && typeof fieldValue === 'object') normalizeBusinessDateTimes(fieldValue, timeZone, field);
  });
  return value;
}

const CACHE_MS = 5 * 60 * 1000;

async function hospitalTimeZone(req) {
  const hospitalId = req.hospital_id || req.hospitalId || userHospitalId(req.user);
  if (!hospitalId) return DEFAULT_HOSPITAL_TIME_ZONE;
  const key = String(hospitalId);
  const cached = zoneCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.timeZone;
  const hospital = await Hospital.findById(hospitalId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  zoneCache.set(key, { timeZone, expiresAt: Date.now() + CACHE_MS });
  return timeZone;
}

module.exports = async function operationTimeMiddleware(req, res, next) {
  try {
    const actualRequestAt = new Date();
    const timeZone = await hospitalTimeZone(req);
    const raw = featureEnabled() ? req.headers[HEADER] : null;
    const effectiveAt = raw ? parseEffectiveHeader(raw, timeZone) : actualRequestAt;
    if (req.body && typeof req.body === 'object') normalizeBusinessDateTimes(req.body, timeZone);
    const overridden = Boolean(raw);
    const context = {
      effectiveAt,
      actualRequestAt,
      timeZone,
      overridden,
      source: overridden ? String(req.headers[SOURCE_HEADER] || 'DATE_SETTER') : 'SYSTEM',
      userId: req.user?._id ? String(req.user._id) : null,
      hospitalId: String(req.hospital_id || req.hospitalId || userHospitalId(req.user) || '')
    };

    req.operationTime = context;
    res.setHeader('X-Operation-Timezone', timeZone);
    res.setHeader('X-Operation-Time-Mode', overridden ? 'OVERRIDE' : 'SYSTEM');
    return runWithOperationTime(context, next);
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || 'Invalid effective operation time',
      code: error.code || 'INVALID_EFFECTIVE_OPERATION_TIME'
    });
  }
};
