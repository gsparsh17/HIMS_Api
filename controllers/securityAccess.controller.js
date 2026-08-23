const crypto = require('crypto');
const User = require('../models/User');
const Patient = require('../models/Patient');
const BreakGlassGrant = require('../models/BreakGlassGrant');
const PrivilegedAccessRequest = require('../models/PrivilegedAccessRequest');
const PatientCareTeamAssignment = require('../models/PatientCareTeamAssignment');
const AbdmOperationLedger = require('../models/AbdmOperationLedger');
const {
  PRIVILEGED_ACTION_SET,
  DUAL_CONTROL_ACTION_SET,
  hasPrivilegedAction
} = require('../utils/privilegedActions');
const { userHospitalId, isPlatformAdmin } = require('../utils/hospitalScope');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function sameHospital(req, hospitalId) {
  return isPlatformAdmin(req.user) || String(userHospitalId(req.user) || '') === String(hospitalId || '');
}

function securityError(res, status, code, error) {
  return res.status(status).json({ success: false, code, error });
}

function requireRecentMfaForDevice(req, res) {
  if (!req.user?.mfa?.enabled) {
    securityError(res, 403, 'DEVICE_MFA_REQUIRED', 'MFA must be enabled before trusting or revoking a browser device.');
    return false;
  }
  const verifiedAt = Number(req.auth?.mfaVerifiedAt || 0);
  const maxAgeMs = Number(process.env.TRUSTED_DEVICE_MFA_MAX_AGE_MINUTES || 10) * 60 * 1000;
  if (!verifiedAt || Date.now() - verifiedAt > maxAgeMs) {
    securityError(res, 403, 'DEVICE_RECENT_MFA_REQUIRED', 'Recent MFA verification is required to change trusted devices. Sign in with MFA again.');
    return false;
  }
  return true;
}

function currentDeviceHash(req) {
  return req.deviceContext?.deviceIdHash || null;
}

exports.createPrivilegedRequest = async (req, res) => {
  try {
    const target = await User.findById(req.body.targetUserId);
    if (!target) return securityError(res, 404, 'USER_NOT_FOUND', 'Target user not found');
    if (!sameHospital(req, target.hospital_id)) return securityError(res, 403, 'CROSS_HOSPITAL_DENIED', 'Cross-hospital privileged access request denied');
    if (String(target._id) === String(req.user._id)) return securityError(res, 403, 'SELF_PRIVILEGE_CHANGE_DENIED', 'You cannot request privileged access for yourself');

    const action = String(req.body.action || '').trim();
    const isPrivilegedAction = PRIVILEGED_ACTION_SET.has(action);
    const isSensitiveAction = DUAL_CONTROL_ACTION_SET.has(action) && !isPrivilegedAction;
    if (!isPrivilegedAction && !isSensitiveAction) {
      return securityError(res, 400, 'INVALID_PRIVILEGED_ACTION', 'Unknown privileged action');
    }
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 12) return securityError(res, 400, 'REASON_REQUIRED', 'A meaningful reason of at least 12 characters is required');
    const operation = String(req.body.operation || 'GRANT').toUpperCase();
    if (!['GRANT', 'REVOKE'].includes(operation)) return securityError(res, 400, 'INVALID_OPERATION', 'operation must be GRANT or REVOKE');

    const duplicate = await PrivilegedAccessRequest.findOne({
      hospitalId: target.hospital_id,
      targetUserId: target._id,
      action,
      operation,
      status: 'PENDING'
    });
    if (duplicate) return res.status(200).json({ success: true, request: duplicate, idempotent: true });

    const request = await PrivilegedAccessRequest.create({
      hospitalId: target.hospital_id,
      targetUserId: target._id,
      requestedBy: req.user._id,
      action,
      actionType: isSensitiveAction ? 'SENSITIVE_ACTION' : 'PRIVILEGED_ACTION',
      operation,
      reason,
      expiresAt: new Date(Date.now() + Number(process.env.PRIVILEGED_REQUEST_TTL_HOURS || 72) * 60 * 60 * 1000),
      metadata: { requestId: req.requestId }
    });
    return res.status(201).json({ success: true, request });
  } catch (error) {
    return securityError(res, error.statusCode || 500, error.code || 'PRIVILEGED_REQUEST_FAILED', error.message);
  }
};

