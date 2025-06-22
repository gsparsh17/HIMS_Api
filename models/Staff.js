const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  role: { type: String, required: true }, // e.g., Doctor, Nurse, Admin
  department: { type: String },
  specialization: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  status: { type: String, enum: ['Active', 'Inactive', 'On Leave'], default: 'Active' },
  joined_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Staff', staffSchema);
