// models/Hospital.js
const mongoose = require('mongoose');

const hospitalSchema = new mongoose.Schema({
  hospitalID: { type: String, required: true },
  registryNo: { type: String, required: true },
  fireNOC: { type: String, required: true},
  name: { type: String, required: true },
  address: { type: String, required: true },
  contact: { type: String, required: true },
  email: { type: String, required: true },
  policyDetails: { type: String },
  healthBima: { type: String },
  additionalInfo: { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } // Link admin user
}, { timestamps: true });

module.exports = mongoose.model('Hospital', hospitalSchema);
