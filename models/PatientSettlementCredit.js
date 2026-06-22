const mongoose = require('mongoose');

/**
 * A payable/usable patient credit created only by a retroactive invoice discount.
 * It keeps refund requests and wallet credits auditable instead of turning an
 * excess discount into a hidden payment or automatic advance.
 */
const patientSettlementCreditSchema = new mongoose.Schema({
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacy_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', index: true },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admission_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  settlement_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyLedgerSettlement', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  disposition: {
    type: String,
    enum: ['PATIENT_CREDIT', 'REFUND_PENDING', 'PHARMACY_ADVANCE', 'IPD_ADJUSTMENT'],
    required: true,
  },
  status: { type: String, enum: ['OPEN', 'APPLIED', 'REFUNDED', 'VOID'], default: 'OPEN', index: true },
  applied_amount: { type: Number, default: 0, min: 0 },
  reference_number: { type: String, trim: true },
  notes: { type: String, trim: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  applied_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  applied_at: { type: Date },
}, { timestamps: true });

patientSettlementCreditSchema.index({ patient_id: 1, status: 1, createdAt: -1 });
module.exports = mongoose.model('PatientSettlementCredit', patientSettlementCreditSchema);
