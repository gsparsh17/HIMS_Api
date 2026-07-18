// controllers/ipdClinicalDocuments.controller.js
const IPDAdmission = require('../models/IPDAdmission');
const IPDInitialAssessment = require('../models/IPDInitialAssessment');
const IPDNursingAdmissionAssessment = require('../models/IPDNursingAdmissionAssessment');
const IPDVitals = require('../models/IPDVitals');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDRound = require('../models/IPDRound');
const Prescription = require('../models/Prescription');
const { clinicalDayBounds, formatClinicalTime, dateKey } = require('../utils/clinicalDate');
const { DEFAULT_TIMEZONE, EWS_CONFIG } = require('../config/clinicalScoring');

const id = v => v?._id || v;
const safeText = v => String(v || '').trim();
const initials = name => safeText(name).split(/\s+/).filter(Boolean).map(n => n[0]).join('').slice(0, 4).toUpperCase();
const allergySnapshot = (allergies = {}, fallback = '') => {
  if (allergies?.none === true) return 'No known allergies';
  const values = [
    ['Blood transfusion', allergies?.bloodTransfusion],
    ['Drug', allergies?.drug],
    ['Food & beverages', allergies?.foodAndBeverages],
    ['Other', allergies?.other]
  ]
    .filter(([, value]) => safeText(value))
    .map(([label, value]) => `${label}: ${safeText(value)}`);
  return values.join('; ') || safeText(fallback);
};
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

