const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  room_number: { type: String, required: true, unique: true },
  ward: { type: String },
  type: { type: String, enum: ['General', 'ICU', 'Private'], required: true },
  status: { type: String, enum: ['Available', 'Occupied'], default: 'Available' },
  assigned_patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' }
});

module.exports = mongoose.model('Room', roomSchema);
