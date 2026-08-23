const { assertPatientAccess } = require('../services/patientAccessPolicy.service');
const { userHospitalId, isPlatformAdmin } = require('../utils/hospitalScope');

function valueAt(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((acc, key) => acc?.[key], obj);
}

function resolvePatientId(req, options) {
  if (options.resolvePatientId) return options.resolvePatientId(req);
  const param = options.patientParam || 'id';
  return req.params?.[param] || valueAt(req.body, options.bodyPath || 'patientId') || valueAt(req.query, options.queryPath || 'patientId');
}

function requirePatientAccess(options = {}) {
  return async (req, res, next) => {
    try {
      const patientId = await resolvePatientId(req, options);
      if (!patientId) {
        if (options.optional) return next();
        return res.status(400).json({ success: false, code: 'PATIENT_CONTEXT_REQUIRED', error: 'Patient context is required for this operation' });
      }
      const decision = await assertPatientAccess({
        user: req.user,
        patientId,
        hospitalId: userHospitalId(req.user),
        purpose: options.purpose || 'AUTO',
        scope: options.scope || 'clinical_read'
      });
      req.patientAccessDecision = decision;
      req.auditMetadata = {
        ...(req.auditMetadata || {}),
        patientAccess: {
          patientId: String(patientId),
          purpose: decision.purpose,
          scope: decision.scope,
          allowed: decision.allowed,
          mode: decision.mode,
          reason: decision.reason,
          breakGlassGrantId: decision.breakGlassGrantId,
          signals: decision.signals
        }
      };
      if (!decision.allowed && decision.mode === 'shadow') {
        res.setHeader('X-MediQliq-Patient-Access-Shadow', 'would-deny');
      }
      return next();
    } catch (error) {
      req.auditError = { message: error.message, code: error.code };
      req.auditMetadata = { ...(req.auditMetadata || {}), patientAccess: error.decision };
      return res.status(error.statusCode || 403).json({ success: false, code: error.code || 'PATIENT_CONTEXT_ACCESS_DENIED', error: error.message });
    }
  };
}


function requireResourcePatientAccess(Model, options = {}) {
  return async (req, res, next) => {
    try {
      const id = req.params?.[options.idParam || 'id'];
      if (!id) return res.status(400).json({ success: false, code: 'RESOURCE_CONTEXT_REQUIRED', error: 'Resource id is required' });
      const hospitalField = options.hospitalField || 'hospitalId';
      const scopedHospitalId = userHospitalId(req.user);
      const lookup = { _id: id };
      // Avoid turning resource IDs into a cross-tenant existence oracle. Hospital users
      // only query resources inside their own tenant; platform admins may explicitly
      // inspect a resource and the patient policy below still evaluates its hospital.
      if (!isPlatformAdmin(req.user) && scopedHospitalId) lookup[hospitalField] = scopedHospitalId;
      const resource = await Model.findOne(lookup).select(`${options.patientField || 'patientId'} ${hospitalField}`).lean();
      if (!resource) return res.status(404).json({ success: false, code: 'RESOURCE_NOT_FOUND', error: 'Resource not found' });
      const patientId = valueAt(resource, options.patientField || 'patientId');
      const resourceHospitalId = valueAt(resource, hospitalField);
      const decision = await assertPatientAccess({
        user: req.user,
        patientId,
        hospitalId: resourceHospitalId || userHospitalId(req.user),
        purpose: options.purpose || 'AUTO',
        scope: options.scope || 'clinical_read'
      });
      req.patientAccessDecision = decision;
      req.patientSecurityResource = resource;
      req.auditMetadata = { ...(req.auditMetadata || {}), patientAccess: { patientId: String(patientId), purpose: decision.purpose, scope: decision.scope, allowed: decision.allowed, mode: decision.mode, reason: decision.reason, breakGlassGrantId: decision.breakGlassGrantId, signals: decision.signals } };
      if (!decision.allowed && decision.mode === 'shadow') res.setHeader('X-MediQliq-Patient-Access-Shadow', 'would-deny');
      return next();
    } catch (error) {
      req.auditError = { message: error.message, code: error.code };
      return res.status(error.statusCode || 403).json({ success: false, code: error.code || 'PATIENT_CONTEXT_ACCESS_DENIED', error: error.message });
    }
  };
}

module.exports = { requirePatientAccess, requireResourcePatientAccess };
