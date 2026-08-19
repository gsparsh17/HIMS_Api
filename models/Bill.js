const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');

const billItemSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true
  },
  charge_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDCharge' },
  charge_type: { type: String, trim: true },
  charge_head: { type: String, trim: true },
  charge_date: Date,
  gross_amount: { type: Number, default: 0 },
  discount_type: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
  discount_rate: { type: Number, default: 0 },
  discount_reason: { type: String, trim: true },
  tax_mode: { type: String, enum: ['exclusive', 'inclusive', 'exempt'], default: 'exclusive' },
  tax_name: { type: String, trim: true },
  tax_code: { type: String, trim: true },
  net_amount: { type: Number, default: 0 },
  source_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  pricing_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  standard_amount: { type: Number, default: 0 },
  contracted_amount: { type: Number, default: 0 },
  eligible_amount: { type: Number, default: 0 },
  patient_liability: { type: Number, default: 0 },
  sponsor_liability: { type: Number, default: 0 },
  non_admissible_amount: { type: Number, default: 0 },
  contractual_adjustment: { type: Number, default: 0 },
  hospital_concession: { type: Number, default: 0 },
  package_absorbed: { type: Number, default: 0 },
  amount: {
    type: Number,
    required: true
  },
  quantity: {
    type: Number,
    default: 1
  },
  item_type: {
    type: String,
    enum: ['Consultation', 'Procedure', 'Medicine', 'Lab Test', 'Radiology', 'Pharmacy', 'Other',
      'Registration Fee', 'Admission Fee', 'IPD Advance', 'Advance Payment', 'Miscellaneous', 'Medicine Return'],
    required: true
  },

  // Medicine/Pharmacy specific fields
  medicine_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine'
  },
  batch_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicineBatch'
  },
  medicine_name: {
    type: String
  },
  batch_number: {
    type: String
  },
  expiry_date: {
    type: Date
  },
  base_unit: {
    type: String,
    default: 'unit'
  },
  quantity_base_units: {
    type: Number
  },
  unit_price: {
    type: Number
  },
  tax_rate: {
    type: Number,
    default: 0
  },
  tax_amount: {
    type: Number,
    default: 0
  },
  discount_amount: {
    type: Number,
    default: 0
  },
  // ========== NEW GST COMPLIANCE FIELDS ==========
  taxable_amount: {
    type: Number,
    default: 0,
    description: 'Amount after discount before tax (Gross - Discount)'
  },
  hsn_code: {
    type: String,
    trim: true,
    uppercase: true,
    description: 'HSN code for GST compliance'
  },

  // Prescription linking
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  prescription_item_id: {
    type: mongoose.Schema.Types.ObjectId
  },

  // Procedure linking
  procedure_code: {
    type: String
  },
  procedure_id: {
    type: mongoose.Schema.Types.ObjectId
  },

  // Lab Test linking
  lab_test_code: {
    type: String
  },
  lab_test_id: {
    type: mongoose.Schema.Types.ObjectId
  },

  // Radiology linking
  radiology_test_code: {
    type: String
  },
  radiology_test_id: {
    type: mongoose.Schema.Types.ObjectId
  },

  // IPD linking
  admission_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission'
  },

  // Doctor who prescribed
  doctor_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  doctor_name: {
    type: String
  }
});

const deletionRequestSchema = new mongoose.Schema({
  requested_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  requested_at: {
    type: Date,
    default: Date.now
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  reviewed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewed_at: {
    type: Date
  },
  review_notes: {
    type: String
  }
});

const billSchema = new mongoose.Schema({
  payer_allocation: {
    coverage_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage' },
    payer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer' },
    rate_card_id: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCard' },
    rate_card_version: String,
    standard_amount: { type: Number, default: 0 },
    contracted_amount: { type: Number, default: 0 },
    eligible_amount: { type: Number, default: 0 },
    patient_liability: { type: Number, default: 0 },
    sponsor_liability: { type: Number, default: 0 },
    non_admissible_amount: { type: Number, default: 0 },
    contractual_adjustment: { type: Number, default: 0 },
    hospital_concession: { type: Number, default: 0 },
    package_absorbed: { type: Number, default: 0 },
    fallback_count: { type: Number, default: 0 }
  },
  bill_number: { type: String, trim: true, uppercase: true, sparse: true },
  document_stage: { type: String, enum: ['DRAFT', 'GENERATED', 'INVOICED', 'VOID'], default: 'DRAFT', index: true },
  invoice_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
  invoiced_at: Date,
  voided_at: Date,
  voided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  void_reason: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patient_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient'
  },
  appointment_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  admission_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission'
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  invoice_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },

  // Sale reference from pharmacy
  sale_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },

  total_amount: {
    type: Number,
    required: true
  },
  gross_amount: { type: Number, default: 0 },
  line_discount_total: { type: Number, default: 0, min: 0 },
  bill_discount_total: { type: Number, default: 0, min: 0 },
  taxable_amount: { type: Number, default: 0 },
  rounding_adjustment: { type: Number, default: 0 },
  advance_applied: { type: Number, default: 0, min: 0 },
  refund_amount: { type: Number, default: 0, min: 0 },
  subtotal: {
    type: Number,
    required: true
  },
  tax_amount: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  discount_type: {
    type: String,
    enum: ['percentage', 'fixed'],
    default: 'percentage'
  },
  discount_reason: {
    type: String
  },

  payment_method: {
    type: String,
    enum: ['Pending', 'Cash', 'Card', 'Insurance', 'UPI', 'Net Banking', 'Bank', 'Government Scheme', 'IPDAdvance', 'OPDAdvance', 'PharmacyAdvance', 'Split', 'NoPayment', 'Adjustment'],
    required: true,
    default: 'Pending'
  },

  // Split payment support
  payments: [{
    method: {
      type: String,
      enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Bank', 'Insurance', 'Government Scheme', 'IPDAdvance', 'OPDAdvance', 'PharmacyAdvance', 'Adjustment']
    },
    amount: Number,
    reference: String,
    date: { type: Date, default: operationNow }
  }],

  items: [billItemSchema],

  status: {
    type: String,
    enum: ['Draft', 'Generated', 'Pending', 'Paid', 'Partially Paid', 'Refunded', 'Cancelled', 'Partially Returned', 'Fully Returned'],
    default: 'Draft'
  },
  generated_at: {
    type: Date,
    default: operationNow
  },
  paid_at: {
    type: Date
  },
  // paid_amount is actual money/advance collected; discounts are tracked independently.
  paid_amount: {
    type: Number,
    default: 0
  },
  settlement_discount_amount: {
    type: Number,
    default: 0,
    min: 0
  },
  credit_note_amount: {
    type: Number,
    default: 0,
    min: 0
  },
  settlement_refs: [{
    settlement_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyLedgerSettlement' },
    payment_amount: { type: Number, default: 0 },
    settlement_discount_amount: { type: Number, default: 0 },
    credit_note_amount: { type: Number, default: 0 },
    settled_at: { type: Date, default: operationNow }
  }],
  balance_due: {
    type: Number,
    default: 0
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  notes: {
    type: String
  },
  patient_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  admission_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  hospital_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  print_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  idempotency_key: { type: String, trim: true },

  // Pharmacy specific fields
  is_pharmacy_bill: {
    type: Boolean,
    default: false
  },
  pharmacy_outstanding_before: {
    type: Number,
    default: 0
  },
  pharmacy_outstanding_after: {
    type: Number,
    default: 0
  },
  pharmacy_advance_used: {
    type: Number,
    default: 0
  },
  pharmacy_advance_created: {
    type: Number,
    default: 0
  },
  advance_balance_after: {
    type: Number,
    default: 0
  },

  // Soft delete fields
  is_deleted: {
    type: Boolean,
    default: false
  },
  deleted_at: {
    type: Date
  },
  deleted_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  deletion_reason: {
    type: String
  },
  deletion_request: deletionRequestSchema
}, {
  timestamps: true
});

