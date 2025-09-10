const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  amount: { type: Number, required: true },
  method: { 
    type: String, 
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme'],
    required: true 
  },
  reference: { type: String },
  status: { type: String, default: 'Completed' },
  collected_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

const serviceItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity: { type: Number, default: 1 },
  unit_price: { type: Number, required: true },
  total_price: { type: Number, required: true },
  tax_rate: { type: Number, default: 0 },
  tax_amount: { type: Number, default: 0 },
  // For appointment/services
  service_type: { type: String, enum: ['Consultation', 'Procedure', 'Test', 'Other', 'Purchase'] }
});

const medicineItemSchema = new mongoose.Schema({
  medicine_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine' },
  batch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
  medicine_name: { type: String, required: true },
  batch_number: { type: String },
  expiry_date: { type: Date },
  quantity: { type: Number, required: true },
  unit_price: { type: Number, required: true },
  total_price: { type: Number, required: true },
  tax_rate: { type: Number, default: 0 },
  tax_amount: { type: Number, default: 0 },
  prescription_required: { type: Boolean, default: false },
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' }
});

const invoiceSchema = new mongoose.Schema({
  invoice_number: { type: String, unique: true },
  
  // Customer Information
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  customer_type: { 
    type: String, 
    enum: ['Patient', 'Walk-in', 'Insurance', 'Corporate', 'Supplier', 'Other'], 
    required: true 
  },
  customer_name: { type: String },
  customer_phone: { type: String },
  customer_address: { type: String },
  
  // Reference Links
  appointment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  bill_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
  sale_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  
  // Invoice Type
  invoice_type: { 
    type: String, 
    enum: ['Appointment', 'Pharmacy', 'Mixed', 'Other', 'Purchase'], 
    required: true 
  },
  
  // Dates
  issue_date: { type: Date, default: Date.now },
  due_date: { type: Date, required: true },
  
  // Items - Can contain both services and medicines
  service_items: [serviceItemSchema],
  medicine_items: [medicineItemSchema],
  
  // Financial details
  subtotal: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
  
  // Payment tracking
  amount_paid: { type: Number, default: 0 },
  balance_due: { type: Number, default: function() { return this.total; } },
  payment_history: [paymentSchema],
  
  // Status
  status: { 
    type: String, 
    enum: ['Draft', 'Issued', 'Paid', 'Partial', 'Overdue', 'Cancelled', 'Refunded'],
    default: 'Draft' 
  },
  
  // Additional fields
  notes: { type: String },
  terms_and_conditions: { type: String },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Pharmacy specific
  is_pharmacy_sale: { type: Boolean, default: false },
  dispensing_date: { type: Date },
  dispensed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Generate invoice number
invoiceSchema.pre('save', async function(next) {
  if (this.isNew && !this.invoice_number) {
    const count = await mongoose.model('Invoice').countDocuments();
    const year = new Date().getFullYear();
    const prefix = this.invoice_type === 'Pharmacy' ? 'PH-INV' : 'MED-INV';
    this.invoice_number = `${prefix}-${year}-${(count + 1).toString().padStart(5, '0')}`;
  }
  next();
});

// Update balance due and auto-detect invoice type
invoiceSchema.pre('save', function(next) {
  this.balance_due = this.total - this.amount_paid;
  
  // Auto-detect invoice type based on items
  if (this.medicine_items.length > 0 && this.service_items.length > 0) {
    this.invoice_type = 'Mixed';
    this.is_pharmacy_sale = true;
  } else if (this.medicine_items.length > 0) {
    this.invoice_type = 'Pharmacy';
    this.is_pharmacy_sale = true;
  } else if (this.service_items.length > 0) {
    this.invoice_type = 'Appointment';
    this.is_pharmacy_sale = false;
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
  return this.service_items.length + this.medicine_items.length;
});

// Virtual for is_fully_paid
invoiceSchema.virtual('is_fully_paid').get(function() {
  return this.amount_paid >= this.total;
});

module.exports = mongoose.model('Invoice', invoiceSchema);