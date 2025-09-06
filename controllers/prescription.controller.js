const Prescription = require('../models/Prescription');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
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

const upload = multer({ storage });

// The upload endpoint with Multer middleware
exports.uploadPrescriptionImage = [upload.single('image'), async (req, res) => {
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
}];

// Create prescription
exports.createPrescription = async (req, res) => {
  try {
    const { 
      patient_id, 
      doctor_id, 
      appointment_id, 
      diagnosis, 
      symptoms, 
      notes, 
      items, 
      prescription_image,
      validity_days,
      follow_up_date,
      is_repeatable,
      repeat_count 
    } = req.body;

    // Filter out empty items
    // const validItems = items && Array.isArray(items) 
    //   ? items.filter(item => 
    //       item.medicine_name && item.medicine_name.trim() !== '' &&
    //       item.dosage && item.dosage.trim() !== '' &&
    //       item.duration && item.duration.trim() !== '' &&
    //       item.frequency && item.frequency.trim() !== '' &&
    //       item.quantity && item.quantity > 0
    //     )
    //   : [];

    // Create prescription
    const prescription = new Prescription({ 
      patient_id, 
      doctor_id, 
      appointment_id,
      diagnosis, 
      symptoms,
      notes,
      items,
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
      prescription: populatedPrescription,
      message: 'Prescription created successfully' 
    });
  } catch (err) {
    console.error('Error creating prescription:', err);
    res.status(400).json({ error: err.message });
  }
};

// Get all prescriptions
exports.getAllPrescriptions = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      patient_id, 
      doctor_id, 
      status, 
      startDate, 
      endDate 
    } = req.query;

    const filter = {};
    if (patient_id) filter.patient_id = patient_id;
    if (doctor_id) filter.doctor_id = doctor_id;
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

// Get a prescription by ID
exports.getPrescriptionById = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patient_id', 'first_name last_name patientId phone dob gender')
      .populate('doctor_id', 'firstName lastName specialization licenseNumber')
      .populate('appointment_id', 'appointment_date type priority')
      .populate('created_by', 'name');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    res.json(prescription);
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
      items, 
      status,
      validity_days,
      follow_up_date,
      is_repeatable,
      repeat_count 
    } = req.body;

    // Filter out empty items if provided
    let validItems;
    if (items && Array.isArray(items)) {
      validItems = items.filter(item => 
        item.medicine_name && item.medicine_name.trim() !== '' &&
        item.dosage && item.dosage.trim() !== '' &&
        item.duration && item.duration.trim() !== '' &&
        item.frequency && item.frequency.trim() !== '' &&
        item.quantity && item.quantity > 0
      );
    }

    const updateData = {
      diagnosis,
      symptoms,
      notes,
      status,
      validity_days,
      follow_up_date: follow_up_date ? new Date(follow_up_date) : null,
      is_repeatable,
      repeat_count
    };

    // Only update items if provided
    if (validItems) {
      updateData.items = validItems;
    }

    const prescription = await Prescription.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
    .populate('patient_id', 'first_name last_name patientId')
    .populate('doctor_id', 'firstName lastName specialization')
    .populate('appointment_id', 'appointment_date type');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    res.json({ 
      prescription,
      message: 'Prescription updated successfully' 
    });
  } catch (err) {
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

    // Update item dispense status
    prescription.items[itemIndex].is_dispensed = true;
    prescription.items[itemIndex].dispensed_quantity = quantityToDispense;
    prescription.items[itemIndex].dispensed_date = new Date();

    // Check if all items are dispensed to update prescription status
    const allDispensed = prescription.items.every(item => item.is_dispensed);
    if (allDispensed) {
      prescription.status = 'Completed';
    }

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
      issue_date: { 
        $gte: new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)) // Last 30 days
      }
    })
    .populate('patient_id', 'first_name last_name patientId')
    .populate('doctor_id', 'firstName lastName specialization')
    .sort({ issue_date: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

    const total = await Prescription.countDocuments({
      status: 'Active',
      issue_date: { 
        $gte: new Date(Date.now() - (30 * 24 * 60 * 60 * 1000))
      }
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
      issue_date: { 
        $lte: new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)) // Older than 30 days
      }
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