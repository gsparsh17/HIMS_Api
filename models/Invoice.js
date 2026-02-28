const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  date: {
    type: Date,
    default: () => new Date()
  },
  amount: {
    type: Number,
    required: true,
    min: [0, 'Amount cannot be negative']
  },
  method: {
    type: String,
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme'],
    required: true
  },
  reference: {
    type: String
  },
  status: {
    type: String,
    enum: ['Pending', 'Completed', 'Failed', 'Refunded'],
    default: 'Completed'
  },
  collected_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  transaction_id: {
    type: String
  }
}, {
  timestamps: true
});

const serviceItemSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    default: 1,
    min: [1, 'Quantity must be at least 1']
  },
  unit_price: {
    type: Number,
    required: true,
    min: [0, 'Unit price cannot be negative']
  },
  total_price: {
    type: Number,
    required: true,
    min: [0, 'Total price cannot be negative']
  },
  tax_rate: {
    type: Number,
    default: 0,
    min: [0, 'Tax rate cannot be negative'],
    max: [100, 'Tax rate cannot exceed 100%']
  },
  tax_amount: {
    type: Number,
    default: 0,
    min: [0, 'Tax amount cannot be negative']
  },
  service_type: {
    type: String,
    enum: ['Consultation', 'Procedure', 'Lab Test', 'Other', 'Purchase']
  },

  // Optional codes (depending on service_type)
  procedure_code: {
    type: String
  },
  lab_test_code: {
    type: String
  },

  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  bill_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bill'
  }
});

const medicineItemSchema = new mongoose.Schema({
  medicine_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine'
  },
  batch_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicineBatch'
  },
  medicine_name: {
    type: String,
    required: true
  },
  batch_number: {
    type: String
  },
  expiry_date: {
    type: Date
  },
  quantity: {
    type: Number,
    required: true,
    min: [1, 'Quantity must be at least 1']
  },
  unit_price: {
    type: Number,
    required: true,
    min: [0, 'Unit price cannot be negative']
  },
  total_price: {
    type: Number,
    required: true,
    min: [0, 'Total price cannot be negative']
  },
  tax_rate: {
    type: Number,
    default: 0,
    min: [0, 'Tax rate cannot be negative'],
    max: [100, 'Tax rate cannot exceed 100%']
  },
  tax_amount: {
    type: Number,
    default: 0,
    min: [0, 'Tax amount cannot be negative']
  },
  prescription_required: {
    type: Boolean,
    default: false
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  is_dispensed: {
    type: Boolean,
    default: false
  },
  dispensed_at: {
    type: Date
  }
});

