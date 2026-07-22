const mongoose = require('mongoose');

const usageLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  lotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot' },
  serialNumber: String,
  reservedQuantity: { type: Number, default: 0 },
  issuedQuantity: { type: Number, default: 0 },
  usedQuantity: { type: Number, default: 0 },
  wastedQuantity: { type: Number, default: 0 },
  returnedQuantity: { type: Number, default: 0 },
  unitCost: { type: Number, default: 0 },
  patientCharge: { type: Number, default: 0 },
  reconciliationStatus: { type: String, enum: ['Pending', 'Reconciled', 'Variance'], default: 'Pending' },
  notes: String
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, unique: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  sourceLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation' },
  lines: [usageLineSchema],
  status: { type: String, enum: ['Planned', 'Reserved', 'Issued', 'In Use', 'Reconciled'], default: 'Planned', index: true },
  totalCost: { type: Number, default: 0 },
  totalPatientCharge: { type: Number, default: 0 },
  reconciledAt: Date,
  reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  version: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model('OTCaseInventoryUsage', schema);