exports.listPrivilegedRequests = async (req, res) => {
  const hospitalId = userHospitalId(req.user);
  const filter = isPlatformAdmin(req.user) && req.query.hospitalId ? { hospitalId: req.query.hospitalId } : { hospitalId };
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  const rows = await PrivilegedAccessRequest.find(filter)
    .populate('targetUserId', 'name email role privilegedActions')
    .populate('requestedBy approvedBy', 'name email role')
    .sort({ createdAt: -1 })
    .limit(200);
  return res.json({ success: true, requests: rows });
};

exports.decidePrivilegedRequest = async (req, res) => {
  try {
    const record = await PrivilegedAccessRequest.findById(req.params.requestId);
    if (!record) return securityError(res, 404, 'REQUEST_NOT_FOUND', 'Privileged access request not found');
    if (!sameHospital(req, record.hospitalId)) return securityError(res, 403, 'CROSS_HOSPITAL_DENIED', 'Cross-hospital decision denied');
    if (String(record.requestedBy) === String(req.user._id)) return securityError(res, 403, 'FOUR_EYES_REQUIRED', 'The requester cannot approve their own privileged access request');
    if (String(record.targetUserId) === String(req.user._id)) return securityError(res, 403, 'SELF_APPROVAL_DENIED', 'You cannot approve privileged access for yourself');
    if (record.status !== 'PENDING') return res.status(200).json({ success: true, request: record, idempotent: true });
    if (record.expiresAt && record.expiresAt <= new Date()) return securityError(res, 409, 'REQUEST_EXPIRED', 'Privileged access request expired');

    const decision = String(req.body.decision || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) return securityError(res, 400, 'INVALID_DECISION', 'decision must be APPROVED or REJECTED');
    const note = String(req.body.reason || '').trim();
    if (note.length < 8) return securityError(res, 400, 'DECISION_REASON_REQUIRED', 'A decision reason of at least 8 characters is required');

    if (decision === 'APPROVED') {
      const target = await User.findById(record.targetUserId);
      if (!target) return securityError(res, 404, 'USER_NOT_FOUND', 'Target user no longer exists');
      if (record.actionType === 'SENSITIVE_ACTION') {
        const rows = Array.isArray(target.modulePermissions)
          ? target.modulePermissions.map((row) => ({
              moduleKey: row.moduleKey,
              access: row.access,
              actions: Array.from(new Set(row.actions || [])),
              grantedBy: row.grantedBy,
              grantedAt: row.grantedAt,
              updatedAt: new Date()
            }))
          : [];
        let row = rows.find((item) => (item.actions || []).includes(record.action));
        if (record.operation === 'GRANT') {
          if (!row) {
            const preferredModule = record.action === 'user_access_manage' ? 'hr_staff' : 'settings';
            row = rows.find((item) => item.moduleKey === preferredModule);
            if (!row) {
              row = {
                moduleKey: preferredModule,
                access: 'manage',
                actions: [],
                grantedBy: req.user._id,
                grantedAt: new Date(),
                updatedAt: new Date()
              };
              rows.push(row);
            }
          }
          row.actions = Array.from(new Set([...(row.actions || []), record.action]));
        } else {
          rows.forEach((item) => {
            item.actions = (item.actions || []).filter((action) => action !== record.action);
          });
        }
        target.modulePermissions = rows;
        target.enforceModulePermissions = true;
      } else {
        const actions = new Set(target.privilegedActions || []);
        if (record.operation === 'GRANT') actions.add(record.action); else actions.delete(record.action);
        target.privilegedActions = Array.from(actions);
      }
      target.$locals.allowPrivilegedPermissionChange = true;
      target.securityVersion = Number(target.securityVersion || 0) + 1;
      target.sessionRevokedAt = new Date();
      await target.save({ validateBeforeSave: true });
    }

    record.status = decision;
    record.approvedBy = req.user._id;
    record.decisionReason = note;
    record.decidedAt = new Date();
    await record.save();
    return res.json({ success: true, request: record });
  } catch (error) {
    return securityError(res, error.statusCode || 500, error.code || 'PRIVILEGED_DECISION_FAILED', error.message);
  }
};

