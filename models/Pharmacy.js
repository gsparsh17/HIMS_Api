const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const pharmacySchema = new mongoose.Schema({
  name: { type: String, required: true },
  licenseNumber: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String },
  address: { type: String },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  registeredAt: { type: Date, default: Date.now }
});

addSoftDeleteFields(pharmacySchema);

module.exports = mongoose.model('Pharmacy', pharmacySchema);