// ===================== NORMALIZE DOCTOR PAYLOAD =====================
function normalizeDoctorPayload(input = {}) {
  const patch = { ...input };
  const uiVitals = input.vitals || {};

  // Allergies
  patch.allergies = { ...(input.allergies || {}) };
  if (patch.allergies.food !== undefined && patch.allergies.foodAndBeverages === undefined) {
    patch.allergies.foodAndBeverages = patch.allergies.food;
  }
  if (patch.allergies.details && !patch.allergies.other) {
    patch.allergies.other = patch.allergies.details;
  }

  // Personal History
  if (typeof input.personalHistory === 'string') {
    patch.personalHistory = {
      occupationalHistory: {
        significant: Boolean(input.personalHistory && input.personalHistory.trim().length > 0),
        details: input.personalHistory
      },
      habits: []
    };
  } else if (input.personalHistory && typeof input.personalHistory === 'object') {
    patch.personalHistory = input.personalHistory;
  }

  // Past Medical History
  if (typeof input.pastMedicalHistory === 'string') {
    patch.pastHistoryMedical = {
      other: input.pastMedicalHistory,
      disorders: [],
      obstetricHistory: { isApplicable: false }
    };
  } else if (input.pastHistoryMedical) {
    patch.pastHistoryMedical = input.pastHistoryMedical;
  }

  // Systemic Examination
  if (typeof input.systemicExamination === 'string') {
    patch.systemicExamination = [{
      system: 'Clinical examination',
      finding: input.systemicExamination
    }];
  } else if (Array.isArray(input.systemicExamination)) {
    patch.systemicExamination = input.systemicExamination;
  }

  // Pain Score
  if (typeof input.painScore === 'number') {
    patch.painScore = { score: input.painScore };
  } else if (input.painScore && typeof input.painScore === 'object') {
    patch.painScore = {
      score: input.painScore.score || 0,
      duration: input.painScore.duration || '',
      location: input.painScore.location || '',
      increasingFactor: input.painScore.increasingFactor || '',
      decreasingFactor: input.painScore.decreasingFactor || ''
    };
  }

  // Vitals & General Examination
  if (Object.keys(uiVitals).length) {
    patch.generalExamination = { ...(input.generalExamination || {}) };

    patch.generalExamination.height = {
      value: uiVitals.height ? parseFloat(uiVitals.height) : undefined,
      unit: 'cm'
    };
    patch.generalExamination.weight = {
      value: uiVitals.weight ? parseFloat(uiVitals.weight) : undefined,
      unit: 'kg'
    };

    // Build BP string from systolic/diastolic
    let bpString = '';
    if (uiVitals.bp) {
      bpString = uiVitals.bp;
    } else if (uiVitals.systolic && uiVitals.diastolic) {
      bpString = `${uiVitals.systolic}/${uiVitals.diastolic}`;
    }

    patch.generalExamination.vitals = {
      temp: uiVitals.temperature || uiVitals.temp || '',
      pulse: uiVitals.pulse || '',
      bp: bpString,
      rr: uiVitals.respiratoryRate || uiVitals.rr || '',
      spo2: uiVitals.spo2 || '',
      rbs: uiVitals.rbs || uiVitals.bloodSugar || ''
    };

    // Level of Consciousness
    if (input.levelOfConsciousness) {
      patch.generalExamination.levelOfConsciousness = input.levelOfConsciousness;
    }

    // GCS
    if (input.gcs) {
      patch.generalExamination.gcs = {
        e: input.gcs.e || '',
        v: input.gcs.v || '',
        m: input.gcs.m || '',
        total: input.gcs.total || ''
      };
    }

    // Orientation
    if (input.orientation) {
      patch.generalExamination.orientation = {
        time: input.orientation.time || false,
        place: input.orientation.place || false,
        person: input.orientation.person || false,
        details: ''
      };
    }

    // Physical Signs
    if (input.physicalSigns) {
      patch.generalExamination.physicalSigns = {
        pallor: input.physicalSigns.pallor || '',
        clubbing: input.physicalSigns.clubbing || '',
        icterus: input.physicalSigns.icterus || '',
        edema: input.physicalSigns.edema || '',
        emaciated: input.physicalSigns.emaciated || ''
      };
    }

    // Body Habitus
    if (input.bodyHabitus) {
      patch.generalExamination.bodyHabitus = input.bodyHabitus;
    }

    // Psychological
    if (input.psychological) {
      patch.generalExamination.psychological = {
        anxious: input.psychological.anxious || false,
        depressed: input.psychological.depressed || false,
        angry: input.psychological.angry || false,
        suicidal: input.psychological.suicidal || false,
        homicidal: input.psychological.homicidal || false,
        other: input.psychological.other || ''
      };
    }

    if (input.generalExamination?.notes) {
      patch.generalExamination.orientation = {
        ...(patch.generalExamination.orientation || {}),
        details: input.generalExamination.notes
      };
    }
  }

  // Triage & Trauma
  const trauma = input.triageAndTrauma || {};
  patch.triageAndTrauma = {
    airway: typeof trauma.airway === 'string' ? { status: trauma.airway } : trauma.airway || { status: 'Clear' },
    breathing: trauma.breathing || {},
    circulation: trauma.circulation || {},
    triageCategory: trauma.triageCategory || 'Green',
    burnChart: trauma.burnChart || { burnAreas: [] },
    externalInjuries: trauma.externalInjuries || '',
    identificationMarks: trauma.identificationMarks || {}
  };

  if (input.burnChart) {
    patch.triageAndTrauma.burnChart = {
      ...(patch.triageAndTrauma.burnChart || {}),
      totalScore: input.burnChart.percentage,
      causeOfBurn: input.burnChart.cause
    };
  }

  // Investigations
  if (typeof input.investigationAdvised?.other === 'string') {
    patch.investigationAdvised = {
      ...(input.investigationAdvised || {}),
      otherPathology: input.investigationAdvised.other
    };
  }

  // Plan & Disposition
  const plan = input.planAndDisposition || {};
  patch.planAndDisposition = {
    provisionalDiagnosis: plan.provisionalDiagnosis || '',
    proceduresPerformedInER: Array.isArray(plan.proceduresPerformedInER)
      ? plan.proceduresPerformedInER
      : typeof plan.proceduresPerformedInER === 'string'
        ? asArrayFromLines(plan.proceduresPerformedInER, (procedure) => ({ procedure }))
        : [],
    treatmentPlanned: Array.isArray(plan.treatmentPlanned)
      ? plan.treatmentPlanned
      : typeof plan.treatmentPlanned === 'string'
        ? asArrayFromLines(plan.treatmentPlanned, (drugNameAndForm) => ({ drugNameAndForm }))
        : [],
    otherPlan: plan.otherPlan || '',
    followUpInstructions: plan.followUpInstructions || '',
    intendedDischargeDate: plan.intendedDischargeDate || null,
    patientStatus: {
      disposition: plan.patientStatus?.disposition || 'Ward',
      referDetails: {
        hospitalName: plan.patientStatus?.referDetails?.hospitalName || '',
        reason: plan.patientStatus?.referDetails?.reason || '',
        referBy: plan.patientStatus?.referDetails?.referBy || ''
      }
    }
  };

  // Remove frontend-only fields
  delete patch.vitals;
  delete patch.gcsTotal;
  delete patch.pastMedicalHistory;
  delete patch.externalInjuries;

  return patch;
}

