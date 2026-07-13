const Hospital = require('../models/Hospital');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const HOSPITAL_PROFILE_FIELDS = new Set([
  'registryNo', 'hospitalName', 'logo', 'companyName', 'licenseNumber', 'name',
  'address', 'contact', 'pinCode', 'city', 'state', 'email', 'fireNOC',
  'policyDetails', 'healthBima', 'additionalInfo', 'vitalsEnabled', 'vitalsController'
]);

function isPlatformAdmin(req) {
  return req.user?.role === 'mediqliq_super_admin';
}

function ownHospitalId(req) {
  return req.user?.hospital_id ? String(req.user.hospital_id) : null;
}

function canAccess(req, hospitalId) {
  return isPlatformAdmin(req) || (ownHospitalId(req) && ownHospitalId(req) === String(hospitalId));
}

const getHospitalDetails = async (req, res) => {
  try {
    const filter = isPlatformAdmin(req) ? {} : { _id: req.user?.hospital_id };
    if (!isPlatformAdmin(req) && !req.user?.hospital_id) {
      return res.status(403).json({ message: 'User is not assigned to a hospital deployment.' });
    }
    const hospitals = await Hospital.find(filter).select('-createdBy');
    if (!hospitals.length) return res.status(404).json({ message: 'No hospital details found.' });
    return res.status(200).json(hospitals);
  } catch (error) {
    return res.status(500).json({ message: 'Server error while fetching hospital details.' });
  }
};

const getHospitalById = async (req, res) => {
  try {
    if (!canAccess(req, req.params.hospitalId)) return res.status(403).json({ message: 'No access to this hospital.' });
    const hospital = await Hospital.findById(req.params.hospitalId).select('-createdBy');
    if (!hospital) return res.status(404).json({ message: 'Hospital not found' });
    return res.status(200).json(hospital);
  } catch (error) {
    return res.status(500).json({ message: 'Server error while fetching hospital details.' });
  }
};

const updateHospitalDetails = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    if (!canAccess(req, hospitalId)) return res.status(403).json({ message: 'No access to this hospital.' });

    const updateData = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (HOSPITAL_PROFILE_FIELDS.has(key) && value !== undefined) updateData[key] = value;
    }
    if (updateData.vitalsController && !['doctor', 'nurse', 'registrar'].includes(updateData.vitalsController)) {
      return res.status(400).json({ message: 'Invalid vitals controller. Must be doctor, nurse or registrar.' });
    }

    if (req.file) {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: 'hospital_logos',
        resource_type: 'image'
      });
      updateData.logo = result.secure_url;
      fs.unlink(req.file.path, () => {});
    }

    const hospital = await Hospital.findByIdAndUpdate(hospitalId, updateData, {
      new: true,
      runValidators: true
    });
    if (!hospital) return res.status(404).json({ message: 'Hospital not found' });
    return res.status(200).json({ message: 'Hospital details updated successfully.', hospital });
  } catch (error) {
    return res.status(500).json({ message: 'Server error while updating details.' });
  }
};

const getVitalsConfig = async (req, res) => {
  try {
    if (!canAccess(req, req.params.hospitalId)) return res.status(403).json({ message: 'No access to this hospital.' });
    const hospital = await Hospital.findById(req.params.hospitalId).select('vitalsEnabled vitalsController');
    if (!hospital) return res.status(404).json({ message: 'Hospital not found' });
    return res.status(200).json({
      vitalsEnabled: hospital.vitalsEnabled,
      vitalsController: hospital.vitalsController
    });
  } catch (error) {
    return res.status(500).json({ message: 'Server error while fetching vitals configuration.' });
  }
};

const updateVitalsConfig = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    if (!canAccess(req, hospitalId)) return res.status(403).json({ message: 'No access to this hospital.' });
    const { vitalsEnabled, vitalsController } = req.body;
    if (vitalsController && !['doctor', 'nurse', 'registrar'].includes(vitalsController)) {
      return res.status(400).json({ message: 'Invalid vitals controller.' });
    }
    const update = {};
    if (vitalsEnabled !== undefined) update.vitalsEnabled = Boolean(vitalsEnabled);
    if (vitalsController !== undefined) update.vitalsController = vitalsController;
    const hospital = await Hospital.findByIdAndUpdate(hospitalId, update, { new: true, runValidators: true });
    if (!hospital) return res.status(404).json({ message: 'Hospital not found' });
    return res.status(200).json({
      message: 'Vitals configuration updated successfully.',
      vitalsConfig: { vitalsEnabled: hospital.vitalsEnabled, vitalsController: hospital.vitalsController }
    });
  } catch (error) {
    return res.status(500).json({ message: 'Server error while updating vitals configuration.' });
  }
};

module.exports = {
  getHospitalDetails,
  getHospitalById,
  updateHospitalDetails,
  getVitalsConfig,
  updateVitalsConfig
};
