const IPDAdmission = require('../models/IPDAdmission');
const IPDInitialAssessment = require('../models/IPDInitialAssessment');
const IPDNursingAdmissionAssessment = require('../models/IPDNursingAdmissionAssessment');
const IPDVitals = require('../models/IPDVitals');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDRound = require('../models/IPDRound');
const { clinicalDayBounds, formatClinicalTime, dateKey } = require('../utils/clinicalDate');
const { DEFAULT_TIMEZONE, EWS_CONFIG } = require('../config/clinicalScoring');

const id = v => v?._id || v;
const safeText = v => String(v || '').trim();
const initials = name => safeText(name).split(/\s+/).filter(Boolean).map(n => n[0]).join('').slice(0, 4).toUpperCase();
const asDate = v => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function statusError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function admissionForRequest(req, admissionId) {
  const admission = await IPDAdmission.findById(admissionId)
    .populate('patientId')
    .populate('primaryDoctorId', 'name firstName lastName')
    .populate('departmentId', 'name')
    .populate('wardId', 'name')
    .populate('bedId', 'bedNumber name')
    .lean();

  if (!admission) {
    throw statusError(404, 'Admission not found');
  }

  const owner = admission.hospitalId || admission.hospital_id;
  if (req.user?.role !== 'mediqliq_super_admin' && req.user?.hospital_id && owner && String(owner) !== String(req.user.hospital_id)) {
    throw statusError(403, 'Cross-hospital access denied');
  }

  return admission;
}

function header(admission) {
  const p = admission.patientId || {};
  const d = admission.primaryDoctorId || {};
  const patientName = p.name || p.fullName || [p.salutation, p.first_name, p.firstName, p.middle_name, p.last_name, p.lastName].filter(Boolean).join(' ');
  const age = p.age ?? p.ageYears;
  const gender = p.gender || p.sex;

  return {
    hospitalId: admission.hospitalId || admission.hospital_id,
    patientName,
    ageGender: [age, gender].filter(v => v !== undefined && v !== null && v !== '').join(' / '),
    uhid: p.uhid || p.patientId || p.registration_number || '',
    ipd: admission.admissionNumber || admission.shipNumber || String(admission._id),
    admissionDateTime: admission.admissionDate || admission.createdAt,
    wardBed: [admission.wardId?.name, admission.bedId?.bedNumber || admission.bedId?.name].filter(Boolean).join(' / '),
    diagnosis: admission.finalDiagnosis || admission.provisionalDiagnosis || '',
    department: admission.departmentId?.name || '',
    consultant: d.name || [d.firstName, d.lastName].filter(Boolean).join(' '),
    patientLabel: p.qrCode || p.uhid || ''
  };
}

function activeFilter() {
  return { status: { $ne: 'Draft' } };
}

function bodyForUpdate(body, ignored = []) {
  const output = { ...body };
  ['admissionId', 'patientId', 'hospitalId', 'createdBy', 'createdAt', 'updatedAt', 'signedBy', 'signedAt', 'amendedAt', 'amendedBy', 'amendments']
    .concat(ignored)
    .forEach(k => delete output[k]);
  return output;
}

function signedCannotOverwrite(existing, body) {
  return existing?.formStatus === 'Signed' && body.status !== 'Amended' && body.amend !== true;
}

function nursingSignedCannotOverwrite(existing, body) {
  return existing?.status === 'Signed' && body.status !== 'Amended' && body.amend !== true;
}

function asArrayFromLines(value, mapper) {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(mapper);
}