// Keep the editable Bill document financially consistent before every save.
billSchema.pre('save', function (next) {
  const paymentTotal = (this.payments || []).reduce(
    (sum, payment) => sum + Number(payment?.amount || 0),
    0
  );
  this.gross_amount = Number(this.gross_amount || this.subtotal || 0);
  this.taxable_amount = Number(this.taxable_amount || Math.max(0, this.gross_amount - Number(this.line_discount_total || 0) - Number(this.bill_discount_total || 0)));
  this.paid_amount = Math.max(Number(this.paid_amount || 0), paymentTotal);
  const patientBase = this.payer_allocation?.coverage_id
    ? Number(this.payer_allocation?.patient_liability || 0)
    : Number(this.total_amount || 0);
  this.balance_due = Math.max(
    0,
    patientBase -
      this.paid_amount -
      Number(this.settlement_discount_amount || 0) -
      Number(this.credit_note_amount || 0)
  );

  const protectedStatuses = ['Draft', 'Cancelled', 'Refunded', 'Partially Returned', 'Fully Returned'];
  if (this.balance_due <= 0 && !['Cancelled', 'Refunded'].includes(this.status)) {
    this.status = 'Paid';
    this.paid_at = this.paid_at || new Date();
  } else if (
    this.paid_amount > 0 ||
    Number(this.settlement_discount_amount || 0) > 0 ||
    Number(this.credit_note_amount || 0) > 0
  ) {
    this.status = 'Partially Paid';
  } else if (!protectedStatuses.includes(this.status)) {
    // Prevent an impossible Paid bill with zero collection and a positive balance.
    this.status = 'Pending';
  }

  const linkedInvoiceIds = [
    ...(this.invoice_ids || []),
    ...(this.invoice_id ? [this.invoice_id] : [])
  ];
  this.invoice_ids = Array.from(
    new Map(linkedInvoiceIds.filter(Boolean).map((id) => [String(id), id])).values()
  );

  if (this.invoice_ids.length > 0) {
    this.document_stage = 'INVOICED';
    this.invoiced_at = this.invoiced_at || new Date();
  } else if (this.document_stage === 'DRAFT' && this.status !== 'Draft') {
    this.document_stage = 'GENERATED';
  }

  next();
});

// Virtuals
billSchema.virtual('is_paid').get(function () {
  return this.status === 'Paid';
});

billSchema.virtual('is_fully_paid').get(function () {
  return this.balance_due <= 0;
});

billSchema.virtual('has_pending_deletion').get(function () {
  return this.deletion_request && this.deletion_request.status === 'pending';
});

// Indexes
billSchema.index({ patient_id: 1, generated_at: -1 });
billSchema.index({ appointment_id: 1 });
billSchema.index({ admission_id: 1 });
billSchema.index({ prescription_id: 1 });
billSchema.index({ sale_id: 1 });
billSchema.index({ status: 1 });
billSchema.index({ 'items.item_type': 1 });
billSchema.index({ is_deleted: 1 });
billSchema.index({ is_pharmacy_bill: 1 });
billSchema.index({ 'deletion_request.status': 1 });
billSchema.index({ bill_number: 1 }, { unique: true, sparse: true });
billSchema.index({ idempotency_key: 1 }, { unique: true, sparse: true });
billSchema.index({ hospital_id: 1, document_stage: 1, generated_at: -1 });

module.exports = mongoose.model('Bill', billSchema);