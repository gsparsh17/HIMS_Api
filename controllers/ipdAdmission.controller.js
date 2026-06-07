const IPDAdmission = require('../models/IPDAdmission');
const Bed = require('../models/Bed');
const Ward = require('../models/Ward');
const Room = require('../models/Room');
const Patient = require('../models/Patient');
const IPDCharge = require('../models/IPDCharge');
const IPDRound = require('../models/IPDRound');
const LabReport = require('../models/LabReport');
const NursingNote = require('../models/NursingNote');
const IPDVitals = require('../models/IPDVitals');
const DischargeSummary = require('../models/DischargeSummary');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const moment = require('moment');
const mongoose = require('mongoose');

// ========== HELPER: Generate Invoice for Registration Fee ==========
async function generateRegistrationFeeInvoice(admission, patient, registrationFee, paymentMethod, createdBy) {
  try {
    if (!registrationFee || registrationFee <= 0) return null;

    // Create a bill for the registration fee
    const bill = new Bill({
      patient_id: patient._id,
      admission_id: admission._id,
      total_amount: registrationFee,
      subtotal: registrationFee,
      tax_amount: 0,
      discount: 0,
      payment_method: paymentMethod || 'Cash',
      status: 'Paid',
      paid_amount: registrationFee,
      balance_due: 0,
      paid_at: new Date(),
      items: [{
        description: `IPD Registration Fee - ${admission.admissionNumber}`,
        amount: registrationFee,
        quantity: 1,
        item_type: 'Other',  // Changed from 'Registration Fee' to 'Other'
        admission_id: admission._id
      }],
      notes: `Registration fee for IPD admission ${admission.admissionNumber}`,
      created_by: createdBy,
      is_pharmacy_bill: false
    });

    await bill.save();

    // Create invoice for the registration fee
    const invoice = new Invoice({
      invoice_type: 'IPD Registration',  // New type
      patient_id: patient._id,
      admission_id: admission._id,
      customer_type: 'Patient',
      customer_name: `${patient.first_name} ${patient.last_name || ''}`.trim(),
      customer_phone: patient.phone,
      bill_id: bill._id,
      issue_date: new Date(),
      due_date: new Date(),
      service_items: [{
        description: `IPD Registration Fee - ${admission.admissionNumber}`,
        quantity: 1,
        unit_price: registrationFee,
        total_price: registrationFee,
        tax_rate: 0,
        tax_amount: 0,
        service_type: 'Other'
      }],
      subtotal: registrationFee,
      discount: 0,
      tax: 0,
      total: registrationFee,
      amount_paid: registrationFee,
      balance_due: 0,
      status: 'Paid',
      notes: `Registration fee for IPD admission ${admission.admissionNumber}`,
      created_by: createdBy,
      payment_history: [{
        amount: registrationFee,
        method: paymentMethod || 'Cash',
        date: new Date(),
        status: 'Completed',
        collected_by: createdBy
      }]
    });

    await invoice.save();
    bill.invoice_id = invoice._id;
    await bill.save();

    return { bill, invoice };
  } catch (error) {
    console.error('Error generating registration fee invoice:', error);
    return null;
  }
}

// ========== HELPER: Generate Invoice for Admission Fee ==========
async function generateAdmissionFeeInvoice(admission, patient, admissionFee, paymentMethod, createdBy) {
  try {
    if (!admissionFee || admissionFee <= 0) return null;

    const bill = new Bill({
      patient_id: patient._id,
      admission_id: admission._id,
      total_amount: admissionFee,
      subtotal: admissionFee,
      tax_amount: 0,
      discount: 0,
      payment_method: paymentMethod || 'Cash',
      status: 'Paid',
      paid_amount: admissionFee,
      balance_due: 0,
      paid_at: new Date(),
      items: [{
        description: `IPD Admission Fee - ${admission.admissionNumber}`,
        amount: admissionFee,
        quantity: 1,
        item_type: 'Other',  // Changed from 'Admission Fee' to 'Other'
        admission_id: admission._id
      }],
      notes: `Admission fee for IPD admission ${admission.admissionNumber}`,
      created_by: createdBy,
      is_pharmacy_bill: false
    });

    await bill.save();

    const invoice = new Invoice({
      invoice_type: 'IPD Admission',  // New type
      patient_id: patient._id,
      admission_id: admission._id,
      customer_type: 'Patient',
      customer_name: `${patient.first_name} ${patient.last_name || ''}`.trim(),
      customer_phone: patient.phone,
      bill_id: bill._id,
      issue_date: new Date(),
      due_date: new Date(),
      service_items: [{
        description: `IPD Admission Fee - ${admission.admissionNumber}`,
        quantity: 1,
        unit_price: admissionFee,
        total_price: admissionFee,
        tax_rate: 0,
        tax_amount: 0,
        service_type: 'Other'
      }],
      subtotal: admissionFee,
      discount: 0,
      tax: 0,
      total: admissionFee,
      amount_paid: admissionFee,
      balance_due: 0,
      status: 'Paid',
      notes: `Admission fee for IPD admission ${admission.admissionNumber}`,
      created_by: createdBy,
      payment_history: [{
        amount: admissionFee,
        method: paymentMethod || 'Cash',
        date: new Date(),
        status: 'Completed',
        collected_by: createdBy
      }]
    });

    await invoice.save();
    bill.invoice_id = invoice._id;
    await bill.save();

    return { bill, invoice };
  } catch (error) {
    console.error('Error generating admission fee invoice:', error);
    return null;
  }
}

