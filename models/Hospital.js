// models/Hospital.js
const mongoose = require('mongoose');

const hospitalSchema = new mongoose.Schema({
  hospitalID: { type: String, required: true, unique: true }, // e.g., AB1234
  registryNo: { type: String, required: true },
  hospitalName: { type: String, required: true }, // Changed from name
  companyName: { type: String }, // Optional
  companyNumber: { type: String }, // Optional
  name: { type: String, required: true }, // Contact person name
  address: { type: String, required: true },
  contact: { type: String, required: true },
  email: { type: String, required: true },
  fireNOC: { type: String }, // Optional
  policyDetails: { type: String }, // Optional
  healthBima: { type: String }, // Optional
  additionalInfo: { type: String }, // Optional
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

module.exports = mongoose.model('Hospital', hospitalSchema);
