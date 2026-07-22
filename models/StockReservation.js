const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  lotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot', required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  quantity: { type: Number, required: true, min: 0.0001 },
  issuedQuantity: { type: Number, default: 0, min: 0 },
  releasedQuantity: { type: Number, default: 0, min: 0 }
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  reservationNumber: { type: String, required: true, index: true },
  sourceType: { type: String, enum: ['Requisition', 'OTCase', 'Patient', 'Other'], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  otCaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', index: true },
  lines: [lineSchema],
  expiresAt: Date,
  status: { type: String, enum: ['Active', 'Partially Issued', 'Issued', 'Released', 'Expired', 'Cancelled'], default: 'Active', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  releasedAt: Date,
  releaseReason: String
}, { timestamps: true });

schema.index({ hospitalId: 1, reservationNumber: 1 }, { unique: true });
schema.index({ hospitalId: 1, sourceType: 1, sourceId: 1, status: 1 });
module.exports = mongoose.model('StockReservation', schema);
