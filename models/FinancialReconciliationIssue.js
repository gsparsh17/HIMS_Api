const mongoose = require('mongoose');

const financialReconciliationIssueSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  issueKey: { type: String, required: true, trim: true },
  category: {
    type: String,
    enum: [
      'CHARGE_WITHOUT_INVOICE', 'INVOICE_WITHOUT_CHARGE', 'SOURCE_STATE_MISMATCH',
      'BILL_INVOICE_TOTAL_MISMATCH', 'DUPLICATE_SOURCE_CHARGE', 'ORPHAN_DOCUMENT',
      'DUPLICATE_COLLECTION', 'PHARMACY_DOUBLE_PROJECTION', 'MISSING_HOSPITAL_SCOPE', 'OTHER'
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
