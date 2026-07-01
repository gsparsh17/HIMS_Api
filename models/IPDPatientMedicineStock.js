// models/IPDPatientMedicineStock.js
const mongoose = require('mongoose');

const ipdPatientMedicineStockSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', index: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch', index: true },
  medicineName: { type: String, required: true, trim: true },
  baseUnit: { type: String, default: 'unit' },
  packUnit: { type: String, default: 'unit' },
  unitsPerPack: { type: Number, default: 1, min: 1 },
  issuedQtyBaseUnits: { type: Number, default: 0, min: 0 },
  administeredQtyBaseUnits: { type: Number, default: 0, min: 0 },
  returnedQtyBaseUnits: { type: Number, default: 0, min: 0 },
  wastedQtyBaseUnits: { type: Number, default: 0, min: 0 },
  currentBalanceBaseUnits: { type: Number, default: 0 },
  sourceSaleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Sale' }],
  medicationChartIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'IPDMedicationChart' }],
  lastIssuedAt: { type: Date },
  lastAdministeredAt: { type: Date },
  lastReturnedAt: { type: Date },
  // NEW: Track source of stock (internal pharmacy or external)
  stockSource: {
    type: String,
    enum: ['INTERNAL_PHARMACY', 'EXTERNAL_PHARMACY', 'MANUAL'],
    default: 'INTERNAL_PHARMACY'
  },
  // NEW: Track if nurse has acknowledged receipt
  receiptAcknowledged: {
    type: Boolean,
    default: false
  },
  receiptAcknowledgedAt: { type: Date },
  receiptAcknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

ipdPatientMedicineStockSchema.index({ admissionId: 1, medicineId: 1, batchId: 1 }, { unique: false });
ipdPatientMedicineStockSchema.index({ receiptAcknowledged: 1, admissionId: 1 });

module.exports = mongoose.model('IPDPatientMedicineStock', ipdPatientMedicineStockSchema);