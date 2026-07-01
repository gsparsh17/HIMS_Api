// controllers/prescription.controller.js
const Prescription = require('../models/Prescription');
const Vital = require('../models/Vital');
const Medicine = require('../models/Medicine');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const LabRequest = require('../models/LabRequest');
const LabTest = require('../models/LabTest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ImagingTest = require('../models/ImagingTest');
const ProcedureRequest = require('../models/ProcedureRequest');
const Pharmacy = require('../models/Pharmacy');
const Procedure = require('../models/Procedure');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============== HELPER FUNCTIONS ==============

// Create Lab Requests from prescription
async function createLabRequests(prescription, labTestRequests, userId, sourceType, admissionId = null) {
  const createdRequests = [];

  for (const labReq of labTestRequests) {
    let labTest = null;
    if (labReq.lab_test_id) labTest = await LabTest.findById(labReq.lab_test_id);
    else if (labReq.lab_test_code) labTest = await LabTest.findOne({ code: labReq.lab_test_code });

    if (!labTest) continue;

    const labRequest = new LabRequest({
      requestNumber: `LAB-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      sourceType: sourceType || 'OPD',
      admissionId: admissionId || null,
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
      lab_test_name: labTest.name
    });
  }

  return createdRequests;
}

// Create Radiology Requests from prescription
async function createRadiologyRequests(prescription, radiologyRequests, userId, sourceType, admissionId = null) {
  const createdRequests = [];

  for (const radReq of radiologyRequests) {
    let imagingTest = null;
    if (radReq.imaging_test_id) imagingTest = await ImagingTest.findById(radReq.imaging_test_id);
    else if (radReq.imaging_test_code) imagingTest = await ImagingTest.findOne({ code: radReq.imaging_test_code });

    if (!imagingTest) continue;

    const radiologyRequest = new RadiologyRequest({
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
      imaging_test_name: imagingTest.name
    });
  }

  return createdRequests;
}

// Create Procedure Requests from prescription
async function createProcedureRequests(prescription, procedureRequests, userId, sourceType, admissionId = null) {
  const createdRequests = [];

  for (const procReq of procedureRequests) {
    let procedure = null;
    if (procReq.procedure_id) procedure = await Procedure.findById(procReq.procedure_id);
    else if (procReq.procedure_code) procedure = await Procedure.findOne({ code: procReq.procedure_code });

    if (!procedure) continue;

    const procedureRequest = new ProcedureRequest({
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
      cost: procedure.base_price
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
  const today = new Date();
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
      requestedAt: new Date(),
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
      symptoms,
      investigation,
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
          requires_pharmacy_dispense: normaliseBoolean(item.requires_pharmacy_dispense, true)
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

    // Create prescription first
    const prescription = new Prescription({
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
      symptoms: symptoms || '',
      investigation: investigation || '',
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
      source_type || 'OPD', ipd_admission_id || null
    );

    // Create Radiology Requests
    const createdRadiologyRequests = await createRadiologyRequests(
      prescription, radiology_test_requests, req.user?._id,
      source_type || 'OPD', ipd_admission_id || null
    );

    // Create Procedure Requests
    const createdProcedureRequests = await createProcedureRequests(
      prescription, procedure_requests, req.user?._id,
      source_type || 'OPD', ipd_admission_id || null
    );

    // Update prescription with request IDs
    if (createdLabRequests.length > 0) {
      prescription.lab_test_requests = createdLabRequests.map(req => ({
        lab_test_id: req.lab_test_id,
        lab_test_code: req.lab_test_code,
        lab_test_name: req.lab_test_name,
        request_id: req.request_id,
        created_at: new Date()
      }));
    }

    if (createdRadiologyRequests.length > 0) {
      prescription.radiology_test_requests = createdRadiologyRequests.map(req => ({
        imaging_test_id: req.imaging_test_id,
        imaging_test_code: req.imaging_test_code,
        imaging_test_name: req.imaging_test_name,
        request_id: req.request_id,
        created_at: new Date()
      }));
    }

    if (createdProcedureRequests.length > 0) {
      prescription.procedure_requests = createdProcedureRequests.map(req => ({
        procedure_id: req.procedure_id,
        procedure_code: req.procedure_code,
        procedure_name: req.procedure_name,
        request_id: req.request_id,
        cost: req.cost,
        created_at: new Date()
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
          startDate: new Date(),
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
      const IPDRound = require('../models/IPDRound');
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
    });
  } catch (err) {
    console.error('Error creating prescription:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get prescription by ID (with populated requests and admission details)
exports.getPrescriptionById = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patient_id', 'first_name last_name patientId phone dob gender')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('ipd_medication_ids', 'medicineName dosage frequency status')
      .populate('lab_test_requests.request_id', 'requestNumber status priority scheduledDate')
      .populate('radiology_test_requests.request_id', 'requestNumber status priority scheduledDate')
      .populate('procedure_requests.request_id', 'requestNumber status priority scheduledDate');

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
      source_type,
      ipd_admission_id,
      status,
      startDate,
      endDate
    } = req.query;

    const filter = {};
    if (patient_id) filter.patient_id = patient_id;
    if (doctor_id) filter.doctor_id = doctor_id;
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

    // ========== FIX: Get admission details for IPD prescriptions ==========
    const IPDAdmission = require('../models/IPDAdmission');
    const prescriptionsWithAdmission = await Promise.all(
      prescriptions.map(async (prescription) => {
        const prescriptionObj = prescription.toObject();

        if (prescription.ipd_admission_id) {
          const admission = await IPDAdmission.findById(prescription.ipd_admission_id)
            .populate('wardId', 'name code')
            .populate('bedId', 'bedNumber name')
            .lean();

          if (admission) {
            prescriptionObj.admission_details = {
              _id: admission._id,
              admissionNumber: admission.admissionNumber,
              shipNumber: admission.shipNumber,
              ward_name: admission.wardId?.name || 'N/A',
              ward_code: admission.wardId?.code || '',
              bed_number: admission.bedId?.bedNumber || 'N/A',
              status: admission.status,
              admission_date: admission.admissionDate
            };

            // For backward compatibility - add ward and bed directly to prescription object
            prescriptionObj.ward = admission.wardId?.name || 'N/A';
            prescriptionObj.bed_number = admission.bedId?.bedNumber || 'N/A';
            prescriptionObj.admission_number = admission.admissionNumber;
          }
        }

        return prescriptionObj;
      })
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
    const { status, page = 1, limit = 10 } = req.query;

    const filter = { patient_id: patientId };
    if (status) filter.status = status;

    const prescriptions = await Prescription.find(filter)
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('lab_test_requests.request_id', 'requestNumber status')
      .populate('radiology_test_requests.request_id', 'requestNumber status')
      .populate('procedure_requests.request_id', 'requestNumber status')
      .sort({ issue_date: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // ========== FIX: Get admission details for IPD prescriptions ==========
    const IPDAdmission = require('../models/IPDAdmission');
    const prescriptionsWithAdmission = await Promise.all(
      prescriptions.map(async (prescription) => {
        const prescriptionObj = prescription.toObject();

        if (prescription.ipd_admission_id) {
          const admission = await IPDAdmission.findById(prescription.ipd_admission_id)
            .populate('wardId', 'name code')
            .populate('bedId', 'bedNumber name')
            .lean();

          if (admission) {
            prescriptionObj.admission_details = {
              _id: admission._id,
              admissionNumber: admission.admissionNumber,
              shipNumber: admission.shipNumber,
              ward_name: admission.wardId?.name || 'N/A',
              bed_number: admission.bedId?.bedNumber || 'N/A',
              status: admission.status,
              admission_date: admission.admissionDate
            };

            // For backward compatibility
            prescriptionObj.ward = admission.wardId?.name || 'N/A';
            prescriptionObj.bed_number = admission.bedId?.bedNumber || 'N/A';
            prescriptionObj.admission_number = admission.admissionNumber;
          }
        }

        return prescriptionObj;
      })
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
    console.error('Error fetching prescriptions by patient:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get IPD prescriptions for admission (with full admission details)
exports.getIPDPrescriptions = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const prescriptions = await Prescription.find({
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
    const admission = await IPDAdmission.findById(admissionId)
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
      status: 'Active',
      issue_date: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    };
    if (patient_id) filter.patient_id = patient_id;

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .sort({ issue_date: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // ========== FIX: Get admission details for IPD prescriptions ==========
    const IPDAdmission = require('../models/IPDAdmission');
    const prescriptionsWithAdmission = await Promise.all(
      prescriptions.map(async (prescription) => {
        const prescriptionObj = prescription.toObject();

        if (prescription.ipd_admission_id) {
          const admission = await IPDAdmission.findById(prescription.ipd_admission_id)
            .populate('wardId', 'name code')
            .populate('bedId', 'bedNumber name')
            .lean();

          if (admission) {
            prescriptionObj.admission_details = {
              _id: admission._id,
              admissionNumber: admission.admissionNumber,
              ward_name: admission.wardId?.name || 'N/A',
              bed_number: admission.bedId?.bedNumber || 'N/A',
              status: admission.status
            };

            // For backward compatibility
            prescriptionObj.ward = admission.wardId?.name || 'N/A';
            prescriptionObj.bed_number = admission.bedId?.bedNumber || 'N/A';
            prescriptionObj.admission_number = admission.admissionNumber;
          }
        }

        return prescriptionObj;
      })
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

// Update prescription
exports.updatePrescription = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const prescription = await Prescription.findByIdAndUpdate(
      id,
      updates,
      { new: true, runValidators: true }
    );

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    res.json({
      success: true,
      message: 'Prescription updated successfully',
      prescription
    });
  } catch (err) {
    console.error('Error updating prescription:', err);
    res.status(500).json({ error: err.message });
  }
};

// Delete prescription
exports.deletePrescription = async (req, res) => {
  try {
    const { id } = req.params;
    const prescription = await Prescription.findByIdAndDelete(id);

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    res.json({
      success: true,
      message: 'Prescription deleted successfully'
    });
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

    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

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
    prescription.items[itemIndex].dispensed_date = new Date();

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

    const filter = { doctor_id: doctorId };
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
    const result = await cloudinary.uploader.upload(req.file.path, {
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