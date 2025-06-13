const mongoose = require('mongoose');

const issuedMedicineSchema = new mongoose.Schema({
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription', required: true },
  medicine_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  quantity_issued: { type: Number, required: true },
  issued_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('IssuedMedicine', issuedMedicineSchema);
