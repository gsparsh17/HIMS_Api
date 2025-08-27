const Prescription = require('../models/Prescription');
const PrescriptionItem = require('../models/PrescriptionItem');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary as you already have
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

exports.createPrescription = async (req, res) => {
  try {
    const { patient_id, doctor_id, diagnosis, notes, items, prescription_image } = req.body;

    // Create prescription with optional image
    const prescription = new Prescription({ 
      patient_id, 
      doctor_id, 
      diagnosis, 
      notes,
      prescription_image: prescription_image || null
    });
    
    await prescription.save();

    let prescriptionItems = [];

    // Only create prescription items if they exist and contain valid data
    if (items && Array.isArray(items) && items.length > 0) {
      // Filter out empty items (where all fields are empty)
      const validItems = items.filter(item => 
        item.medicine_name && item.medicine_name.trim() !== '' &&
        item.dosage && item.dosage.trim() !== '' &&
        item.duration && item.duration.trim() !== ''
      );

      if (validItems.length > 0) {
        prescriptionItems = await Promise.all(
          validItems.map(async (item) => {
            return await PrescriptionItem.create({ 
              ...item, 
              prescription_id: prescription._id 
            });
          })
        );
      }
    }

    res.status(201).json({ 
      prescription, 
      items: prescriptionItems,
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
    const prescriptions = await Prescription.find()
      .populate('patient_id')
      // .populate('doctor_id');
      .populate({
        path: 'doctor_id',
        model: 'Doctor' // Explicitly tell Mongoose which model to use
      });
      console.log('Sending Prescriptions:', JSON.stringify(prescriptions, null, 2));
    res.json(prescriptions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get a prescription by ID
exports.getPrescriptionById = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patient_id')
      // .populate('doctor_id');
      .populate({
        path: 'doctor_id',
        model: 'Doctor' // Also update here for consistency
      });
    if (!prescription) return res.status(404).json({ error: 'Not found' });

    const items = await PrescriptionItem.find({ prescription_id: prescription._id });
    res.json({ prescription, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update prescription
exports.updatePrescription = async (req, res) => {
  try {
    const { diagnosis, notes, items } = req.body;

    const prescription = await Prescription.findByIdAndUpdate(
      req.params.id,
      { diagnosis, notes },
      { new: true }
    );

    if (!prescription) return res.status(404).json({ error: 'Prescription not found' });

    // Optionally update items (simplified: remove old and add new)
    await PrescriptionItem.deleteMany({ prescription_id: prescription._id });

    const newItems = await Promise.all(
      items.map((item) => {
        return PrescriptionItem.create({ ...item, prescription_id: prescription._id });
      })
    );

    res.json({ prescription, items: newItems });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete prescription
exports.deletePrescription = async (req, res) => {
  try {
    const prescription = await Prescription.findByIdAndDelete(req.params.id);
    if (!prescription) return res.status(404).json({ error: 'Not found' });

    await PrescriptionItem.deleteMany({ prescription_id: prescription._id });

    res.json({ message: 'Prescription and items deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
