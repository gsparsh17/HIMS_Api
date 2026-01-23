const mongoose = require('mongoose');

const nurseSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name: { type: String },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  shift_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  joined_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Nurse', nurseSchema);
