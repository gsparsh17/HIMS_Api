const mongoose = require('mongoose');

const storedFileSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  storageDriver: { type: String, enum: ['local'], default: 'local' },
  storageKey: { type: String, required: true, unique: true, trim: true },
  originalName: { type: String, required: true, trim: true },
  mimeType: { type: String, required: true, trim: true },
  sizeBytes: { type: Number, required: true, min: 0 },
  sha256: { type: String, required: true, trim: true },
  category: { type: String, trim: true, default: 'documents' },
  visibility: { type: String, enum: ['private', 'public'], default: 'private' },
  status: { type: String, enum: ['active', 'deleted'], default: 'active', index: true },
  deletedAt: Date
}, { timestamps: true });

storedFileSchema.index({ hospitalId: 1, createdAt: -1 });

module.exports = mongoose.model('StoredFile', storedFileSchema);
