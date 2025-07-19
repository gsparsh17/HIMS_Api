const HospitalCharges = require('../models/HospitalCharges');

// ✅ Create or Update Hospital Charges
exports.createOrUpdateCharges = async (req, res) => {
  try {
    const { hospital } = req.body;

    if (!hospital) {
      return res.status(400).json({ error: 'Hospital ID is required' });
    }

    let charges = await HospitalCharges.findOne({ hospital });

    if (charges) {
      // Update existing record
      charges = await HospitalCharges.findOneAndUpdate(
        { hospital },
        req.body,
        { new: true, runValidators: true }
      );
      return res.status(200).json({ message: 'Hospital charges updated successfully', charges });
    } else {
      // Create new charges record
      const newCharges = await HospitalCharges.create(req.body);
      return res.status(201).json({ message: 'Hospital charges created successfully', charges: newCharges });
    }
  } catch (error) {
    console.error('Error creating/updating charges:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ✅ Get Charges for a Hospital
exports.getChargesByHospital = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const charges = await HospitalCharges.findOne({ hospital: hospitalId });

    if (!charges) {
      return res.status(404).json({ error: 'Charges not found for this hospital' });
    }

    res.status(200).json(charges);
  } catch (error) {
    console.error('Error fetching charges:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ✅ Get All Charges Records
exports.getAllCharges = async (req, res) => {
  try {
    const charges = await HospitalCharges.find().populate('hospital', 'hospitalName address contact');
    res.status(200).json(charges);
  } catch (error) {
    console.error('Error fetching all charges:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ✅ Delete Charges for a Hospital
exports.deleteCharges = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const deletedCharges = await HospitalCharges.findOneAndDelete({ hospital: hospitalId });

    if (!deletedCharges) {
      return res.status(404).json({ error: 'Charges not found for this hospital' });
    }

    res.status(200).json({ message: 'Hospital charges deleted successfully' });
  } catch (error) {
    console.error('Error deleting charges:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
