const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  issueLineId: mongoose.Schema.Types.ObjectId,
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  lotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot' },
  serialNumber: String,
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  quantity: { type: Number, required: true, min: 0.0001 },
  condition: { type: String, enum: ['Unused', 'Opened Usable', 'Damaged', 'Expired', 'Contaminated'], default: 'Unused' },
  disposition: { type: String, enum: ['Return To Stock', 'Quarantine', 'Write Off'], default: 'Return To Stock' },
  unitCost: { type: Number, default: 0 }
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  returnNumber: { type: String, required: true, index: true },
  issueId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreIssue', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission' },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  otCaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest' },
  lines: [lineSchema],
  returnedByName: String,
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  returnedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['Draft', 'Received', 'Posted', 'Rejected'], default: 'Draft', index: true },
  notes: String
}, { timestamps: true });

schema.index({ hospitalId: 1, returnNumber: 1 }, { unique: true });
module.exports = mongoose.model('StoreIssueReturn', schema);
