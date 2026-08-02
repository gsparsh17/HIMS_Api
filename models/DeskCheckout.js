const mongoose = require('mongoose');

const deskCheckoutSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  idempotencyKey: { type: String, required: true, trim: true },
  status: { type: String, enum: ['PROCESSING', 'COMPLETED', 'FAILED'], default: 'PROCESSING', index: true },
  requestHash: { type: String, required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission' },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  billIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bill' }],
  invoiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
  chargeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'IPDCharge' }],
  result: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: { type: mongoose.Schema.Types.Mixed },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: Date
}, { timestamps: true });

deskCheckoutSchema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true });
module.exports = mongoose.model('DeskCheckout', deskCheckoutSchema);
