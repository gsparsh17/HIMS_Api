const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  templateId: { type: String, required: true, trim: true, index: true },
  documentType: { type: String, required: true, trim: true, index: true },
  version: { type: Number, required: true, min: 1 },
  rendererId: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  pageCount: { type: Number, default: 1, min: 1 },
  pageRules: mongoose.Schema.Types.Mixed,
  signatureRoles: [{ type: String, trim: true }],
  signatureAnchors: mongoose.Schema.Types.Mixed,
  branding: mongoose.Schema.Types.Mixed,
  activeFrom: { type: Date, default: Date.now },
  activeTo: Date,
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, minimize: false });

schema.index({ hospitalId: 1, templateId: 1, version: 1 }, { unique: true });
module.exports = mongoose.model('PrintTemplate', schema);
