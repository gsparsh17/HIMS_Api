// const Prescription = require('../models/Prescription');
// const PrescriptionItem = require('../models/PrescriptionItem');
// const multer = require('multer');
// const path = require('path');
// const cloudinary = require('cloudinary').v2;

// // Configure Cloudinary as you already have
// cloudinary.config({
//   cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
//   api_key: process.env.CLOUDINARY_API_KEY,
//   api_secret: process.env.CLOUDINARY_API_SECRET
// });

// // Configure Multer for disk storage
// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, 'uploads/');
//   },
//   filename: (req, file, cb) => {
//     cb(null, Date.now() + path.extname(file.originalname)); 
//   }
// });

// // The upload endpoint with Multer middleware
// exports.uploadPrescriptionImage = async (req, res) => {
//   try {
//     if (!req.file) {
//       return res.status(400).json({ error: 'No image file provided' });
//     }
//     const result = await cloudinary.uploader.upload(req.file.path, {
//         folder: 'prescriptions',
//         resource_type: 'image'
//     });
//     const fs = require('fs');
//     fs.unlinkSync(req.file.path);

//     res.json({ imageUrl: result.secure_url });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

// exports.createPrescription = async (req, res) => {
//   try {
//     const { patient_id, doctor_id, diagnosis, notes, items, prescription_image } = req.body;

//     // Create prescription with optional image
//     const prescription = new Prescription({ 
//       patient_id, 
//       doctor_id, 
//       diagnosis, 
//       notes,
//       prescription_image: prescription_image || null
//     });
    
//     await prescription.save();

//     let prescriptionItems = [];

//     // Only create prescription items if they exist and contain valid data
//     if (items && Array.isArray(items) && items.length > 0) {
//       // Filter out empty items (where all fields are empty)
//       const validItems = items.filter(item => 
//         item.medicine_name && item.medicine_name.trim() !== '' &&
//         item.dosage && item.dosage.trim() !== '' &&
//         item.duration && item.duration.trim() !== ''
//       );

//       if (validItems.length > 0) {
//         prescriptionItems = await Promise.all(
//           validItems.map(async (item) => {
//             return await PrescriptionItem.create({ 
//               ...item, 
//               prescription_id: prescription._id 
//             });
//           })
//         );
//       }
//     }

//     res.status(201).json({ 
//       prescription, 
//       items: prescriptionItems,
//       message: 'Prescription created successfully' 
//     });
//   } catch (err) {
//     console.error('Error creating prescription:', err);
//     res.status(400).json({ error: err.message });
//   }
// };

// // Get all prescriptions
// exports.getAllPrescriptions = async (req, res) => {
//   try {
//     const prescriptions = await Prescription.find()
//       .populate('patient_id')
//       // .populate('doctor_id');
//       .populate({
//         path: 'doctor_id',
//         model: 'Doctor' // Explicitly tell Mongoose which model to use
//       });
//       console.log('Sending Prescriptions:', JSON.stringify(prescriptions, null, 2));
//     res.json(prescriptions);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

// // Get a prescription by ID
// exports.getPrescriptionById = async (req, res) => {
//   try {
//     const prescription = await Prescription.findById(req.params.id)
//       .populate('patient_id')
//       // .populate('doctor_id');
//       .populate({
//         path: 'doctor_id',
//         model: 'Doctor' // Also update here for consistency
//       });
//     if (!prescription) return res.status(404).json({ error: 'Not found' });

//     const items = await PrescriptionItem.find({ prescription_id: prescription._id });
//     res.json({ prescription, items });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

// // Update prescription
// exports.updatePrescription = async (req, res) => {
//   try {
//     const { diagnosis, notes, items } = req.body;

//     const prescription = await Prescription.findByIdAndUpdate(
//       req.params.id,
//       { diagnosis, notes },
//       { new: true }
//     );

//     if (!prescription) return res.status(404).json({ error: 'Prescription not found' });

//     // Optionally update items (simplified: remove old and add new)
//     await PrescriptionItem.deleteMany({ prescription_id: prescription._id });

//     const newItems = await Promise.all(
//       items.map((item) => {
//         return PrescriptionItem.create({ ...item, prescription_id: prescription._id });
//       })
//     );

//     res.json({ prescription, items: newItems });
//   } catch (err) {
//     res.status(400).json({ error: err.message });
//   }
// };

// // Delete prescription
// exports.deletePrescription = async (req, res) => {
//   try {
//     const prescription = await Prescription.findByIdAndDelete(req.params.id);
//     if (!prescription) return res.status(404).json({ error: 'Not found' });

//     await PrescriptionItem.deleteMany({ prescription_id: prescription._id });

//     res.json({ message: 'Prescription and items deleted successfully' });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };































const Prescription = require('../models/Prescription');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

// Configure Cloudinary
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

// // Get all prescriptions (with fix and logging)
// exports.getAllPrescriptions = async (req, res) => {
//   try {
//     let prescriptions = await Prescription.aggregate([
//       {
//         $lookup: {
//           from: 'prescriptionitems', // Collection name for PrescriptionItem model
//           localField: '_id',
//           foreignField: 'prescription_id',
//           as: 'medicines' 
//         }
//       },
//       {
//         // CORRECTED: Sort by 'created_at' to match your schema
//         $sort: { created_at: -1 }
//       }
//     ]);

//     prescriptions = await Prescription.populate(prescriptions, [
//         { path: 'patient_id' },
//         { path: 'doctor_id', model: 'Doctor' }
//     ]);
    
//     // --- DEBUGGING LOG ---
//     console.log('Final data being sent to frontend:', JSON.stringify(prescriptions, null, 2));

//     res.json(prescriptions);
//   } catch (err) {
//     // --- ADDED ERROR LOG ---
//     console.error("Error in getAllPrescriptions:", err);
//     res.status(500).json({ error: err.message });
//   }
// };





// In HIMS_Api/controllers/prescription.controller.js

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
    console.error("Error in getAllPrescriptions:", err);
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