const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');

const issuedMedicineSchema = new mongoose.Schema({
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription', required: true },
  medicine_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  quantity_issued: { type: Number, required: true },
  issued_at: { type: Date, default: operationNow }
});

module.exports = mongoose.model('IssuedMedicine', issuedMedicineSchema);
