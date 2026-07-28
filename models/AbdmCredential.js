const mongoose = require('mongoose');

const encryptedBlobSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true, select: false },
    iv: { type: String, required: true, select: false },
    tag: { type: String, required: true, select: false },
    keyVersion: { type: String, default: 'v1' }
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      unique: true,
      index: true
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    encryptedSession: { type: encryptedBlobSchema, required: true, select: false },
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
    purgeAt: { type: Date, required: true },
    scopes: [String],
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AbdmCredential', schema);
