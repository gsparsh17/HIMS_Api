const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');

exports.createPharmacy = async (req, res) => {
  try {
    const { name, licenseNumber, email, phone, address, password } = req.body;

    const pharmacy = new Pharmacy({
      name,
      licenseNumber,
      email,
      phone,
      address
    });
    await pharmacy.save();

    if (password) {
      const user = new User({
        name,
        email,
        phone,
        role: 'pharmacy',
        password
      });
      await user.save();
    }

    res.status(201).json({ message: 'Pharmacy created', pharmacyId: pharmacy._id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllPharmacies = async (req, res) => {
  try {
    const pharmacies = await Pharmacy.find({ status: 'Active' });
    res.json(pharmacies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getPharmacyById = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findById(req.params.id);
    if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found' });
    res.json(pharmacy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updatePharmacy = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found' });
    res.json(pharmacy);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deletePharmacy = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findByIdAndUpdate(
      req.params.id,
      { status: 'Inactive' },
      { new: true }
    );
    if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found' });
    res.json({ message: 'Pharmacy deactivated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};