const procedureItemSchema = new mongoose.Schema({
  procedure_code: {
    type: String,
    required: true
  },
  procedure_name: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    default: 1,
    min: [1, 'Quantity must be at least 1']
  },
  unit_price: {
    type: Number,
    required: true,
    min: [0, 'Unit price cannot be negative']
  },
  total_price: {
    type: Number,
    required: true,
    min: [0, 'Total price cannot be negative']
  },
  tax_rate: {
    type: Number,
    default: 0,
    min: [0, 'Tax rate cannot be negative'],
    max: [100, 'Tax rate cannot exceed 100%']
  },
  tax_amount: {
    type: Number,
    default: 0,
    min: [0, 'Tax amount cannot be negative']
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  status: {
    type: String,
    enum: ['Pending', 'Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Paid'],
    default: 'Pending'
  },
  scheduled_date: {
    type: Date
  },
  completed_date: {
    type: Date
  },
  performed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// ✅ NEW: Lab Test items (mirrors procedure items)
const labTestItemSchema = new mongoose.Schema({
  lab_test_code: {
    type: String,
    required: true
  },
  lab_test_name: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    default: 1,
    min: [1, 'Quantity must be at least 1']
  },
  unit_price: {
    type: Number,
    required: true,
    min: [0, 'Unit price cannot be negative']
  },
  total_price: {
    type: Number,
    required: true,
    min: [0, 'Total price cannot be negative']
  },
  tax_rate: {
    type: Number,
    default: 0,
    min: [0, 'Tax rate cannot be negative'],
    max: [100, 'Tax rate cannot exceed 100%']
  },
  tax_amount: {
    type: Number,
    default: 0,
    min: [0, 'Tax amount cannot be negative']
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  status: {
    type: String,
    enum: ['Pending', 'Sample Collected', 'Processing', 'Completed', 'Cancelled', 'Paid'],
    default: 'Pending'
  },
  scheduled_date: {
    type: Date
  },
  sample_collected_at: {
    type: Date
  },
  completed_date: {
    type: Date
  },
  performed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  notes: {
    type: String
  },
  report_url: {
    type: String
  }
}, {
  timestamps: true
});

const invoiceSchema = new mongoose.Schema({
  invoice_number: {
    type: String,
    unique: true,
    uppercase: true,
    trim: true
  },

  // Customer Information
  patient_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    index: true
  },
  customer_type: {
    type: String,
    enum: ['Patient', 'Walk-in', 'Insurance', 'Corporate', 'Supplier', 'Other'],
    required: true,
    default: 'Patient'
  },
  customer_name: {
    type: String,
    trim: true
  },
  customer_phone: {
    type: String,
    trim: true
  },
  customer_address: {
    type: String,
    trim: true
  },

  // Reference Links
  appointment_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    index: true
  },
  bill_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bill',
    index: true
  },
  sale_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    index: true
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription',
    index: true
  },

  // Invoice Type
  invoice_type: {
    type: String,
    enum: ['Appointment', 'Pharmacy', 'Procedure', 'Lab Test', 'Mixed', 'Other', 'Purchase'],
    required: true,
    index: true
  },

  // Dates - All stored in UTC
  issue_date: {
    type: Date,
    default: () => new Date(),
    required: true
  },
  due_date: {
    type: Date,
    required: true,
    validate: {
      validator: function(v) {
        return v >= this.issue_date;
      },
      message: 'Due date must be after issue date'
    }
  },

  // Items
  service_items: [serviceItemSchema],
  medicine_items: [medicineItemSchema],
  procedure_items: [procedureItemSchema],
  lab_test_items: [labTestItemSchema],

  // Financial details
  subtotal: {
    type: Number,
    required: true,
    min: [0, 'Subtotal cannot be negative'],
    validate: {
      validator: function(v) {
        return v <= this.total;
      },
      message: 'Subtotal cannot exceed total'
    }
  },
  discount: {
    type: Number,
    default: 0,
    min: [0, 'Discount cannot be negative'],
    validate: {
      validator: function(v) {
        return v <= this.subtotal;
      },
      message: 'Discount cannot exceed subtotal'
    }
  },
  tax: {
    type: Number,
    default: 0,
    min: [0, 'Tax cannot be negative']
  },
  total: {
    type: Number,
    required: true,
    min: [0, 'Total cannot be negative'],
    validate: {
      validator: function(v) {
        return Math.abs(v - (this.subtotal - this.discount + this.tax)) < 0.01;
      },
      message: 'Total must equal subtotal - discount + tax'
    }
  },

  // Payment tracking
  amount_paid: {
    type: Number,
    default: 0,
    min: [0, 'Amount paid cannot be negative'],
    validate: {
      validator: function(v) {
        return v <= this.total;
      },
      message: 'Amount paid cannot exceed total'
    }
  },
  balance_due: {
    type: Number,
    min: [0, 'Balance due cannot be negative']
  },
  payment_history: [paymentSchema],

  // Status
  status: {
    type: String,
    enum: ['Draft', 'Issued', 'Pending', 'Paid', 'Partial', 'Overdue', 'Cancelled', 'Refunded'],
    default: 'Draft',
    index: true
  },

  // Additional fields
  notes: {
    type: String,
    trim: true
  },
  terms_and_conditions: {
    type: String,
    trim: true
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Pharmacy specific
  is_pharmacy_sale: {
    type: Boolean,
    default: false
  },
  dispensing_date: {
    type: Date
  },
  dispensed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Procedure specific
  has_procedures: {
    type: Boolean,
    default: false
  },
  procedures_status: {
    type: String,
    enum: ['None', 'Pending', 'Partial', 'Completed', 'Paid'],
    default: 'None'
  },

  // ✅ NEW: Lab Test specific
  has_lab_tests: {
    type: Boolean,
    default: false
  },
  lab_tests_status: {
    type: String,
    enum: ['None', 'Pending', 'Partial', 'Completed', 'Paid'],
    default: 'None'
  },
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
  deletion_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bill'
  },

  // Audit fields
  created_at: {
    type: Date,
    default: () => new Date(),
    immutable: true
  },
  updated_at: {
    type: Date,
    default: () => new Date()
  }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      if (ret.created_at) {
        ret.created_at_ist = new Date(ret.created_at).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'full',
          timeStyle: 'long'
        });
      }
      if (ret.updated_at) {
        ret.updated_at_ist = new Date(ret.updated_at).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'full',
          timeStyle: 'long'
        });
      }
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// Pre-save middleware
invoiceSchema.pre('save', function(next) {
  this.updated_at = new Date();

  if (this.isNew) {
    this.created_at = new Date();
  }

  // Calculate balance due
  this.balance_due = this.total - this.amount_paid;

  // Validate dates
  if (this.due_date < this.issue_date) {
    return next(new Error('Due date cannot be before issue date'));
  }

  // Auto-update status based on payment
  if (this.amount_paid >= this.total) {
    this.status = 'Paid';
  } else if (this.amount_paid > 0) {
    this.status = 'Partial';
  } else if (new Date() > this.due_date && !['Paid', 'Cancelled', 'Refunded'].includes(this.status)) {
    this.status = 'Overdue';
  }

  // Update procedures related fields
  if (this.procedure_items && this.procedure_items.length > 0) {
    this.has_procedures = true;

    const totalProcedures = this.procedure_items.length;
    const completedProcedures = this.procedure_items.filter(p => p.status === 'Completed').length;

    if (completedProcedures === 0) {
      this.procedures_status = 'Pending';
    } else if (completedProcedures === totalProcedures) {
      this.procedures_status = 'Completed';
    } else {
      this.procedures_status = 'Partial';
    }
  } else {
    this.has_procedures = false;
    this.procedures_status = 'None';
  }

  // ✅ Update lab tests related fields
  if (this.lab_test_items && this.lab_test_items.length > 0) {
    this.has_lab_tests = true;

    const total = this.lab_test_items.length;
    const completed = this.lab_test_items.filter(t => t.status === 'Completed').length;

    if (completed === 0) {
      this.lab_tests_status = 'Pending';
    } else if (completed === total) {
      this.lab_tests_status = 'Completed';
    } else {
      this.lab_tests_status = 'Partial';
    }
  } else {
    this.has_lab_tests = false;
    this.lab_tests_status = 'None';
  }

  next();
});

