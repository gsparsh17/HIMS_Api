const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');
const { userHospitalId } = require('../utils/hospitalScope');
const { cloneAndRedact, redactSensitiveText } = require('../utils/sensitiveData');
const MAX_SERIALIZED_LENGTH = 8000;

function limitSize(value) {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length <= MAX_SERIALIZED_LENGTH) return value;
    return {
      truncated: true,
      message: `Audit payload exceeded ${MAX_SERIALIZED_LENGTH} characters`,
      preview: serialized.slice(0, MAX_SERIALIZED_LENGTH),
    };
  } catch (error) {
    return { unserializable: true };
  }
}

function getIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
}

function buildActor(req) {
  if (req.auditActor) return req.auditActor;
  if (!req.user) return undefined;

  return {
    userId: req.user._id || req.user.id,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
  };
}

function getHospitalId(req) {
  return (
    req.hospital_id ||
    req.hospitalId ||
    userHospitalId(req.user) ||
    req.body?.hospital_id ||
    req.body?.hospitalId ||
    req.body?.hospitalID ||
    req.params?.hospital_id ||
    req.params?.hospitalId ||
    undefined
  );
}

function auditLogger(options = {}) {
  const apiPrefix = options.apiPrefix || '/api';
  const ignoredPaths = options.ignoredPaths || [];

  return (req, res, next) => {
    if (!req.originalUrl.startsWith(apiPrefix)) return next();
    if (ignoredPaths.some((path) => req.originalUrl.startsWith(path))) return next();

    const start = Date.now();
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      const headers = cloneAndRedact({
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        referer: req.headers.referer,
        origin: req.headers.origin,
      });

      const auditPayload = {
        requestId,
        actor: buildActor(req),
        hospitalId: getHospitalId(req),
        request: {
          method: req.method,
          originalUrl: req.originalUrl,
          baseUrl: req.baseUrl,
          path: req.path,
          params: limitSize(cloneAndRedact(req.params || {})),
          query: limitSize(cloneAndRedact(req.query || {})),
          body: limitSize(cloneAndRedact(req.body || {})),
          headers,
          ip: getIp(req),
          userAgent: redactSensitiveText(req.headers['user-agent'] || ''),
        },
        response: {
          statusCode: res.statusCode,
          success: res.statusCode < 400,
          responseTimeMs: Date.now() - start,
        },
        resource: req.auditResource,
        error: cloneAndRedact(req.auditError),
        metadata: cloneAndRedact(req.auditMetadata),
      };

      AuditLog.create(auditPayload).catch((error) => {
        // Audit logging must never break the API response.
        console.error('Audit log write failed:', error.message);
      });
    });

    next();
  };
}

module.exports = auditLogger;
