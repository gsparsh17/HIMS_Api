const Prescription = require('../models/Prescription');
const Vital = require('../models/Vital');
const Procedure = require('../models/Procedure');
const LabTest = require('../models/LabTest'); // ✅ LabTest model
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Multer for disk storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

// Helper function to extract procedure code from various formats
function extractProcedureCode(input) {
  if (!input) return '';

  // If it matches a procedure code pattern (like D2161)
  const codePattern = /^[A-Z]\d+$/i;
  if (codePattern.test(input)) {
    return input.toUpperCase();
  }

  // Try to extract from formatted string like "D2161 - Amalgam – four surfaces (₹2290)"
  const match = input.match(/^([A-Z]\d+)/i);
  if (match) {
    return match[1].toUpperCase();
  }

  return input.toUpperCase();
}

// ✅ Helper function to extract lab test code from various formats
function extractLabTestCode(input) {
  if (!input) return '';

  // Common lab test code patterns: LT1001, LAB12, T123 etc.
  const codePattern = /^[A-Z]{1,4}\d+$/i;
  if (codePattern.test(input)) return input.toUpperCase();

  // Extract from "LT1001 - CBC (₹500)"
  const match = input.match(/^([A-Z]{1,4}\d+)/i);
  if (match) return match[1].toUpperCase();

  return input.toUpperCase();
}

/* =============================================================================
   PROCEDURES (EXISTING)
============================================================================= */

// Get prescriptions with recommended procedures
exports.getPrescriptionsWithProcedures = async (req, res) => {
  try {
    const { status, date, patient_id } = req.query;

    const filter = {
      'recommendedProcedures.0': { $exists: true }, // Has at least one procedure
      has_procedures: true
    };

    if (status) {
      filter['recommendedProcedures.status'] = status;
    }

    if (date) {
      const targetDate = new Date(date);
      targetDate.setHours(0, 0, 0, 0);
      const nextDate = new Date(targetDate);
      nextDate.setDate(targetDate.getDate() + 1);

      filter['recommendedProcedures.scheduled_date'] = {
        $gte: targetDate,
        $lt: nextDate
      };
    }

    if (patient_id) {
      filter.patient_id = patient_id;
    }

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId phone')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type')
      .sort({ issue_date: -1 });

    // Extract procedures for easier access
    const procedures = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedProcedures || []).forEach(proc => {
        if (
          (!status || proc.status === status) &&
          (!date ||
            (proc.scheduled_date &&
              new Date(proc.scheduled_date).toDateString() === new Date(date).toDateString()))
        ) {
          procedures.push({
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            patient: prescription.patient_id,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            ...proc.toObject()
          });
        }
      });
    });

    res.json({
      success: true,
      count: procedures.length,
      procedures
    });
  } catch (err) {
    console.error('Error fetching prescriptions with procedures:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get today's procedures
exports.getTodaysProcedures = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const prescriptions = await Prescription.find({
      'recommendedProcedures.scheduled_date': {
        $gte: today,
        $lt: tomorrow
      },
      'recommendedProcedures.status': { $in: ['Pending', 'Scheduled'] }
    })
      .populate('patient_id', 'first_name last_name patientId phone age gender')
      .populate('doctor_id', 'firstName lastName')
      .populate('appointment_id', 'appointment_date type')
      .sort({ 'recommendedProcedures.scheduled_date': 1 });

    // Extract today's procedures
    const todaysProcedures = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedProcedures || []).forEach(proc => {
        if (
          proc.scheduled_date &&
          new Date(proc.scheduled_date) >= today &&
          new Date(proc.scheduled_date) < tomorrow &&
          ['Pending', 'Scheduled'].includes(proc.status)
        ) {
          todaysProcedures.push({
            _id: proc._id,
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            patient: prescription.patient_id,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            procedure_code: proc.procedure_code,
            procedure_name: proc.procedure_name,
            notes: proc.notes,
            status: proc.status,
            scheduled_date: proc.scheduled_date,
            performed_by: proc.performed_by,
            cost: proc.cost,
            is_billed: proc.is_billed
          });
        }
      });
    });

    // Group by status
    const pendingProcedures = todaysProcedures.filter(p => p.status === 'Pending');
    const scheduledProcedures = todaysProcedures.filter(p => p.status === 'Scheduled');

    res.json({
      success: true,
      count: todaysProcedures.length,
      todaysProcedures,
      pendingProcedures,
      scheduledProcedures,
      summary: {
        pending: pendingProcedures.length,
        scheduled: scheduledProcedures.length,
        total: todaysProcedures.length
      }
    });
  } catch (err) {
    console.error("Error fetching today's procedures:", err);
    res.status(500).json({ error: err.message });
  }
};