// Pre-validate middleware for calculations
invoiceSchema.pre('validate', function(next) {
  if (
    this.isNew ||
    this.isModified('service_items') ||
    this.isModified('medicine_items') ||
    this.isModified('procedure_items') ||
    this.isModified('lab_test_items')
  ) {
    let calculatedSubtotal = 0;

    [...this.service_items, ...this.medicine_items, ...this.procedure_items, ...this.lab_test_items].forEach(item => {
      calculatedSubtotal += item.total_price || 0;
    });

    if (!this.subtotal || this.subtotal === 0) {
      this.subtotal = calculatedSubtotal;
    }

    if (!this.total || this.total === 0) {
      this.total = this.subtotal - (this.discount || 0) + (this.tax || 0);
    }
  }

  next();
});

// Generate invoice number
invoiceSchema.pre('save', async function(next) {
  if (this.isNew && !this.invoice_number) {
    try {
      const year = new Date().getFullYear();
      const month = String(new Date().getMonth() + 1).padStart(2, '0');
      
      let prefix = 'INV';
      switch (this.invoice_type) {
        case 'Pharmacy':
          prefix = 'PH';
          this.is_pharmacy_sale = true;
          break;
        case 'Procedure':
          prefix = 'PR';
          break;
        case 'Lab Test':
          prefix = 'LT';
          break;
        case 'Appointment':
          prefix = 'AP';
          break;
        case 'Mixed':
          prefix = 'MX';
          break;
        case 'Purchase':
          prefix = 'PO';
          break;
        default:
          prefix = 'INV';
      }

      let attempts = 0;
      const maxAttempts = 5;
      let saved = false;

      while (!saved && attempts < maxAttempts) {
        try {
          const startOfMonth = new Date(Date.UTC(year, new Date().getMonth(), 1));
          const endOfMonth = new Date(Date.UTC(year, new Date().getMonth() + 1, 0, 23, 59, 59, 999));

          const count = await mongoose.model('Invoice').countDocuments();

          this.invoice_number = `${prefix}-${year}${month}-${(count + 2 + attempts).toString().padStart(6, '0')}`;
          
          // Try to save - this will throw if duplicate
          await this.constructor.findById(this._id).session(this.$session());
          saved = true;
        } catch (error) {
          if (error.code === 11000) {
            attempts++;
            if (attempts === maxAttempts) {
              throw new Error('Unable to generate unique invoice number after multiple attempts');
            }
            // Small delay before retry
            await new Promise(resolve => setTimeout(resolve, 100));
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      return next(error);
    }
  }
  next();
});

// Post-save middleware for logging
invoiceSchema.post('save', function(doc) {
  console.log(`📄 Invoice ${doc.invoice_number} saved at ${new Date().toISOString()}`);
});

// Post-save middleware for error handling
// invoiceSchema.post('save', function(error, doc, next) {
//   if (error.name === 'MongoServerError' && error.code === 11000) {
//     next(new Error('Invoice number already exists. Please try again.'));
//   } else {
//     next(error);
//   }
// });

// Virtual for total items count
invoiceSchema.virtual('total_items').get(function() {
  return (this.service_items?.length || 0) +
    (this.medicine_items?.length || 0) +
    (this.procedure_items?.length || 0) +
    (this.lab_test_items?.length || 0);
});

// Virtual for is_fully_paid
invoiceSchema.virtual('is_fully_paid').get(function() {
  return this.amount_paid >= this.total;
});

// Virtual for pending procedures count
invoiceSchema.virtual('pending_procedures_count').get(function() {
  if (!this.has_procedures) return 0;
  return this.procedure_items?.filter(p => p.status === 'Pending').length || 0;
});

// ✅ Virtual for pending lab tests count
invoiceSchema.virtual('pending_lab_tests_count').get(function() {
  if (!this.has_lab_tests) return 0;
  return this.lab_test_items?.filter(t => t.status === 'Pending').length || 0;
});

// Virtual for days overdue
invoiceSchema.virtual('days_overdue').get(function() {
  if (this.status !== 'Overdue') return 0;
  const today = new Date();
  const dueDate = new Date(this.due_date);
  const diffTime = Math.abs(today - dueDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
});

// Virtual for formatted dates
invoiceSchema.virtual('created_at_ist').get(function() {
  return this.created_at?.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'long'
  });
});

invoiceSchema.virtual('created_at_utc').get(function() {
  return this.created_at?.toISOString();
});

invoiceSchema.virtual('due_date_ist').get(function() {
  return this.due_date?.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full'
  });
});

