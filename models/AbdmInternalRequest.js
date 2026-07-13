const mongoose = require('mongoose');

const abdmInternalRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true, index: true },
    direction: { type: String, enum: ['MASTER_INBOUND', 'HOSPITAL_INBOUND'], required: true },
    identity: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

abdmInternalRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AbdmInternalRequest', abdmInternalRequestSchema);
