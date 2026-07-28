const Patient = require('../models/Patient');
const AbdmPacket = require('../models/AbdmPacket');
const { assertUserHospital } = require('../utils/hospitalScope');
const {
  previewPacket,
  preparePacket,
  validatePacket,
  approvePacket,
  listPatientPackets,
  packetSummary,
  packetFhir,
  listDisclosures
} = require('../services/abdmPacket.service');

function failure(res, error) {
  return res.status(error.statusCode || 400).json({
    success: false,
    code: error.code || 'ABDM_PACKET_ERROR',
    error: error.message,
    details: error.details
  });
}

async function scopedPatient(patientId, hospitalId) {
  const patient = await Patient.findOne({ _id: patientId, hospitalId });
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    error.code = 'ABDM_PATIENT_NOT_FOUND';
    throw error;
  }
  return patient;
}

exports.listPatientPackets = async (req, res) => {
  try {
    const hospitalId = assertUserHospital(req.user);
    await scopedPatient(req.params.patientId, hospitalId);
    const packets = await listPatientPackets({ hospitalId, patientId: req.params.patientId });
    return res.json({ success: true, count: packets.length, packets });
  } catch (error) {
    return failure(res, error);
  }
};

exports.preview = async (req, res) => {
  try {
    const result = await previewPacket({
      contextId: req.params.contextId,
      hospitalId: assertUserHospital(req.user),
      consentId: req.body?.consentId,
      actorUserId: req.user._id
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return failure(res, error);
  }
};

exports.prepare = async (req, res) => {
  try {
    const result = await preparePacket({
      contextId: req.params.contextId,
      hospitalId: assertUserHospital(req.user),
      consentId: req.body?.consentId,
      actorUserId: req.user._id
    });
    return res.status(result.reused ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    return failure(res, error);
  }
};

exports.summary = async (req, res) => {
  try {
    const result = await packetSummary({
      packetId: req.params.packetId,
      versionNumber: req.params.version,
      hospitalId: assertUserHospital(req.user),
      actorUserId: req.user._id
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return failure(res, error);
  }
};

exports.fhir = async (req, res) => {
  try {
    const result = await packetFhir({
      packetId: req.params.packetId,
      versionNumber: req.params.version,
      hospitalId: assertUserHospital(req.user),
      actorUser: req.user
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return failure(res, error);
  }
};

exports.validate = async (req, res) => {
  try {
    const result = await validatePacket({
      packetId: req.params.packetId,
      versionNumber: req.params.version,
      hospitalId: assertUserHospital(req.user),
      actorUserId: req.user._id
    });
    return res.status(result.validation.valid ? 200 : 422).json({ success: result.validation.valid, ...result });
  } catch (error) {
    return failure(res, error);
  }
};

exports.approve = async (req, res) => {
  try {
    const result = await approvePacket({
      packetId: req.params.packetId,
      versionNumber: req.params.version,
      hospitalId: assertUserHospital(req.user),
      actorUser: req.user,
      expectedBundleHash: req.body?.bundleHash,
      note: req.body?.note
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return failure(res, error);
  }
};

exports.rebuild = async (req, res) => {
  try {
    const hospitalId = assertUserHospital(req.user);
    const packet = await AbdmPacket.findOne({ _id: req.params.packetId, hospitalId });
    if (!packet) {
      const error = new Error('ABDM packet not found');
      error.statusCode = 404;
      error.code = 'ABDM_PACKET_NOT_FOUND';
      throw error;
    }
    const result = await preparePacket({
      contextId: packet.careContextId,
      hospitalId,
      consentId: req.body?.consentId,
      actorUserId: req.user._id
    });
    return res.status(result.reused ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    return failure(res, error);
  }
};

exports.disclosures = async (req, res) => {
  try {
    const hospitalId = assertUserHospital(req.user);
    await scopedPatient(req.params.patientId, hospitalId);
    const disclosures = await listDisclosures({
      hospitalId,
      patientId: req.params.patientId,
      actorUserId: req.user._id,
      limit: req.query.limit
    });
    return res.json({ success: true, count: disclosures.length, disclosures });
  } catch (error) {
    return failure(res, error);
  }
};
