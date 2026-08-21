const mongoose = require('mongoose');

const platformInternalRequestSchema = new mongoose.Schema({
  requestId: { type: String, required: true, unique: true, index: true },
  identity: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true });

module.exports = mongoose.model('PlatformInternalRequest', platformInternalRequestSchema);
