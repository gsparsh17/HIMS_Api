const Prescription = require('../models/Prescription');
const PrescriptionItem = require('../models/PrescriptionItem');

// Create a prescription
exports.createPrescription = async (req, res) => {
  try {
    const { patient_id, doctor_id, diagnosis, notes, items } = req.body;

    const prescription = new Prescription({ patient_id, doctor_id, diagnosis, notes });
    await prescription.save();

    const prescriptionItems = await Promise.all(
      items.map(async (item) => {
        return await PrescriptionItem.create({ ...item, prescription_id: prescription._id });
      })
    );

    res.status(201).json({ prescription, items: prescriptionItems });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all prescriptions
exports.getAllPrescriptions = async (req, res) => {
  try {
    const prescriptions = await Prescription.find()
      .populate('patient_id')
      .populate('doctor_id');
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
      .populate('doctor_id');
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
