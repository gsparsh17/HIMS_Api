const mongoose = require('mongoose');

/**
 * Central, atomic document numbering for finance documents. Count-based numbers
 * are unsafe under concurrent billing; this collection is incremented atomically.
 */
const financialSequenceSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  documentType: {
    type: String,
    enum: ['BILL', 'INVOICE', 'RECEIPT', 'ADVANCE_RECEIPT', 'ADVANCE_REFUND', 'CREDIT_NOTE'],
    required: true
  },
  period: { type: String, required: true }, // YYYYMM
  value: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

financialSequenceSchema.index(
  { hospitalId: 1, documentType: 1, period: 1 },
  { unique: true }
);

module.exports = mongoose.model('FinancialSequence', financialSequenceSchema);