// ===================== NORMALIZE NURSING PAYLOAD =====================
function normalizeNursingPayload(input = {}) {
  const patch = { ...input };

  // ========== VITALS -> initialVitals ==========
  if (input.vitals) {
    patch.initialVitals = {
      ...(input.initialVitals || {}),
      temperature: input.vitals.temperature ? parseFloat(input.vitals.temperature) : undefined,
      pulse: input.vitals.pulse ? parseInt(input.vitals.pulse) : undefined,
      spo2: input.vitals.spo2 ? parseInt(input.vitals.spo2) : undefined,
      respiratoryRate: input.vitals.respiratoryRate ? parseInt(input.vitals.respiratoryRate) : undefined,
      height: input.vitals.height ? parseFloat(input.vitals.height) : undefined,
      weight: input.vitals.weight ? parseFloat(input.vitals.weight) : undefined,
      bloodPressure: {
        systolic: input.vitals.systolic ? parseInt(input.vitals.systolic) : undefined,
        diastolic: input.vitals.diastolic ? parseInt(input.vitals.diastolic) : undefined
      },
      temperatureUnit: 'Fahrenheit',
      recordedAt: input.arrivalTime || new Date()
    };
  }

  // ========== ALLERGY KNOWN ==========
  if (['Yes', 'No', 'Unknown'].includes(input.allergyKnown)) {
    patch.allergyKnown = input.allergyKnown === 'Yes' ? 'Known' : input.allergyKnown === 'No' ? 'None' : 'Unknown';
  }

  // ========== ORIENTATION CHECKLIST ==========
  const orientation = input.orientationChecklist || {};
  patch.orientationChecklist = {
    room: Boolean(orientation.room),
    bathroom: Boolean(orientation.bathroom),
    emergencyLight: Boolean(orientation.emergencyLight || orientation.emergencylight),
    lightControls: Boolean(orientation.lightControls || orientation.lightcontrols),
    sideRails: Boolean(orientation.sideRails || orientation.siderails),
    bedControls: Boolean(orientation.bedControls || orientation.bedcontrols),
    nurseCall: Boolean(orientation.nurseCall || orientation.nursecall),
    telephone: Boolean(orientation.telephone),
    toiletRail: Boolean(orientation.toiletRail || orientation.toiletrail),
    footstool: Boolean(orientation.footstool),
    television: Boolean(orientation.television),
    smokingPolicy: Boolean(orientation.smokingPolicy || orientation.smokingpolicy),
    visitingPolicy: Boolean(orientation.visitingPolicy || orientation.visitingpolicy),
    handbookGiven: Boolean(orientation.handbookGiven || orientation.handbookgiven)
  };

  // ========== CURRENT MEDICATIONS ==========
  if (input.currentMedicationsText) {
    patch.currentMedications = input.currentMedicationsText
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        // Try to parse drug, dose, frequency from line
        const parts = line.split(',').map(p => p.trim());
        return {
          drug: parts[0] || line,
          dose: parts[1] || '',
          frequency: parts[2] || '',
          remarks: parts.slice(3).join(', ') || ''
        };
      });
  }

  // ========== FUNCTIONAL ASSESSMENT ==========
  if (input.functionalAssessment) {
    if (!Array.isArray(input.functionalAssessment)) {
      // Convert object to array
      patch.functionalAssessment = Object.entries(input.functionalAssessment)
        .map(([activity, status]) => ({
          activity: activity.replace(/_/g, ' '),
          status: status || ''
        }));
    } else {
      patch.functionalAssessment = input.functionalAssessment;
    }
  }

  // ========== FALL RISK ==========
  const rawFall = input.fallRisk || {};
  if (rawFall && !Array.isArray(rawFall.items)) {
    const fallItems = [];
    const fallKeys = ['historyOfFalling', 'eliminationProblem', 'ambulatoryAid', 'cnscvsMedication', 'gait', 'mentalStatus'];
    const fallLabels = {
      historyOfFalling: 'History of Falling',
      eliminationProblem: 'Elimination Problem',
      ambulatoryAid: 'Ambulatory Aid',
      cnscvsMedication: 'CNS/CVS Medication',
      gait: 'Gait',
      mentalStatus: 'Mental Status'
    };

    fallKeys.forEach(key => {
      const value = rawFall[key];
      if (value !== undefined && value !== null && value !== '') {
        const score = Number(value) || 0;
        fallItems.push({
          key,
          label: fallLabels[key] || key,
          value: String(value),
          score
        });
      }
    });

    const total = fallItems.reduce((sum, item) => sum + item.score, 0);
    const riskBand = total >= 45 ? 'High Risk' : total >= 25 ? 'Medium Risk' : 'Low Risk';

    patch.fallRisk = {
      items: fallItems,
      total: Number(rawFall.total) || total,
      riskBand: rawFall.riskBand || riskBand,
      configVersion: rawFall.configVersion || 'pending-clinical-approval'
    };
  }

  // ========== PRESSURE ULCER RISK ==========
  const rawPressure = input.pressureUlcerRisk || input.pressureRisk || {};
  if (rawPressure && !Array.isArray(rawPressure.items)) {
    const pressureItems = [];
    const pressureKeys = ['sensoryPerception', 'moisture', 'activity', 'mobility', 'nutrition', 'shearFriction'];
    const pressureLabels = {
      sensoryPerception: 'Sensory Perception',
      moisture: 'Moisture',
      activity: 'Activity',
      mobility: 'Mobility',
      nutrition: 'Nutrition',
      shearFriction: 'Shear & Friction'
    };

    pressureKeys.forEach(key => {
      const value = rawPressure[key];
      if (value !== undefined && value !== null && value !== '') {
        const score = Number(value) || 0;
        pressureItems.push({
          key,
          label: pressureLabels[key] || key,
          value: String(value),
          score
        });
      }
    });

    const total = pressureItems.reduce((sum, item) => sum + item.score, 0);
    const riskBand = total <= 12 ? 'High Risk' : total <= 16 ? 'Moderate Risk' : 'Low Risk';

    patch.pressureUlcerRisk = {
      bedsorePresent: Boolean(input.bedsorePresent || rawPressure.bedsorePresent),
      location: input.bedsoreLocation || rawPressure.location || '',
      size: input.bedsoreSize || rawPressure.size || '',
      items: pressureItems,
      total: Number(rawPressure.total) || total,
      riskBand: rawPressure.riskBand || riskBand,
      configVersion: rawPressure.configVersion || 'pending-clinical-approval'
    };
  }

  // ========== SPECIAL NEEDS ==========
  if (input.specialNeedsText) {
    patch.specialNeeds = {
      ...(input.specialNeeds || {}),
      other: {
        value: Boolean(input.specialNeedsText && input.specialNeedsText.trim().length > 0),
        description: input.specialNeedsText,
        action: ''
      }
    };
  }

  // ========== CARE PLAN ==========
  if (input.carePlanText) {
    patch.nursingCarePlan = [{
      diagnosis: 'Nursing care plan',
      selected: true,
      interventionPlan: input.carePlanText,
      remarks: ''
    }];
  }

  // ========== CULTURAL/RELIGIOUS BARRIER ==========
  if (input.culturalReligiousBarrier) {
    if (typeof input.culturalReligiousBarrier === 'boolean') {
      patch.culturalReligiousBarrier = {
        value: input.culturalReligiousBarrier,
        description: '',
        action: ''
      };
    } else if (typeof input.culturalReligiousBarrier === 'object') {
      patch.culturalReligiousBarrier = {
        value: Boolean(input.culturalReligiousBarrier.value),
        description: input.culturalReligiousBarrier.description || '',
        action: input.culturalReligiousBarrier.action || ''
      };
    }
  }

  // Remove frontend-only fields
  delete patch.vitals;
  delete patch.currentMedicationsText;
  delete patch.pressureRisk;
  delete patch.specialNeedsText;
  delete patch.carePlanText;
  delete patch.bedsorePresent;
  delete patch.bedsoreLocation;
  delete patch.bedsoreSize;

  return patch;
}

