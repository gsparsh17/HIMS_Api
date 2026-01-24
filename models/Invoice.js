const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  date: { 
    type: Date, 
    default: Date.now 
  },
  amount: { 
    type: Number, 
    required: true 
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
    default: 'Completed' 
  },
  collected_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
  transaction_id: {
    type: String
  }
});

const serviceItemSchema = new mongoose.Schema({
  description: { 
    type: String, 
    required: true 
  },
  quantity: { 
    type: Number, 
    default: 1 
  },
  unit_price: { 
    type: Number, 
    required: true 
  },
  total_price: { 
    type: Number, 
    required: true 
  },
  tax_rate: { 
    type: Number, 
    default: 0 
  },
  tax_amount: { 
    type: Number, 
    default: 0 
  },
  service_type: { 
    type: String, 
    enum: ['Consultation', 'Procedure', 'Lab Test', 'Other', 'Purchase'] 
  },
  procedure_code: {
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
    required: true 
  },
  unit_price: { 
    type: Number, 
    required: true 
  },
  total_price: { 
    type: Number, 
    required: true 
  },
  tax_rate: { 
    type: Number, 
    default: 0 
  },
  tax_amount: { 
    type: Number, 
    default: 0 
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
    default: 1
  },
  unit_price: {
    type: Number,
    required: true
  },
  total_price: {
    type: Number,
    required: true
  },
  tax_rate: {
    type: Number,
    default: 0
  },
  tax_amount: {
    type: Number,
    default: 0
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  status: {
    type: String,
    enum: ['Pending', 'Scheduled', 'In Progress', 'Completed'],
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
  }
});

const invoiceSchema = new mongoose.Schema({
  invoice_number: { 
    type: String, 
    unique: true 
  },
  
  // Customer Information
  patient_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Patient' 
  },
  customer_type: { 
    type: String, 
    enum: ['Patient', 'Walk-in', 'Insurance', 'Corporate', 'Supplier', 'Other'], 
    required: true 
  },
  customer_name: { 
    type: String 
  },
  customer_phone: { 
    type: String 
  },
  customer_address: { 
    type: String 
  },
  
  // Reference Links
  appointment_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Appointment' 
  },
  bill_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Bill' 
  },
  sale_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Sale' 
  },
  prescription_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Prescription' 
  },
  
  // Invoice Type
  invoice_type: { 
    type: String, 
    enum: ['Appointment', 'Pharmacy', 'Procedure', 'Mixed', 'Other', 'Purchase'], 
    required: true 
  },
  
  // Dates
  issue_date: { 
    type: Date, 
    default: Date.now 
  },
  due_date: { 
    type: Date, 
    required: true 
  },
  
  // Items
  service_items: [serviceItemSchema],
  medicine_items: [medicineItemSchema],
  procedure_items: [procedureItemSchema],
  
  // Financial details
  subtotal: { 
    type: Number, 
    required: true 
  },
  discount: { 
    type: Number, 
    default: 0 
  },
  tax: { 
    type: Number, 
    default: 0 
  },
  total: { 
    type: Number, 
    required: true 
  },
  
  // Payment tracking
  amount_paid: { 
    type: Number, 
    default: 0 
  },
  balance_due: { 
    type: Number, 
    default: function() { return this.total; } 
  },
  payment_history: [paymentSchema],
  
  // Status
  status: { 
    type: String, 
    enum: ['Draft', 'Issued', 'Paid', 'Partial', 'Overdue', 'Cancelled', 'Refunded'],
    default: 'Draft' 
  },
  
  // Additional fields
  notes: { 
    type: String 
  },
  terms_and_conditions: { 
    type: String 
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
    enum: ['None', 'Pending', 'Partial', 'Completed'],
    default: 'None'
  }
}, { 
  timestamps: true 
});

// Generate invoice number
invoiceSchema.pre('save', async function(next) {
  if (this.isNew && !this.invoice_number) {
    const count = await mongoose.model('Invoice').countDocuments();
    const year = new Date().getFullYear();
    
    let prefix = 'INV';
    switch(this.invoice_type) {
      case 'Pharmacy':
        prefix = 'PH-INV';
        this.is_pharmacy_sale = true;
        break;
      case 'Procedure':
        prefix = 'PR-INV';
        break;
      case 'Appointment':
        prefix = 'AP-INV';
        break;
      case 'Mixed':
        prefix = 'MX-INV';
        break;
      default:
        prefix = 'INV';
    }
    
    this.invoice_number = `${prefix}-${year}-${(count + 1).toString().padStart(6, '0')}`;
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
  }
  
  next();
});

// Update balance due and auto-detect invoice type
invoiceSchema.pre('save', function(next) {
  this.balance_due = this.total - this.amount_paid;
  
  // Auto-detect invoice type if not set
  if (!this.invoice_type || this.invoice_type === 'Mixed') {
    const hasMedicines = this.medicine_items.length > 0;
    const hasServices = this.service_items.length > 0;
    const hasProcedures = this.procedure_items.length > 0;
    
    if (hasMedicines && (hasServices || hasProcedures)) {
      this.invoice_type = 'Mixed';
      this.is_pharmacy_sale = true;
    } else if (hasMedicines) {
      this.invoice_type = 'Pharmacy';
      this.is_pharmacy_sale = true;
    } else if (hasProcedures) {
      this.invoice_type = 'Procedure';
    } else if (hasServices) {
      this.invoice_type = 'Appointment';
      this.is_pharmacy_sale = false;
    }
  }
  
  // Auto-update status based on payment
  if (this.amount_paid >= this.total) {
    this.status = 'Paid';
  } else if (this.amount_paid > 0) {
    this.status = 'Partial';
  } else if (new Date() > this.due_date && this.status !== 'Paid') {
    this.status = 'Overdue';
  }
  
  next();
});

// Virtual for total items count
invoiceSchema.virtual('total_items').get(function() {
  return this.service_items.length + this.medicine_items.length + this.procedure_items.length;
});

// Virtual for is_fully_paid
invoiceSchema.virtual('is_fully_paid').get(function() {
  return this.amount_paid >= this.total;
});

// Virtual for pending procedures count
invoiceSchema.virtual('pending_procedures_count').get(function() {
  if (!this.has_procedures) return 0;
  return this.procedure_items.filter(p => p.status === 'Pending').length;
});

// Indexes
invoiceSchema.index({ invoice_number: 1 });
invoiceSchema.index({ patient_id: 1, issue_date: -1 });
invoiceSchema.index({ appointment_id: 1 });
invoiceSchema.index({ prescription_id: 1 });
invoiceSchema.index({ invoice_type: 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ 'procedure_items.status': 1 });

module.exports = mongoose.model('Invoice', invoiceSchema);