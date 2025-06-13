const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  specialization: { type: String, required: true },
  department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  license_number: { type: String, required: true, unique: true },
  joined_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Doctor', doctorSchema);
