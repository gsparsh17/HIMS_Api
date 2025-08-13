const Medicine = require('../models/Medicine');
const IssuedMedicine = require('../models/IssuedMedicine');

// Add new medicine to inventory
exports.addMedicine = async (req, res) => {
  try {
    const medicine = new Medicine(req.body);
    await medicine.save();
    res.status(201).json(medicine);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all medicines
// exports.getAllMedicines = async (req, res) => {
//   try {
//     const medicines = await Medicine.find();
//     res.json(medicines);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };


// ... other functions

// Get all medicines (only non-expired ones)
exports.getAllMedicines = async (req, res) => {
  try {
    // Find medicines where the expiry date is greater than or equal to today
    const medicines = await Medicine.find({
      expiry_date: { $gte: new Date() }
    });
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ... other functions
// Update medicine stock
exports.updateMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!medicine) return res.status(404).json({ error: 'Medicine not found' });
    res.json(medicine);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete medicine
exports.deleteMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findByIdAndDelete(req.params.id);
    if (!medicine) return res.status(404).json({ error: 'Medicine not found' });
    res.json({ message: 'Medicine deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Issue medicine for prescription
exports.issueMedicine = async (req, res) => {
  try {
    const { prescription_id, medicine_id, quantity_issued } = req.body;

    const medicine = await Medicine.findById(medicine_id);
    if (!medicine) return res.status(404).json({ error: 'Medicine not found' });

    if (medicine.stock_quantity < quantity_issued) {
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    medicine.stock_quantity -= quantity_issued;
    await medicine.save();

    const issued = new IssuedMedicine({ prescription_id, medicine_id, quantity_issued });
    await issued.save();

    res.status(201).json(issued);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all issued medicines
exports.getIssuedMedicines = async (req, res) => {
  try {
    const issued = await IssuedMedicine.find()
      .populate('prescription_id')
      .populate('medicine_id');
    res.json(issued);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

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

    res.status(201).json({ message: 'Pharmacy and user created', pharmacyId: pharmacy._id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all pharmacies
exports.getAllPharmacies = async (req, res) => {
  try {
    const pharmacies = await Pharmacy.find();
    res.json(pharmacies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get pharmacy by ID
exports.getPharmacyById = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findById(req.params.id);
    if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found' });
    res.json(pharmacy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update pharmacy
exports.updatePharmacy = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found' });
    res.json(pharmacy);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete pharmacy
exports.deletePharmacy = async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findByIdAndDelete(req.params.id);
    if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found' });
    res.json({ message: 'Pharmacy deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