// Static methods
invoiceSchema.statics.findByDate = function(date) {
  const startDate = new Date(date);
  startDate.setUTCHours(0, 0, 0, 0);

  const endDate = new Date(date);
  endDate.setUTCHours(23, 59, 59, 999);

  return this.find({
    created_at: { $gte: startDate, $lte: endDate }
  });
};

invoiceSchema.statics.findByDateRange = function(startDate, endDate) {
  const start = new Date(startDate);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(endDate);
  end.setUTCHours(23, 59, 59, 999);

  return this.find({
    created_at: { $gte: start, $lte: end }
  }).sort({ created_at: -1 });
};

// Indexes
invoiceSchema.index({ invoice_number: 1 }, { unique: true });
invoiceSchema.index({ patient_id: 1, created_at: -1 });
invoiceSchema.index({ appointment_id: 1, created_at: -1 });
invoiceSchema.index({ prescription_id: 1 });
invoiceSchema.index({ invoice_type: 1, created_at: -1 });
invoiceSchema.index({ status: 1, due_date: 1 });
invoiceSchema.index({ created_at: -1 });
invoiceSchema.index({ due_date: 1, status: 1 });
invoiceSchema.index({ amount_paid: 1, total: 1 });

invoiceSchema.index({ invoice_type: 1, status: 1, created_at: -1 });
invoiceSchema.index({ patient_id: 1, status: 1, created_at: -1 });
invoiceSchema.index({ is_deleted: 1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
