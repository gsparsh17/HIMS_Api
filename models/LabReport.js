// models/LabReport.js
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
    ref: 'PathologyStaff' 
  }
}, {
  timestamps: true
});

// Index for better query performance
labReportSchema.index({ patient_id: 1, report_date: -1 });
labReportSchema.index({ prescription_id: 1 });
labReportSchema.index({ lab_test_id: 1 });

module.exports = mongoose.model('LabReport', labReportSchema);