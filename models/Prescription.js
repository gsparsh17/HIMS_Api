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
  medicine_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine'
  },
  medicine_type: {
    type: String,
    enum: ['Capsule', 'Tablet', 'Injection', 'Syrup', 'Cream', 'Ointment', 'Drops', 'Inhaler', 'Other'],
    trim: true,
    default: 'Tablet'
  },
  route_of_administration: {
    type: String,
    enum: ["Oral", "Sublingual", "Intramuscular Injection", "Intravenous Injection", 
             "Subcutaneous Injection", "Topical Application", "Inhalation", "Nasal", 
             "Eye Drops", "Ear Drops", "Rectal", "Other"],
    trim: true,
    default: 'Oral'
  },
  dosage: { type: String },
  frequency: { type: String, required: true },
  duration: { type: String, required: true },
  quantity: { type: Number, min: 1, default: 1 },
  instructions: { type: String, trim: true },
  timing: { type: String, enum: ['Before food', 'After food', 'With food', 'Anytime'] },
  is_dispensed: { type: Boolean, default: false },
  dispensed_quantity: { type: Number, default: 0 },
  dispensed_date: { type: Date }
});

// Lab Test Request Schema (embedded but creates separate LabRequest)
const labTestRequestSchema = new mongoose.Schema({
  lab_test_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabTest'
  },
  lab_test_code: { type: String, required: true },
  lab_test_name: { type: String, required: true },
  category: { type: String },
  clinical_history: { type: String, trim: true },
  priority: { type: String, enum: ['Routine', 'Urgent', 'Stat'], default: 'Routine' },
  scheduled_date: { type: Date },
  notes: { type: String, trim: true },
  request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LabRequest' }, // Reference to created LabRequest
  created_at: { type: Date, default: Date.now }
});

// Radiology/Imaging Test Request Schema
const radiologyTestRequestSchema = new mongoose.Schema({
  imaging_test_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImagingTest'
  },
  imaging_test_code: { type: String, required: true },
  imaging_test_name: { type: String, required: true },
  category: { type: String },
  clinical_history: { type: String, trim: true },
  priority: { type: String, enum: ['Routine', 'Urgent', 'Emergency'], default: 'Routine' },
  scheduled_date: { type: Date },
  notes: { type: String, trim: true },
  request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'RadiologyRequest' }, // Reference to created RadiologyRequest
  created_at: { type: Date, default: Date.now }
});

// Procedure Request Schema
const procedureRequestSchema = new mongoose.Schema({
  procedure_code: { type: String, required: true },
  procedure_name: { type: String, required: true },
  category: { type: String },
  notes: { type: String, trim: true },
  priority: { type: String, enum: ['Routine', 'Urgent', 'Emergency'], default: 'Routine' },
  scheduled_date: { type: Date },
  cost: { type: Number, default: 0 },
  request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcedureRequest' }, // Reference to created ProcedureRequest
  created_at: { type: Date, default: Date.now }
});

const prescriptionSchema = new mongoose.Schema({
  prescription_number: { type: String, unique: true },
  
  // Patient & Doctor
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  appointment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  
  // IPD Support
  ipd_admission_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission' },
  source_type: { type: String, enum: ['OPD', 'IPD', 'Emergency'], default: 'OPD' },
  round_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDRound' },
  
  // Clinical Information
  presenting_complaint: { type: String, trim: true },
  history_of_presenting_complaint: { type: String, trim: true },
  diagnosis: { type: String, trim: true },
  diagnosis_icd11_code: { type: String, trim: true, index: true },
  symptoms: { type: String, trim: true },
  investigation: { type: String, trim: true },

  // Medication Items
  items: [prescriptionItemSchema],

  // Test Requests (with request_id references)
  lab_test_requests: [labTestRequestSchema],
  radiology_test_requests: [radiologyTestRequestSchema],
  procedure_requests: [procedureRequestSchema],

  notes: { type: String, trim: true },
  prescription_image: { type: String },
  status: { type: String, enum: ['Active', 'Completed', 'Cancelled', 'Expired'], default: 'Active' },
  issue_date: { type: Date, default: Date.now },
  validity_days: { type: Number, default: 30 },
  follow_up_date: { type: Date },
  is_repeatable: { type: Boolean, default: false },
  repeat_count: { type: Number, default: 0 },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Pharmacy Integration
  is_converted_to_ipd: { type: Boolean, default: false },
  ipd_medication_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'IPDMedicationChart' }]
}, { timestamps: true });

// Generate prescription number
prescriptionSchema.pre('save', async function(next) {
  if (this.isNew && !this.prescription_number) {
    const count = await mongoose.model('Prescription').countDocuments();
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    this.prescription_number = `RX${year}${month}${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

// Virtuals
prescriptionSchema.virtual('is_expired').get(function() {
  const expiryDate = new Date(this.issue_date);
  expiryDate.setDate(expiryDate.getDate() + this.validity_days);
  return new Date() > expiryDate;
});

prescriptionSchema.virtual('is_fully_dispensed').get(function() {
  return this.items.every(item => item.is_dispensed);
});

// Indexes
prescriptionSchema.index({ patient_id: 1, issue_date: -1 });
prescriptionSchema.index({ doctor_id: 1, issue_date: -1 });
prescriptionSchema.index({ prescription_number: 1 });
prescriptionSchema.index({ status: 1 });
prescriptionSchema.index({ diagnosis_icd11_code: 1 });
prescriptionSchema.index({ ipd_admission_id: 1, source_type: 1 });
prescriptionSchema.index({ 'lab_test_requests.request_id': 1 });
prescriptionSchema.index({ 'radiology_test_requests.request_id': 1 });
prescriptionSchema.index({ 'procedure_requests.request_id': 1 });

module.exports = mongoose.model('Prescription', prescriptionSchema);