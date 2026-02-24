const Hospital = require('../models/Hospital.js');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Fetches details for all hospitals
const getHospitalDetails = async (req, res) => {
  try {
    const hospitals = await Hospital.find({});
    if (!hospitals.length) {
      return res.status(404).json({ message: 'No hospital details found.' });
    }
    res.status(200).json(hospitals);
  } catch (error) {
    console.error("Error fetching hospital details:", error);
    res.status(500).json({ message: 'Server error while fetching hospital details.' });
  }
};

// Get single hospital by ID
const getHospitalById = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const hospital = await Hospital.findById(hospitalId);
    
    if (!hospital) {
      return res.status(404).json({ message: 'Hospital not found' });
    }
    
    res.status(200).json(hospital);
  } catch (error) {
    console.error("Error fetching hospital by ID:", error);
    res.status(500).json({ message: 'Server error while fetching hospital details.' });
  }
};

// Update hospital details
const updateHospitalDetails = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const updateData = req.body; // Accept any fields from the request body

    // Validate vitalsController if it's being updated
    if (updateData.vitalsController) {
      const validControllers = ['doctor', 'nurse', 'registrar'];
      if (!validControllers.includes(updateData.vitalsController)) {
        return res.status(400).json({ 
          message: 'Invalid vitals controller. Must be one of: doctor, nurse, registrar' 
        });
      }
    }

    // Handle logo upload if file exists
    if (req.file) {
      try {
        const result = await cloudinary.uploader.upload(req.file.path, {
          folder: 'hospital_logos',
          resource_type: 'image'
        });
        updateData.logo = result.secure_url;
        fs.unlinkSync(req.file.path); // Clean up local file
      } catch (uploadErr) {
        console.error('Logo Upload Error:', uploadErr);
        // Continue with update even if logo upload fails
      }
    }

    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      return res.status(404).json({ message: 'Hospital not found' });
    }

    // Dynamically update only the fields sent in req.body
    Object.keys(updateData).forEach((key) => {
      // Only update if the value is not undefined
      if (updateData[key] !== undefined) {
        hospital[key] = updateData[key];
      }
    });

    // Update the updatedAt timestamp
    hospital.updatedAt = Date.now();

    await hospital.save();

    res.status(200).json({
      message: 'Hospital details updated successfully.',
      hospital: {
        _id: hospital._id,
        hospitalName: hospital.hospitalName,
        email: hospital.email,
        vitalsEnabled: hospital.vitalsEnabled,
        vitalsController: hospital.vitalsController,
        // Include other fields as needed
      }
    });
  } catch (error) {
    console.error('Error updating hospital details:', error);
    res.status(500).json({ message: 'Server error while updating details.' });
  }
};

// Get vitals configuration for a hospital
const getVitalsConfig = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const hospital = await Hospital.findById(hospitalId).select('vitalsEnabled vitalsController');
    
    if (!hospital) {
      return res.status(404).json({ message: 'Hospital not found' });
    }
    
    res.status(200).json({
      vitalsEnabled: hospital.vitalsEnabled,
      vitalsController: hospital.vitalsController
    });
  } catch (error) {
    console.error("Error fetching vitals config:", error);
    res.status(500).json({ message: 'Server error while fetching vitals configuration.' });
  }
};

// Update vitals configuration only
const updateVitalsConfig = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const { vitalsEnabled, vitalsController } = req.body;

    // Validate vitalsController if provided
    if (vitalsController) {
      const validControllers = ['doctor', 'nurse', 'registrar'];
      if (!validControllers.includes(vitalsController)) {
        return res.status(400).json({ 
          message: 'Invalid vitals controller. Must be one of: doctor, nurse, registrar' 
        });
      }
    }

    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      return res.status(404).json({ message: 'Hospital not found' });
    }

    // Update only vitals-related fields
    if (vitalsEnabled !== undefined) {
      hospital.vitalsEnabled = vitalsEnabled;
    }
    
    if (vitalsController !== undefined) {
      hospital.vitalsController = vitalsController;
    }

    hospital.updatedAt = Date.now();
    await hospital.save();

    res.status(200).json({
      message: 'Vitals configuration updated successfully.',
      vitalsConfig: {
        vitalsEnabled: hospital.vitalsEnabled,
        vitalsController: hospital.vitalsController
      }
    });
  } catch (error) {
    console.error('Error updating vitals config:', error);
    res.status(500).json({ message: 'Server error while updating vitals configuration.' });
  }
};

// Export all functions
module.exports = {
  getHospitalDetails,
  getHospitalById,
  updateHospitalDetails,
  getVitalsConfig,
  updateVitalsConfig
};