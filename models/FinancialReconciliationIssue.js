const mongoose = require('mongoose');

const financialReconciliationIssueSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  issueKey: { type: String, required: true, trim: true },
  category: {
    type: String,
    enum: [
      'CHARGE_WITHOUT_INVOICE', 'INVOICE_WITHOUT_CHARGE', 'SOURCE_STATE_MISMATCH',
      'BILL_INVOICE_TOTAL_MISMATCH', 'INVOICE_SERVICE_TOTAL_MISMATCH',
      'INVOICE_PAYMENT_TOTAL_MISMATCH', 'INVOICE_BALANCE_MISMATCH', 'BILL_BALANCE_MISMATCH',
      'RECEIPT_TRANSACTION_MISMATCH', 'RECEIPT_AMOUNT_MISMATCH', 'ADVANCE_LEDGER_MISMATCH',
      'PAYMENT_WITHOUT_ALLOCATION', 'PAYMENT_ALLOCATION_MISMATCH', 'PAYMENT_ALLOCATED_TO_VOID_INVOICE',
      'PAID_DOCUMENT_WITH_POSITIVE_BALANCE', 'NEGATIVE_BALANCE', 'DISCOUNT_WITHOUT_APPROVAL',
      'TAX_WITHOUT_AUTHORIZATION', 'SOURCE_CHARGE_WITH_MULTIPLE_INVOICES',
      'INVOICE_WITH_MULTIPLE_UNRELATED_ENCOUNTERS', 'BIDIRECTIONAL_LINK_MISMATCH',
      'REFUND_PROJECTION_MISMATCH', 'CREDIT_NOTE_PROJECTION_MISMATCH', 'SETTLEMENT_PROJECTION_MISMATCH',
      'REFUND_WITHOUT_CREDIT_NOTE', 'CREDIT_NOTE_WITHOUT_TRANSACTION',
      'DUPLICATE_SOURCE_CHARGE', 'ORPHAN_DOCUMENT', 'DUPLICATE_COLLECTION',
      'PHARMACY_DOUBLE_PROJECTION', 'MISSING_HOSPITAL_SCOPE', 'OTHER'
    ],
    required: true,
    index: true
  },
  severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM', index: true },
  status: { type: String, enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED'], default: 'OPEN', index: true },
  entityType: { type: String, trim: true },
  entityId: mongoose.Schema.Types.ObjectId,
  relatedEntities: [{ entityType: String, entityId: mongoose.Schema.Types.ObjectId }],
  summary: { type: String, required: true, trim: true },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  deterministicFix: { type: Boolean, default: false },
  suggestedAction: { type: String, trim: true },
  detectedAt: { type: Date, default: Date.now, index: true },
  lastSeenAt: { type: Date, default: Date.now },
  occurrenceCount: { type: Number, default: 1 },
  resolution: {
    action: String,
    reason: String,
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed
  },
  runId: { type: String, trim: true, index: true }
}, { timestamps: true });

financialReconciliationIssueSchema.index({ hospitalId: 1, issueKey: 1 }, { unique: true });
financialReconciliationIssueSchema.index({ hospitalId: 1, status: 1, severity: 1, detectedAt: -1 });

module.exports = mongoose.model('FinancialReconciliationIssue', financialReconciliationIssueSchema);
