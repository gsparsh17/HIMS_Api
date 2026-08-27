const { operationNow } = require('../utils/operationTimeContext');
// controllers/prescription.controller.js
const Prescription = require('../models/Prescription');
const Vital = require('../models/Vital');
const Medicine = require('../models/Medicine');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const IPDRound = require('../models/IPDRound');
const Patient = require('../models/Patient');
const LabRequest = require('../models/LabRequest');
const LabTest = require('../models/LabTest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ImagingTest = require('../models/ImagingTest');
const ProcedureRequest = require('../models/ProcedureRequest');
const Pharmacy = require('../models/Pharmacy');
const Procedure = require('../models/Procedure');
const Hospital = require('../models/Hospital');
const FinancialTransaction = require('../models/FinancialTransaction');
const Doctor = require('../models/Doctor');
const Appointment = require('../models/Appointment');
const SafetyPolicy = require('../models/SafetyPolicy');
const { generatePrescriptionPdf, generateOpdSlipPdf } = require('../services/clinicalPdf.service');
const fileStorage = require('../services/fileStorage.service');
const fs = require('fs');
const { requestHospitalId } = require('../utils/hospitalScope');

async function attachAdmissionDetailsToPrescriptions(prescriptions, hospitalId, { includeWardCode = false } = {}) {
  const rows = prescriptions.map((prescription) =>
    typeof prescription?.toObject === 'function' ? prescription.toObject() : prescription
  );
  const admissionIds = [...new Set(rows.map((row) => row?.ipd_admission_id?.toString?.() || row?.ipd_admission_id).filter(Boolean))];
  if (!admissionIds.length) return rows;

  const admissions = await IPDAdmission.find({ _id: { $in: admissionIds }, hospitalId })
    .select('admissionNumber shipNumber wardId bedId status admissionDate')
    .populate('wardId', 'name code')
    .populate('bedId', 'bedNumber name')
    .lean();
  const admissionMap = new Map(admissions.map((admission) => [String(admission._id), admission]));

  return rows.map((row) => {
    if (!row.ipd_admission_id) return row;
    const admission = admissionMap.get(String(row.ipd_admission_id));
    if (!admission) return row;
    row.admission_details = {
      _id: admission._id,
      admissionNumber: admission.admissionNumber,
      shipNumber: admission.shipNumber,
      ward_name: admission.wardId?.name || 'N/A',
      ...(includeWardCode ? { ward_code: admission.wardId?.code || '' } : {}),
      bed_number: admission.bedId?.bedNumber || 'N/A',
      status: admission.status,
      admission_date: admission.admissionDate
    };
    row.ward = admission.wardId?.name || 'N/A';
    row.bed_number = admission.bedId?.bedNumber || 'N/A';
    row.admission_number = admission.admissionNumber;
    return row;
  });
}



// ============== HELPER FUNCTIONS ==============

// Create Lab Requests from prescription
async function createLabRequests(prescription, labTestRequests, userId, sourceType, admissionId = null, hospitalId = null) {
  const createdRequests = [];

  for (const labReq of labTestRequests) {
    let labTest = null;
    if (labReq.lab_test_id) labTest = await LabTest.findOne({ _id: labReq.lab_test_id, hospitalId });
    else if (labReq.lab_test_code) labTest = await LabTest.findOne({ hospitalId, code: labReq.lab_test_code });

    if (!labTest) continue;

    const labRequest = new LabRequest({
      hospitalId,
      requestNumber: `LAB-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      orderGroupId: prescription._id,
      orderNumber: prescription.prescription_number || undefined,
      requestGroupKey: `RX:${prescription._id}`,
      sourceType: sourceType || 'OPD',
      admissionId: admissionId || null,
      appointmentId: prescription.appointment_id || null,
      prescriptionId: prescription._id,
      patientId: prescription.patient_id,
      doctorId: prescription.doctor_id,
      labTestId: labTest._id,
      testCode: labTest.code,
      testName: labTest.name,
      category: labTest.category,
      clinical_history: labReq.clinical_history || '',
      priority: labReq.priority || 'Routine',
      scheduledDate: labReq.scheduled_date || null,
      patient_notes: labReq.notes || '',
      cost: labTest.base_price,
      status: 'Pending',
      createdBy: userId
    });

    await labRequest.save();
    createdRequests.push({
      request_id: labRequest._id,
      lab_test_id: labTest._id,
      lab_test_code: labTest.code,
      lab_test_name: labTest.name,
      category: labTest.category,
      clinical_history: labReq.clinical_history || '',
      priority: labReq.priority || 'Routine',
      scheduled_date: labReq.scheduled_date || null,
      notes: labReq.notes || '',
      cost: labTest.base_price || 0
    });
  }

  return createdRequests;
}

// Create Radiology Requests from prescription
async function createRadiologyRequests(prescription, radiologyRequests, userId, sourceType, admissionId = null, hospitalId = null) {
  const createdRequests = [];

  for (const radReq of radiologyRequests) {
    let imagingTest = null;
    if (radReq.imaging_test_id) imagingTest = await ImagingTest.findOne({ _id: radReq.imaging_test_id, hospitalId });
    else if (radReq.imaging_test_code) imagingTest = await ImagingTest.findOne({ hospitalId, code: radReq.imaging_test_code });

    if (!imagingTest) continue;

    const radiologyRequest = new RadiologyRequest({
      hospitalId,
      requestNumber: `RAD-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      sourceType: sourceType || 'OPD',
      admissionId: admissionId || null,
      prescriptionId: prescription._id,
      patientId: prescription.patient_id,
      doctorId: prescription.doctor_id,
      imagingTestId: imagingTest._id,
      testCode: imagingTest.code,
      testName: imagingTest.name,
      category: imagingTest.category,
      clinical_history: radReq.clinical_history || '',
      priority: radReq.priority || 'Routine',
      scheduledDate: radReq.scheduled_date || null,
      patient_notes: radReq.notes || '',
      cost: imagingTest.base_price,
      status: 'Pending',
      createdBy: userId
    });

    await radiologyRequest.save();
    createdRequests.push({
      request_id: radiologyRequest._id,
      imaging_test_id: imagingTest._id,
      imaging_test_code: imagingTest.code,
      imaging_test_name: imagingTest.name,
      category: imagingTest.category,
      clinical_history: radReq.clinical_history || '',
      priority: radReq.priority || 'Routine',
      scheduled_date: radReq.scheduled_date || null,
      notes: radReq.notes || '',
      cost: imagingTest.base_price || 0
    });
  }

  return createdRequests;
}

// Create Procedure Requests from prescription
async function createProcedureRequests(prescription, procedureRequests, userId, sourceType, admissionId = null, hospitalId = null) {
  const createdRequests = [];

  for (const procReq of procedureRequests) {
    let procedure = null;
    if (procReq.procedure_id) procedure = await Procedure.findOne({ _id: procReq.procedure_id, hospitalId });
    else if (procReq.procedure_code) procedure = await Procedure.findOne({ hospitalId, code: procReq.procedure_code });

    if (!procedure) continue;

    const procedureRequest = new ProcedureRequest({
      hospitalId,
      requestNumber: `PROC-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      sourceType: sourceType || 'OPD',
      admissionId: admissionId || null,
      prescriptionId: prescription._id,
      patientId: prescription.patient_id,
      doctorId: prescription.doctor_id,
      procedureId: procedure._id,
      procedureCode: procedure.code,
      procedureName: procedure.name,
      category: procedure.category,
      subcategory: procedure.subcategory,
      clinical_indication: procReq.clinical_indication || '',
      clinical_history: procReq.clinical_history || '',
      priority: procReq.priority || 'Routine',
      scheduledDate: procReq.scheduled_date || null,
      anesthesia_type: procReq.anesthesia_type || 'Local',
      consent_obtained: procReq.consent_obtained || false,
      pre_procedure_instructions: procReq.pre_procedure_instructions || '',
      cost: procedure.base_price,
      status: 'Pending',
      createdBy: userId
    });

    await procedureRequest.save();
    createdRequests.push({
      request_id: procedureRequest._id,
      procedure_id: procedure._id,
      procedure_code: procedure.code,
      procedure_name: procedure.name,
      category: procedure.category,
      clinical_history: procReq.clinical_history || '',
      clinical_indication: procReq.clinical_indication || '',
      priority: procReq.priority || 'Routine',
      scheduled_date: procReq.scheduled_date || null,
      notes: procReq.notes || procReq.pre_procedure_instructions || '',
      cost: procedure.base_price || 0
    });
  }

  return createdRequests;
}

const { calculateMedicationRequiredBaseUnits, resolveDoseQtyBaseUnits, generateTimingSlots: generateMedicationTimingSlots, createOrUpdatePharmacyRequest, normaliseBoolean, assertAdmissionHospitalAccess } = require('../services/ipdMedicationFlow.service');

// Helper function to generate timing slots for medication
function generateTimingSlots(frequency, durationDays) {
  const timingSlots = [];
  const freqTimingMap = {
    'OD': ['08:00'],
    'BD': ['08:00', '20:00'],
    'TDS': ['08:00', '14:00', '20:00'],
    'QDS': ['06:00', '12:00', '18:00', '22:00'],
    'q4h': ['06:00', '10:00', '14:00', '18:00', '22:00', '02:00'],
    'q6h': ['06:00', '12:00', '18:00', '00:00'],
    'q8h': ['06:00', '14:00', '22:00'],
    'q12h': ['08:00', '20:00'],
    'Stat': ['now'],
    'SOS': []
  };

  const times = freqTimingMap[frequency] || ['08:00'];
  const today = operationNow();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < durationDays; d++) {
    const slotDate = new Date(today);
    slotDate.setDate(today.getDate() + d);

    for (const t of times) {
      timingSlots.push({
        date: slotDate,
        time: t,
        status: 'Pending'
      });
    }
  }

  return timingSlots;
}

// ========== UNIFIED PHARMACY REQUEST FUNCTION ==========
// FIX: Unified createPharmacyRequest with quantity parameter
async function createPharmacyRequest(medication, requestedQuantity = null) {
  try {
    const pharmacy = await Pharmacy.findOne({ status: 'Active' });
    if (!pharmacy) {
      console.log('No active pharmacy found for medication request');
      return null;
    }

    const requestNumber = `PHARM-REQ-${Date.now()}-${medication._id.toString().substring(0, 6)}`;

    medication.pharmacyRequest = {
      requestedToPharmacy: true,
      requestedAt: operationNow(),
      requestedBy: medication.createdBy || medication.prescribedBy,
      pharmacyId: pharmacy._id,
      pharmacyRequestNumber: requestNumber,
      pharmacyStatus: 'Pending',
      requestedQuantity: requestedQuantity || medication.requiredQtyBaseUnits || 1,
      dispensedFromPharmacy: false,
      dispensedQuantity: 0,
      stockReceivedByNurse: false
    };

    medication.status = 'Requested';
    medication.stockReceiptStatus = 'PENDING_RECEIPT';
    await medication.save();

    // Create nursing note for audit
    const NursingNote = require('../models/NursingNote');
    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      noteType: 'Medication',
      note: `Pharmacy request created for ${medication.medicineName} - Qty: ${requestedQuantity || medication.requiredQtyBaseUnits} ${medication.baseUnit || 'units'}`,
      priority: medication.isHighRisk ? 'Important' : 'Normal',
      createdBy: medication.createdBy || medication.prescribedBy
    });
    await nursingNote.save();

    return medication;

  } catch (error) {
    console.error('Error creating pharmacy request:', error);
    throw error;
  }
}


async function prescriptionTenant(req, prescription, { notFound = false } = {}) {
  const hospitalId = requestHospitalId(req);
  const patientId = prescription?.patient_id?._id || prescription?.patient_id;
  if (!patientId) {
    const error = new Error('Prescription patient is missing');
    error.statusCode = 400;
    throw error;
  }
  const patient = await Patient.findOne({ _id: patientId, hospitalId }).select('_id hospitalId allergies').lean();
  if (!patient) {
    const error = new Error(notFound ? 'Prescription not found' : 'Cross-hospital prescription access is not permitted');
    error.statusCode = notFound ? 404 : 403;
    throw error;
  }
  return { hospitalId, patient };
}

async function validatePrescriptionActors(req, { hospitalId, patientId, doctorId, appointmentId }) {
  const [patient, doctor] = await Promise.all([
    Patient.findOne({ _id: patientId, hospitalId }).select('_id hospitalId allergies').lean(),
    Doctor.findOne({ _id: doctorId, hospitalId }).select('_id hospitalId user_id email').lean()
  ]);
  if (!patient) { const error = new Error('Patient not found for this hospital'); error.statusCode = 404; throw error; }
  if (!doctor) { const error = new Error('Doctor not found for this hospital'); error.statusCode = 404; throw error; }
  if (req.user?.role === 'doctor') {
    const ownsDoctor = (doctor.user_id && String(doctor.user_id) === String(req.user._id)) ||
      (doctor.email && req.user.email && String(doctor.email).toLowerCase() === String(req.user.email).toLowerCase());
    if (!ownsDoctor) { const error = new Error('Doctors may create prescriptions only under their own doctor profile'); error.statusCode = 403; throw error; }
  }
  let appointment = null;
  if (appointmentId) {
    appointment = await Appointment.findOne({ _id: appointmentId, hospital_id: hospitalId }).select('_id patient_id doctor_id hospital_id').lean();
    if (!appointment) { const error = new Error('Appointment not found for this hospital'); error.statusCode = 404; throw error; }
    if (String(appointment.patient_id) !== String(patientId) || String(appointment.doctor_id) !== String(doctorId)) {
      const error = new Error('Appointment, patient and doctor do not match'); error.statusCode = 409; throw error;
    }
  }
  return { patient, doctor, appointment };
}

exports.createPrescription = async (req, res) => {
  try {
    const {
      patient_id,
      doctor_id,
      appointment_id,
      ipd_admission_id,
      source_type,
      round_id,
      presenting_complaint,
      history_of_presenting_complaint,
      diagnosis,
      diagnosis_icd11_code,
      pain_score,
      allergy_snapshot,
      symptoms,
      investigation,
      provisional_diagnosis,
      treatment_plan,
      physical_examination,
      outcome_expected,
      diet_advice,
      items,
      lab_test_requests = [],
      radiology_test_requests = [],
      procedure_requests = [],
      notes,
      prescription_image,
      validity_days,
      follow_up_date,
      is_repeatable,
      repeat_count
    } = req.body;

    // Resolve safety metadata from the existing Medicine master. The order remains
    // clinically independent of inventory, but when an inventory medicine is selected
    // we enforce its configured NABH medication-safety controls.
    const selectedMedicineIds = Array.isArray(items)
      ? items.map((x) => x.medicine_id).filter(Boolean)
      : [];
    const prescriptionHospitalId = requestHospitalId(req);
    const prescriptionActors = await validatePrescriptionActors(req, {
      hospitalId: prescriptionHospitalId,
      patientId: patient_id,
      doctorId: doctor_id,
      appointmentId: appointment_id
    });
    const selectedMedicines = selectedMedicineIds.length
      ? await Medicine.find({ _id: { $in: selectedMedicineIds }, hospitalId: prescriptionHospitalId }).select('name generic_name brand dosage_form manufacturer manufacturer_brand_owner is_high_risk is_high_alert prescription_required medicationSafety').lean()
      : [];
    const medicineSafetyById = new Map(selectedMedicines.map((x) => [String(x._id), x]));
    const antimicrobialPolicy = await SafetyPolicy.findOne({
      hospitalId: prescriptionHospitalId,
      policyType: 'antimicrobial_usage',
      active: true,
      $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: operationNow() } }]
    }).sort({ effectiveFrom: -1 }).lean();
    const medicationSafetyAlerts = [];
    for (const item of Array.isArray(items) ? items : []) {
      const master = item.medicine_id ? medicineSafetyById.get(String(item.medicine_id)) : null;
      if (!master) continue;
      const safety = master.medicationSafety || {};
      const alerts = [];
      if (safety.highRisk) alerts.push('HIGH_RISK_MEDICATION');
      if (safety.lasa) alerts.push('LOOK_ALIKE_SOUND_ALIKE');
      if (safety.lookAlikeSoundAlikeGroup) alerts.push(`LASA_GROUP:${safety.lookAlikeSoundAlikeGroup}`);
      if (safety.formularyStatus === 'restricted') alerts.push('RESTRICTED_FORMULARY');
      if (safety.antimicrobial) {
        alerts.push('ANTIMICROBIAL');
        if (!String(item.antimicrobial_justification || '').trim()) {
          return res.status(422).json({
            success: false,
            error: `Antimicrobial justification is required for ${master.name}`,
            code: 'ANTIMICROBIAL_JUSTIFICATION_REQUIRED'
          });
        }
        const restricted = (antimicrobialPolicy?.content?.restrictedAntibiotics || [])
          .map((x) => String(x).toLowerCase())
          .some((x) => [master.name, master.generic_name].filter(Boolean).map((y) => String(y).toLowerCase()).includes(x));
        if (restricted && !String(item.antimicrobial_approval_reference || '').trim()) {
          return res.status(422).json({
            success: false,
            error: `Restricted antimicrobial approval is required for ${master.name}`,
            code: 'ANTIMICROBIAL_APPROVAL_REQUIRED'
          });
        }
      }
      item.__resolvedSafetyAlerts = alerts;
      if (alerts.length) medicationSafetyAlerts.push({ medicineId: master._id, medicineName: master.name, alerts });
    }

    // Process medication items and calculate required quantities
    const processedItems = items && Array.isArray(items)
      ? items.map(item => {
        const doseQtyBaseUnits = resolveDoseQtyBaseUnits(item);
        const requiredQtyBaseUnits = calculateMedicationRequiredBaseUnits({
          ...item,
          duration: parseInt(item.duration) || 1,
          durationUnit: 'Days'
        });

        return {
          medicine_name: item.medicine_name,
          generic_name: item.generic_name || item.medicine_name || '',
          nlem_code: item.nlem_code || item.nlemCode || '',
          dosage_form: item.dosage_form || item.dosageForm || item.medicine_type || '',
          // Optional legacy/pre-mapped inventory reference only. It is never
          // required for OPD/IPD prescribing and is not used to constrain the doctor.
          medicine_id: item.medicine_id || null,
          medicine_type: item.medicine_type || 'Tablet',
          route_of_administration: item.route_of_administration || 'Oral',
          dosage: item.dosage || '',
          frequency: item.frequency,
          duration: item.duration,
          quantity: item.quantity || requiredQtyBaseUnits,
          dose_qty_base_units: doseQtyBaseUnits,
          required_qty_base_units: requiredQtyBaseUnits,
          instructions: item.instructions || '',
          timing: item.timing || 'Anytime',
          // NEW: Include pharmacy dispense flag from frontend
          requires_pharmacy_dispense: normaliseBoolean(item.requires_pharmacy_dispense, true),
          antimicrobial_justification: item.antimicrobial_justification || '',
          antimicrobial_approval_reference: item.antimicrobial_approval_reference || '',
          safety_alerts: item.__resolvedSafetyAlerts || []
        };
      })
      : [];

    // IPD prescriptions must be tied to the admission and to its patient. This prevents
    // a medication chart or pharmacy sale from being created for the wrong patient/file.
    let ipdAdmission = null;
    if (String(source_type || '').toUpperCase() === 'IPD') {
      ipdAdmission = await IPDAdmission.findById(ipd_admission_id);
      if (!ipdAdmission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
      assertAdmissionHospitalAccess(req, ipdAdmission);
      if (String(ipdAdmission.patientId) !== String(patient_id)) {
        return res.status(400).json({ success: false, error: 'The selected patient does not belong to this IPD admission.' });
      }
    }

    // Capture immutable clinical context for the generated prescription PDF.
    // Existing callers remain compatible: allergy is taken from the patient
    // master when omitted, and IPD ward-round pain is taken from the linked
    // round when the caller does not send it explicitly.
    let resolvedAllergySnapshot = String(allergy_snapshot || '').trim();
    if (!resolvedAllergySnapshot && patient_id) {
      resolvedAllergySnapshot = String(prescriptionActors?.patient?.allergies || '').trim();
    }

    let resolvedPainScore = pain_score;
    if ((resolvedPainScore === undefined || resolvedPainScore === null || resolvedPainScore === '') && round_id) {
      const linkedRound = await IPDRound.findById(round_id).select('painScore').lean();
      resolvedPainScore = linkedRound?.painScore;
    }
    if (resolvedPainScore !== undefined && resolvedPainScore !== null && resolvedPainScore !== '') {
      resolvedPainScore = Number(resolvedPainScore);
      if (!Number.isFinite(resolvedPainScore)) resolvedPainScore = undefined;
    } else {
      resolvedPainScore = undefined;
    }

    // Create prescription first
    const prescription = new Prescription({
      hospitalId: prescriptionHospitalId,
      patient_id,
      doctor_id,
      appointment_id: appointment_id || null,
      ipd_admission_id: ipd_admission_id || null,
      source_type: source_type || 'OPD',
      round_id: round_id || null,
      presenting_complaint: presenting_complaint || '',
      history_of_presenting_complaint: history_of_presenting_complaint || '',
      diagnosis: diagnosis || '',
      diagnosis_icd11_code: diagnosis_icd11_code || null,
      pain_score: resolvedPainScore,
      allergy_snapshot: resolvedAllergySnapshot,
      symptoms: symptoms || '',
      investigation: investigation || '',
      provisional_diagnosis: provisional_diagnosis || diagnosis || '',
      treatment_plan: treatment_plan || notes || '',
      physical_examination: physical_examination || '',
      outcome_expected: outcome_expected || '',
      diet_advice: diet_advice || '',
      items: processedItems,
      notes: notes || '',
      prescription_image: prescription_image || null,
      validity_days: validity_days || 30,
      follow_up_date: follow_up_date ? new Date(follow_up_date) : null,
      is_repeatable: is_repeatable || false,
      repeat_count: repeat_count || 0,
      created_by: req.user?._id
    });

    await prescription.save();

    // Create Lab Requests
    const createdLabRequests = await createLabRequests(
      prescription, lab_test_requests, req.user?._id,
      source_type || 'OPD', ipd_admission_id || null, prescriptionHospitalId
    );

    // Create Radiology Requests
    const createdRadiologyRequests = await createRadiologyRequests(
      prescription, radiology_test_requests, req.user?._id,
      source_type || 'OPD', ipd_admission_id || null, prescriptionHospitalId
    );

    // Create Procedure Requests
    const createdProcedureRequests = await createProcedureRequests(
      prescription, procedure_requests, req.user?._id,
      source_type || 'OPD', ipd_admission_id || null, prescriptionHospitalId
    );

    // Update prescription with request IDs
    if (createdLabRequests.length > 0) {
      prescription.lab_test_requests = createdLabRequests.map(req => ({
        lab_test_id: req.lab_test_id,
        lab_test_code: req.lab_test_code,
        lab_test_name: req.lab_test_name,
        category: req.category,
        clinical_history: req.clinical_history,
        priority: req.priority,
        scheduled_date: req.scheduled_date,
        notes: req.notes,
        cost: req.cost,
        request_id: req.request_id,
        created_at: operationNow()
      }));
    }

    if (createdRadiologyRequests.length > 0) {
      prescription.radiology_test_requests = createdRadiologyRequests.map(req => ({
        imaging_test_id: req.imaging_test_id,
        imaging_test_code: req.imaging_test_code,
        imaging_test_name: req.imaging_test_name,
        category: req.category,
        clinical_history: req.clinical_history,
        priority: req.priority,
        scheduled_date: req.scheduled_date,
        notes: req.notes,
        cost: req.cost,
        request_id: req.request_id,
        created_at: operationNow()
      }));
    }

    if (createdProcedureRequests.length > 0) {
      prescription.procedure_requests = createdProcedureRequests.map(req => ({
        procedure_id: req.procedure_id,
        procedure_code: req.procedure_code,
        procedure_name: req.procedure_name,
        category: req.category,
        clinical_history: req.clinical_history,
        clinical_indication: req.clinical_indication,
        priority: req.priority,
        scheduled_date: req.scheduled_date,
        notes: req.notes,
        request_id: req.request_id,
        cost: req.cost,
        created_at: operationNow()
      }));
    }

    await prescription.save();

    let convertedMedications = [];

    // For IPD prescriptions, convert medications to IPD Medication Chart
    if (source_type === 'IPD' && ipd_admission_id && processedItems.length > 0) {
      for (const item of processedItems) {
        // Get medicine details if available
        let medicineDetails = null;
        let baseUnit = 'unit';
        let packUnit = 'pack';
        let unitsPerPack = 1;
        let costPerUnit = 0;

        if (item.medicine_id) {
          medicineDetails = await Medicine.findById(item.medicine_id);
          if (medicineDetails) {
            baseUnit = medicineDetails.base_unit || 'unit';
            packUnit = medicineDetails.pack_unit || 'pack';
            unitsPerPack = medicineDetails.units_per_pack || 1;
            costPerUnit = medicineDetails.selling_price || medicineDetails.mrp || 0;
          }
        }

        // Generate timing slots for nurse administration
        const durationValue = parseInt(item.duration) || 1;
        const timingSlots = generateMedicationTimingSlots(item.frequency, durationValue);

        // Quantity planning uses dose units, never the text strength (for example, 500mg is one tablet unless a dose count is entered).
        const doseQtyBaseUnits = item.dose_qty_base_units || resolveDoseQtyBaseUnits(item);
        const requiredQtyBaseUnits = item.required_qty_base_units || calculateMedicationRequiredBaseUnits({
          ...item,
          duration: durationValue,
          durationUnit: 'Days'
        });

        // Check if pharmacy dispense is required (from frontend)
        const requiresPharmacyDispense = item.requires_pharmacy_dispense !== undefined
          ? item.requires_pharmacy_dispense
          : true;

        const medicationOrder = new IPDMedicationChart({
          admissionId: ipd_admission_id,
          hospitalId: ipdAdmission?.hospitalId || req.user?.hospital_id || null,
          patientId: patient_id,
          prescribedBy: doctor_id,
          roundId: round_id || null,
          prescriptionId: prescription._id,
          medicineId: item.medicine_id || null,
          medicineName: item.medicine_name,
          genericName: item.generic_name,
          nlemCode: item.nlem_code || '',
          dosageForm: item.dosage_form || item.medicine_type || '',
          doseQtyBaseUnits,
          route: item.route_of_administration,
          dosage: item.dosage,
          frequency: item.frequency,
          duration: durationValue,
          durationUnit: 'Days',
          specialInstructions: item.instructions,
          timing: timingSlots,
          requiredQtyBaseUnits,
          costPerUnit,
          totalCost: requiredQtyBaseUnits * costPerUnit,
          requiresPharmacyDispense: requiresPharmacyDispense,
          status: requiresPharmacyDispense ? 'Requested' : 'Active',
          stockReceiptStatus: requiresPharmacyDispense ? 'PENDING_RECEIPT' : 'NOT_REQUESTED',
          startDate: operationNow(),
          createdBy: req.user?._id
        });

        await medicationOrder.save();
        convertedMedications.push(medicationOrder._id);

        // Pharmacy dispense means a real pharmacy issue is required. The request is
        // created now; the actual sale is created only when pharmacy selects a batch.
        if (requiresPharmacyDispense) {
          await createOrUpdatePharmacyRequest({
            medication: medicationOrder,
            requestedQuantity: requiredQtyBaseUnits,
            requestedBy: req.user?._id
          });
        }
      }

      prescription.is_converted_to_ipd = true;
      prescription.ipd_medication_ids = convertedMedications;
      await prescription.save();
    }

    // Update IPDRound with this prescription
    if (source_type === 'IPD' && round_id) {
      await IPDRound.findByIdAndUpdate(round_id, { prescriptionId: prescription._id });
    }

    // Populate response
    const populatedPrescription = await Prescription.findById(prescription._id)
      .populate('patient_id', 'first_name last_name patientId phone')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('lab_test_requests.request_id', 'requestNumber status')
      .populate('radiology_test_requests.request_id', 'requestNumber status')
      .populate('procedure_requests.request_id', 'requestNumber status');

    res.status(201).json({
      success: true,
      message: 'Prescription created successfully',
      prescription: populatedPrescription,
      lab_requests: createdLabRequests,
      radiology_requests: createdRadiologyRequests,
      procedure_requests: createdProcedureRequests,
      ipd_medications_count: source_type === 'IPD' ? (convertedMedications?.length || 0) : 0,
      pharmacy_requests_created: processedItems.filter(m => m.requires_pharmacy_dispense).length
,
      medication_safety_alerts: medicationSafetyAlerts    });
  } catch (err) {
    console.error('Error creating prescription:', err);
    res.status(500).json({ error: err.message });
  }
};


// Generate a blank standard clinical prescription for a scheduled appointment.
// The PDF is not persisted as a prescription record; it is intended for walk-in/manual prescribing.
exports.downloadBlankPrescriptionPdfByAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.appointmentId)
      .populate(
        'patient_id',
        'salutation first_name middle_name last_name patientId uhid phone dob gender address city state zipCode registered_at patient_type occupation nationality father_name fatherName marital_status maritalStatus mother_name motherName'
      )
      .populate({
        path: 'doctor_id',
        select: 'firstName lastName specialization department',
        populate: { path: 'department', select: 'name' }
      })
      .populate('hospital_id')
      .lean();

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const appointmentHospitalId = appointment.hospital_id?._id || appointment.hospital_id;
    const userHospitalId = req.user?.hospital_id?._id || req.user?.hospital_id;
    const isSuperAdmin = req.user?.role === 'mediqliq_super_admin';

    if (
      !isSuperAdmin &&
      (!userHospitalId || String(appointmentHospitalId) !== String(userHospitalId))
    ) {
      return res.status(403).json({ error: 'Cross-hospital access denied' });
    }

    const patient = {
      ...(appointment.patient_id || {}),
      // Keep all clinical writing areas empty even when the patient master has history.
      medical_history: ''
    };
    const sourceType =
      String(patient.patient_type || '').toUpperCase() === 'IPD' ||
      String(appointment.token || '').toUpperCase().startsWith('IPD-')
        ? 'IPD'
        : 'OPD';
    const appointmentReference =
      appointment.token || String(appointment._id).slice(-8).toUpperCase();

    const blankPrescription = {
      prescription_number: `MANUAL-${appointmentReference}`,
      is_blank_manual_form: true,
      patient_id: patient,
      doctor_id: appointment.doctor_id || {},
      appointment_id: {
        _id: appointment._id,
        token: appointment.token || '',
        appointment_date: appointment.appointment_date
      },
      source_type: sourceType,
      issue_date:
        appointment.start_time ||
        appointment.appointment_date ||
        appointment.created_at ||
        operationNow(),
      consultation_fee: '',
      pain_score: null,
      allergy_snapshot: '',
      presenting_complaint: '',
      symptoms: '',
      history_of_presenting_complaint: '',
      physical_examination: '',
      investigation: '',
      diagnosis: '',
      provisional_diagnosis: '',
      treatment_plan: '',
      notes: '',
      outcome_expected: '',
      diet_advice: '',
      follow_up_date: null,
      lab_test_requests: [],
      radiology_test_requests: [],
      procedure_requests: [],
      items: []
    };

    return generatePrescriptionPdf({
      res,
      prescription: blankPrescription,
      hospital: appointment.hospital_id || null,
      vitals: null
    });
  } catch (error) {
    console.error('Error generating blank appointment prescription PDF:', error);
    if (!res.headersSent) {
      return res.status(error?.name === 'CastError' ? 400 : 500).json({
        error: error?.name === 'CastError' ? 'Invalid appointment ID' : error.message
      });
    }
    return undefined;
  }
};

// Generate the supplied OPD slip / prescription format through the shared
// clinical PDF renderer. Data loading stays in the controller; visual rendering
// stays in clinicalPdf.service.js so prescription documents share one PDF stack.
exports.downloadOpdSlipPdf = async (req, res) => {
  try {
    const hospitalId = requestHospitalId(req);
    const prescription = await Prescription.findOne({ _id: req.params.id, hospitalId })
      .populate('patient_id', 'hospitalId salutation first_name middle_name last_name patientId uhid phone dob gender address city state zipCode allergies medical_history')
      .populate({
        path: 'doctor_id',
        select: 'firstName lastName specialization department hospitalId',
        populate: { path: 'department', select: 'name' }
      })
      .populate('appointment_id', 'hospital_id token serial_number appointment_date created_at department_id')
      .populate('created_by', 'firstName lastName name email')
      .lean();

    if (!prescription) return res.status(404).json({ success: false, error: 'OPD prescription/slip not found for this hospital' });

    const date = prescription.appointment_id?.appointment_date || prescription.createdAt || prescription.issue_date;
    const receiptQuery = {
      hospitalId,
      patientId: prescription.patient_id?._id,
      sourceModule: 'OPD',
      transactionType: 'RECEIPT',
      status: 'POSTED'
    };
    if (date) {
      const d = new Date(date);
      const from = new Date(d); from.setHours(0, 0, 0, 0);
      const to = new Date(d); to.setHours(23, 59, 59, 999);
      receiptQuery.postedAt = { $gte: from, $lte: to };
    }

    const [hospital, vitals, receipt] = await Promise.all([
      Hospital.findById(hospitalId).lean(),
      Vital.findOne({
        $or: [
          { prescription_id: prescription._id },
          ...(prescription.appointment_id?._id ? [{ appointment_id: prescription.appointment_id._id }] : [])
        ]
      }).sort({ recorded_at: -1, createdAt: -1 }).lean(),
      prescription.patient_id?._id
        ? FinancialTransaction.findOne(receiptQuery).sort({ postedAt: -1 }).select('transactionNumber').lean()
        : null
    ]);

    return generateOpdSlipPdf({
      res,
      prescription,
      hospital,
      vitals,
      receipt,
      printedBy: req.user
    });
  } catch (err) {
    console.error('Error generating OPD slip PDF:', err);
    if (!res.headersSent) return res.status(err.statusCode || 500).json({ success: false, error: err.message });
    return undefined;
  }
};

exports.downloadPrescriptionPdf = async (req, res) => {
  try {
    const prescription = await Prescription.findOne({ _id: req.params.id, hospitalId: requestHospitalId(req) })
      .populate('patient_id', 'salutation first_name middle_name last_name patientId uhid phone dob gender address city state zipCode allergies medical_history registered_at patient_type')
      .populate({
        path: 'doctor_id',
        select: 'firstName lastName specialization department',
        populate: { path: 'department', select: 'name' }
      })
      .populate('appointment_id', 'token appointment_date');

    if (!prescription) return res.status(404).json({ error: 'Prescription not found' });

    const [vitals, hospital] = await Promise.all([
      Vital.findOne({
        $or: [
          { prescription_id: prescription._id },
          ...(prescription.appointment_id ? [{ appointment_id: prescription.appointment_id }] : [])
        ]
      }).sort({ recorded_at: -1 }).lean(),
      req.user?.hospital_id ? Hospital.findById(req.user.hospital_id).lean() : null
    ]);

    return generatePrescriptionPdf({ res, prescription, hospital, vitals });
  } catch (error) {
    console.error('Error generating prescription PDF:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
};

// Get the prescription linked to a specific appointment.
exports.getPrescriptionByAppointmentId = async (req, res) => {
  try {
    const prescription = await Prescription.findOne({ appointment_id: req.params.appointmentId, hospitalId: requestHospitalId(req) })
      .populate('patient_id', 'first_name last_name patientId phone dob gender allergies')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('lab_test_requests.request_id', 'requestNumber status priority scheduledDate clinical_history patient_notes is_billed')
      .populate('radiology_test_requests.request_id', 'requestNumber status priority scheduledDate clinical_history patient_notes is_billed')
      .populate('procedure_requests.request_id', 'requestNumber status priority scheduledDate clinical_history clinical_indication pre_procedure_instructions is_billed')
      .sort({ issue_date: -1 });

    if (!prescription) {
      return res.status(404).json({ error: 'No prescription found for this appointment' });
    }

    const vitals = await Vital.findOne({
      $or: [
        { prescription_id: prescription._id },
        { appointment_id: req.params.appointmentId }
      ]
    }).sort({ recorded_at: -1 });

    return res.json({
      success: true,
      prescription,
      vitals: vitals || null
    });
  } catch (err) {
    console.error('Error fetching prescription by appointment:', err);
    return res.status(err?.name === 'CastError' ? 400 : 500).json({ error: err.message });
  }
};

// Get prescription by ID (with populated requests and admission details)
exports.getPrescriptionById = async (req, res) => {
  try {
    const prescription = await Prescription.findOne({ _id: req.params.id, hospitalId: requestHospitalId(req) })
      .populate('patient_id', 'first_name last_name patientId phone dob gender')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('ipd_medication_ids', 'medicineName dosage frequency status')
      .populate('lab_test_requests.request_id', 'requestNumber status priority scheduledDate clinical_history patient_notes is_billed')
      .populate('radiology_test_requests.request_id', 'requestNumber status priority scheduledDate clinical_history patient_notes is_billed')
      .populate('procedure_requests.request_id', 'requestNumber status priority scheduledDate clinical_history clinical_indication pre_procedure_instructions is_billed');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    // ========== FIX: Populate IPD admission details ==========
    let admissionDetails = null;
    if (prescription.ipd_admission_id) {
      const IPDAdmission = require('../models/IPDAdmission');
      admissionDetails = await IPDAdmission.findById(prescription.ipd_admission_id)
        .populate('wardId', 'name code')
        .populate('bedId', 'bedNumber name')
        .populate('roomId', 'room_number')
        .populate('primaryDoctorId', 'firstName lastName specialization')
        .lean();

      if (admissionDetails) {
        // Extract ward and bed details
        admissionDetails.ward_name = admissionDetails.wardId?.name || 'N/A';
        admissionDetails.bed_number = admissionDetails.bedId?.bedNumber || 'N/A';
        admissionDetails.room_number = admissionDetails.roomId?.room_number || 'N/A';
      }
    }

    const vitals = await Vital.findOne({ prescription_id: prescription._id });

    // Convert to object and add admission details
    const prescriptionObj = prescription.toObject();
    prescriptionObj.admission_details = admissionDetails;

    res.json({
      success: true,
      prescription: prescriptionObj,
      vitals: vitals || null
    });
  } catch (err) {
    console.error('Error fetching prescription:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get all prescriptions (with admission details)
exports.getAllPrescriptions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      patient_id,
      doctor_id,
      appointment_id,
      source_type,
      ipd_admission_id,
      status,
      startDate,
      endDate
    } = req.query;

    const filter = { hospitalId: requestHospitalId(req) };
    if (patient_id) filter.patient_id = patient_id;
    if (doctor_id) filter.doctor_id = doctor_id;
    if (appointment_id) filter.appointment_id = appointment_id;
    if (source_type) filter.source_type = source_type;
    if (ipd_admission_id) filter.ipd_admission_id = ipd_admission_id;
    if (status) filter.status = status;

    if (startDate && endDate) {
      filter.issue_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId phone')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('lab_test_requests.request_id', 'requestNumber status')
      .populate('radiology_test_requests.request_id', 'requestNumber status')
      .populate('procedure_requests.request_id', 'requestNumber status')
      .sort({ issue_date: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const prescriptionsWithAdmission = await attachAdmissionDetailsToPrescriptions(
      prescriptions,
      requestHospitalId(req),
      { includeWardCode: true }
    );

    const total = await Prescription.countDocuments(filter);

    res.json({
      success: true,
      prescriptions: prescriptionsWithAdmission,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching prescriptions:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get prescriptions by patient (with admission details)
exports.getPrescriptionsByPatientId = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { status, doctor_id, appointment_id, page = 1, limit = 10 } = req.query;

    const hospitalId = requestHospitalId(req);
    const patientExists = await Patient.exists({ _id: patientId, hospitalId });
    if (!patientExists) return res.status(404).json({ error: 'Patient not found' });
    const filter = { hospitalId, patient_id: patientId };
    if (status) filter.status = status;
    if (doctor_id) filter.doctor_id = doctor_id;
    if (appointment_id) filter.appointment_id = appointment_id;

    const prescriptions = await Prescription.find(filter)
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('lab_test_requests.request_id', 'requestNumber status')
      .populate('radiology_test_requests.request_id', 'requestNumber status')
      .populate('procedure_requests.request_id', 'requestNumber status')
      .sort({ issue_date: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const prescriptionsWithAdmission = await attachAdmissionDetailsToPrescriptions(prescriptions, hospitalId);

    const total = await Prescription.countDocuments(filter);

    res.json({
      success: true,
      prescriptions: prescriptionsWithAdmission,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching prescriptions by patient:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get IPD prescriptions for admission (with full admission details)
exports.getIPDPrescriptions = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const hospitalId = requestHospitalId(req);
    const admissionExists = await IPDAdmission.exists({ _id: admissionId, hospitalId });
    if (!admissionExists) return res.status(404).json({ error: 'IPD admission not found' });

    const prescriptions = await Prescription.find({
      hospitalId,
      ipd_admission_id: admissionId,
      source_type: 'IPD'
    })
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('ipd_medication_ids', 'medicineName dosage frequency status')
      .populate('lab_test_requests.request_id', 'requestNumber status')
      .populate('radiology_test_requests.request_id', 'requestNumber status')
      .populate('procedure_requests.request_id', 'requestNumber status')
      .sort({ issue_date: -1 });

    // ========== FIX: Get admission details ==========
    const IPDAdmission = require('../models/IPDAdmission');
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId })
      .populate('wardId', 'name code')
      .populate('bedId', 'bedNumber name')
      .populate('roomId', 'room_number')
      .lean();

    const prescriptionsWithAdmission = prescriptions.map((prescription) => {
      const prescriptionObj = prescription.toObject();

      if (admission) {
        prescriptionObj.admission_details = {
          _id: admission._id,
          admissionNumber: admission.admissionNumber,
          shipNumber: admission.shipNumber,
          ward_name: admission.wardId?.name || 'N/A',
          ward_code: admission.wardId?.code || '',
          bed_number: admission.bedId?.bedNumber || 'N/A',
          room_number: admission.roomId?.room_number || 'N/A',
          status: admission.status,
          admission_date: admission.admissionDate
        };

        // For backward compatibility
        prescriptionObj.ward = admission.wardId?.name || 'N/A';
        prescriptionObj.bed_number = admission.bedId?.bedNumber || 'N/A';
        prescriptionObj.admission_number = admission.admissionNumber;
      }

      return prescriptionObj;
    });

    res.json({
      success: true,
      count: prescriptionsWithAdmission.length,
      admission_details: admission ? {
        _id: admission._id,
        admissionNumber: admission.admissionNumber,
        ward_name: admission.wardId?.name || 'N/A',
        bed_number: admission.bedId?.bedNumber || 'N/A',
        status: admission.status
      } : null,
      prescriptions: prescriptionsWithAdmission
    });
  } catch (err) {
    console.error('Error fetching IPD prescriptions:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get active prescriptions (with admission details)
exports.getActivePrescriptions = async (req, res) => {
  try {
    const { page = 1, limit = 10, patient_id } = req.query;

    const filter = {
      hospitalId: requestHospitalId(req),
      status: 'Active',
      issue_date: { $gte: new Date(operationNow().getTime() - 30 * 24 * 60 * 60 * 1000), $lte: operationNow() }
    };
    if (patient_id) filter.patient_id = patient_id;

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .sort({ issue_date: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const prescriptionsWithAdmission = await attachAdmissionDetailsToPrescriptions(
      prescriptions,
      requestHospitalId(req)
    );

    const total = await Prescription.countDocuments(filter);

    res.json({
      success: true,
      prescriptions: prescriptionsWithAdmission,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching active prescriptions:', err);
    res.status(500).json({ error: err.message });
  }
};

const PRESCRIPTION_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function normaliseRequestId(value) {
  if (!value) return null;
  return value._id || value.id || value;
}

function embeddedRequestObject(value) {
  return typeof value?.toObject === 'function' ? value.toObject() : { ...value };
}

function editableWorkflowRequest(request) {
  return request && request.status === 'Pending' && !request.is_billed;
}

async function reconcilePrescriptionRequests({
  prescription,
  incoming,
  embeddedField,
  RequestModel,
  createRequests,
  updateExisting,
  toEmbedded,
  userId,
  hospitalId
}) {
  const existingEmbedded = Array.isArray(prescription[embeddedField])
    ? prescription[embeddedField].map(embeddedRequestObject)
    : [];
  const existingIds = existingEmbedded.map((item) => normaliseRequestId(item.request_id)).filter(Boolean);
  const requestDocuments = existingIds.length
    ? await RequestModel.find({ _id: { $in: existingIds }, prescriptionId: prescription._id })
    : [];
  const documentsById = new Map(requestDocuments.map((item) => [String(item._id), item]));
  const lockedIds = new Set(
    requestDocuments.filter((item) => !editableWorkflowRequest(item)).map((item) => String(item._id))
  );

  const lockedEmbedded = existingEmbedded.filter((item) => {
    const requestId = normaliseRequestId(item.request_id);
    return requestId && lockedIds.has(String(requestId));
  });
  const retainedEditableIds = new Set();
  const updatedEmbedded = [];
  const newIncoming = [];

  for (const item of Array.isArray(incoming) ? incoming : []) {
    const requestId = normaliseRequestId(item.request_id);
    if (!requestId) {
      newIncoming.push(item);
      continue;
    }

    const requestDocument = documentsById.get(String(requestId));
    if (!requestDocument) {
      newIncoming.push({ ...item, request_id: null });
      continue;
    }
    if (!editableWorkflowRequest(requestDocument)) continue;

    const embedded = await updateExisting(requestDocument, item);
    retainedEditableIds.add(String(requestDocument._id));
    updatedEmbedded.push(embedded);
  }

  const removedIds = requestDocuments
    .filter((item) => editableWorkflowRequest(item) && !retainedEditableIds.has(String(item._id)))
    .map((item) => item._id);

  const created = await createRequests(
    prescription,
    newIncoming,
    userId,
    prescription.source_type || 'OPD',
    prescription.ipd_admission_id || null,
    hospitalId
  );

  if (removedIds.length) {
    const now = operationNow();
    await RequestModel.updateMany(
      { _id: { $in: removedIds }, prescriptionId: prescription._id, is_active: { $ne: false } },
      {
        $set: {
          status: 'Cancelled',
          is_active: false,
          cancelled_at: now,
          cancelled_by: userId || null,
          deleted_at: now,
          deleted_by: userId || null,
          deletion_reason: 'Removed from prescription before billing/processing'
        }
      }
    );
  }

  // Locked requests may already be processing, billed, or completed. They remain
  // attached exactly as stored; pending unbilled requests are updated in place.
  return [
    ...lockedEmbedded,
    ...updatedEmbedded,
    ...created.map(toEmbedded)
  ];
}

function normaliseUpdatedMedicationItems(existingPrescription, incomingItems) {
  const existingById = new Map(
    (existingPrescription.items || []).map((item) => [String(item._id), item])
  );
  const incoming = Array.isArray(incomingItems) ? incomingItems : [];
  const incomingIds = new Set(incoming.map((item) => normaliseRequestId(item._id)).filter(Boolean).map(String));

  for (const existing of existingPrescription.items || []) {
    const locked = existing.is_dispensed || Number(existing.dispensed_quantity) > 0;
    if (locked && !incomingIds.has(String(existing._id))) {
      const error = new Error(`Dispensed medicine "${existing.medicine_name}" cannot be removed.`);
      error.statusCode = 409;
      throw error;
    }
  }

  return incoming.map((item) => {
    const existing = normaliseRequestId(item._id)
      ? existingById.get(String(normaliseRequestId(item._id)))
      : null;
    const locked = existing && (existing.is_dispensed || Number(existing.dispensed_quantity) > 0);

    const doseQtyBaseUnits = resolveDoseQtyBaseUnits(item);
    const requiredQtyBaseUnits = calculateMedicationRequiredBaseUnits({
      ...item,
      duration: parseInt(item.duration, 10) || 1,
      durationUnit: 'Days'
    });
    const normalised = {
      medicine_name: String(item.medicine_name || '').trim(),
      generic_name: String(item.generic_name || item.medicine_name || '').trim(),
      nlem_code: String(item.nlem_code || item.nlemCode || '').trim(),
      dosage_form: item.dosage_form || item.dosageForm || item.medicine_type || '',
      medicine_id: item.medicine_id || null,
      medicine_type: item.medicine_type || 'Tablet',
      route_of_administration: item.route_of_administration || 'Oral',
      dosage: String(item.dosage || '').trim(),
      frequency: item.frequency,
      duration: item.duration,
      quantity: Number(item.quantity) || requiredQtyBaseUnits || 1,
      dose_qty_base_units: doseQtyBaseUnits,
      required_qty_base_units: requiredQtyBaseUnits,
      requires_pharmacy_dispense: normaliseBoolean(item.requires_pharmacy_dispense, true),
      instructions: String(item.instructions || '').trim(),
      timing: item.timing || 'Anytime'
    };

    if (!normalised.medicine_name || !normalised.dosage || !normalised.frequency || !normalised.duration) {
      const error = new Error('Every medicine requires a name, dosage, frequency, and duration.');
      error.statusCode = 400;
      throw error;
    }

    if (locked) {
      const comparableFields = [
        'medicine_name', 'generic_name', 'nlem_code', 'dosage_form', 'medicine_type',
        'route_of_administration', 'dosage', 'frequency', 'duration', 'quantity',
        'dose_qty_base_units', 'requires_pharmacy_dispense', 'instructions', 'timing'
      ];
      const changed = comparableFields.some((field) => String(existing[field] ?? '') !== String(normalised[field] ?? ''));
      if (changed) {
        const error = new Error(`Dispensed medicine "${existing.medicine_name}" cannot be changed.`);
        error.statusCode = 409;
        throw error;
      }
      return existing.toObject();
    }

    return normalised;
  });
}

// Update prescription
exports.updatePrescription = async (req, res) => {
  try {
    const prescription = await Prescription.findOne({ _id: req.params.id, hospitalId: requestHospitalId(req) });
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' });
    const { hospitalId: prescriptionHospitalId } = await prescriptionTenant(req, prescription, { notFound: true });

    const createdAt = prescription.createdAt || prescription.issue_date;
    if (!createdAt || Date.now() - new Date(createdAt).getTime() > PRESCRIPTION_EDIT_WINDOW_MS) {
      return res.status(403).json({ error: 'Prescription editing is allowed only within 24 hours of creation.' });
    }

    if (req.user?.role === 'doctor') {
      const doctor = await Doctor.findOne({
        $or: [{ user_id: req.user._id }, { email: req.user.email }]
      }).select('_id').lean();
      if (!doctor || String(doctor._id) !== String(prescription.doctor_id)) {
        return res.status(403).json({ error: 'You can edit only prescriptions created for your own appointments.' });
      }
    }

    const updates = req.body || {};
    const diagnosis = String(updates.diagnosis ?? prescription.diagnosis ?? '').trim();
    if (!diagnosis) return res.status(400).json({ error: 'Diagnosis is required.' });

    let painScore = updates.pain_score;
    if (painScore === '' || painScore === null || painScore === undefined) painScore = undefined;
    else {
      painScore = Number(painScore);
      if (!Number.isFinite(painScore) || painScore < 0 || painScore > 10) {
        return res.status(400).json({ error: 'Pain score must be between 0 and 10.' });
      }
    }

    if (Array.isArray(updates.items)) {
      if (prescription.is_converted_to_ipd) {
        return res.status(409).json({
          error: 'Medication items cannot be edited after this prescription has been converted to an IPD medication chart.'
        });
      }
      prescription.items = normaliseUpdatedMedicationItems(prescription, updates.items);
    }

    const clinicalFields = [
      'presenting_complaint', 'history_of_presenting_complaint', 'diagnosis_icd11_code',
      'allergy_snapshot', 'symptoms', 'investigation', 'provisional_diagnosis',
      'treatment_plan', 'physical_examination', 'outcome_expected', 'diet_advice',
      'notes', 'prescription_image', 'status'
    ];
    for (const field of clinicalFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) prescription[field] = updates[field];
    }
    prescription.diagnosis = diagnosis;
    prescription.pain_score = painScore;

    if (Object.prototype.hasOwnProperty.call(updates, 'follow_up_date')) {
      prescription.follow_up_date = updates.follow_up_date ? new Date(updates.follow_up_date) : null;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'validity_days')) {
      prescription.validity_days = Math.max(1, Number(updates.validity_days) || 30);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'is_repeatable')) {
      prescription.is_repeatable = normaliseBoolean(updates.is_repeatable, false);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'repeat_count')) {
      prescription.repeat_count = prescription.is_repeatable
        ? Math.max(0, Number(updates.repeat_count) || 0)
        : 0;
    }

    if (Array.isArray(updates.lab_test_requests)) {
      prescription.lab_test_requests = await reconcilePrescriptionRequests({
        prescription,
        incoming: updates.lab_test_requests,
        embeddedField: 'lab_test_requests',
        RequestModel: LabRequest,
        createRequests: createLabRequests,
        userId: req.user?._id,
        hospitalId: prescriptionHospitalId,
        updateExisting: async (requestDocument, item) => {
          const labTestId = item.lab_test_id || requestDocument.labTestId;
          const labTest = labTestId
            ? await LabTest.findOne({ _id: labTestId, hospitalId: prescriptionHospitalId })
            : await LabTest.findOne({ hospitalId: prescriptionHospitalId, code: item.lab_test_code });
          if (!labTest) {
            const error = new Error(`Lab test not found: ${item.lab_test_code || item.lab_test_name}`);
            error.statusCode = 400;
            throw error;
          }
          Object.assign(requestDocument, {
            labTestId: labTest._id,
            testCode: labTest.code,
            testName: labTest.name,
            category: labTest.category,
            clinical_history: item.clinical_history || '',
            priority: item.priority || 'Routine',
            scheduledDate: item.scheduled_date || null,
            patient_notes: item.notes || '',
            cost: labTest.base_price || 0
          });
          await requestDocument.save();
          return {
            request_id: requestDocument._id,
            lab_test_id: labTest._id,
            lab_test_code: labTest.code,
            lab_test_name: labTest.name,
            category: labTest.category,
            clinical_history: item.clinical_history || '',
            priority: item.priority || 'Routine',
            scheduled_date: item.scheduled_date || null,
            notes: item.notes || '',
            cost: labTest.base_price || 0,
            created_at: operationNow()
          };
        },
        toEmbedded: (item) => ({ ...item, created_at: operationNow() })
      });
    }
    if (Array.isArray(updates.radiology_test_requests)) {
      prescription.radiology_test_requests = await reconcilePrescriptionRequests({
        prescription,
        incoming: updates.radiology_test_requests,
        embeddedField: 'radiology_test_requests',
        RequestModel: RadiologyRequest,
        createRequests: createRadiologyRequests,
        userId: req.user?._id,
        hospitalId: prescriptionHospitalId,
        updateExisting: async (requestDocument, item) => {
          const imagingTestId = item.imaging_test_id || requestDocument.imagingTestId;
          const imagingTest = imagingTestId
            ? await ImagingTest.findOne({ _id: imagingTestId, hospitalId: prescriptionHospitalId })
            : await ImagingTest.findOne({ hospitalId: prescriptionHospitalId, code: item.imaging_test_code });
          if (!imagingTest) {
            const error = new Error(`Imaging test not found: ${item.imaging_test_code || item.imaging_test_name}`);
            error.statusCode = 400;
            throw error;
          }
          Object.assign(requestDocument, {
            imagingTestId: imagingTest._id,
            testCode: imagingTest.code,
            testName: imagingTest.name,
            category: imagingTest.category,
            clinical_history: item.clinical_history || '',
            priority: item.priority || 'Routine',
            scheduledDate: item.scheduled_date || null,
            patient_notes: item.notes || '',
            cost: imagingTest.base_price || 0
          });
          await requestDocument.save();
          return {
            request_id: requestDocument._id,
            imaging_test_id: imagingTest._id,
            imaging_test_code: imagingTest.code,
            imaging_test_name: imagingTest.name,
            category: imagingTest.category,
            clinical_history: item.clinical_history || '',
            priority: item.priority || 'Routine',
            scheduled_date: item.scheduled_date || null,
            notes: item.notes || '',
            cost: imagingTest.base_price || 0,
            created_at: operationNow()
          };
        },
        toEmbedded: (item) => ({ ...item, created_at: operationNow() })
      });
    }
    if (Array.isArray(updates.procedure_requests)) {
      prescription.procedure_requests = await reconcilePrescriptionRequests({
        prescription,
        incoming: updates.procedure_requests,
        embeddedField: 'procedure_requests',
        RequestModel: ProcedureRequest,
        createRequests: createProcedureRequests,
        userId: req.user?._id,
        hospitalId: prescriptionHospitalId,
        updateExisting: async (requestDocument, item) => {
          const procedureId = item.procedure_id || requestDocument.procedureId;
          const procedure = procedureId
            ? await Procedure.findOne({ _id: procedureId, hospitalId: prescriptionHospitalId })
            : await Procedure.findOne({ hospitalId: prescriptionHospitalId, code: item.procedure_code });
          if (!procedure) {
            const error = new Error(`Procedure not found: ${item.procedure_code || item.procedure_name}`);
            error.statusCode = 400;
            throw error;
          }
          Object.assign(requestDocument, {
            procedureId: procedure._id,
            procedureCode: procedure.code,
            procedureName: procedure.name,
            category: procedure.category,
            subcategory: procedure.subcategory,
            clinical_history: item.clinical_history || '',
            clinical_indication: item.clinical_indication || '',
            priority: item.priority || 'Routine',
            scheduledDate: item.scheduled_date || null,
            pre_procedure_instructions: item.notes || '',
            cost: procedure.base_price || 0
          });
          await requestDocument.save();
          return {
            request_id: requestDocument._id,
            procedure_id: procedure._id,
            procedure_code: procedure.code,
            procedure_name: procedure.name,
            category: procedure.category,
            clinical_history: item.clinical_history || '',
            clinical_indication: item.clinical_indication || '',
            priority: item.priority || 'Routine',
            scheduled_date: item.scheduled_date || null,
            notes: item.notes || '',
            cost: procedure.base_price || 0,
            created_at: operationNow()
          };
        },
        toEmbedded: (item) => ({ ...item, created_at: operationNow() })
      });
    }

    await prescription.save();

    const populatedPrescription = await Prescription.findById(prescription._id)
      .populate('patient_id', 'first_name last_name patientId phone allergies')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('lab_test_requests.request_id', 'requestNumber status priority scheduledDate clinical_history patient_notes is_billed')
      .populate('radiology_test_requests.request_id', 'requestNumber status priority scheduledDate clinical_history patient_notes is_billed')
      .populate('procedure_requests.request_id', 'requestNumber status priority scheduledDate clinical_history clinical_indication pre_procedure_instructions is_billed');

    return res.json({
      success: true,
      message: 'Prescription and linked clinical orders updated successfully',
      prescription: populatedPrescription
    });
  } catch (err) {
    console.error('Error updating prescription:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Delete prescription
exports.deletePrescription = async (req, res) => {
  try {
    const { id } = req.params;
    const prescription = await Prescription.findOne({ _id: id, hospitalId: requestHospitalId(req), is_active: { $ne: false } });
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' });
    await prescriptionTenant(req, prescription, { notFound: true });
    prescription.is_active = false;
    if (prescription.status !== 'Completed') prescription.status = 'Cancelled';
    prescription.deleted_at = new Date();
    prescription.deleted_by = req.user?._id || null;
    prescription.deletion_reason = String(req.body?.reason || 'Prescription archived by user').trim();
    await prescription.save();

    res.json({ success: true, message: 'Prescription archived successfully' });
  } catch (err) {
    console.error('Error deleting prescription:', err);
    res.status(500).json({ error: err.message });
  }
};

// Dispense medication
exports.dispenseMedication = async (req, res) => {
  try {
    const { prescriptionId, itemIndex } = req.params;
    const { dispensed_quantity, batch_id } = req.body;

    const prescription = await Prescription.findOne({ _id: prescriptionId, hospitalId: requestHospitalId(req) });
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }
    await prescriptionTenant(req, prescription, { notFound: true });

    if (itemIndex >= prescription.items.length) {
      return res.status(400).json({ error: 'Invalid item index' });
    }

    const item = prescription.items[itemIndex];
    const quantityToDispense = dispensed_quantity || item.quantity;

    if (quantityToDispense > item.quantity) {
      return res.status(400).json({ error: 'Dispensed quantity cannot exceed prescribed quantity' });
    }

    if (batch_id) {
      const MedicineBatch = require('../models/MedicineBatch');
      const batch = await MedicineBatch.findById(batch_id);
      if (batch && batch.quantity >= quantityToDispense) {
        batch.quantity -= quantityToDispense;
        await batch.save();
      }
    }

    prescription.items[itemIndex].is_dispensed = true;
    prescription.items[itemIndex].dispensed_quantity = quantityToDispense;
    prescription.items[itemIndex].dispensed_date = operationNow();

    const allDispensed = prescription.items.every(it => it.is_dispensed);
    if (allDispensed) prescription.status = 'Completed';

    await prescription.save();

    res.json({
      success: true,
      message: 'Medication dispensed successfully',
      prescription
    });
  } catch (err) {
    console.error('Error dispensing medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get prescriptions by doctor
exports.getPrescriptionsByDoctorId = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { status, page = 1, limit = 10 } = req.query;

    const hospitalId = requestHospitalId(req);
    const doctorExists = await Doctor.exists({ _id: doctorId, hospitalId });
    if (!doctorExists) return res.status(404).json({ error: 'Doctor not found' });
    const filter = { hospitalId, doctor_id: doctorId };
    if (status) filter.status = status;

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .sort({ issue_date: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Prescription.countDocuments(filter);

    res.json({
      success: true,
      prescriptions,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching prescriptions by doctor:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============== IPD PRESCRIPTION CONVERSION ==============

// Convert OPD prescription to IPD
exports.convertToIPD = async (req, res) => {
  try {
    const { prescriptionId, admissionId } = req.params;

    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (prescription.is_converted_to_ipd) {
      return res.status(400).json({ error: 'Prescription already converted to IPD' });
    }

    // Update lab requests to link to IPD admission
    for (const labReq of prescription.lab_test_requests) {
      if (labReq.request_id) {
        await LabRequest.findByIdAndUpdate(labReq.request_id, {
          sourceType: 'IPD',
          admissionId: admissionId
        });
      }
    }

    // Update radiology requests to link to IPD admission
    for (const radReq of prescription.radiology_test_requests) {
      if (radReq.request_id) {
        await RadiologyRequest.findByIdAndUpdate(radReq.request_id, {
          sourceType: 'IPD',
          admissionId: admissionId
        });
      }
    }

    // Update procedure requests to link to IPD admission
    for (const procReq of prescription.procedure_requests) {
      if (procReq.request_id) {
        await ProcedureRequest.findByIdAndUpdate(procReq.request_id, {
          sourceType: 'IPD',
          admissionId: admissionId
        });
      }
    }

    // Convert medications to IPD Medication Chart
    const convertedMedications = [];
    for (const item of prescription.items) {
      const medicationOrder = new IPDMedicationChart({
        admissionId: admissionId,
        patientId: admission.patientId,
        prescribedBy: prescription.doctor_id,
        medicineId: item.medicine_id || null,
        medicineName: item.medicine_name,
        genericName: item.generic_name,
        route: item.route_of_administration,
        dosage: item.dosage,
        frequency: item.frequency,
        duration: item.duration,
        specialInstructions: item.instructions,
        requiresPharmacyDispense: true,
        status: 'Pending',
        createdBy: req.user?._id
      });

      await medicationOrder.save();
      convertedMedications.push(medicationOrder._id);
    }

    prescription.is_converted_to_ipd = true;
    prescription.ipd_medication_ids = convertedMedications;
    prescription.ipd_admission_id = admissionId;
    await prescription.save();

    res.json({
      success: true,
      message: `Prescription converted to IPD with ${convertedMedications.length} medications`,
      data: {
        prescription,
        medication_ids: convertedMedications
      }
    });
  } catch (err) {
    console.error('Error converting prescription to IPD:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get OPD prescriptions for IPD conversion
exports.getOPDPrescriptionsForIPD = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { active = 'true' } = req.query;

    const filter = {
      patient_id: patientId,
      source_type: 'OPD',
      is_converted_to_ipd: false
    };

    if (active === 'true') {
      filter.status = 'Active';
    }

    const prescriptions = await Prescription.find(filter)
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('lab_test_requests.request_id', 'requestNumber status')
      .populate('radiology_test_requests.request_id', 'requestNumber status')
      .populate('procedure_requests.request_id', 'requestNumber status')
      .sort({ issue_date: -1 });

    res.json({
      success: true,
      count: prescriptions.length,
      prescriptions
    });
  } catch (err) {
    console.error('Error fetching OPD prescriptions:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============== IMAGE UPLOAD ==============

exports.uploadPrescriptionImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    const result = await fileStorage.upload(req.file, req, {
      folder: 'prescriptions',
      resource_type: 'image'
    });
    fs.unlinkSync(req.file.path);

    res.json({ imageUrl: result.secure_url });
  } catch (err) {
    console.error('Error uploading image:', err);
    res.status(500).json({ error: err.message });
  }
};