// ===================== CONTROLLER FUNCTIONS =====================

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

exports.saveDoctorInitialAssessment = async (req, res) => {
  try {
    if (!['nurse', 'admin', 'mediqliq_super_admin', 'staff', 'registrar', 'receptionist'].includes(req.user.role)) {
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

    const isSigning = req.body.sign === true || req.body.formStatus === 'Signed';

    if (isSigning) {
      existing.formStatus = 'Signed';
      existing.signedAt = new Date();
      existing.signedBy = req.user._id;
      existing.signerName = req.user.name;
    }

    await existing.save();

    // ✅ UPDATE IPD ADMISSION with assessment data when signed
    if (isSigning) {
      try {
        const updateData = {};
        let shouldUpdate = false;

        // Update chief complaints
        if (patch.chiefComplaints) {
          updateData.chiefComplaints = patch.chiefComplaints;
          shouldUpdate = true;
        }

        // Update history of presenting illness
        if (patch.historyOfPresentingIllness) {
          updateData.historyOfPresentIllness = patch.historyOfPresentingIllness;
          shouldUpdate = true;
        }

        // Update past medical history
        if (patch.pastHistoryMedical?.other) {
          updateData.pastMedicalHistory = patch.pastHistoryMedical.other;
          shouldUpdate = true;
        }

        // Update provisional diagnosis
        if (patch.planAndDisposition?.provisionalDiagnosis) {
          updateData.provisionalDiagnosis = patch.planAndDisposition.provisionalDiagnosis;
          shouldUpdate = true;
        }

        // Update clinical assessment status
        updateData.clinicalAssessmentCompleted = true;
        updateData.clinicalAssessmentCompletedAt = new Date();
        updateData.clinicalAssessmentCompletedBy = req.user._id;
        shouldUpdate = true;

        // Update attendant information from assessment
        if (patch.relation) {
          updateData['attendant.relation'] = patch.relation;
          shouldUpdate = true;
        }

        // If admission status is still 'Admitted', update to 'Under Treatment'
        if (admission.status === 'Admitted') {
          updateData.status = 'Under Treatment';
          shouldUpdate = true;
        }

        if (shouldUpdate) {
          await IPDAdmission.findByIdAndUpdate(
            admission._id,
            { $set: updateData },
            { new: true, runValidators: true }
          );
          console.log('✅ IPD Admission updated with doctor assessment data');
        }
      } catch (admissionUpdateError) {
        console.error('Error updating IPD admission from assessment:', admissionUpdateError);
        // Don't throw - assessment is already saved, just log the error
      }
    }

    // Create Vitals record from assessment data
    try {
      const vitalsData = patch.generalExamination?.vitals || {};
      const height = patch.generalExamination?.height?.value || patch.generalExamination?.height;
      const weight = patch.generalExamination?.weight?.value || patch.generalExamination?.weight;
      const painScore = patch.painScore?.score || 0;

      const vitalsPayload = {
        admissionId: admission._id,
        patientId: id(admission.patientId),
        hospitalId: hospitalId,
        recordedBy: req.user._id,
        recordedByName: req.user.name,
        recordedByInitials: initials(req.user.name),
        recordedAt: new Date(),
        temperature: vitalsData.temp ? parseFloat(vitalsData.temp) : undefined,
        pulse: vitalsData.pulse ? parseInt(vitalsData.pulse) : undefined,
        bloodPressure: {
          systolic: vitalsData.bp?.split('/')[0] ? parseInt(vitalsData.bp.split('/')[0]) : undefined,
          diastolic: vitalsData.bp?.split('/')[1] ? parseInt(vitalsData.bp.split('/')[1]) : undefined
        },
        respiratoryRate: vitalsData.rr ? parseInt(vitalsData.rr) : undefined,
        spo2: vitalsData.spo2 ? parseInt(vitalsData.spo2) : undefined,
        bloodSugar: vitalsData.rbs ? parseInt(vitalsData.rbs) : undefined,
        weight: weight ? parseFloat(weight) : undefined,
        height: height ? parseFloat(height) : undefined,
        painScore: painScore ? parseInt(painScore) : undefined,
        status: req.body.formStatus === 'Signed' ? 'Signed' : 'Draft',
        remarks: 'Auto-created from Doctor Initial Assessment'
      };

      const newVitals = new IPDVitals(vitalsPayload);
      await newVitals.save();

    } catch (vitalsError) {
      console.error('Error saving vitals from assessment:', vitalsError);
    }

    // Save prescription if medications were prescribed
    if (req.body.prescription) {
      try {
        const { items, lab_test_requests, radiology_test_requests, procedure_requests } = req.body.prescription;

        if (items && items.length > 0) {
          const prescription = new Prescription({
            patient_id: admission.patientId,
            doctor_id: req.user._id,
            ipd_admission_id: admission._id,
            source_type: 'IPD',
            diagnosis: patch.planAndDisposition?.provisionalDiagnosis || '',
            pain_score: patch.painScore?.score,
            allergy_snapshot: allergySnapshot(
              patch.allergies,
              admission.patientId?.allergies
            ),
            items: items.map(item => ({
              medicine_name: item.medicine_name,
              generic_name: item.generic_name || item.medicine_name,
              nlem_code: item.nlem_code || '',
              dosage_form: item.dosage_form || '',
              medicine_type: item.medicine_type || 'Tablet',
              route_of_administration: item.route_of_administration || 'Oral',
              dosage: item.dosage || '',
              frequency: item.frequency || '',
              duration: item.duration || '',
              quantity: item.quantity || 1,
              dose_qty_base_units: item.dose_quantity || 1,
              requires_pharmacy_dispense: item.requires_pharmacy_dispense !== false,
              instructions: item.instructions || '',
              timing: item.timing || 'Anytime'
            })),
            lab_test_requests: lab_test_requests || [],
            radiology_test_requests: radiology_test_requests || [],
            procedure_requests: procedure_requests || [],
            created_by: req.user._id
          });

          await prescription.save();

          if (!existing.prescriptionIds) existing.prescriptionIds = [];
          existing.prescriptionIds.push(prescription._id);

          const medicationNames = items.map(item => item.medicine_name).filter(Boolean);
          if (medicationNames.length > 0) {
            existing.medicationSummary = medicationNames.join(', ');
          }

          await existing.save();
        }
      } catch (prescriptionError) {
        console.error('Error saving prescription from assessment:', prescriptionError);
      }
    }

    res.json({ success: true, assessment: existing });
  } catch (error) {
    console.log('Error in saveDoctorInitialAssessment:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.saveNursingAdmissionAssessment = async (req, res) => {
  try {
    if (!['nurse', 'admin', 'mediqliq_super_admin', 'staff', 'registrar', 'receptionist'].includes(req.user.role)) {
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

    // Recalculate scores
    const fall = (existing.fallRisk?.items || []).reduce((s, r) => s + Number(r.score || 0), 0);
    const pressure = (existing.pressureUlcerRisk?.items || []).reduce((s, r) => s + Number(r.score || 0), 0);

    if (existing.fallRisk) existing.fallRisk.total = fall;
    if (existing.pressureUlcerRisk) existing.pressureUlcerRisk.total = pressure;

    if (req.body.sign === true || req.body.status === 'Signed') {
      existing.status = 'Signed';
      existing.signedAt = new Date();
      existing.signedBy = req.user._id;
    }

    await existing.save();

    // Create Vitals record from nursing assessment
    try {
      const vitalsData = patch.initialVitals || {};

      const vitalsPayload = {
        admissionId: admission._id,
        patientId: id(admission.patientId),
        hospitalId: hospitalId,
        recordedBy: req.user._id,
        recordedByName: req.user.name,
        recordedByInitials: initials(req.user.name),
        recordedAt: new Date(),
        temperature: vitalsData.temperature ? parseFloat(vitalsData.temperature) : undefined,
        pulse: vitalsData.pulse ? parseInt(vitalsData.pulse) : undefined,
        bloodPressure: {
          systolic: vitalsData.bloodPressure?.systolic ? parseInt(vitalsData.bloodPressure.systolic) : undefined,
          diastolic: vitalsData.bloodPressure?.diastolic ? parseInt(vitalsData.bloodPressure.diastolic) : undefined
        },
        respiratoryRate: vitalsData.respiratoryRate ? parseInt(vitalsData.respiratoryRate) : undefined,
        spo2: vitalsData.spo2 ? parseInt(vitalsData.spo2) : undefined,
        weight: vitalsData.weight ? parseFloat(vitalsData.weight) : undefined,
        height: vitalsData.height ? parseFloat(vitalsData.height) : undefined,
        painScore: patch.painScore ? parseInt(patch.painScore) : undefined,
        status: req.body.status === 'Signed' ? 'Signed' : 'Draft',
        remarks: 'Auto-created from Nursing Admission Assessment'
      };

      const newVitals = new IPDVitals(vitalsPayload);
      await newVitals.save();

    } catch (vitalsError) {
      console.error('Error saving vitals from nursing assessment:', vitalsError);
    }

    res.json({ success: true, assessment: existing });
  } catch (error) {
    console.log('Error in saveNursingAdmissionAssessment:', error);
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

    // Build query for medications
    const q = {
      admissionId: admission._id,
      status: { $ne: 'Stopped' }
    };

    // ✅ Date range filter - inclusive of the end date
    if (req.query.from || req.query.to) {
      q.startDate = {};
      if (req.query.from) {
        q.startDate.$gte = asDate(req.query.from);
      }
      if (req.query.to) {
        // ✅ Add one day to include the entire end date
        const toDate = asDate(req.query.to);
        if (toDate) {
          const inclusiveEnd = new Date(toDate);
          inclusiveEnd.setDate(inclusiveEnd.getDate() + 1);
          q.startDate.$lte = inclusiveEnd;
        }
      }
    }

    console.log('🔍 Medication filter:', JSON.stringify(q));

    const medications = await IPDMedicationChart.find(q)
      .sort({ emergencyDrug: -1, isHighRisk: -1, startDate: 1 })
      .populate('prescribedBy', 'name firstName lastName')
      .populate('timing.administeredBy', 'name firstName lastName')
      .populate('timing.witnessedBy', 'name firstName lastName')
      .lean();

    console.log(`✅ Found ${medications.length} medications for admission ${admission._id}`);

    res.json({
      success: true,
      payload: {
        reportType: 'medication_chart',
        title: 'NURSING MEDICATION CHART',
        header: header(admission),
        from: req.query.from || null,
        to: req.query.to || null,
        medications: medications
      }
    });
  } catch (error) {
    console.error('❌ Error in printMedicationChart:', error);
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

    // ✅ Build date filter only if both from and to are provided and have values
    const fromDate = req.query.from && req.query.from.trim() !== '' ? asDate(req.query.from) : null;
    const toDate = req.query.to && req.query.to.trim() !== '' ? asDate(req.query.to) : null;

    if (fromDate && toDate) {
      filter.roundDateTime = {
        $gte: fromDate,
        $lte: toDate
      };
    } else if (fromDate) {
      filter.roundDateTime = { $gte: fromDate };
    } else if (toDate) {
      filter.roundDateTime = { $lte: toDate };
    }

    console.log('🔍 Print rounds filter:', JSON.stringify(filter));
    console.log('📅 From date:', fromDate);
    console.log('📅 To date:', toDate);

    const rounds = await IPDRound.find(filter)
      .sort({ roundDateTime: 1 })
      .populate('doctorId', 'name firstName lastName')
      .populate('vitalId')
      .populate({
        path: 'prescriptionId',
        select: 'items lab_test_requests radiology_test_requests procedure_requests prescription_number _id'
      })
      .lean();

    console.log(`✅ Found ${rounds.length} rounds for admission ${admission._id}`);

    // ✅ If no rounds found, log for debugging
    if (rounds.length === 0) {
      const allRounds = await IPDRound.find({
        admissionId: admission._id,
        hospitalId: admission.hospitalId || admission.hospital_id
      }).lean();
      console.log(`📊 Total rounds in DB for this admission: ${allRounds.length}`);
      if (allRounds.length > 0) {
        console.log('📝 Sample round:', JSON.stringify(allRounds[0], null, 2));
      }
    }

    res.json({
      success: true,
      payload: {
        reportType: req.query.type === 'notes' ? 'doctors_note' : 'consultant_daily_assessment',
        title: req.query.type === 'notes'
          ? "DOCTOR'S NOTE"
          : 'CONSULTANT DAILY ASSESSMENT AND MANAGEMENT PLAN',
        header: header(admission),
        rounds: rounds
      }
    });
  } catch (error) {
    console.error('❌ Error in printRounds:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};