// Update procedure status
exports.updateProcedureStatus = async (req, res) => {
  try {
    const { prescription_id, procedure_id } = req.params;
    const { status, performed_by, completed_date, notes, scheduled_date } = req.body;

    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const procedureIndex = (prescription.recommendedProcedures || []).findIndex(
      p => p._id.toString() === procedure_id
    );

    if (procedureIndex === -1) {
      return res.status(404).json({ error: 'Procedure not found in this prescription' });
    }

    // Update procedure
    if (status) {
      prescription.recommendedProcedures[procedureIndex].status = status;

      if (status === 'Completed') {
        prescription.recommendedProcedures[procedureIndex].completed_date = completed_date || new Date();
      }
    }

    if (performed_by) {
      prescription.recommendedProcedures[procedureIndex].performed_by = performed_by;
    }

    if (scheduled_date) {
      prescription.recommendedProcedures[procedureIndex].scheduled_date = scheduled_date;
      if (prescription.recommendedProcedures[procedureIndex].status === 'Pending') {
        prescription.recommendedProcedures[procedureIndex].status = 'Scheduled';
      }
    }

    if (notes) {
      prescription.recommendedProcedures[procedureIndex].notes =
        prescription.recommendedProcedures[procedureIndex].notes
          ? `${prescription.recommendedProcedures[procedureIndex].notes}\n${notes}`
          : notes;
    }

    await prescription.save();

    // Return updated prescription
    const updatedPrescription = await Prescription.findById(prescription_id)
      .populate('patient_id', 'first_name last_name')
      .populate('doctor_id', 'firstName lastName')
      .populate('recommendedProcedures.performed_by', 'firstName lastName');

    res.json({
      success: true,
      message: 'Procedure status updated successfully',
      prescription: updatedPrescription,
      updatedProcedure: updatedPrescription.recommendedProcedures[procedureIndex]
    });
  } catch (err) {
    console.error('Error updating procedure status:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get procedures by status
exports.getProceduresByStatus = async (req, res) => {
  try {
    const { status } = req.params;
    const { patient_id, doctor_id, start_date, end_date } = req.query;

    const filter = {
      'recommendedProcedures.status': status,
      has_procedures: true
    };

    if (patient_id) {
      filter.patient_id = patient_id;
    }

    if (doctor_id) {
      filter.doctor_id = doctor_id;
    }

    if (start_date && end_date) {
      filter['recommendedProcedures.scheduled_date'] = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName')
      .populate('appointment_id')
      .sort({ issue_date: -1 });

    // Extract procedures with the specific status
    const procedures = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedProcedures || []).forEach(proc => {
        if (proc.status === status) {
          procedures.push({
            _id: proc._id,
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            patient: prescription.patient_id,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            ...proc.toObject()
          });
        }
      });
    });

    res.json({
      success: true,
      count: procedures.length,
      status,
      procedures
    });
  } catch (err) {
    console.error('Error fetching procedures by status:', err);
    res.status(500).json({ error: err.message });
  }
};

// Mark procedure as billed
exports.markProcedureAsBilled = async (req, res) => {
  try {
    const { prescription_id, procedure_id } = req.params;
    const { invoice_id, cost } = req.body;

    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const procedureIndex = (prescription.recommendedProcedures || []).findIndex(
      p => p._id.toString() === procedure_id
    );

    if (procedureIndex === -1) {
      return res.status(404).json({ error: 'Procedure not found' });
    }

    // Update procedure billing info
    prescription.recommendedProcedures[procedureIndex].is_billed = true;
    prescription.recommendedProcedures[procedureIndex].invoice_id = invoice_id;

    if (cost !== undefined) {
      prescription.recommendedProcedures[procedureIndex].cost = cost;
    }

    await prescription.save();

    res.json({
      success: true,
      message: 'Procedure marked as billed',
      procedure: prescription.recommendedProcedures[procedureIndex]
    });
  } catch (err) {
    console.error('Error marking procedure as billed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get patient's pending procedures
exports.getPatientPendingProcedures = async (req, res) => {
  try {
    const { patientId } = req.params;

    const prescriptions = await Prescription.find({
      patient_id: patientId,
      'recommendedProcedures.status': { $in: ['Pending', 'Scheduled'] },
      has_procedures: true
    })
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type')
      .sort({ issue_date: -1 });

    const pendingProcedures = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedProcedures || []).forEach(proc => {
        if (['Pending', 'Scheduled'].includes(proc.status)) {
          pendingProcedures.push({
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            issue_date: prescription.issue_date,
            ...proc.toObject()
          });
        }
      });
    });

    res.json({
      success: true,
      count: pendingProcedures.length,
      pendingProcedures
    });
  } catch (err) {
    console.error('Error fetching patient pending procedures:', err);
    res.status(500).json({ error: err.message });
  }
};

/* =============================================================================
   ✅ LAB TESTS (NEW)
============================================================================= */

// Get prescriptions with recommended lab tests
exports.getPrescriptionsWithLabTests = async (req, res) => {
  try {
    const { status, date, patient_id } = req.query;

    const filter = {
      'recommendedLabTests.0': { $exists: true },
      has_lab_tests: true
    };

    if (status) filter['recommendedLabTests.status'] = status;

    if (date) {
      const targetDate = new Date(date);
      targetDate.setHours(0, 0, 0, 0);
      const nextDate = new Date(targetDate);
      nextDate.setDate(targetDate.getDate() + 1);

      filter['recommendedLabTests.scheduled_date'] = { $gte: targetDate, $lt: nextDate };
    }

    if (patient_id) filter.patient_id = patient_id;

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId phone')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type')
      .sort({ issue_date: -1 });

    const labTests = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedLabTests || []).forEach(test => {
        if (
          (!status || test.status === status) &&
          (!date ||
            (test.scheduled_date &&
              new Date(test.scheduled_date).toDateString() === new Date(date).toDateString()))
        ) {
          labTests.push({
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            patient: prescription.patient_id,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            ...test.toObject()
          });
        }
      });
    });

    res.json({ success: true, count: labTests.length, labTests });
  } catch (err) {
    console.error('Error fetching prescriptions with lab tests:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get today's lab tests
exports.getTodaysLabTests = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const prescriptions = await Prescription.find({
      'recommendedLabTests.scheduled_date': { $gte: today, $lt: tomorrow },
      'recommendedLabTests.status': { $in: ['Pending', 'Scheduled', 'Sample Collected'] },
      has_lab_tests: true
    })
      .populate('patient_id', 'first_name last_name patientId phone age gender')
      .populate('doctor_id', 'firstName lastName')
      .populate('appointment_id', 'appointment_date type')
      .sort({ 'recommendedLabTests.scheduled_date': 1 });

    const todaysLabTests = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedLabTests || []).forEach(test => {
        if (
          test.scheduled_date &&
          new Date(test.scheduled_date) >= today &&
          new Date(test.scheduled_date) < tomorrow &&
          ['Pending', 'Scheduled', 'Sample Collected'].includes(test.status)
        ) {
          todaysLabTests.push({
            _id: test._id,
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            patient: prescription.patient_id,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            lab_test_code: test.lab_test_code,
            lab_test_name: test.lab_test_name,
            notes: test.notes,
            status: test.status,
            scheduled_date: test.scheduled_date,
            sample_collected_at: test.sample_collected_at,
            performed_by: test.performed_by,
            completed_date: test.completed_date,
            cost: test.cost,
            is_billed: test.is_billed
          });
        }
      });
    });

    const pending = todaysLabTests.filter(t => t.status === 'Pending');
    const scheduled = todaysLabTests.filter(t => t.status === 'Scheduled');
    const collected = todaysLabTests.filter(t => t.status === 'Sample Collected');

    res.json({
      success: true,
      count: todaysLabTests.length,
      todaysLabTests,
      pending,
      scheduled,
      collected,
      summary: {
        pending: pending.length,
        scheduled: scheduled.length,
        sample_collected: collected.length,
        total: todaysLabTests.length
      }
    });
  } catch (err) {
    console.error("Error fetching today's lab tests:", err);
    res.status(500).json({ error: err.message });
  }
};

