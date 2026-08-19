'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { hospitalDateKey, parseHospitalDateTime, assertTimeZone } = (() => {
  const dt = require('./hospitalDateTime');
  return { ...dt, assertTimeZone: dt.assertTimeZone || ((tz) => tz) };
})();

const storage = new AsyncLocalStorage();
const HEADER = 'x-effective-operation-time';
const SOURCE_HEADER = 'x-effective-operation-source';

function featureEnabled() {
  return String(process.env.EFFECTIVE_OPERATION_TIME_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function cloneDate(value) {
  return new Date((value instanceof Date ? value : new Date(value)).getTime());
}

function currentContext() {
  return storage.getStore() || null;
}

function operationNow(fallback = new Date()) {
  const ctx = currentContext();
  return cloneDate(ctx?.effectiveAt || fallback);
}

function operationDateKey(timeZone) {
  const ctx = currentContext();
  const zone = timeZone || ctx?.timeZone;
  return hospitalDateKey(ctx?.effectiveAt || new Date(), zone);
}

function isBackdatedOperation() {
  return Boolean(currentContext()?.overridden);
}

function operationMetadata() {
  const ctx = currentContext();
  if (!ctx) return { overridden: false, source: 'SYSTEM' };
  return {
    overridden: Boolean(ctx.overridden),
    source: ctx.source || (ctx.overridden ? 'DATE_SETTER' : 'SYSTEM'),
    effectiveAt: cloneDate(ctx.effectiveAt),
    actualRequestAt: cloneDate(ctx.actualRequestAt),
    timeZone: ctx.timeZone
  };
}

function runWithOperationTime(context, fn) {
  return storage.run(context, fn);
}

function parseEffectiveHeader(rawValue, timeZone) {
  if (!rawValue) return null;
  const parsed = parseHospitalDateTime(String(rawValue), null, timeZone);
  const now = new Date();
  const maxFutureMs = Number(process.env.EFFECTIVE_OPERATION_MAX_FUTURE_MINUTES || 5) * 60 * 1000;
  if (parsed.getTime() > now.getTime() + maxFutureMs) {
    const error = new Error('Effective operation time cannot be in the future');
    error.statusCode = 400;
    error.code = 'EFFECTIVE_TIME_IN_FUTURE';
    throw error;
  }
  return parsed;
}

module.exports = {
  HEADER,
  SOURCE_HEADER,
  featureEnabled,
  currentContext,
  operationNow,
  operationDateKey,
  isBackdatedOperation,
  operationMetadata,
  runWithOperationTime,
  parseEffectiveHeader
};
