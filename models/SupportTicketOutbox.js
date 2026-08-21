const mongoose = require('mongoose');

const supportTicketOutboxSchema = new mongoose.Schema({
  ticketRequestId: { type: String, required: true, unique: true, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['PENDING', 'DELIVERED', 'FAILED'], default: 'PENDING', index: true },
  attempts: { type: Number, default: 0 },
  nextRetryAt: { type: Date, default: Date.now, index: true },
  deliveredAt: Date,
  masterTicketRef: String,
  lastError: String
}, { timestamps: true });

supportTicketOutboxSchema.index({ status: 1, nextRetryAt: 1 });
module.exports = mongoose.model('SupportTicketOutbox', supportTicketOutboxSchema);
