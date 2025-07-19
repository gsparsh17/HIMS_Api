const mongoose = require('mongoose');

const billSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  appointment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  total_amount: { type: Number, required: true },
  payment_method: { type: String, enum: ['Cash', 'Card', 'Insurance', 'Government Funded Scheme'], required: true },
  details: [{ description: String, amount: Number }],
  status: { type: String, enum: ['Paid', 'Pending', 'Refunded'], default: 'Pending' },
  generated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Bill', billSchema);
