const HospitalCharges = require('../models/HospitalCharges');
const { requireHospitalId } = require('../services/tenantScope.service');

// ✅ Create or Update Hospital Charges
exports.createOrUpdateCharges = async (req, res) => {
  try {
    const hospital = requireHospitalId(req);

    if (!hospital) {
      return res.status(400).json({ error: 'Hospital ID is required' });
    }

    // Hospital charges are a logical singleton per hospital. Reuse an archived row
    // instead of creating a second record, so historical references remain stable.
    let charges = await HospitalCharges.findOne({ hospital });

    if (charges) {
      const updates = { ...req.body };
      delete updates.hospital;
      delete updates.is_active;
      delete updates.deleted_at;
      delete updates.deleted_by;
      delete updates.deletion_reason;
      charges = await HospitalCharges.findOneAndUpdate(
        { _id: charges._id, hospital },
        {
          $set: {
            ...updates,
            is_active: true,
            deleted_at: null,
            deleted_by: null,
            deletion_reason: ''
          }
        },
        { new: true, runValidators: true }
      );
      return res.status(200).json({ message: 'Hospital charges updated successfully', charges });
    }

    const newCharges = await HospitalCharges.create({ ...req.body, hospital, is_active: true });
    return res.status(201).json({ message: 'Hospital charges created successfully', charges: newCharges });
  } catch (error) {
    console.error('Error creating/updating charges:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ✅ Get Charges for a Hospital
exports.getChargesByHospital = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    if (String(req.params.hospitalId) !== String(hospitalId)) return res.status(403).json({ error: 'Hospital scope mismatch' });
    const charges = await HospitalCharges.findOne({ hospital: hospitalId, is_active: { $ne: false } });
    if (!charges) return res.status(404).json({ error: 'Charges not found for this hospital' });
    res.status(200).json(charges);
  } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
};

// ✅ Get All Charges Records
exports.getAllCharges = async (req, res) => {
  try {
    const charges = await HospitalCharges.find({ hospital: requireHospitalId(req), is_active: { $ne: false } }).populate('hospital', 'hospitalName address contact');
    res.status(200).json(charges);
  } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
};

// ✅ Delete Charges for a Hospital
exports.deleteCharges = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    if (String(req.params.hospitalId) !== String(hospitalId)) return res.status(403).json({ error: 'Hospital scope mismatch' });
    const charges = await HospitalCharges.findOneAndUpdate(
      { hospital: hospitalId, is_active: { $ne: false } },
      { $set: { is_active: false, deleted_at: new Date(), deleted_by: req.user?._id || null, deletion_reason: String(req.body?.reason || 'Hospital charges archived by user').trim() } },
      { new: true }
    );
    if (!charges) return res.status(404).json({ error: 'Charges not found for this hospital' });
    res.status(200).json({ message: 'Hospital charges archived successfully', charges });
  } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
};
