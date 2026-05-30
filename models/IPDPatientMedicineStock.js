const mongoose = require('mongoose');

const ipdPatientMedicineStockSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true, index: true },
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
  lastReturnedAt: { type: Date }
}, { timestamps: true });

ipdPatientMedicineStockSchema.index({ admissionId: 1, medicineId: 1, batchId: 1 }, { unique: false });

module.exports = mongoose.model('IPDPatientMedicineStock', ipdPatientMedicineStockSchema);
