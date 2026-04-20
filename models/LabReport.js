const mongoose = require('mongoose');

const labReportSchema = new mongoose.Schema({
  patient_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Patient', 
    required: true 
  },
  doctor_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Doctor' 
  },
  prescription_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Prescription' 
  },
  lab_test_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'LabTest' 
  },
  report_type: { 
    type: String, 
    required: true 
  },
  file_url: { 
    type: String 
  },
  public_id: { 
    type: String 
  },
  report_date: { 
    type: Date, 
    required: true,
    default: Date.now
  },
  notes: { 
    type: String 
  },
  created_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
  // ========== EXTERNAL LAB FIELDS ==========
  is_external: {
    type: Boolean,
    default: false
  },
  external_lab_name: {
    type: String,
    trim: true
  },
  external_reference_number: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes
labReportSchema.index({ patient_id: 1, report_date: -1 });
labReportSchema.index({ prescription_id: 1 });
labReportSchema.index({ lab_test_id: 1 });
labReportSchema.index({ is_external: 1 });

module.exports = mongoose.model('LabReport', labReportSchema);