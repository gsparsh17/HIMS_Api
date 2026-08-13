const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  flow: { type: String, enum: ['FACE_LOGIN', 'ABHA_ADDRESS_LOGIN', 'ABHA_NUMBER_LOGIN', 'AADHAAR_LOGIN'], required: true, index: true },
  txnId: { type: String, required: true, unique: true, index: true },
  parentTxnId: { type: String, index: true },
  mobile: { type: String, index: true },
  selectedIndex: String,
  selectedAbhaNumber: String,
  abhaAddress: String,
  status: { type: String, enum: ['CREATED','WAITING','VERIFIED','COMPLETE','FAILED','EXPIRED'], default: 'CREATED', index: true },
  expiresAt: { type: Date, required: true, index: true },
  metadata: mongoose.Schema.Types.Mixed,
  error: mongoose.Schema.Types.Mixed
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });
module.exports = mongoose.model('PatientPortalAbdmTransaction', schema);
