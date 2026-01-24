const mongoose = require('mongoose');

const prescriptionItemSchema = new mongoose.Schema({
  medicine_name: { 
    type: String, 
    required: true, 
    trim: true 
  },
  generic_name: { 
    type: String, 
    trim: true 
  },
  medicine_type: { 
    type: String, 
    enum: {
      values: ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 'Drops', 'Inhaler', 'Other', ''],
      message: 'Please select a valid medicine type'
    },
    trim: true,
    default: ''
  },
  route_of_administration: { 
    type: String, 
    enum: {
      values: [
        "Oral",
        "Sublingual",
        "Intramuscular Injection",
        "Intravenous Injection",
        "Subcutaneous Injection",
        "Topical Application",
        "Inhalation",
        "Nasal",
        "Eye Drops",
        "Ear Drops",
        "Rectal",
        "Other"
      ],
      message: 'Please select a valid route of administration'
    },
    trim: true,
    default: ''
  },
  dosage: { 
    type: String, 
    required: false 
  },
  frequency: { 
    type: String, 
    required: true 
  },
  duration: { 
    type: String, 
    required: true 
  },
  quantity: { 
    type: Number, 
    required: false, 
    min: 1 
  },
  instructions: { 
    type: String, 
    trim: true 
  },
  timing: { 
    type: String, 
    enum: ['Before food', 'After food', 'With food', 'Anytime'] 
  },
  is_dispensed: { 
    type: Boolean, 
    default: false 
  },
  dispensed_quantity: { 
    type: Number, 
    default: 0 
  },
  dispensed_date: { 
    type: Date 
  }
});

const recommendedProcedureSchema = new mongoose.Schema({
  procedure_code: {
    type: String,
    required: true,
    trim: true
  },
  procedure_name: {
    type: String,
    required: true,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['Pending', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'],
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
  cost: {
    type: Number,
    default: 0
  },
  is_billed: {
    type: Boolean,
    default: false
  },
  invoice_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  }
});

const prescriptionSchema = new mongoose.Schema({
  prescription_number: { 
    type: String, 
    unique: true 
  },
  patient_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Patient', 
    required: true 
  },
  doctor_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Doctor', 
    required: true 
  },
  appointment_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Appointment' 
  },
  diagnosis: { 
    type: String, 
    trim: true 
  },
  symptoms: { 
    type: String, 
    trim: true 
  },
  investigation: {
    type: String,
    trim: true
  },
  items: [prescriptionItemSchema],
  recommendedProcedures: [recommendedProcedureSchema],
  notes: { 
    type: String, 
    trim: true 
  },
  prescription_image: { 
    type: String 
  },
  status: { 
    type: String, 
    enum: ['Active', 'Completed', 'Cancelled', 'Expired'], 
    default: 'Active' 
  },
  issue_date: { 
    type: Date, 
    default: Date.now 
  },
  validity_days: { 
    type: Number, 
    default: 30 
  },
  follow_up_date: { 
    type: Date 
  },
  is_repeatable: { 
    type: Boolean, 
    default: false 
  },
  repeat_count: { 
    type: Number, 
    default: 0 
  },
  created_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
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

// Generate prescription number before saving
prescriptionSchema.pre('save', async function(next) {
  if (this.isNew && !this.prescription_number) {
    const count = await mongoose.model('Prescription').countDocuments();
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    this.prescription_number = `RX${year}${month}${(count + 1).toString().padStart(4, '0')}`;
  }
  
  // Update procedures related fields
  if (this.recommendedProcedures && this.recommendedProcedures.length > 0) {
    this.has_procedures = true;
    
    // Calculate procedures status
    const totalProcedures = this.recommendedProcedures.length;
    const completedProcedures = this.recommendedProcedures.filter(p => p.status === 'Completed').length;
    
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
  
  next();
});

// Calculate expiry date virtual
prescriptionSchema.virtual('expiry_date').get(function() {
  const expiryDate = new Date(this.issue_date);
  expiryDate.setDate(expiryDate.getDate() + this.validity_days);
  return expiryDate;
});

// Check if prescription is expired
prescriptionSchema.virtual('is_expired').get(function() {
  return new Date() > this.expiry_date;
});

// Check if all items are dispensed
prescriptionSchema.virtual('is_fully_dispensed').get(function() {
  return this.items.every(item => item.is_dispensed);
});

// Check if all procedures are completed
prescriptionSchema.virtual('are_procedures_completed').get(function() {
  if (!this.has_procedures) return true;
  return this.recommendedProcedures.every(proc => proc.status === 'Completed');
});

// Virtual for pending procedures count
prescriptionSchema.virtual('pending_procedures_count').get(function() {
  if (!this.has_procedures) return 0;
  return this.recommendedProcedures.filter(p => p.status === 'Pending').length;
});

// Virtual for today's procedures
prescriptionSchema.virtual('todays_procedures').get(function() {
  if (!this.has_procedures) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return this.recommendedProcedures.filter(p => {
    if (!p.scheduled_date) return false;
    const scheduledDate = new Date(p.scheduled_date);
    scheduledDate.setHours(0, 0, 0, 0);
    return scheduledDate.getTime() === today.getTime() && p.status !== 'Completed';
  });
});

// Index for better query performance
prescriptionSchema.index({ patient_id: 1, issue_date: -1 });
prescriptionSchema.index({ doctor_id: 1, issue_date: -1 });
prescriptionSchema.index({ prescription_number: 1 });
prescriptionSchema.index({ status: 1 });
prescriptionSchema.index({ 'recommendedProcedures.status': 1 });
prescriptionSchema.index({ 'recommendedProcedures.scheduled_date': 1 });

module.exports = mongoose.model('Prescription', prescriptionSchema);