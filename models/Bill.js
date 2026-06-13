const mongoose = require('mongoose');

const billItemSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true
  },
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
  patient_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true
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
    enum: ['Pending', 'Cash', 'Card', 'Insurance', 'UPI', 'Net Banking', 'Government Scheme', 'IPDAdvance', 'PharmacyAdvance', 'Split', 'NoPayment'],
    required: true,
    default: 'Pending'
  },

  // Split payment support
  payments: [{
    method: {
      type: String,
      enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'IPDAdvance', 'PharmacyAdvance']
    },
    amount: Number,
    reference: String,
    date: { type: Date, default: Date.now }
  }],

  items: [billItemSchema],

  status: {
    type: String,
    enum: ['Draft', 'Generated', 'Pending', 'Paid', 'Partially Paid', 'Refunded', 'Cancelled', 'Partially Returned', 'Fully Returned'],
    default: 'Draft'
  },
  generated_at: {
    type: Date,
    default: Date.now
  },
  paid_at: {
    type: Date
  },
  paid_amount: {
    type: Number,
    default: 0
  },
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

// Calculate balance before save
billSchema.pre('save', function (next) {
  this.balance_due = this.total_amount - this.paid_amount;

  // Update status based on payment
  if (this.paid_amount >= this.total_amount) {
    this.status = 'Paid';
    this.paid_at = this.paid_at || new Date();
  } else if (this.paid_amount > 0) {
    this.status = 'Partially Paid';
  } else if (this.status === 'Generated') {
    this.status = 'Pending';
  }

  next();
});

// Virtuals
billSchema.virtual('is_paid').get(function () {
  return this.status === 'Paid';
});

billSchema.virtual('is_fully_paid').get(function () {
  return this.paid_amount >= this.total_amount;
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

module.exports = mongoose.model('Bill', billSchema);