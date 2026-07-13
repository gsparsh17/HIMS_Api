const Patient = require('../models/Patient');
const AbdmCareContext = require('../models/AbdmCareContext');
const abdmConfig = require('../config/abdm.config');
const { buildPatientCareContexts, groupedForAbdm } = require('../services/abdmCareContext.service');
const { generateAbdmHiBundle } = require('../services/fhir/abdmHiBundle.service');
const { masterRequest } = require('../services/abdmMasterClient.service');

function abdmGender(value) {
  const gender = String(value || '').toLowerCase();
  if (gender === 'male') return 'M';
  if (gender === 'female') return 'F';
  return 'O';
}

exports.integrationStatus = async (req, res) => {
  const configured = Boolean(
    abdmConfig.masterUrl &&
      abdmConfig.facilityId &&
      abdmConfig.connectorKeyId &&
      abdmConfig.connectorSecret
  );
  res.json({
    success: true,
    configured,
    appRole: abdmConfig.appRole,
    environment: abdmConfig.environment,
    facilityId: abdmConfig.facilityId || null,
    tenantCode: abdmConfig.tenantCode || null,
    masterUrl: abdmConfig.masterUrl || null,
    features: {
      m1: abdmConfig.featureM1,
      m2: abdmConfig.featureM2,
      m3: abdmConfig.featureM3
    }
  });
};

exports.buildCareContexts = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.patientId);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    const contexts = await buildPatientCareContexts(patient._id);
    res.json({ success: true, count: contexts.length, contexts });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.listPatientCareContexts = async (req, res) => {
  const contexts = await AbdmCareContext.find({ patientId: req.params.patientId }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, count: contexts.length, contexts });
};

exports.initiateHipLinking = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.patientId);
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    if (patient.abha?.status !== 'VERIFIED') {
      return res.status(409).json({
        success: false,
        error: 'Patient ABHA must be verified before HIP-initiated care-context linking'
      });
    }
    if (!patient.abha?.address && !patient.abha?.number) {
      return res.status(409).json({ success: false, error: 'Verified ABHA address or ABHA number is required' });
    }

    await buildPatientCareContexts(patient._id);
    let query = { patientId: patient._id, linkStatus: { $in: ['LOCAL_RECORD_READY', 'ABDM_LINK_FAILED'] } };
    if (Array.isArray(req.body?.careContextIds) && req.body.careContextIds.length) {
      query._id = { $in: req.body.careContextIds };
    }
    const contexts = await AbdmCareContext.find(query);
    if (!contexts.length) {
      return res.status(409).json({
        success: false,
        error: 'No unlinked local care contexts are available for this patient'
      });
    }

    const body = {
      ...(patient.abha?.number ? { abhaNumber: patient.abha.number } : {}),
      ...(patient.abha?.address ? { abhaAddress: patient.abha.address } : {}),
      name: [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' '),
      gender: abdmGender(patient.gender),
      yearOfBirth: new Date(patient.dob).getFullYear()
    };

    const result = await masterRequest('/internal/abdm/hip/action', {
      method: 'POST',
      body: { action: 'GENERATE_LINK_TOKEN', body }
    });

    await AbdmCareContext.updateMany(
      { _id: { $in: contexts.map((item) => item._id) } },
      {
        linkStatus: 'ABDM_LINK_PENDING',
        linkRequestId: result.requestId,
        metadata: {
          initiatedBy: req.user?._id,
          initiatedAt: new Date(),
          masterRequestId: result.requestId
        }
      }
    );

    res.status(202).json({
      success: true,
      requestId: result.requestId,
      pendingCareContexts: contexts.length,
      message: 'ABDM link-token generation was accepted. Final linking continues asynchronously through the ABDM callback.'
    });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};

exports.generateFhir = async (req, res) => {
  try {
    const { patientId, hiTypes, dateRange } = req.body || {};
    if (!patientId) return res.status(400).json({ success: false, error: 'patientId is required' });
    const result = await generateAbdmHiBundle(patientId, { hiTypes, dateRange, createdBy: req.user?._id });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.groupedCareContexts = async (req, res) => {
  try {
    const result = await groupedForAbdm(req.params.patientId);
    res.json({ success: true, patient: result.patientGroups });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
};
