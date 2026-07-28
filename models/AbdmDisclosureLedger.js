const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    packetId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmPacket', required: true, index: true },
    packetVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmPacketVersion', required: true, index: true },
    transferId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmDataTransfer', index: true },
    consentId: { type: String, required: true, index: true },
    transactionId: { type: String, required: true, index: true },
    hiuId: String,
    purpose: mongoose.Schema.Types.Mixed,
    careContextReference: { type: String, required: true },
    hiType: { type: String, required: true },
    bundleHash: { type: String, required: true },
    sourceSnapshotHash: { type: String, required: true },
    disclosedAt: { type: Date, default: Date.now, index: true },
    outcome: { type: String, enum: ['SUCCESS', 'FAILED'], required: true },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index(
  { hospitalId: 1, transactionId: 1, packetVersionId: 1 },
  { unique: true }
);
schema.index({ hospitalId: 1, patientId: 1, disclosedAt: -1 });

module.exports = mongoose.model('AbdmDisclosureLedger', schema);