function normalizeDoctorPayload(input = {}) {
  const patch = { ...input };
  const uiVitals = input.vitals || {};

  patch.allergies = { ...(input.allergies || {}) };
  if (patch.allergies.food !== undefined && patch.allergies.foodAndBeverages === undefined) {
    patch.allergies.foodAndBeverages = patch.allergies.food;
  }
  if (patch.allergies.details && !patch.allergies.other) {
    patch.allergies.other = patch.allergies.details;
  }

  if (typeof input.personalHistory === 'string') {
    patch.personalHistory = {
      occupationalHistory: { significant: Boolean(input.personalHistory), details: input.personalHistory }
    };
  }

  if (typeof input.pastMedicalHistory === 'string') {
    patch.pastHistoryMedical = { other: input.pastMedicalHistory };
  }

  if (typeof input.systemicExamination === 'string') {
    patch.systemicExamination = [{ system: 'Clinical examination', finding: input.systemicExamination }];
  }

  if (typeof input.painScore === 'number') {
    patch.painScore = { score: input.painScore };
  }

  if (Object.keys(uiVitals).length) {
    patch.generalExamination = { ...(input.generalExamination || {}) };
    patch.generalExamination.height = { value: uiVitals.height, unit: 'cm' };
    patch.generalExamination.weight = { value: uiVitals.weight, unit: 'kg' };
    patch.generalExamination.vitals = {
      temp: uiVitals.temperature,
      pulse: uiVitals.pulse,
      bp: [uiVitals.systolic, uiVitals.diastolic].filter(Boolean).join('/'),
      rr: uiVitals.respiratoryRate,
      spo2: uiVitals.spo2
    };

    if (input.gcsTotal !== undefined) {
      patch.generalExamination.gcs = { ...(patch.generalExamination.gcs || {}), total: String(input.gcsTotal) };
    }

    if (input.generalExamination?.notes) {
      patch.generalExamination.orientation = { ...(patch.generalExamination.orientation || {}), details: input.generalExamination.notes };
    }
  }

  const trauma = input.triageAndTrauma || {};
  if (typeof trauma.airway === 'string' || typeof trauma.breathing === 'string' || typeof trauma.circulation === 'string') {
    patch.triageAndTrauma = {
      ...trauma,
      airway: typeof trauma.airway === 'string' ? { status: trauma.airway } : trauma.airway,
      breathing: typeof trauma.breathing === 'string' ? { breatheSounds: trauma.breathing } : trauma.breathing,
      circulation: typeof trauma.circulation === 'string' ? { others: trauma.circulation } : trauma.circulation
    };
  }

  if (input.burnChart) {
    patch.triageAndTrauma = {
      ...(patch.triageAndTrauma || {}),
      burnChart: {
        ...(patch.triageAndTrauma?.burnChart || {}),
        totalScore: input.burnChart.percentage,
        causeOfBurn: input.burnChart.cause
      }
    };
  }

  if (typeof input.externalInjuries === 'string') {
    patch.triageAndTrauma = { ...(patch.triageAndTrauma || {}), externalInjuries: input.externalInjuries };
  }

  if (typeof input.investigationAdvised?.other === 'string') {
    patch.investigationAdvised = { ...(input.investigationAdvised || {}), otherPathology: input.investigationAdvised.other };
  }

  const plan = input.planAndDisposition || {};
  if (typeof plan.proceduresPerformedInER === 'string' || typeof plan.treatmentPlanned === 'string' || typeof plan.followUpInstructions === 'string') {
    patch.planAndDisposition = {
      ...plan,
      proceduresPerformedInER: typeof plan.proceduresPerformedInER === 'string'
        ? asArrayFromLines(plan.proceduresPerformedInER, (procedure) => ({ procedure }))
        : plan.proceduresPerformedInER,
      treatmentPlanned: typeof plan.treatmentPlanned === 'string'
        ? asArrayFromLines(plan.treatmentPlanned, (drugNameAndForm) => ({ drugNameAndForm }))
        : plan.treatmentPlanned,
      patientStatus: typeof plan.patientStatus === 'string'
        ? { disposition: plan.patientStatus }
        : plan.patientStatus
    };
  }

  delete patch.vitals;
  delete patch.gcsTotal;
  delete patch.pastMedicalHistory;
  delete patch.externalInjuries;

  return patch;
}