// Update lab test status
exports.updateLabTestStatus = async (req, res) => {
  try {
    const { prescription_id, lab_test_id } = req.params;
    const { status, performed_by, completed_date, notes, scheduled_date, sample_collected_at, report_url } = req.body;

    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' });

    const labIndex = (prescription.recommendedLabTests || []).findIndex(
      t => t._id.toString() === lab_test_id
    );
    if (labIndex === -1) return res.status(404).json({ error: 'Lab test not found in this prescription' });

    if (status) {
      prescription.recommendedLabTests[labIndex].status = status;

      if (status === 'Completed') {
        prescription.recommendedLabTests[labIndex].completed_date = completed_date || new Date();
      }
      if (status === 'Sample Collected') {
        prescription.recommendedLabTests[labIndex].sample_collected_at = sample_collected_at || new Date();
      }
    }

    if (performed_by) prescription.recommendedLabTests[labIndex].performed_by = performed_by;

    if (scheduled_date) {
      prescription.recommendedLabTests[labIndex].scheduled_date = scheduled_date;
      if (prescription.recommendedLabTests[labIndex].status === 'Pending') {
        prescription.recommendedLabTests[labIndex].status = 'Scheduled';
      }
    }

    if (report_url) prescription.recommendedLabTests[labIndex].report_url = report_url;

    if (notes) {
      prescription.recommendedLabTests[labIndex].notes =
        prescription.recommendedLabTests[labIndex].notes
          ? `${prescription.recommendedLabTests[labIndex].notes}\n${notes}`
          : notes;
    }

    // Update prescription-level lab tests status fields (if your schema supports these)
    const total = (prescription.recommendedLabTests || []).length;
    const completed = (prescription.recommendedLabTests || []).filter(t => t.status === 'Completed').length;

    prescription.has_lab_tests = total > 0;
    if (total === 0) prescription.lab_tests_status = 'None';
    else if (completed === 0) prescription.lab_tests_status = 'Pending';
    else if (completed === total) prescription.lab_tests_status = 'Completed';
    else prescription.lab_tests_status = 'Partial';

    await prescription.save();

    const updatedPrescription = await Prescription.findById(prescription_id)
      .populate('patient_id', 'first_name last_name')
      .populate('doctor_id', 'firstName lastName')
      .populate('recommendedLabTests.performed_by', 'firstName lastName');

    res.json({
      success: true,
      message: 'Lab test status updated successfully',
      prescription: updatedPrescription,
      updatedLabTest: updatedPrescription.recommendedLabTests[labIndex]
    });
  } catch (err) {
    console.error('Error updating lab test status:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get lab tests by status
exports.getLabTestsByStatus = async (req, res) => {
  try {
    const { status } = req.params;
    const { patient_id, doctor_id, start_date, end_date } = req.query;

    const filter = {
      'recommendedLabTests.status': status,
      has_lab_tests: true
    };

    if (patient_id) filter.patient_id = patient_id;
    if (doctor_id) filter.doctor_id = doctor_id;

    if (start_date && end_date) {
      filter['recommendedLabTests.scheduled_date'] = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName')
      .populate('appointment_id')
      .sort({ issue_date: -1 });

    const labTests = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedLabTests || []).forEach(test => {
        if (test.status === status) {
          labTests.push({
            _id: test._id,
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            patient: prescription.patient_id,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            ...test.toObject()
          });
        }
      });
    });

    res.json({ success: true, count: labTests.length, status, labTests });
  } catch (err) {
    console.error('Error fetching lab tests by status:', err);
    res.status(500).json({ error: err.message });
  }
};

// Mark lab test as billed
exports.markLabTestAsBilled = async (req, res) => {
  try {
    const { prescription_id, lab_test_id } = req.params;
    const { invoice_id, cost } = req.body;

    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' });

    const labIndex = (prescription.recommendedLabTests || []).findIndex(
      t => t._id.toString() === lab_test_id
    );
    if (labIndex === -1) return res.status(404).json({ error: 'Lab test not found' });

    prescription.recommendedLabTests[labIndex].is_billed = true;
    prescription.recommendedLabTests[labIndex].invoice_id = invoice_id;

    if (cost !== undefined) prescription.recommendedLabTests[labIndex].cost = cost;

    await prescription.save();

    res.json({
      success: true,
      message: 'Lab test marked as billed',
      labTest: prescription.recommendedLabTests[labIndex]
    });
  } catch (err) {
    console.error('Error marking lab test as billed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get patient's pending lab tests
exports.getPatientPendingLabTests = async (req, res) => {
  try {
    const { patientId } = req.params;

    const prescriptions = await Prescription.find({
      patient_id: patientId,
      'recommendedLabTests.status': { $in: ['Pending', 'Scheduled', 'Sample Collected'] },
      has_lab_tests: true
    })
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type')
      .sort({ issue_date: -1 });

    const pendingLabTests = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedLabTests || []).forEach(test => {
        if (['Pending', 'Scheduled', 'Sample Collected'].includes(test.status)) {
          pendingLabTests.push({
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            doctor: prescription.doctor_id,
            appointment: prescription.appointment_id,
            diagnosis: prescription.diagnosis,
            issue_date: prescription.issue_date,
            ...test.toObject()
          });
        }
      });
    });

    res.json({ success: true, count: pendingLabTests.length, pendingLabTests });
  } catch (err) {
    console.error('Error fetching patient pending lab tests:', err);
    res.status(500).json({ error: err.message });
  }
};

/* =============================================================================
   IMAGE UPLOAD (EXISTING)
============================================================================= */

// The upload endpoint with Multer middleware
exports.uploadPrescriptionImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'prescriptions',
      resource_type: 'image'
    });
    const fs = require('fs');
    fs.unlinkSync(req.file.path);

    res.json({ imageUrl: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* =============================================================================
   CREATE PRESCRIPTION (UPDATED: PROCEDURES + ✅ LAB TESTS)
============================================================================= */

exports.createPrescription = async (req, res) => {
  try {
    const {
      patient_id,
      doctor_id,
      appointment_id,
      diagnosis,
      symptoms,
      notes,
      investigation,
      presenting_complaint,
      history_of_presenting_complaint,
      items,
      prescription_image,
      validity_days,
      follow_up_date,
      is_repeatable,
      repeat_count,
      recommendedProcedures = [],
      recommendedLabTests = [] // ✅ NEW
    } = req.body;

    console.log('Creating prescription with procedures:', recommendedProcedures);
    console.log('Creating prescription with lab tests:', recommendedLabTests);

    // Process items to ensure all fields are included
    const processedItems = items && Array.isArray(items)
      ? items.map(item => ({
          medicine_name: item.medicine_name || '',
          dosage: item.dosage || '',
          medicine_type: item.medicine_type || '',
          route_of_administration: item.route_of_administration || '',
          frequency: item.frequency || '',
          duration: item.duration || '',
          quantity: item.quantity || 0,
          instructions: item.instructions || '',
          generic_name: item.generic_name || '',
          timing: item.timing || undefined,
          is_dispensed: item.is_dispensed || false,
          dispensed_quantity: item.dispensed_quantity || 0
        }))
      : [];

    // Process procedures with their costs
    const processedProcedures = await Promise.all(
      (recommendedProcedures || [])
        .filter(proc => proc.procedure_code && proc.procedure_name)
        .map(async proc => {
          try {
            const procedureCode = extractProcedureCode(proc.procedure_code);

            // Find procedure in database to get the correct cost
            const procedure = await Procedure.findOne({
              code: procedureCode,
              is_active: true
            });

            if (procedure) {
              // Increment usage count
              await Procedure.findByIdAndUpdate(procedure._id, {
                $inc: { usage_count: 1 },
                last_used: new Date()
              });

              return {
                procedure_code: procedureCode,
                procedure_name: proc.procedure_name,
                notes: proc.notes?.trim() || '',
                status: 'Pending',
                cost: procedure.base_price || 0,
                base_price: procedure.base_price || 0,
                category: procedure.category || 'Other',
                duration_minutes: procedure.duration_minutes || 30,
                insurance_coverage: procedure.insurance_coverage || 'Partial',
                is_billed: false
              };
            } else {
              console.warn(`Procedure ${procedureCode} not found in database`);
              return {
                procedure_code: procedureCode,
                procedure_name: proc.procedure_name,
                notes: proc.notes?.trim() || '',
                status: 'Pending',
                cost: proc.cost || 0,
                base_price: proc.base_price || 0,
                category: proc.category || 'Other',
                duration_minutes: proc.duration_minutes || 30,
                insurance_coverage: proc.insurance_coverage || 'Partial',
                is_billed: false
              };
            }
          } catch (error) {
            console.error(`Error processing procedure ${proc.procedure_code}:`, error);
            return {
              procedure_code: extractProcedureCode(proc.procedure_code),
              procedure_name: proc.procedure_name,
              notes: proc.notes?.trim() || '',
              status: 'Pending',
              cost: proc.cost || 0,
              base_price: proc.base_price || 0,
              category: proc.category || 'Other',
              duration_minutes: proc.duration_minutes || 30,
              insurance_coverage: proc.insurance_coverage || 'Partial',
              is_billed: false
            };
          }
        })
    );

    // ✅ Process lab tests with their costs (similar to procedures)
    const processedLabTests = await Promise.all(
      (recommendedLabTests || [])
        .filter(t => t.lab_test_code && t.lab_test_name)
        .map(async t => {
          try {
            const labCode = extractLabTestCode(t.lab_test_code);

            // Find lab test in database to get correct cost (adjust fields to your LabTest schema)
            const labTest = await LabTest.findOne({
              code: labCode,
              is_active: true
            });

            if (labTest) {
              // Increment usage count (if your schema has these fields)
              await LabTest.findByIdAndUpdate(labTest._id, {
                $inc: { usage_count: 1 },
                last_used: new Date()
              }).catch(() => {});

              return {
                lab_test_code: labCode,
                lab_test_name: t.lab_test_name,
                notes: t.notes?.trim() || '',
                status: 'Pending',
                cost: labTest.base_price || labTest.price || 0,
                base_price: labTest.base_price || labTest.price || 0,
                category: labTest.category || 'Other',
                fasting_required: labTest.fasting_required || false,
                sample_type: labTest.sample_type || t.sample_type || '',
                turnaround_time: labTest.turnaround_time || t.turnaround_time || '',
                insurance_coverage: labTest.insurance_coverage || 'Partial',
                scheduled_date: t.scheduled_date || null,
                is_billed: false
              };
            } else {
              console.warn(`LabTest ${labCode} not found in database`);
              return {
                lab_test_code: labCode,
                lab_test_name: t.lab_test_name,
                notes: t.notes?.trim() || '',
                status: 'Pending',
                cost: t.cost || 0,
                base_price: t.base_price || t.cost || 0,
                category: t.category || 'Other',
                fasting_required: t.fasting_required || false,
                sample_type: t.sample_type || '',
                turnaround_time: t.turnaround_time || '',
                insurance_coverage: t.insurance_coverage || 'Partial',
                scheduled_date: t.scheduled_date || null,
                is_billed: false
              };
            }
          } catch (error) {
            console.error(`Error processing lab test ${t.lab_test_code}:`, error);
            return {
              lab_test_code: extractLabTestCode(t.lab_test_code),
              lab_test_name: t.lab_test_name,
              notes: t.notes?.trim() || '',
              status: 'Pending',
              cost: t.cost || 0,
              base_price: t.base_price || t.cost || 0,
              category: t.category || 'Other',
              fasting_required: t.fasting_required || false,
              sample_type: t.sample_type || '',
              turnaround_time: t.turnaround_time || '',
              insurance_coverage: t.insurance_coverage || 'Partial',
              scheduled_date: t.scheduled_date || null,
              is_billed: false
            };
          }
        })
    );

    // Calculate totals
    const totalProcedureCost = processedProcedures.reduce((sum, proc) => sum + (proc.cost || 0), 0);
    const totalLabTestCost = processedLabTests.reduce((sum, t) => sum + (t.cost || 0), 0);

    // Create prescription
    const prescription = new Prescription({
      patient_id,
      doctor_id,
      appointment_id,
      diagnosis: diagnosis || '',
      symptoms: symptoms || '',
      investigation: investigation || null,
      presenting_complaint: presenting_complaint || '',
      history_of_presenting_complaint: history_of_presenting_complaint || '',
      notes: notes || '',
      items: processedItems,

      recommendedProcedures: processedProcedures,
      has_procedures: processedProcedures.length > 0,
      total_procedure_cost: totalProcedureCost,
      procedures_status: processedProcedures.length > 0 ? 'Pending' : 'None',

      // ✅ NEW: lab tests fields
      recommendedLabTests: processedLabTests,
      has_lab_tests: processedLabTests.length > 0,
      total_lab_test_cost: totalLabTestCost,
      lab_tests_status: processedLabTests.length > 0 ? 'Pending' : 'None',

      prescription_image: prescription_image || null,
      validity_days: validity_days || 30,
      follow_up_date: follow_up_date ? new Date(follow_up_date) : null,
      is_repeatable: is_repeatable || false,
      repeat_count: repeat_count || 0,
      created_by: req.user?._id
    });

    await prescription.save();

    // Populate the response
    const populatedPrescription = await Prescription.findById(prescription._id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type')
      .populate('created_by', 'name');

    res.status(201).json({
      success: true,
      prescription: populatedPrescription,
      message: 'Prescription created successfully',
      procedures: {
        count: processedProcedures.length,
        totalCost: totalProcedureCost,
        list: processedProcedures
      },
      labTests: {
        count: processedLabTests.length,
        totalCost: totalLabTestCost,
        list: processedLabTests
      }
    });
  } catch (err) {
    console.error('Error creating prescription:', err);
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

/* =============================================================================
   READ / UPDATE / DELETE (EXISTING)
============================================================================= */

exports.getAllPrescriptions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      patient_id,
      doctor_id,
      appointment_id,
      status,
      startDate,
      endDate
    } = req.query;

    const filter = {};
    if (patient_id) filter.patient_id = patient_id;
    if (doctor_id) filter.doctor_id = doctor_id;
    if (appointment_id) filter.appointment_id = appointment_id;
    if (status) filter.status = status;

    if (startDate && endDate) {
      filter.issue_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Fetch vitals for each prescription
    const prescriptionsWithVitals = await Promise.all(
      prescriptions.map(async p => {
        const vital = await Vital.findOne({ prescription_id: p._id });
        return {
          ...p.toObject(),
          vitals: vital || null
        };
      })
    );

    const total = await Prescription.countDocuments(filter);

    res.json({
      prescriptions: prescriptionsWithVitals,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    console.error('Error in getAllPrescriptions:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get a prescription by ID
exports.getPrescriptionById = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patient_id', 'first_name last_name patientId phone dob gender')
      .populate('doctor_id', 'firstName lastName specialization licenseNumber department')
      .populate('appointment_id', 'appointment_date type priority')
      .populate('created_by', 'name');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    // Fetch associated vitals
    const vitals = await Vital.findOne({ prescription_id: prescription._id });

    // Return prescription converted to object with vitals attached
    res.json({
      ...prescription.toObject(),
      vitals: vitals || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update prescription
exports.updatePrescription = async (req, res) => {
  try {
    const {
      diagnosis,
      symptoms,
      notes,
      investigation,
      items,
      status,
      validity_days,
      follow_up_date,
      is_repeatable,
      repeat_count
    } = req.body;

    // Process items to ensure all fields are included
    let processedItems;
    if (items && Array.isArray(items)) {
      processedItems = items.map(item => ({
        medicine_name: item.medicine_name || '',
        dosage: item.dosage || '',
        medicine_type: item.medicine_type || '',
        route_of_administration: item.route_of_administration || '',
        frequency: item.frequency || '',
        duration: item.duration || '',
        quantity: item.quantity || 0,
        instructions: item.instructions || '',
        generic_name: item.generic_name || '',
        timing: item.timing || undefined,
        is_dispensed: item.is_dispensed || false,
        dispensed_quantity: item.dispensed_quantity || 0
      }));
    }

    const updateData = {
      diagnosis,
      symptoms,
      investigation,
      notes,
      status,
      validity_days,
      follow_up_date: follow_up_date ? new Date(follow_up_date) : null,
      is_repeatable,
      repeat_count
    };

    // Only update items if provided
    if (processedItems) updateData.items = processedItems;

    const prescription = await Prescription.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true
    })
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    // --- HANDLE VITALS UPDATE ---
    let savedVitals = null;
    if (req.body.vitals) {
      const { bp, weight, pulse, spo2, temperature } = req.body.vitals;

      let vitalRecord = await Vital.findOne({ prescription_id: prescription._id });

      if (vitalRecord) {
        vitalRecord.bp = bp || vitalRecord.bp;
        vitalRecord.weight = weight || vitalRecord.weight;
        vitalRecord.pulse = pulse || vitalRecord.pulse;
        vitalRecord.spo2 = spo2 || vitalRecord.spo2;
        vitalRecord.temperature = temperature || vitalRecord.temperature;
        vitalRecord.recorded_at = new Date();
        savedVitals = await vitalRecord.save();
      } else {
        savedVitals = await Vital.create({
          patient_id: prescription.patient_id._id || prescription.patient_id,
          prescription_id: prescription._id,
          recorded_by: req.user ? req.user._id : null,
          bp,
          weight,
          pulse,
          spo2,
          temperature
        });
      }
    }

    res.json({
      prescription,
      vitals: savedVitals,
      message: 'Prescription updated successfully'
    });
  } catch (err) {
    console.error('Error updating prescription:', err);
    res.status(400).json({ error: err.message });
  }
};

// Delete prescription
exports.deletePrescription = async (req, res) => {
  try {
    const prescription = await Prescription.findByIdAndDelete(req.params.id);

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    res.json({ message: 'Prescription deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update prescription item status (dispense medication)
exports.dispenseMedication = async (req, res) => {
  try {
    const { prescriptionId, itemIndex } = req.params;
    const { dispensed_quantity } = req.body;

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

    prescription.items[itemIndex].is_dispensed = true;
    prescription.items[itemIndex].dispensed_quantity = quantityToDispense;
    prescription.items[itemIndex].dispensed_date = new Date();

    const allDispensed = prescription.items.every(it => it.is_dispensed);
    if (allDispensed) prescription.status = 'Completed';

    await prescription.save();

    const updatedPrescription = await Prescription.findById(prescriptionId)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization');

    res.json({
      prescription: updatedPrescription,
      message: 'Medication dispensed successfully'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get prescriptions by patient ID
exports.getPrescriptionsByPatientId = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { status, page = 1, limit = 10 } = req.query;

    const filter = { patient_id: patientId };
    if (status) filter.status = status;

    const prescriptions = await Prescription.find(filter)
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('appointment_id', 'appointment_date type')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Prescription.countDocuments(filter);

    res.json({
      prescriptions,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get prescriptions by doctor ID
exports.getPrescriptionsByDoctorId = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { status, page = 1, limit = 10 } = req.query;

    const filter = { doctor_id: doctorId };
    if (status) filter.status = status;

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Prescription.countDocuments(filter);

    res.json({
      prescriptions,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get active prescriptions (not expired and not completed)
exports.getActivePrescriptions = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const prescriptions = await Prescription.find({
      status: 'Active',
      issue_date: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    })
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Prescription.countDocuments({
      status: 'Active',
      issue_date: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    });

    res.json({
      prescriptions,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Check prescription expiry (can be run as a cron job)
exports.checkPrescriptionExpiry = async () => {
  try {
    const expiredPrescriptions = await Prescription.find({
      status: 'Active',
      issue_date: { $lte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    });

    for (const prescription of expiredPrescriptions) {
      prescription.status = 'Expired';
      await prescription.save();
    }

    return {
      expiredCount: expiredPrescriptions.length,
      message: `Marked ${expiredPrescriptions.length} prescriptions as expired`
    };
  } catch (err) {
    console.error('Error checking prescription expiry:', err);
    throw err;
  }
};

// Get procedure statistics from prescriptions
exports.getProcedureStats = async (req, res) => {
  try {
    const stats = await Prescription.aggregate([
      { $unwind: '$recommendedProcedures' },
      {
        $group: {
          _id: '$recommendedProcedures.procedure_code',
          procedure_name: { $first: '$recommendedProcedures.procedure_name' },
          count: { $sum: 1 },
          total_revenue: { $sum: '$recommendedProcedures.cost' },
          avg_cost: { $avg: '$recommendedProcedures.cost' },
          completed: {
            $sum: { $cond: [{ $eq: ['$recommendedProcedures.status', 'Completed'] }, 1, 0] }
          },
          pending: {
            $sum: { $cond: [{ $eq: ['$recommendedProcedures.status', 'Pending'] }, 1, 0] }
          },
          scheduled: {
            $sum: { $cond: [{ $eq: ['$recommendedProcedures.status', 'Scheduled'] }, 1, 0] }
          }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({ success: true, stats });
  } catch (err) {
    console.error('Error fetching procedure stats:', err);
    res.status(500).json({ error: err.message });
  }
};

// ✅ Lab test statistics from prescriptions
exports.getLabTestStats = async (req, res) => {
  try {
    const stats = await Prescription.aggregate([
      { $unwind: '$recommendedLabTests' },
      {
        $group: {
          _id: '$recommendedLabTests.lab_test_code',
          lab_test_name: { $first: '$recommendedLabTests.lab_test_name' },
          count: { $sum: 1 },
          total_revenue: { $sum: '$recommendedLabTests.cost' },
          avg_cost: { $avg: '$recommendedLabTests.cost' },
          completed: {
            $sum: { $cond: [{ $eq: ['$recommendedLabTests.status', 'Completed'] }, 1, 0] }
          },
          pending: {
            $sum: { $cond: [{ $eq: ['$recommendedLabTests.status', 'Pending'] }, 1, 0] }
          },
          scheduled: {
            $sum: { $cond: [{ $eq: ['$recommendedLabTests.status', 'Scheduled'] }, 1, 0] }
          }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({ success: true, stats });
  } catch (err) {
    console.error('Error fetching lab test stats:', err);
    res.status(500).json({ error: err.message });
  }
};
