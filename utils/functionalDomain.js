'use strict';
const crypto = require('crypto');
const { assertSafeOutboundUrl } = require('./safeOutboundUrl');
function hospitalId(req) {
  return req.user?.hospital_id?._id || req.user?.hospital_id || req.user?.hospitalId?._id || req.user?.hospitalId;
}
function ref(prefix) { return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function required(body, fields) {
  const missing = fields.filter((field) => body?.[field] === undefined || body?.[field] === null || body?.[field] === '');
  if (missing.length) { const e = new Error(`Missing required field(s): ${missing.join(', ')}`); e.statusCode = 400; throw e; }
}
function sendError(res, error, fallback = 400) {
  if (error?.code === 11000) return res.status(409).json({ error: 'Duplicate record', details: error.keyValue });
  const status = Number(error?.statusCode || error?.status || fallback);
  return res.status(status).json({ error: error?.message || 'Request failed' });
}

async function postProviderJson(rawUrl, payload, options = {}) {
  const allowedHosts = Array.isArray(options.allowedHosts)
    ? options.allowedHosts
    : String(options.allowedHosts || '').split(',').map((x) => x.trim()).filter(Boolean);
  const production = process.env.NODE_ENV === 'production';
  const safeUrl = await assertSafeOutboundUrl(rawUrl, {
    label: options.label || 'Provider URL',
    allowedHosts,
    requireAllowlist: production,
    requireHttps: production,
    allowPrivate: !production,
    allowedPorts: options.allowedPorts || []
  });
  const fetchFn = typeof fetch === 'function'
    ? fetch
    : (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
  let response;
  try {
    response = await fetchFn(safeUrl, {
      method: options.method || 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(options.timeoutMs || 15000))
    });
  } catch (cause) {
    const error = new Error(`${options.label || 'Provider'} is unavailable`);
    error.statusCode = 503;
    error.cause = cause;
    throw error;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `${options.label || 'Provider'} returned HTTP ${response.status}`);
    error.statusCode = response.status >= 500 ? 503 : response.status;
    error.details = body;
    throw error;
  }
  return body;
}
module.exports = { hospitalId, ref, required, sendError, postProviderJson };
