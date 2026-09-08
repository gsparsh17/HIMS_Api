const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const pharmacySchema = new mongoose.Schema({
  // Optional for backward compatibility with legacy single-hospital rows.
  // New rows are hospital scoped and resolver logic can still bootstrap an
  // older database that has exactly one unscoped active pharmacy.
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true, default: null },
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