exports.createBreakGlass = async (req, res) => {
  if (String(process.env.BREAK_GLASS_ENABLED || 'false').toLowerCase() !== 'true') {
    return securityError(res, 503, 'BREAK_GLASS_DISABLED', 'Emergency break-glass access is disabled');
  }
  const role = String(req.user?.role || '').toLowerCase();
  if (!['doctor', 'nurse'].includes(role) && !isPlatformAdmin(req.user)) {
    return securityError(res, 403, 'BREAK_GLASS_ROLE_DENIED', 'Break-glass is limited to clinicians');
  }
  if (String(process.env.BREAK_GLASS_REQUIRE_MFA || (process.env.NODE_ENV === 'production' ? 'true' : 'false')).toLowerCase() === 'true') {
    if (!req.user?.mfa?.enabled) {
      return securityError(res, 403, 'BREAK_GLASS_MFA_REQUIRED', 'MFA must be enabled before break-glass access can be used');
    }
    const verifiedAt = Number(req.auth?.mfaVerifiedAt || 0);
    const maxAgeMs = Number(process.env.BREAK_GLASS_MFA_MAX_AGE_MINUTES || 10) * 60 * 1000;
    if (!verifiedAt || Date.now() - verifiedAt > maxAgeMs) {
      return securityError(res, 403, 'BREAK_GLASS_RECENT_MFA_REQUIRED', 'Recent MFA verification is required before break-glass access can be used. Sign in with MFA again.');
    }
  }
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 20) return securityError(res, 400, 'BREAK_GLASS_REASON_REQUIRED', 'Emergency reason must be at least 20 characters');
  const patient = await Patient.findById(req.body.patientId).select('_id hospitalId');
  if (!patient) return securityError(res, 404, 'PATIENT_NOT_FOUND', 'Patient not found');
  if (!sameHospital(req, patient.hospitalId)) return securityError(res, 403, 'CROSS_HOSPITAL_DENIED', 'Cross-hospital emergency access denied');
  const minutes = Math.max(15, Math.min(Number(req.body.durationMinutes || 30), Number(process.env.BREAK_GLASS_MAX_MINUTES || 60)));
  const grant = await BreakGlassGrant.create({
    grantId: `BG-${crypto.randomUUID()}`,
    hospitalId: patient.hospitalId,
    patientId: patient._id,
    userId: req.user._id,
    reason,
    scope: ['clinical_read'],
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + minutes * 60 * 1000),
    deviceContext: {
      sourceIpHash: sha256(req.ip),
      userAgentHash: sha256(req.headers['user-agent']),
      requestId: req.requestId
    }
  });
  req.auditMetadata = { ...(req.auditMetadata || {}), breakGlassGrantId: grant.grantId, patientId: String(patient._id), reason };
  return res.status(201).json({ success: true, grant: { grantId: grant.grantId, patientId: grant.patientId, expiresAt: grant.expiresAt, scope: grant.scope } });
};

exports.myBreakGlass = async (req, res) => {
  const rows = await BreakGlassGrant.find({ hospitalId: userHospitalId(req.user), userId: req.user._id }).sort({ issuedAt: -1 }).limit(100);
  return res.json({ success: true, grants: rows });
};

