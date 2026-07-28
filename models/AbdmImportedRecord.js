const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    hiuRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmHiuRequest', required: true, index: true },
    consentId: { type: String, required: true, index: true },
    transactionId: { type: String, required: true, index: true },
    sourceHipId: { type: String, index: true },
    sourceName: String,
    careContextReference: { type: String, index: true },
    hiType: { type: String, required: true, index: true },
    recordDate: Date,
    title: String,
    bundleIdentifier: String,
    fhirVersion: String,
    encryptedFhirBundle: {
      ciphertext: { type: String, required: true, select: false },
      iv: { type: String, required: true, select: false },
      tag: { type: String, required: true, select: false },
      keyVersion: { type: String, default: 'v1', select: false }
    },
    bundleHash: { type: String, required: true, index: true },
    provenance: mongoose.Schema.Types.Mixed,
    consentSnapshot: mongoose.Schema.Types.Mixed,
    status: {
      type: String,
      enum: ['ACTIVE', 'REVOKED', 'EXPIRED', 'QUARANTINED'],
      default: 'ACTIVE',
      index: true
    },
    validation: mongoose.Schema.Types.Mixed,
    receivedAt: { type: Date, default: Date.now },
    importedAt: { type: Date, default: Date.now },
    purgeAt: { type: Date }
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, transactionId: 1, bundleHash: 1 }, { unique: true });
schema.index({ hospitalId: 1, patientId: 1, hiType: 1, recordDate: -1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AbdmImportedRecord', schema);