function normalizeNursingPayload(input = {}) {
  const patch = { ...input };

  if (input.vitals) {
    patch.initialVitals = {
      ...(input.initialVitals || {}),
      temperature: input.vitals.temperature,
      pulse: input.vitals.pulse,
      spo2: input.vitals.spo2,
      respiratoryRate: input.vitals.respiratoryRate,
      height: input.vitals.height,
      weight: input.vitals.weight,
      bloodPressure: {
        systolic: input.vitals.systolic,
        diastolic: input.vitals.diastolic
      },
      recordedAt: input.arrivalTime || new Date()
    };
  }

  if (['Yes', 'No', 'Unknown'].includes(input.allergyKnown)) {
    patch.allergyKnown = input.allergyKnown === 'Yes' ? 'Known' : input.allergyKnown === 'No' ? 'None' : 'Unknown';
  }

  const orientation = input.orientationChecklist || {};
  const orientationMap = {
    Room: 'room',
    Bathroom: 'bathroom',
    'Emergency light': 'emergencyLight',
    'Light controls': 'lightControls',
    'Side rails': 'sideRails',
    'Bed controls': 'bedControls',
    'Nurse call': 'nurseCall',
    Telephone: 'telephone',
    'Toilet rail': 'toiletRail',
    Footstool: 'footstool',
    Television: 'television',
    'Smoking policy': 'smokingPolicy',
    'Visiting policy': 'visitingPolicy',
    'Patient handbook': 'handbookGiven'
  };

  patch.orientationChecklist = Object.fromEntries(
    Object.entries(orientation).map(([key, value]) => [
      orientationMap[key.replaceAll('_', ' ')] || key,
      value
    ])
  );

  if (input.currentMedicationsText) {
    patch.currentMedications = asArrayFromLines(input.currentMedicationsText, (line) => ({ drug: line }));
  }

  if (input.functionalAssessment && !Array.isArray(input.functionalAssessment)) {
    patch.functionalAssessment = Object.entries(input.functionalAssessment).map(([activity, status]) => ({
      activity: activity.replaceAll('_', ' '),
      status
    }));
  }

  const rawFall = input.fallRisk || {};
  if (rawFall && !Array.isArray(rawFall.items)) {
    patch.fallRisk = {
      items: Object.entries(rawFall)
        .filter(([key]) => !['total', 'riskBand', 'configVersion'].includes(key))
        .map(([key, score]) => ({
          key,
          label: key.replace(/([A-Z])/g, ' $1'),
          value: String(score),
          score: Number(score) || 0
        })),
      total: Number(rawFall.total) || 0,
      riskBand: rawFall.riskBand
    };
  }

  const rawPressure = input.pressureRisk || input.pressureUlcerRisk || {};
  if (rawPressure && !Array.isArray(rawPressure.items)) {
    patch.pressureUlcerRisk = {
      ...(input.pressureUlcerRisk || {}),
      items: Object.entries(rawPressure)
        .filter(([key]) => !['total', 'riskBand', 'configVersion'].includes(key))
        .map(([key, score]) => ({
          key,
          label: key.replace(/([A-Z])/g, ' $1'),
          value: String(score),
          score: Number(score) || 0
        })),
      total: Number(rawPressure.total) || 0,
      riskBand: rawPressure.riskBand
    };
  }

  if (input.specialNeedsText) {
    patch.specialNeeds = {
      ...(input.specialNeeds || {}),
      other: {
        value: Boolean(input.specialNeedsText),
        description: input.specialNeedsText
      }
    };
  }

  if (input.carePlanText) {
    patch.nursingCarePlan = [{
      diagnosis: 'Nursing care plan',
      selected: true,
      interventionPlan: input.carePlanText
    }];
  }

  delete patch.vitals;
  delete patch.currentMedicationsText;
  delete patch.pressureRisk;
  delete patch.specialNeedsText;
  delete patch.carePlanText;

  return patch;
}