exports.breakGlassReviewQueue = async (req, res) => {
  const filter = { hospitalId: userHospitalId(req.user), reviewStatus: 'PENDING_REVIEW' };
  if (isPlatformAdmin(req.user) && req.query.hospitalId) filter.hospitalId = req.query.hospitalId;
  const rows = await BreakGlassGrant.find(filter).populate('userId', 'name email role').populate('patientId', 'patientId uhid first_name last_name').sort({ issuedAt: -1 }).limit(200);
  return res.json({ success: true, grants: rows });
};

exports.reviewBreakGlass = async (req, res) => {
  const record = await BreakGlassGrant.findById(req.params.grantId);
  if (!record) return securityError(res, 404, 'BREAK_GLASS_NOT_FOUND', 'Break-glass grant not found');
  if (!sameHospital(req, record.hospitalId)) return securityError(res, 403, 'CROSS_HOSPITAL_DENIED', 'Cross-hospital review denied');
  if (String(record.userId) === String(req.user._id)) return securityError(res, 403, 'SELF_REVIEW_DENIED', 'A clinician cannot review their own break-glass event');
  const status = String(req.body.status || '').toUpperCase();
  if (!['REVIEWED_OK', 'REVIEWED_CONCERN'].includes(status)) return securityError(res, 400, 'INVALID_REVIEW_STATUS', 'Invalid review status');
  const note = String(req.body.note || '').trim();
  if (note.length < 8) return securityError(res, 400, 'REVIEW_NOTE_REQUIRED', 'Review note must be at least 8 characters');
  record.reviewStatus = status;
  record.reviewedBy = req.user._id;
  record.reviewedAt = new Date();
  record.reviewNote = note;
  await record.save();
  return res.json({ success: true, grant: record });
};


exports.createCareTeamAssignment = async (req, res) => {
  try {
    const patient = await Patient.findById(req.body.patientId).select('_id hospitalId');
    const target = await User.findById(req.body.userId).select('_id hospital_id role is_active');
    if (!patient || !target) return securityError(res, 404, 'CARE_TEAM_TARGET_NOT_FOUND', 'Patient or target user not found');
    if (!sameHospital(req, patient.hospitalId) || String(target.hospital_id) !== String(patient.hospitalId)) {
      return securityError(res, 403, 'CROSS_HOSPITAL_DENIED', 'Care-team assignment must remain inside the hospital');
    }
    if (String(target._id) === String(req.user._id)) return securityError(res, 403, 'SELF_ASSIGNMENT_DENIED', 'You cannot assign yourself additional patient access');
    if (!target.is_active) return securityError(res, 409, 'TARGET_USER_INACTIVE', 'Target user is inactive');
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 12) return securityError(res, 400, 'REASON_REQUIRED', 'A care-team assignment reason is required');
    const validDays = Math.max(1, Math.min(Number(req.body.validDays || 7), 30));
    const row = await PatientCareTeamAssignment.create({
      hospitalId: patient.hospitalId,
      patientId: patient._id,
      userId: target._id,
      assignmentType: req.body.assignmentType || 'CARE_TEAM',
      purposes: Array.isArray(req.body.purposes) && req.body.purposes.length ? req.body.purposes : ['TREATMENT'],
      scopes: Array.isArray(req.body.scopes) && req.body.scopes.length ? req.body.scopes : ['clinical_read'],
      validFrom: new Date(),
      validTo: new Date(Date.now() + validDays * 24 * 60 * 60 * 1000),
      reason,
      createdBy: req.user._id
    });
    return res.status(201).json({ success: true, assignment: row });
  } catch (error) {
    return securityError(res, error.statusCode || 400, error.code || 'CARE_TEAM_ASSIGNMENT_FAILED', error.message);
  }
};