// ========== HELPER: Create IPD Charge ==========
async function createIPDCharge({
  admissionId,
  patientId,
  chargeType,
  description,
  quantity,
  rate,
  sourceModule,
  sourceId,
  isAutoGenerated = true,
  isBilled = false,
  invoiceId = null,
  addedBy,
  notes,
  chargeDate = new Date()
}) {
  const netAmount = (quantity || 1) * (rate || 0);

  const charge = new IPDCharge({
    admissionId,
    patientId,
    chargeType,
    description,
    quantity: quantity || 1,
    rate: rate || 0,
    amount: netAmount,
    netAmount,
    sourceModule,
    sourceId,
    isAutoGenerated,
    isBilled,
    invoiceId,
    addedBy,
    notes,
    chargeDate
  });

  await charge.save();
  return charge;
}

// ========== ADMISSION CRUD ==========

// Create new IPD admission
exports.createAdmission = async (req, res) => {
  try {
    const {
      patientId,
      admissionType,
      departmentId,
      primaryDoctorId,
      secondaryDoctorIds,
      bedId,
      provisionalDiagnosis,
      chiefComplaints,
      historyOfPresentIllness,
      pastMedicalHistory,
      attendant,
      paymentType,
      insuranceDetails,
      sponsorType,
      sponsorName,
      advanceAmount,
      admissionNotes,
      // Payment-related fields from frontend
      registrationFee = 0,
      admissionFee = 0,
      registrationFeeMethod = 'Cash',
      admissionFeeMethod = 'Cash',
      advancePaymentMethod = 'Cash'
    } = req.body;

    // Validate patient exists
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Check if patient already has active admission
    const existingAdmission = await IPDAdmission.findOne({
      patientId,
      status: { $in: ['Admitted', 'Under Treatment', 'Discharge Initiated', 'Discharge Summary Pending', 'Billing Pending', 'Payment Pending', 'Ready for Discharge'] }
    });

    if (existingAdmission) {
      return res.status(400).json({
        error: 'Patient already has an active admission',
        admissionNumber: existingAdmission.admissionNumber,
        shipNumber: existingAdmission.shipNumber
      });
    }

    // Validate bed availability if provided
    let bed = null;
    let roomId = null;
    let wardId = null;
    let dailyBedCharge = 0;

    if (bedId) {
      bed = await Bed.findById(bedId).populate('roomId');
      if (!bed) {
        return res.status(404).json({ error: 'Bed not found' });
      }
      if (bed.status !== 'Available') {
        return res.status(400).json({ error: 'Bed is not available' });
      }
      roomId = bed.roomId?._id;
      wardId = bed.wardId;
      dailyBedCharge = bed.dailyCharge || 0;
    }

    // Get doctor and department details for population
    let doctor = null;
    let department = null;

    if (primaryDoctorId) {
      doctor = await Doctor.findById(primaryDoctorId).select('firstName lastName specialization');
    }

    if (departmentId) {
      department = await Department.findById(departmentId).select('name');
    }

    // Calculate total initial payment from frontend values
    const totalInitialPayment = (parseFloat(advanceAmount) || 0) +
      (parseFloat(registrationFee) || 0) +
      (parseFloat(admissionFee) || 0);

    // Create admission
    const admission = new IPDAdmission({
      patientId,
      admissionType,
      departmentId,
      primaryDoctorId,
      secondaryDoctorIds: secondaryDoctorIds || [],
      bedId,
      roomId,
      wardId,
      provisionalDiagnosis,
      chiefComplaints,
      historyOfPresentIllness,
      pastMedicalHistory,
      attendant,
      paymentType,
      insuranceDetails,
      sponsorType: sponsorType || patient.sponsor_type || 'self',
      sponsorName: sponsorName || patient.sponsor_name,
      advanceAmount: advanceAmount || 0,
      admissionNotes,
      status: 'Admitted',
      clinicalAssessmentCompleted: false,
      createdBy: req.user?._id,
      pharmacyClearanceStatus: 'pending',
      paidAmount: totalInitialPayment
    });

    await admission.save();

    // Update bed status
    if (bed) {
      bed.status = 'Occupied';
      bed.currentAdmissionId = admission._id;
      await bed.save();
    }

    // In createAdmission function, replace the patient update with:
    await Patient.findByIdAndUpdate(patientId, {
      patient_type: 'ipd',
      $addToSet: {  // Use $addToSet instead of $push to prevent duplicates
        active_admissions: {
          admission_id: admission._id,
          ship_number: admission.shipNumber,
          registration_number: admission.admissionNumber,
          ward_name: wardId,
          bed_number: bedId,
          doctor_name: primaryDoctorId,
          department_name: departmentId,
          status: 'active'
        }
      },
      last_pharmacy_visit: new Date()
    });

    // Array to store created invoices
    const createdInvoices = [];
    const createdCharges = []; // Only for actual charges (fees, bed charges)

    // 1. Create registration fee invoice if provided by frontend
    if (registrationFee > 0) {
      const regInvoice = await generateRegistrationFeeInvoice(
        admission,
        patient,
        parseFloat(registrationFee),
        registrationFeeMethod,
        req.user?._id
      );
      if (regInvoice) {
        createdInvoices.push(regInvoice.invoice);

        // Registration Fee IS a charge
        const regCharge = await createIPDCharge({
          admissionId: admission._id,
          patientId,
          chargeType: 'Miscellaneous',
          description: `Registration Fee - ${admission.admissionNumber}`,
          quantity: 1,
          rate: parseFloat(registrationFee),
          sourceModule: 'Admission',
          sourceId: admission._id,
          isAutoGenerated: true,
          isBilled: true,
          invoiceId: regInvoice.invoice._id,
          addedBy: req.user?._id,
          notes: 'Registration fee collected at admission'
        });
        createdCharges.push(regCharge);
      }
    }

    // 2. Create admission fee invoice if provided by frontend
    if (admissionFee > 0) {
      const admInvoice = await generateAdmissionFeeInvoice(
        admission,
        patient,
        parseFloat(admissionFee),
        admissionFeeMethod,
        req.user?._id
      );
      if (admInvoice) {
        createdInvoices.push(admInvoice.invoice);

        // Admission Fee IS a charge
        const admCharge = await createIPDCharge({
          admissionId: admission._id,
          patientId,
          chargeType: 'Miscellaneous',
          description: `Admission Fee - ${admission.admissionNumber}`,
          quantity: 1,
          rate: parseFloat(admissionFee),
          sourceModule: 'Admission',
          sourceId: admission._id,
          isAutoGenerated: true,
          isBilled: true,
          invoiceId: admInvoice.invoice._id,
          addedBy: req.user?._id,
          notes: 'Admission fee collected at admission'
        });
        createdCharges.push(admCharge);
      }
    }

    // 3. Create advance payment - Store in Ledger, NOT as IPD Charge
    if (advanceAmount > 0) {
      // const advanceInvoice = await generateAdvanceCreditInvoice(
      //   admission,
      //   patient,
      //   parseFloat(advanceAmount),
      //   advancePaymentMethod,
      //   req.user?._id
      // );
      // if (advanceInvoice) {
      //   createdInvoices.push(advanceInvoice.invoice);

      // IMPORTANT: DO NOT create IPDCharge for advance payment
      // Advance is a credit/prepayment, not a charge/debt

      // Instead, create advance ledger entry
      const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
      await PatientAdvanceLedger.create({
        hospitalId: req.user?.hospital_id,
        patientId: patient._id,
        admissionId: admission._id,
        walletType: 'IPD_SHARED',  // or 'IPD_SHARED' based on configuration
        transactionType: 'ADVANCE_DEPOSIT',
        direction: 'CREDIT',
        amount: parseFloat(advanceAmount),
        paymentMethod: advancePaymentMethod,
        sourceModule: 'IPD',
        sourceId: admission._id,
        balanceAfter: parseFloat(advanceAmount),
        notes: `Advance payment at admission - ${admission.admissionNumber}`,
        createdBy: req.user?._id
      });
    }
    console.log('Total initial payment recorded for admission:', totalInitialPayment);
    console.log('Created invoices for admission:', createdInvoices.map(inv => inv._id));
    // 4. Create bed charge for first day (if bed is selected) - This IS a charge
    if (dailyBedCharge > 0 && bedId) {
      const bedCharge = await createIPDCharge({
        admissionId: admission._id,
        patientId,
        chargeType: 'Bed',
        description: `Bed Charges - ${bed.bedNumber} (${bed.bedType}) for ${new Date().toLocaleDateString()}`,
        quantity: 1,
        rate: dailyBedCharge,
        sourceModule: 'Bed',
        sourceId: bed._id,
        isAutoGenerated: true,
        isBilled: false,
        addedBy: req.user?._id,
        notes: 'First day bed charge',
        chargeDate: new Date()
      });
      createdCharges.push(bedCharge);
    }

    console.log('Created charges for admission:', createdCharges.map(ch => ch._id));

    // Update admission totals - ONLY from actual charges (not advance)
    const totalCharges = createdCharges.reduce((sum, c) => sum + c.netAmount, 0);
    admission.totalBillAmount = totalCharges;
    admission.dueAmount = totalCharges - (admission.paidAmount || 0);
    await admission.save();

    // Fetch the complete admission with populated fields for response
    const populatedAdmission = await IPDAdmission.findById(admission._id)
      .populate('patientId', 'first_name last_name patientId uhid phone')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('departmentId', 'name')
      .populate('bedId', 'bedNumber bedType dailyCharge')
      .populate('wardId', 'name')
      .populate('roomId', 'room_number type');

    // Prepare response with populated data
    const responseData = {
      success: true,
      message: 'Patient admitted successfully',
      admission: {
        _id: populatedAdmission._id,
        admissionNumber: populatedAdmission.admissionNumber,
        shipNumber: populatedAdmission.shipNumber,
        patientId: populatedAdmission.patientId,
        status: populatedAdmission.status,
        advanceAmount: populatedAdmission.advanceAmount,
        paidAmount: populatedAdmission.paidAmount,
        dueAmount: populatedAdmission.dueAmount,
        admissionDate: populatedAdmission.admissionDate,
        admissionFee: admissionFee,
        registrationFee: registrationFee,
        totalCharges: totalCharges,
        // Add populated fields for receipt
        patient: populatedAdmission.patientId ? {
          _id: populatedAdmission.patientId._id,
          first_name: populatedAdmission.patientId.first_name,
          last_name: populatedAdmission.patientId.last_name,
          patientId: populatedAdmission.patientId.patientId,
          uhid: populatedAdmission.patientId.uhid,
          phone: populatedAdmission.patientId.phone
        } : null,
        doctor: populatedAdmission.primaryDoctorId ? {
          _id: populatedAdmission.primaryDoctorId._id,
          firstName: populatedAdmission.primaryDoctorId.firstName,
          lastName: populatedAdmission.primaryDoctorId.lastName,
          specialization: populatedAdmission.primaryDoctorId.specialization
        } : null,
        department: populatedAdmission.departmentId ? {
          _id: populatedAdmission.departmentId._id,
          name: populatedAdmission.departmentId.name
        } : null,
        bed: populatedAdmission.bedId ? {
          _id: populatedAdmission.bedId._id,
          bedNumber: populatedAdmission.bedId.bedNumber,
          bedType: populatedAdmission.bedId.bedType,
          dailyCharge: populatedAdmission.bedId.dailyCharge
        } : null,
        ward: populatedAdmission.wardId ? {
          _id: populatedAdmission.wardId._id,
          name: populatedAdmission.wardId.name
        } : null
      }
    };

    // Add invoice details if created
    if (createdInvoices.length > 0) {
      responseData.invoices = createdInvoices.map(inv => ({
        _id: inv._id,
        invoice_number: inv.invoice_number,
        invoice_type: inv.invoice_type,
        total: inv.total,
        status: inv.status,
        download_url: `/api/invoices/${inv._id}/download`
      }));
    }

    res.status(201).json(responseData);

  } catch (err) {
    console.error('Error creating admission:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get admission by ID (enhanced with invoice data)
exports.getAdmissionById = async (req, res) => {
  try {
    const { id } = req.params;

    const admission = await IPDAdmission.findById(id)
      .populate('patientId', 'first_name last_name patientId uhid phone dob gender blood_group pharmacy_outstanding_balance pharmacy_advance_balance sponsor_type sponsor_name')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('secondaryDoctorIds', 'firstName lastName specialization')
      .populate('departmentId', 'name')
      .populate('bedId', 'bedNumber bedType dailyCharge')
      .populate('roomId', 'room_number type')
      .populate('wardId', 'name floor type');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    // Get related data
    const rounds = await IPDRound.find({ admissionId: admission._id })
      .populate('doctorId', 'firstName lastName')
      .populate('prescriptionId')
      .sort({ roundDateTime: -1 })
      .limit(10);

    const nursingNotes = await NursingNote.find({ admissionId: admission._id })
      .populate('nurseId', 'first_name last_name')
      .sort({ noteDateTime: -1 })
      .limit(5);

    const vitals = await IPDVitals.find({ admissionId: admission._id })
      .populate('recordedBy', 'first_name last_name')
      .sort({ recordedAt: -1 })
      .limit(10);

    const charges = await IPDCharge.find({ admissionId: admission._id })
      .sort({ chargeDate: -1 });

    const dischargeSummary = await DischargeSummary.findOne({ admissionId: admission._id });

    // Get invoices for this admission
    const invoices = await Invoice.find({ admission_id: admission._id })
      .sort({ issue_date: -1 });

    // Get bills for this admission
    const bills = await Bill.find({ admission_id: admission._id })
      .sort({ generated_at: -1 });

    res.json({
      admission,
      rounds,
      nursingNotes,
      vitals,
      charges,
      dischargeSummary,
      invoices,
      bills
    });
  } catch (err) {
    console.error('Error fetching admission:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get admission invoice by ID (for printing receipt)
exports.getAdmissionInvoice = async (req, res) => {
  try {
    const { admissionId, invoiceId } = req.params;

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      admission_id: admissionId
    }).populate('patient_id', 'first_name last_name patientId phone address')
      .populate('admission_id', 'admissionNumber admissionDate bedId wardId');

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Get hospital info for receipt
    const Hospital = require('../models/Hospital');
    const hospital = await Hospital.findOne();

    res.json({
      success: true,
      invoice,
      hospital: {
        name: hospital?.hospitalName || 'City Hospital',
        address: hospital?.address || '',
        phone: hospital?.contact || '',
        email: hospital?.email || '',
        logo: hospital?.logo || ''
      }
    });
  } catch (err) {
    console.error('Error fetching admission invoice:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get all admissions with filters
exports.getAllAdmissions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      patientId,
      doctorId,
      startDate,
      endDate,
      search,
      clinicalAssessmentCompleted,
      pharmacyClearanceStatus
    } = req.query;

    const filter = {};

    if (status) {
      const statusArray = status.split(',').map(s => s.trim());
      filter.status = statusArray.length === 1 ? statusArray[0] : { $in: statusArray };
    }

    if (clinicalAssessmentCompleted !== undefined) {
      filter.clinicalAssessmentCompleted = clinicalAssessmentCompleted === 'true';
    }

    if (pharmacyClearanceStatus) {
      filter.pharmacyClearanceStatus = pharmacyClearanceStatus;
    }

    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.primaryDoctorId = doctorId;

    if (startDate || endDate) {
      filter.admissionDate = {};
      if (startDate) filter.admissionDate.$gte = new Date(startDate);
      if (endDate) filter.admissionDate.$lte = new Date(endDate);
    }

    if (search) {
      const patients = await Patient.find({
        $or: [
          { first_name: { $regex: search, $options: 'i' } },
          { last_name: { $regex: search, $options: 'i' } },
          { patientId: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } },
          { uhid: { $regex: search, $options: 'i' } }
        ]
      }).select('_id');

      filter.patientId = { $in: patients.map(p => p._id) };
    }

    const admissions = await IPDAdmission.find(filter)
      .populate('patientId', 'first_name last_name patientId uhid phone dob gender pharmacy_outstanding_balance pharmacy_advance_balance')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('departmentId', 'name')
      .populate('bedId', 'bedNumber bedType dailyCharge')
      .populate('wardId', 'name')
      .sort({ admissionDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await IPDAdmission.countDocuments(filter);

    // Get additional statistics for each admission
    const admissionsWithStats = await Promise.all(admissions.map(async (admission) => {
      const rounds = await IPDRound.countDocuments({ admissionId: admission._id });
      const vitals = await IPDVitals.countDocuments({ admissionId: admission._id });
      const charges = await IPDCharge.aggregate([
        { $match: { admissionId: admission._id } },
        { $group: { _id: null, total: { $sum: '$netAmount' } } }
      ]);

      // Get invoices count
      const invoices = await Invoice.countDocuments({ admission_id: admission._id });
      const bills = await Bill.countDocuments({ admission_id: admission._id });

      return {
        ...admission.toObject(),
        stats: {
          rounds,
          vitals,
          totalCharges: charges[0]?.total || 0,
          invoices,
          bills
        }
      };
    }));

    res.json({
      admissions: admissionsWithStats,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching admissions:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update admission
exports.updateAdmission = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const admission = await IPDAdmission.findByIdAndUpdate(
      id,
      { ...updates, updatedBy: req.user?._id },
      { new: true, runValidators: true }
    );

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    res.json({
      success: true,
      message: 'Admission updated successfully',
      admission
    });
  } catch (err) {
    console.error('Error updating admission:', err);
    res.status(500).json({ error: err.message });
  }
};

// Complete clinical assessment
exports.completeClinicalAssessment = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      provisionalDiagnosis,
      chiefComplaints,
      historyOfPresentIllness,
      pastMedicalHistory,
      recordedBy,
      temperature,
      temperatureUnit,
      pulse,
      bloodPressure,
      respiratoryRate,
      spo2,
      bloodSugar,
      weight,
      height,
      painScore,
      remarks
    } = req.body;

    const admission = await IPDAdmission.findById(id);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (admission.clinicalAssessmentCompleted) {
      return res.status(400).json({ error: 'Clinical assessment already completed for this admission' });
    }

    // Update admission with clinical details
    admission.provisionalDiagnosis = provisionalDiagnosis || admission.provisionalDiagnosis;
    admission.chiefComplaints = chiefComplaints || admission.chiefComplaints;
    admission.historyOfPresentIllness = historyOfPresentIllness || admission.historyOfPresentIllness;
    admission.pastMedicalHistory = pastMedicalHistory || admission.pastMedicalHistory;

    admission.clinicalAssessmentCompleted = true;
    admission.clinicalAssessmentCompletedAt = new Date();
    admission.clinicalAssessmentCompletedBy = recordedBy || req.user?._id;

    await admission.save();

    // Create initial vitals record if any vitals data provided
    if (temperature || pulse || bloodPressure?.systolic || respiratoryRate || spo2) {
      const initialVitals = new IPDVitals({
        admissionId: admission._id,
        patientId: admission.patientId,
        recordedBy: recordedBy || req.user?._id,
        recordedAt: new Date(),
        temperature: temperature || null,
        temperatureUnit: temperatureUnit || 'Celsius',
        pulse: pulse || null,
        bloodPressure: bloodPressure || { systolic: null, diastolic: null },
        respiratoryRate: respiratoryRate || null,
        spo2: spo2 || null,
        bloodSugar: bloodSugar || null,
        weight: weight || null,
        height: height || null,
        painScore: painScore || null,
        remarks: remarks || 'Initial assessment vitals'
      });
      await initialVitals.save();
    }

    // Create initial nursing note
    const initialNote = new NursingNote({
      admissionId: admission._id,
      patientId: admission.patientId,
      nurseId: recordedBy || req.user?._id,
      noteType: 'Assessment',
      note: `Initial clinical assessment completed. ${chiefComplaints ? `Chief complaints: ${chiefComplaints}` : ''}`,
      priority: 'Normal',
      createdBy: recordedBy || req.user?._id
    });
    await initialNote.save();

    res.json({
      success: true,
      message: 'Clinical assessment completed successfully',
      admission
    });
  } catch (err) {
    console.error('Error completing clinical assessment:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get nurse dashboard data
exports.getNurseDashboardData = async (req, res) => {
  try {
    const nurseId = req.user?._id;

    const pendingAssessments = await IPDAdmission.find({
      clinicalAssessmentCompleted: false,
      status: { $in: ['Admitted', 'Under Treatment'] }
    })
      .populate('patientId', 'first_name last_name patientId uhid phone dob gender')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('bedId', 'bedNumber bedType')
      .populate('wardId', 'name')
      .sort({ admissionDate: -1 });

    const assignedPatients = await IPDAdmission.find({
      clinicalAssessmentCompleted: true,
      status: { $in: ['Admitted', 'Under Treatment'] }
    })
      .populate('patientId', 'first_name last_name patientId uhid phone dob gender pharmacy_outstanding_balance pharmacy_advance_balance')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('bedId', 'bedNumber bedType')
      .populate('wardId', 'name')
      .sort({ admissionDate: -1 });

    res.json({
      success: true,
      pendingAssessments,
      assignedPatients,
      counts: {
        pending: pendingAssessments.length,
        assigned: assignedPatients.length
      }
    });
  } catch (err) {
    console.error('Error fetching nurse dashboard data:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update admission status
exports.updateAdmissionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    const admission = await IPDAdmission.findById(id);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const validTransitions = {
      'Admitted': ['Under Treatment', 'Discharge Initiated'],
      'Under Treatment': ['Discharge Initiated', 'Discharge Summary Pending'],
      'Discharge Initiated': ['Discharge Summary Pending', 'Admitted'],
      'Discharge Summary Pending': ['Billing Pending', 'Under Treatment'],
      'Billing Pending': ['Payment Pending', 'Discharge Summary Pending'],
      'Payment Pending': ['Ready for Discharge', 'Billing Pending'],
      'Ready for Discharge': ['Discharged', 'Payment Pending'],
      'Discharged': []
    };

    if (validTransitions[admission.status] && !validTransitions[admission.status].includes(status)) {
      return res.status(400).json({ error: `Invalid status transition from ${admission.status} to ${status}` });
    }

    if (status === 'Discharged' && !admission.dischargeDate) {
      admission.dischargeDate = new Date();
    }

    if (reason && (status === 'LAMA' || status === 'DAMA' || status === 'Expired')) {
      admission.dischargeReason = reason;
      if (status === 'LAMA' || status === 'DAMA') {
        admission.isLAMA = true;
      }
    }

    admission.status = status;
    admission.updatedBy = req.user?._id;
    await admission.save();

    if (status === 'Discharged' && admission.bedId) {
      await Bed.findByIdAndUpdate(admission.bedId, {
        status: 'Cleaning',
        currentAdmissionId: null
      });
    }

    res.json({
      success: true,
      message: `Admission status updated to ${status}`,
      admission
    });
  } catch (err) {
    console.error('Error updating admission status:', err);
    res.status(500).json({ error: err.message });
  }
};

// Delete admission (cancellation)
exports.deleteAdmission = async (req, res) => {
  try {
    const { id } = req.params;

    const admission = await IPDAdmission.findById(id);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (admission.status !== 'Admitted' && admission.status !== 'Under Treatment') {
      return res.status(400).json({ error: 'Cannot cancel admission after treatment has progressed' });
    }

    admission.status = 'Cancelled';
    admission.updatedBy = req.user?._id;
    await admission.save();

    if (admission.bedId) {
      await Bed.findByIdAndUpdate(admission.bedId, {
        status: 'Available',
        currentAdmissionId: null
      });
    }

    // Remove from patient's active admissions
    await Patient.findByIdAndUpdate(admission.patientId, {
      $pull: { active_admissions: { admission_id: admission._id } },
      $set: { patient_type: 'opd' }
    });

    res.json({
      success: true,
      message: 'Admission cancelled successfully'
    });
  } catch (err) {
    console.error('Error deleting admission:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get dashboard statistics
exports.getDashboardStats = async (req, res) => {
  try {
    const totalAdmitted = await IPDAdmission.countDocuments({
      status: { $in: ['Admitted', 'Under Treatment'] }
    });

    const pendingClinicalAssessment = await IPDAdmission.countDocuments({
      clinicalAssessmentCompleted: false,
      status: { $in: ['Admitted', 'Under Treatment'] }
    });

    const dischargeInitiated = await IPDAdmission.countDocuments({
      status: { $in: ['Discharge Initiated', 'Discharge Summary Pending', 'Billing Pending', 'Payment Pending', 'Ready for Discharge'] }
    });

    const dischargedToday = await IPDAdmission.countDocuments({
      status: 'Discharged',
      dischargeDate: { $gte: new Date().setHours(0, 0, 0, 0) }
    });

    const occupiedBeds = await Bed.countDocuments({ status: 'Occupied' });
    const availableBeds = await Bed.countDocuments({ status: 'Available' });

    const criticalPatients = await IPDAdmission.countDocuments({
      status: { $in: ['Admitted', 'Under Treatment'] },
      $or: [
        { wardId: { $in: await Ward.find({ type: 'ICU' }).distinct('_id') } },
        { roomId: { $in: await Room.find({ type: 'ICU' }).distinct('_id') } }
      ]
    });

    const pendingLabReports = await LabReport.countDocuments({ status: 'Pending' });

    const pendingPayments = await IPDAdmission.aggregate([
      { $match: { status: { $in: ['Under Treatment', 'Discharge Initiated'] } } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$totalBillAmount', '$paidAmount'] } } } }
    ]);

    const pendingPharmacyClearance = await IPDAdmission.countDocuments({
      status: { $in: ['Admitted', 'Under Treatment', 'Discharge Initiated', 'Discharge Summary Pending'] },
      pharmacyClearanceStatus: 'pending'
    });

    const recentAdmissions = await IPDAdmission.find()
      .populate('patientId', 'first_name last_name patientId uhid')
      .populate('primaryDoctorId', 'firstName lastName')
      .sort({ admissionDate: -1 })
      .limit(10);

    res.json({
      success: true,
      stats: {
        totalAdmitted,
        pendingClinicalAssessment,
        dischargeInitiated,
        dischargedToday,
        occupiedBeds,
        availableBeds,
        criticalPatients,
        pendingLabReports,
        pendingPayments: pendingPayments[0]?.total || 0,
        pendingPharmacyClearance
      },
      recentAdmissions
    });
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== PHARMACY CLEARANCE METHODS ==========

// Get admission by SHIP number (for pharmacy lookup)
exports.getAdmissionByShipNumber = async (req, res) => {
  try {
    const { shipNumber } = req.params;

    const admission = await IPDAdmission.findOne({ shipNumber })
      .populate('patientId', 'first_name last_name patientId uhid phone pharmacy_outstanding_balance pharmacy_advance_balance sponsor_type sponsor_name')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('wardId', 'name');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found with this SHIP number' });
    }

    res.json({
      success: true,
      admission: {
        _id: admission._id,
        shipNumber: admission.shipNumber,
        admissionNumber: admission.admissionNumber,
        patient: admission.patientId,
        doctor: admission.primaryDoctorId,
        ward: admission.wardId?.name,
        status: admission.status,
        pharmacyClearanceStatus: admission.pharmacyClearanceStatus,
        pharmacyFinalBalance: admission.pharmacyFinalBalance
      }
    });
  } catch (err) {
    console.error('Error fetching admission by SHIP number:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update pharmacy clearance status
exports.updatePharmacyClearance = async (req, res) => {
  try {
    const { id } = req.params;
    const { clearanceStatus, finalBalance, notes } = req.body;

    const admission = await IPDAdmission.findById(id);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const validStatuses = ['pending', 'in_progress', 'cleared', 'exempted'];
    if (!validStatuses.includes(clearanceStatus)) {
      return res.status(400).json({ error: 'Invalid clearance status' });
    }

    admission.pharmacyClearanceStatus = clearanceStatus;
    if (finalBalance !== undefined) {
      admission.pharmacyFinalBalance = finalBalance;
    }

    if (clearanceStatus === 'cleared') {
      admission.pharmacyClearanceDate = new Date();
      admission.pharmacyClearanceBy = req.user?._id;
    }

    await admission.save();

    // Update patient's pharmacy outstanding if final balance is provided
    if (finalBalance !== undefined && admission.patientId) {
      await Patient.findByIdAndUpdate(admission.patientId, {
        pharmacy_outstanding_balance: finalBalance
      });
    }

    res.json({
      success: true,
      message: `Pharmacy clearance status updated to ${clearanceStatus}`,
      admission: {
        _id: admission._id,
        pharmacyClearanceStatus: admission.pharmacyClearanceStatus,
        pharmacyFinalBalance: admission.pharmacyFinalBalance,
        pharmacyClearanceDate: admission.pharmacyClearanceDate
      }
    });
  } catch (err) {
    console.error('Error updating pharmacy clearance:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get admissions pending pharmacy clearance
exports.getPendingPharmacyClearance = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const admissions = await IPDAdmission.find({
      status: { $in: ['Discharge Initiated', 'Discharge Summary Pending', 'Billing Pending', 'Payment Pending', 'Ready for Discharge'] },
      pharmacyClearanceStatus: { $in: ['pending', 'in_progress'] }
    })
      .populate('patientId', 'first_name last_name patientId uhid phone pharmacy_outstanding_balance pharmacy_advance_balance')
      .populate('primaryDoctorId', 'firstName lastName')
      .populate('wardId', 'name')
      .sort({ admissionDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await IPDAdmission.countDocuments({
      status: { $in: ['Discharge Initiated', 'Discharge Summary Pending', 'Billing Pending', 'Payment Pending', 'Ready for Discharge'] },
      pharmacyClearanceStatus: { $in: ['pending', 'in_progress'] }
    });

    res.json({
      success: true,
      admissions,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching pending pharmacy clearance:', err);
    res.status(500).json({ error: err.message });
  }
};