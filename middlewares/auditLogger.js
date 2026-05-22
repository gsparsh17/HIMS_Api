const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');

const SENSITIVE_KEY_PATTERN = /(password|passcode|token|secret|authorization|cookie|otp|pin|api[_-]?key|refresh|access)/i;
const MAX_SERIALIZED_LENGTH = 8000;

function cloneAndRedact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[MaxDepth]';

  if (Buffer.isBuffer(value)) return `[Buffer:${value.length}]`;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => cloneAndRedact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const output = {};
    Object.entries(value).slice(0, 100).forEach(([key, item]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = cloneAndRedact(item, depth + 1);
      }
    });
    return output;
  }

  if (typeof value === 'string' && value.length > 1000) {
    return `${value.slice(0, 1000)}...[truncated]`;
  }

  return value;
}

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
    req.hospitalId ||
    req.user?.hospitalId ||
    req.user?.hospitalID ||
    req.body?.hospitalId ||
    req.body?.hospitalID ||
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
          userAgent: req.headers['user-agent'],
        },
        response: {
          statusCode: res.statusCode,
          success: res.statusCode < 400,
          responseTimeMs: Date.now() - start,
        },
        resource: req.auditResource,
        error: req.auditError,
        metadata: req.auditMetadata,
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