exports.revokeCareTeamAssignment = async (req, res) => {
  const row = await PatientCareTeamAssignment.findById(req.params.assignmentId);
  if (!row) return securityError(res, 404, 'ASSIGNMENT_NOT_FOUND', 'Care-team assignment not found');
  if (!sameHospital(req, row.hospitalId)) return securityError(res, 403, 'CROSS_HOSPITAL_DENIED', 'Cross-hospital assignment change denied');
  if (String(row.userId) === String(req.user._id)) return securityError(res, 403, 'SELF_ASSIGNMENT_DENIED', 'You cannot revoke or alter your own patient access assignment');
  row.revokedAt = new Date();
  row.revokedBy = req.user._id;
  await row.save();
  return res.json({ success: true, assignment: row });
};


exports.listAbdmReconciliation = async (req, res) => {
  const hospitalId = isPlatformAdmin(req.user) && req.query.hospitalId ? req.query.hospitalId : userHospitalId(req.user);
  const statuses = req.query.status ? [String(req.query.status).toUpperCase()] : ['RECONCILIATION_REQUIRED', 'UNKNOWN', 'EXTERNAL_ACCEPTED', 'SENT'];
  const rows = await AbdmOperationLedger.find({ hospitalId, status: { $in: statuses } })
    .select('-requestFingerprint -externalResponseFingerprint -consentEvidenceHash')
    .populate('patientId', 'patientId uhid first_name last_name abha.status')
    .populate('userId', 'name email role')
    .sort({ updatedAt: 1 })
    .limit(250);
  return res.json({ success: true, operations: rows });
};

exports.resolveAbdmReconciliation = async (req, res) => {
  const row = await AbdmOperationLedger.findOne({ operationId: req.params.operationId });
  if (!row) return securityError(res, 404, 'ABDM_OPERATION_NOT_FOUND', 'ABDM operation not found');
  if (!sameHospital(req, row.hospitalId)) return securityError(res, 403, 'CROSS_HOSPITAL_DENIED', 'Cross-hospital reconciliation denied');
  if (!['RECONCILIATION_REQUIRED', 'UNKNOWN', 'EXTERNAL_ACCEPTED', 'SENT'].includes(row.status)) {
    return securityError(res, 409, 'ABDM_OPERATION_NOT_RECONCILABLE', `Operation is already ${row.status}`);
  }
  const resolution = String(req.body.resolution || '').toUpperCase();
  if (!['LOCAL_STATE_RECOVERED', 'PATIENT_REVERIFIED', 'FAILED_CONFIRMED'].includes(resolution)) {
    return securityError(res, 400, 'INVALID_RECONCILIATION_RESOLUTION', 'Use LOCAL_STATE_RECOVERED, PATIENT_REVERIFIED, or FAILED_CONFIRMED');
  }
  const note = String(req.body.note || '').trim();
  if (note.length < 20) return securityError(res, 400, 'RECONCILIATION_NOTE_REQUIRED', 'A detailed reconciliation note of at least 20 characters is required');

  if (resolution !== 'FAILED_CONFIRMED') {
    const patient = await Patient.findById(row.patientId).select('abha.status abha.kycVerified abha.identityReconciliation.status');
    const eligible = patient && ['VERIFIED', 'ACTIVE'].includes(String(patient.abha?.status || '').toUpperCase()) && patient.abha?.kycVerified === true && patient.abha?.identityReconciliation?.status === 'MATCHED';
    if (!eligible) return securityError(res, 409, 'PATIENT_IDENTITY_NOT_RECOVERED', 'Patient identity is not in verified/reconciled state; do not mark this operation recovered');
    row.status = 'COMPLETED';
    row.completedAt = new Date();
  } else {
    row.status = 'FAILED';
  }
  row.reconciliation = {
    ...(row.reconciliation?.toObject?.() || row.reconciliation || {}),
    lastCheckedAt: new Date(),
    resolvedAt: new Date(),
    resolution: `${resolution}: ${note}`,
    resolvedBy: req.user._id
  };
  await row.save();
  return res.json({ success: true, operation: row });
};


