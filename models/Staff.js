const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  role: { type: String, required: true }, // e.g., 'Receptionist', 'Clerk', 'Cleaner'
  shift_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  joined_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Staff', staffSchema);