exports.getClinicalDocumentStatus = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const hospitalId = admission.hospitalId || admission.hospital_id;
    const today = dateKey(new Date(), DEFAULT_TIMEZONE);

    const [doctor, nursing, latestVitals, latestRound, medicationOrders] = await Promise.all([
      IPDInitialAssessment.findOne({ admissionId: admission._id, hospitalId }).select('formStatus updatedAt signedAt').lean(),
      IPDNursingAdmissionAssessment.findOne({ admissionId: admission._id, hospitalId }).select('status updatedAt signedAt').lean(),
      IPDVitals.findOne({ admissionId: admission._id, hospitalId, chartDate: today })
        .sort({ recordedAt: -1 })
        .select('recordedAt chartDate ewsTotal status')
        .lean(),
      IPDRound.findOne({ admissionId: admission._id, hospitalId })
        .sort({ roundDateTime: -1 })
        .select('roundDateTime status')
        .lean(),
      IPDMedicationChart.countDocuments({ admissionId: admission._id })
    ]);

    res.json({
      success: true,
      status: {
        doctorAssessment: doctor,
        nursingAssessment: nursing,
        latestVitals,
        latestRound,
        medicationOrders
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.getDoctorInitialAssessment = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const assessment = await IPDInitialAssessment.findOne({
      admissionId: admission._id,
      hospitalId: admission.hospitalId || admission.hospital_id
    });

    res.json({ success: true, assessment });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.saveDoctorInitialAssessment = async (req, res) => {
  try {
    if (!['doctor', 'admin', 'mediqliq_super_admin'].includes(req.user.role)) {
      throw statusError(403, 'Only a doctor may create, sign, or amend the Doctor Initial Assessment');
    }

    const admission = await admissionForRequest(req, req.params.admissionId);
    const hospitalId = admission.hospitalId || admission.hospital_id || req.user.hospital_id;
    let existing = await IPDInitialAssessment.findOne({ admissionId: admission._id });

    if (signedCannotOverwrite(existing, req.body)) {
      throw statusError(409, 'Signed Doctor Initial Assessment must be amended with a reason');
    }

    const patch = normalizeDoctorPayload(bodyForUpdate(req.body));
    patch.admissionId = admission._id;
    patch.patientId = id(admission.patientId);
    patch.hospitalId = hospitalId;
    patch.updatedBy = req.user._id;

    if (!existing) {
      patch.createdBy = req.user._id;
      existing = new IPDInitialAssessment(patch);
    } else {
      if (existing.formStatus === 'Signed' || req.body.amend === true) {
        if (!safeText(req.body.amendmentReason)) {
          throw statusError(400, 'Amendment reason is required');
        }
        existing.amendments.push({
          amendedBy: req.user._id,
          reason: req.body.amendmentReason,
          snapshot: existing.toObject()
        });
        patch.formStatus = 'Amended';
        patch.amendedBy = req.user._id;
        patch.amendedAt = new Date();
      }
      existing.set(patch);
    }

    if (req.body.sign === true || req.body.formStatus === 'Signed') {
      existing.formStatus = 'Signed';
      existing.signedAt = new Date();
      existing.signedBy = req.user._id;
      existing.signerName = req.user.name;
    }

    await existing.save();
    res.json({ success: true, assessment: existing });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.getNursingAdmissionAssessment = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const assessment = await IPDNursingAdmissionAssessment.findOne({
      admissionId: admission._id,
      hospitalId: admission.hospitalId || admission.hospital_id
    });

    res.json({ success: true, assessment });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.saveNursingAdmissionAssessment = async (req, res) => {
  try {
    if (!['nurse', 'admin', 'mediqliq_super_admin'].includes(req.user.role)) {
      throw statusError(403, 'Only a nurse may create, sign, or amend the Nursing Admission Assessment');
    }

    const admission = await admissionForRequest(req, req.params.admissionId);
    const hospitalId = admission.hospitalId || admission.hospital_id || req.user.hospital_id;
    let existing = await IPDNursingAdmissionAssessment.findOne({ admissionId: admission._id });

    if (nursingSignedCannotOverwrite(existing, req.body)) {
      throw statusError(409, 'Signed Nursing Admission Assessment must be amended with a reason');
    }

    const patch = normalizeNursingPayload(bodyForUpdate(req.body));
    patch.admissionId = admission._id;
    patch.patientId = id(admission.patientId);
    patch.hospitalId = hospitalId;
    patch.assessedBy = patch.assessedBy || req.user._id;
    patch.assessedByName = patch.assessedByName || req.user.name;

    if (!existing) {
      existing = new IPDNursingAdmissionAssessment(patch);
    } else {
      if (existing.status === 'Signed' || req.body.amend === true) {
        if (!safeText(req.body.amendmentReason)) {
          throw statusError(400, 'Amendment reason is required');
        }
        patch.status = 'Amended';
        patch.amendedBy = req.user._id;
        patch.amendedAt = new Date();
      }
      existing.set(patch);
    }

    const fall = (existing.fallRisk?.items || []).reduce((s, r) => s + Number(r.score || 0), 0);
    const pressure = (existing.pressureUlcerRisk?.items || []).reduce((s, r) => s + Number(r.score || 0), 0);

    existing.fallRisk = existing.fallRisk || {};
    existing.pressureUlcerRisk = existing.pressureUlcerRisk || {};
    existing.fallRisk.total = fall;
    existing.pressureUlcerRisk.total = pressure;

    if (req.body.sign === true || req.body.status === 'Signed') {
      existing.status = 'Signed';
      existing.signedAt = new Date();
      existing.signedBy = req.user._id;
    }

    await existing.save();
    res.json({ success: true, assessment: existing });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.createVitals = async (req, res) => {
  try {
    if (!['nurse', 'staff', 'doctor', 'admin', 'mediqliq_super_admin'].includes(req.user.role)) {
      throw statusError(403, 'Clinical role required');
    }

    const admission = await admissionForRequest(req, req.body.admissionId);
    const hospitalId = admission.hospitalId || admission.hospital_id || req.user.hospital_id;
    const body = bodyForUpdate(req.body);
    body.recordedTimezone = DEFAULT_TIMEZONE;

    if (req.body.sign === true || req.body.status === 'Signed') {
      if (!['nurse', 'admin', 'mediqliq_super_admin'].includes(req.user.role)) {
        throw statusError(403, 'Only nursing roles may sign vitals');
      }
      if (!EWS_CONFIG.approved) {
        throw statusError(409, 'EWS configuration is pending clinical approval; save as Draft only');
      }
    }

    const record = new IPDVitals({
      ...body,
      admissionId: admission._id,
      patientId: id(admission.patientId),
      hospitalId,
      recordedBy: req.user._id,
      recordedByName: req.user.name,
      recordedByInitials: initials(req.user.name)
    });

    if (req.body.sign === true || req.body.status === 'Signed') {
      record.status = 'Signed';
      record.signedAt = new Date();
      record.signedBy = req.user._id;
    }

    await record.save();
    res.status(201).json({ success: true, vitals: record });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.updateVitals = async (req, res) => {
  try {
    const record = await IPDVitals.findById(req.params.id);
    if (!record) {
      throw statusError(404, 'Vitals record not found');
    }

    await admissionForRequest(req, record.admissionId);

    if (record.status === 'Signed' && req.body.amend !== true) {
      throw statusError(409, 'Signed vital record must be amended with a reason');
    }

    if (record.status === 'Signed' || req.body.amend === true) {
      if (!safeText(req.body.amendmentReason)) {
        throw statusError(400, 'Amendment reason is required');
      }
      record.status = 'Amended';
      record.amendedAt = new Date();
      record.amendedBy = req.user._id;
      record.amendmentReason = req.body.amendmentReason;
    }

    const patch = bodyForUpdate(req.body);
    patch.recordedTimezone = DEFAULT_TIMEZONE;
    record.set(patch);

    if (req.body.sign === true || req.body.status === 'Signed') {
      if (!['nurse', 'admin', 'mediqliq_super_admin'].includes(req.user.role)) {
        throw statusError(403, 'Only nursing roles may sign vitals');
      }
      if (!EWS_CONFIG.approved) {
        throw statusError(409, 'EWS configuration is pending clinical approval; save as Draft only');
      }
      record.status = 'Signed';
      record.signedAt = new Date();
      record.signedBy = req.user._id;
    }

    await record.save();
    res.json({ success: true, vitals: record });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.getVitals = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const q = {
      admissionId: admission._id,
      hospitalId: admission.hospitalId || admission.hospital_id
    };

    if (req.query.chartDate) q.chartDate = req.query.chartDate;
    if (req.query.shift) q.clinicalShift = req.query.shift;
    if (req.query.includeDraft !== 'true') Object.assign(q, activeFilter());

    const rows = await IPDVitals.find(q)
      .sort({ recordedAt: 1 })
      .populate('recordedBy', 'name')
      .lean();

    res.json({ success: true, vitals: rows });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

function vitalsTotals(rows) {
  const t = rows.reduce((a, r) => {
    a.ivFluidsMl += Number(r.ivFluidsMl || 0);
    a.oralRtMl += Number(r.oralRtMl || 0);
    a.urineMl += Number(r.urineMl || 0);
    a.rtOutputMl += Number(r.rtOutputMl || 0);
    a.vomitMl += Number(r.vomitMl || 0);

    if (r.bowelMovement) {
      a.bowelMovements.push({ time: r.recordedAt, value: r.bowelMovement });
    }

    return a;
  }, {
    ivFluidsMl: 0,
    oralRtMl: 0,
    urineMl: 0,
    rtOutputMl: 0,
    vomitMl: 0,
    bowelMovements: []
  });

  t.totalIntake = t.ivFluidsMl + t.oralRtMl;
  t.totalOutput = t.urineMl + t.rtOutputMl + t.vomitMl;
  t.balance = t.totalIntake - t.totalOutput;

  return t;
}

async function chartVitals(req) {
  const admission = await admissionForRequest(req, req.params.admissionId);
  const chartDate = req.query.chartDate;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(chartDate || '')) {
    throw statusError(400, 'chartDate YYYY-MM-DD is required');
  }

  const timezone = DEFAULT_TIMEZONE;
  const bounds = clinicalDayBounds(chartDate, timezone);

  const rows = await IPDVitals.find({
    admissionId: admission._id,
    hospitalId: admission.hospitalId || admission.hospital_id,
    recordedAt: { $gte: bounds.start, $lt: bounds.end },
    status: { $ne: 'Draft' }
  })
    .sort({ recordedAt: 1 })
    .populate('recordedBy', 'name')
    .lean();

  return {
    admission,
    chartDate,
    timezone,
    rows,
    totals: vitalsTotals(rows),
    bounds
  };
}

exports.printVitalsEws = async (req, res) => {
  try {
    const x = await chartVitals(req);

    res.json({
      success: true,
      payload: {
        reportType: 'vitals_ews',
        title: 'NURSING - VITALS WITH EWS SCORING',
        header: header(x.admission),
        chartDate: x.chartDate,
        timezone: x.timezone,
        clinicalDay: { start: x.bounds.start, end: x.bounds.end },
        slots: Array.from({ length: 25 }, (_, index) => ({
          index,
          label: `${String((6 + index) % 24).padStart(2, '0')}:00`,
          dateOffset: index === 24 ? 1 : 0
        })),
        vitals: x.rows,
        totals: x.totals
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.printPatientCareFlow = async (req, res) => {
  try {
    const x = await chartVitals(req);

    const rows = x.rows.map(v => ({
      ...v,
      time: formatClinicalTime(v.recordedAt, x.timezone),
      nurseInitials: v.recordedByInitials || initials(v.recordedBy?.name)
    }));

    res.json({
      success: true,
      payload: {
        reportType: 'patient_care_flow',
        title: 'NURSING - PATIENT CARE FLOW CHART',
        header: header(x.admission),
        chartDate: x.chartDate,
        timezone: x.timezone,
        rows,
        totals: x.totals
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.printDoctorInitialAssessment = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const assessment = await IPDInitialAssessment.findOne({
      admissionId: admission._id,
      hospitalId: admission.hospitalId || admission.hospital_id
    }).lean();

    res.json({
      success: true,
      payload: {
        reportType: 'doctor_initial_assessment',
        title: 'DOCTOR INITIAL ASSESSMENT FORM',
        header: header(admission),
        assessment
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.printNursingAdmissionAssessment = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const assessment = await IPDNursingAdmissionAssessment.findOne({
      admissionId: admission._id,
      hospitalId: admission.hospitalId || admission.hospital_id
    }).lean();

    res.json({
      success: true,
      payload: {
        reportType: 'nursing_admission_assessment',
        title: 'NURSING ADMISSION ASSESSMENT',
        header: header(admission),
        assessment
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.printMedicationChart = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const q = { admissionId: admission._id };

    if (req.query.from || req.query.to) {
      q.startDate = {
        ...(req.query.from ? { $lte: asDate(req.query.to || req.query.from) } : {}),
        ...(req.query.to ? { $gte: asDate(req.query.from || req.query.to) } : {})
      };
    }

    const medications = await IPDMedicationChart.find(q)
      .sort({ emergencyDrug: -1, isHighRisk: -1, startDate: 1 })
      .populate('prescribedBy', 'name')
      .populate('timing.administeredBy', 'name')
      .populate('timing.witnessedBy', 'name')
      .lean();

    res.json({
      success: true,
      payload: {
        reportType: 'medication_chart',
        title: 'NURSING MEDICATION CHART',
        header: header(admission),
        from: req.query.from || null,
        to: req.query.to || null,
        medications
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.printRounds = async (req, res) => {
  try {
    const admission = await admissionForRequest(req, req.params.admissionId);
    const filter = {
      admissionId: admission._id,
      hospitalId: admission.hospitalId || admission.hospital_id
    };

    if (req.query.from || req.query.to) {
      filter.roundDateTime = {
        ...(req.query.from ? { $gte: asDate(req.query.from) } : {}),
        ...(req.query.to ? { $lte: asDate(req.query.to) } : {})
      };
    }

    const rounds = await IPDRound.find(filter)
      .sort({ roundDateTime: 1 })
      .populate('doctorId', 'name firstName lastName')
      .populate('vitalId')
      .lean();

    res.json({
      success: true,
      payload: {
        reportType: req.query.type === 'notes' ? 'doctors_note' : 'consultant_daily_assessment',
        title: req.query.type === 'notes'
          ? "DOCTOR'S NOTE"
          : 'CONSULTANT DAILY ASSESSMENT AND MANAGEMENT PLAN',
        header: header(admission),
        rounds
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};