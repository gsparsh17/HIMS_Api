const mongoose = require('mongoose');

const prescriptionItemSchema = new mongoose.Schema({
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription', required: true },
  medicine_name: { type: String, required: true },
  dosage: { type: String, required: true },
  duration: { type: String, required: true },
  instructions: { type: String }
});

module.exports = mongoose.model('PrescriptionItem', prescriptionItemSchema);