exports.lookupBreakGlassPatient = async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 3) return securityError(res, 400, 'PATIENT_LOOKUP_QUERY_REQUIRED', 'Enter an exact Patient ID, UHID, or Mongo patient id');
  const hospitalId = userHospitalId(req.user);
  const or = [{ patientId: query }, { uhid: query }];
  if (/^[a-f\d]{24}$/i.test(query)) or.push({ _id: query });
  const patient = await Patient.findOne({ hospitalId, is_active: { $ne: false }, $or: or })
    .select('_id patientId uhid first_name last_name')
    .lean();
  if (!patient) return securityError(res, 404, 'PATIENT_NOT_FOUND', 'No patient matched that exact identifier');
  const name = `${patient.first_name || ''} ${patient.last_name || ''}`.trim();
  const maskedName = name ? `${name.slice(0, 1)}${'*'.repeat(Math.min(Math.max(name.length - 1, 1), 12))}` : 'Patient';
  return res.json({ success: true, patient: { _id: patient._id, patientId: patient.patientId, uhid: patient.uhid, maskedName } });
};

exports.listTrustedDevices = async (req, res) => {
  const user = await User.findById(req.user._id).select('+trustedDevices');
  if (!user) return securityError(res, 404, 'USER_NOT_FOUND', 'User not found');
  const current = currentDeviceHash(req);
  const devices = (user.trustedDevices || []).map((device) => ({
    id: device._id,
    label: device.label || 'Browser device',
    addedAt: device.addedAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    current: Boolean(current && device.deviceIdHash === current),
    fingerprint: String(device.deviceIdHash || '').slice(0, 12),
  }));
  return res.json({ success: true, devices, currentDevicePresent: Boolean(current), currentDeviceTrusted: Boolean(req.deviceContext?.trusted) });
};

exports.trustCurrentDevice = async (req, res) => {
  if (!requireRecentMfaForDevice(req, res)) return;
  const hash = currentDeviceHash(req);
  if (!hash) return securityError(res, 400, 'DEVICE_ID_REQUIRED', 'This client did not send a device identifier. Refresh the MediQliq application and try again.');
  const user = await User.findById(req.user._id).select('+trustedDevices');
  if (!user) return securityError(res, 404, 'USER_NOT_FOUND', 'User not found');
  const now = new Date();
  let row = (user.trustedDevices || []).find((device) => device.deviceIdHash === hash);
  if (row) {
    row.revokedAt = undefined;
    row.lastSeenAt = now;
    if (req.body?.label) row.label = String(req.body.label).trim().slice(0, 120);
  } else {
    const activeCount = (user.trustedDevices || []).filter((device) => !device.revokedAt).length;
    if (activeCount >= Number(process.env.TRUSTED_DEVICE_MAX_PER_USER || 10)) {
      return securityError(res, 409, 'TRUSTED_DEVICE_LIMIT', 'Trusted-device limit reached. Revoke an old device before adding another.');
    }
    user.trustedDevices.push({
      deviceIdHash: hash,
      label: String(req.body?.label || 'Browser device').trim().slice(0, 120),
      addedAt: now,
      lastSeenAt: now,
    });
    row = user.trustedDevices[user.trustedDevices.length - 1];
  }
  await user.save({ validateBeforeSave: true });
  return res.status(201).json({ success: true, device: { id: row._id, label: row.label, addedAt: row.addedAt, current: true, fingerprint: hash.slice(0, 12) } });
};

exports.revokeTrustedDevice = async (req, res) => {
  if (!requireRecentMfaForDevice(req, res)) return;
  const user = await User.findById(req.user._id).select('+trustedDevices');
  if (!user) return securityError(res, 404, 'USER_NOT_FOUND', 'User not found');
  const row = (user.trustedDevices || []).find((device) => String(device._id) === String(req.params.deviceId));
  if (!row) return securityError(res, 404, 'TRUSTED_DEVICE_NOT_FOUND', 'Trusted device not found');
  if (!row.revokedAt) row.revokedAt = new Date();
  await user.save({ validateBeforeSave: true });
  return res.json({ success: true, device: { id: row._id, revokedAt: row.revokedAt } });
};

