const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  // Basic Information
  expense_number: {
    type: String,
    unique: true,
    required: true
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  
  // Category & Description
  category: {
    type: String,
    enum: [
      'Medical Equipment',
      'Medical Supplies',
      'Utilities',
      'Staff Salaries',
      'Pharmaceuticals',
      'Maintenance',
      'Insurance',
      'Rent',
      'Other'
    ],
    required: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  },
  
  // Financial Details
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  tax_rate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  tax_amount: {
    type: Number,
    default: 0,
    min: 0
  },
  total_amount: {
    type: Number,
    required: true,
    min: 0
  },
  
  // Vendor Information
  vendor: {
    type: String,
    required: true,
    trim: true
  },
  vendor_phone: {
    type: String,
    trim: true
  },
  vendor_email: {
    type: String,
    trim: true,
    lowercase: true
  },
  
  // Payment Information
  payment_method: {
    type: String,
    enum: ['Cash', 'Card', 'Bank Transfer', 'UPI', 'Cheque', 'Online'],
    required: true
  },
  payment_status: {
    type: String,
    enum: ['Pending', 'Paid', 'Partially Paid', 'Cancelled'],
    default: 'Pending'
  },
  paid_amount: {
    type: Number,
    default: 0,
    min: 0
  },
  payment_date: {
    type: Date
  },
  transaction_id: {
    type: String,
    trim: true
  },
  
  // Department & Location
  department: {
    type: String,
    trim: true
  },
  location: {
    type: String,
    trim: true
  },
  
  // Approval Information
  approved_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approved_date: {
    type: Date
  },
  approval_status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected', 'On Hold'],
    default: 'Pending'
  },
  
  // Receipt Information
  receipt_number: {
    type: String,
    trim: true
  },
  receipt_date: {
    type: Date
  },
  receipt_file: {
    type: String, // URL or path to uploaded file
    trim: true
  },
  
  // Recurring Expense
  is_recurring: {
    type: Boolean,
    default: false
  },
  recurring_frequency: {
    type: String,
    enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly']
  },
  recurring_end_date: {
    type: Date
  },
  
  // Hospital Reference
  hospital_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true
  },
  
  // Created By
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Timestamps
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

// Generate expense number before saving
expenseSchema.pre('save', async function(next) {
  if (!this.expense_number) {
    const year = new Date().getFullYear();
    const count = await mongoose.model('Expense').countDocuments();
    this.expense_number = `EXP-${year}-${(count + 1).toString().padStart(6, '0')}`;
  }
  
  // Calculate tax amount if not set
  if (this.tax_rate && !this.tax_amount) {
    this.tax_amount = (this.amount * this.tax_rate) / 100;
  }
  
  // Calculate total amount if not set
  if (!this.total_amount) {
    this.total_amount = this.amount + (this.tax_amount || 0);
  }
  
  // Update paid_amount based on payment_status
  if (this.payment_status === 'Paid') {
    this.paid_amount = this.total_amount;
    this.payment_date = this.payment_date || new Date();
  } else if (this.payment_status === 'Partially Paid' && this.paid_amount === 0) {
    this.paid_amount = 0;
  }
  
  this.updated_at = new Date();
  next();
});

// Indexes for better query performance
expenseSchema.index({ expense_number: 1 });
expenseSchema.index({ date: -1 });
expenseSchema.index({ category: 1 });
expenseSchema.index({ vendor: 1 });
expenseSchema.index({ payment_status: 1 });
expenseSchema.index({ approval_status: 1 });
expenseSchema.index({ hospital_id: 1, date: -1 });
expenseSchema.index({ created_by: 1 });
expenseSchema.index({ is_recurring: 1 });

// Virtual for balance due
expenseSchema.virtual('balance_due').get(function() {
  return this.total_amount - this.paid_amount;
});

// Virtual for is_fully_paid
expenseSchema.virtual('is_fully_paid').get(function() {
  return this.paid_amount >= this.total_amount;
});

const Expense = mongoose.model('Expense', expenseSchema);

module.exports = Expense;