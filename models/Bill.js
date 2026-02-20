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
    enum: ['Consultation', 'Procedure', 'Medicine', 'Lab Test', 'Other'],
    required: true
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

  // Common linking
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
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
    ref: 'Appointment',
    required: true
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  invoice_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
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

  payment_method: {
    type: String,
    enum: ['Pending', 'Cash', 'Card', 'Insurance', 'UPI', 'Net Banking', 'Government Funded Scheme'],
    required: true
  },

  items: [billItemSchema],

  status: {
    type: String,
    enum: ['Draft', 'Generated', 'Pending', 'Paid', 'Partially Paid', 'Refunded', 'Cancelled'],
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
  }
}, {
  timestamps: true
});

// Calculate balance before save
billSchema.pre('save', function(next) {
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

// Virtual for is_paid
billSchema.virtual('is_paid').get(function() {
  return this.status === 'Paid';
});

// Virtual for is_fully_paid
billSchema.virtual('is_fully_paid').get(function() {
  return this.paid_amount >= this.total_amount;
});

// Indexes
billSchema.index({ patient_id: 1, generated_at: -1 });
billSchema.index({ appointment_id: 1 });
billSchema.index({ prescription_id: 1 });
billSchema.index({ status: 1 });
billSchema.index({ 'items.item_type': 1 });

module.exports = mongoose.model('Bill', billSchema);
