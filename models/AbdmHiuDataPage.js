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
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    hiuRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AbdmHiuRequest',
      required: true,
      index: true
    },
    transactionId: { type: String, required: true, index: true },
    pageNumber: { type: Number, required: true, min: 0 },
    pageCount: { type: Number, required: true, min: 1 },
    entryCount: { type: Number, required: true, min: 0 },
    payloadHash: { type: String, required: true },
    encryptedPayload: { type: encryptedBlobSchema, required: true, select: false },
    purgeAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

schema.index(
  { hospitalId: 1, transactionId: 1, pageNumber: 1 },
  { unique: true }
);
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AbdmHiuDataPage', schema);
