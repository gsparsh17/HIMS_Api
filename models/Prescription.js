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

// ✅ NEW: Recommended Lab Tests (mirrors procedures)
const recommendedLabTestSchema = new mongoose.Schema({
  lab_test_code: {
    type: String,
    required: true,
    trim: true
  },
  lab_test_name: {
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
    enum: ['Pending', 'Scheduled', 'Sample Collected', 'Processing', 'Completed', 'Cancelled'],
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
  },
  report_url: {
    type: String
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
  presenting_complaint: {
    type: String,
    trim: true
  },
  history_of_presenting_complaint: {
    type: String,
    trim: true
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

  // Procedures + Lab Tests
  recommendedProcedures: [recommendedProcedureSchema],
  recommendedLabTests: [recommendedLabTestSchema],

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

  // Procedure flags
  has_procedures: {
    type: Boolean,
    default: false
  },
  procedures_status: {
    type: String,
    enum: ['None', 'Pending', 'Partial', 'Completed'],
    default: 'None'
  },

  // ✅ Lab test flags
  has_lab_tests: {
    type: Boolean,
    default: false
  },
  lab_tests_status: {
    type: String,
    enum: ['None', 'Pending', 'Partial', 'Completed'],
    default: 'None'
  },

  // Optional totals (helps billing/UI)
  total_procedure_cost: {
    type: Number,
    default: 0
  },
  total_lab_test_cost: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Generate prescription number + update statuses + totals before saving
prescriptionSchema.pre('save', async function(next) {
  if (this.isNew && !this.prescription_number) {
    const count = await mongoose.model('Prescription').countDocuments();
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    this.prescription_number = `RX${year}${month}${(count + 1).toString().padStart(4, '0')}`;
  }

  // ---- Procedures ----
  if (this.recommendedProcedures && this.recommendedProcedures.length > 0) {
    this.has_procedures = true;

    const totalProcedures = this.recommendedProcedures.length;
    const completedProcedures = this.recommendedProcedures.filter(p => p.status === 'Completed').length;

    if (completedProcedures === 0) {
      this.procedures_status = 'Pending';
    } else if (completedProcedures === totalProcedures) {
      this.procedures_status = 'Completed';
    } else {
      this.procedures_status = 'Partial';
    }

    this.total_procedure_cost = this.recommendedProcedures.reduce((sum, p) => sum + (Number(p.cost) || 0), 0);
  } else {
    this.has_procedures = false;
    this.procedures_status = 'None';
    this.total_procedure_cost = 0;
  }

  // ---- Lab Tests ----
  if (this.recommendedLabTests && this.recommendedLabTests.length > 0) {
    this.has_lab_tests = true;

    const totalLabTests = this.recommendedLabTests.length;
    const completedLabTests = this.recommendedLabTests.filter(t => t.status === 'Completed').length;

    if (completedLabTests === 0) {
      this.lab_tests_status = 'Pending';
    } else if (completedLabTests === totalLabTests) {
      this.lab_tests_status = 'Completed';
    } else {
      this.lab_tests_status = 'Partial';
    }

    this.total_lab_test_cost = this.recommendedLabTests.reduce((sum, t) => sum + (Number(t.cost) || 0), 0);
  } else {
    this.has_lab_tests = false;
    this.lab_tests_status = 'None';
    this.total_lab_test_cost = 0;
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

// ✅ Check if all lab tests are completed
prescriptionSchema.virtual('are_lab_tests_completed').get(function() {
  if (!this.has_lab_tests) return true;
  return this.recommendedLabTests.every(t => t.status === 'Completed');
});

// Virtual for pending procedures count
prescriptionSchema.virtual('pending_procedures_count').get(function() {
  if (!this.has_procedures) return 0;
  return this.recommendedProcedures.filter(p => p.status === 'Pending').length;
});

// ✅ Virtual for pending lab tests count
prescriptionSchema.virtual('pending_lab_tests_count').get(function() {
  if (!this.has_lab_tests) return 0;
  return this.recommendedLabTests.filter(t => t.status === 'Pending').length;
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

// ✅ Virtual for today's lab tests
prescriptionSchema.virtual('todays_lab_tests').get(function() {
  if (!this.has_lab_tests) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return this.recommendedLabTests.filter(t => {
    if (!t.scheduled_date) return false;
    const scheduledDate = new Date(t.scheduled_date);
    scheduledDate.setHours(0, 0, 0, 0);
    return scheduledDate.getTime() === today.getTime() && t.status !== 'Completed';
  });
});

// Indexes
prescriptionSchema.index({ patient_id: 1, issue_date: -1 });
prescriptionSchema.index({ doctor_id: 1, issue_date: -1 });
prescriptionSchema.index({ prescription_number: 1 });
prescriptionSchema.index({ status: 1 });

prescriptionSchema.index({ 'recommendedProcedures.status': 1 });
prescriptionSchema.index({ 'recommendedProcedures.scheduled_date': 1 });

prescriptionSchema.index({ 'recommendedLabTests.status': 1 });
prescriptionSchema.index({ 'recommendedLabTests.scheduled_date': 1 });

module.exports = mongoose.model('Prescription', prescriptionSchema);
