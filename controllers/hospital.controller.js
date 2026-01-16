
// const Hospital = require('../models/Hospital.js');

// const getHospitalDetails = async (req, res) => {
//   try {
//     const hospital = await Hospital.find({});
//     if (!hospital.length) {
//       return res.status(404).json({ message: 'No hospital details found.' });
//     }
//     res.status(200).json(hospital);
//   } catch (error) {
//     console.error("Error fetching hospital details:", error);
//     res.status(500).json({ message: 'Server error while fetching hospital details.' });
//   }
// };

// module.exports = {
//   getHospitalDetails,
// };





// const Hospital = require('../models/Hospital.js');

// // Fetches details for all hospitals
// const getHospitalDetails = async (req, res) => {
//   try {
//     const hospitals = await Hospital.find({});
//     if (!hospitals.length) {
//       return res.status(404).json({ message: 'No hospital details found.' });
//     }
//     res.status(200).json(hospitals);
//   } catch (error) {
//     console.error("Error fetching hospital details:", error);
//     res.status(500).json({ message: 'Server error while fetching hospital details.' });
//   }
// };

// // Updates a specific hospital with additional details
// const updateHospitalDetails = async (req, res) => {
//   try {
//     // 1. Get the hospital ID from the URL
//     const { hospitalId } = req.params;

//     // 2. Get the new details from the request body
//     const { policyDetails, healthBima, additionalInfo } = req.body;

//     // 3. Find the hospital by its ID
//     const hospital = await Hospital.findById(hospitalId);

//     if (!hospital) {
//       return res.status(404).json({ message: 'Hospital not found' });
//     }

//     // 4. Update the hospital document
//     hospital.policyDetails = policyDetails || hospital.policyDetails;
//     hospital.healthBima = healthBima || hospital.healthBima;
//     hospital.additionalInfo = additionalInfo || hospital.additionalInfo;

//     // 5. Save the updated document
//     await hospital.save();

//     // 6. Send a success response
//     res.status(200).json({ message: 'Additional details saved successfully.' });

//   } catch (error) {
//     // Handle potential errors
//     console.error('Error updating hospital details:', error);
//     res.status(500).json({ message: 'Server error while updating details.' });
//   }
// };

// module.exports = {
//   getHospitalDetails,
//   updateHospitalDetails,
// };




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

// Updates a specific hospital with additional details
// const updateHospitalDetails = async (req, res) => {
//   try {
//     const { hospitalId } = req.params;
//     const { policyDetails, healthBima, additionalInfo, fireNOC } = req.body;

//     const hospital = await Hospital.findById(hospitalId);
//     if (!hospital) {
//       return res.status(404).json({ message: 'Hospital not found' });
//     }

//     // Update the hospital document
//     hospital.policyDetails = policyDetails || hospital.policyDetails;
//     hospital.healthBima = healthBima || hospital.healthBima;
//     hospital.additionalInfo = additionalInfo || hospital.additionalInfo;
//     hospital.fireNOC = fireNOC || hospital.fireNOC;

//     await hospital.save();
//     res.status(200).json({ message: 'Additional details saved successfully.' });
//   } catch (error) {
//     console.error('Error updating hospital details:', error);
//     res.status(500).json({ message: 'Server error while updating details.' });
//   }
// };

const updateHospitalDetails = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const updateData = req.body; // Accept any fields from the request body

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
        // Continue but maybe warn?
      }
    }

    const hospital = await Hospital.findById(hospitalId);
    if (!hospital) {
      return res.status(404).json({ message: 'Hospital not found' });
    }

    // Dynamically update only the fields sent in req.body
    Object.keys(updateData).forEach((key) => {
      hospital[key] = updateData[key] !== undefined ? updateData[key] : hospital[key];
    });

    await hospital.save();

    res.status(200).json({
      message: 'Hospital details updated successfully.',
      hospital
    });
  } catch (error) {
    console.error('Error updating hospital details:', error);
    res.status(500).json({ message: 'Server error while updating details.' });
  }
};


// Export both functions correctly
module.exports = {
  getHospitalDetails,
  updateHospitalDetails,
};