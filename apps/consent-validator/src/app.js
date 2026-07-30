const express = require('express');
const helmet = require('helmet');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { config } = require('./config');
const { safeEqual, sha256 } = require('./canonical');
const { jwksStore } = require('./trust');
const {
  validateConsent,
  recordStatusEvent,
  commitReservation,
  releaseReservation
} = require('./service');

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: config.requestBodyLimit, strict: true }));

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
app.use(noStore);

const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => sha256(String(req.headers[config.serviceTokenHeader] || req.ip || 'unknown')),
  message: {
    valid: false,
    decision: 'DENY',
    code: 'CONSENT_VALIDATOR_RATE_LIMITED',
    message: 'Consent validator request rate limit exceeded'
  }
});

function serviceAuth(req, res, next) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const headerToken = String(req.headers[config.serviceTokenHeader] || '').trim();
  const token = bearer || headerToken;
  if (!token || !safeEqual(token, config.serviceToken)) {
    return res.status(401).json({
      code: 'SERVICE_AUTH_FAILED',
      message: 'Consent validator service authentication failed'
    });
  }
  return next();
}

app.get('/health/live', (_req, res) => {
  res.json({ healthy: true, status: 'up', service: config.serviceName, version: config.version });
});

app.get(['/health', '/health/ready'], async (_req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  const trust = jwksStore.status();
  const trustReady = trust.ready;
  const healthy = databaseReady && trustReady;
  const capabilities = {
    signatureVerification: true,
    integrityVerification: true,
    lifecycleValidation: true,
    scopeValidation: true,
    purposeValidation: true,
    hiTypeValidation: true,
    identityValidation: true,
    frequencyEnforcement: true,
    retentionEnforcement: true,
    durableUsageLedger: true,
    operationBinding: true
  };
  const productionCapable = healthy && !config.allowUnsignedSandboxArtefacts &&
    Object.values(capabilities).every((value) => value === true);
  res.status(healthy ? 200 : 503).json({
    healthy,
    status: healthy ? 'up' : 'down',
    service: config.serviceName,
    version: config.version,
    environment: config.environment,
    databaseReady,
    trustReady,
    productionCapable,
    trust,
    capabilities
  });
});

app.get('/version', (_req, res) => {
  res.json({
    service: config.serviceName,
    version: config.version,
    apiVersion: 'v1',
    environment: config.environment
  });
});

app.use('/v1', apiLimiter, serviceAuth);
app.post('/v1/validate', async (req, res, next) => {
  try {
    const result = await validateConsent(req.body || {});
    return res.status(result.decision === 'PERMIT' ? 200 : 422).json(result);
  } catch (error) {
    return next(error);
  }
});

// Backward-compatible alias. Keep it authenticated and rate-limited; new clients must use /v1/validate.
app.post('/validate', apiLimiter, serviceAuth, async (req, res, next) => {
  try {
    const result = await validateConsent(req.body || {});
    return res.status(result.decision === 'PERMIT' ? 200 : 422).json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/status-events', async (req, res, next) => {
  try {
    return res.status(202).json(await recordStatusEvent(req.body || {}));
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/usage/:reservationId/commit', async (req, res, next) => {
  try {
    const reservation = await commitReservation(req.params.reservationId);
    return res.json({
      success: true,
      reservationId: reservation.reservationId,
      status: reservation.status,
      committedAt: reservation.committedAt
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/usage/:reservationId/release', async (req, res, next) => {
  try {
    const reservation = await releaseReservation(req.params.reservationId);
    return res.json({
      success: true,
      reservationId: reservation?.reservationId || req.params.reservationId,
      status: reservation?.status || 'NOT_FOUND'
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.statusCode || 500;
  const publicStatus = status >= 500 ? 503 : status;
  return res.status(publicStatus).json({
    valid: false,
    decision: 'DENY',
    code: error.code || 'CONSENT_VALIDATION_FAILED',
    message: status >= 500 ? 'Consent validation service failed closed' : error.message,
    errors: error.details?.errors || error.details?.issues || undefined
  });
});

module.exports = app;
