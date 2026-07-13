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
  abdmRecordLink: {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    abhaNumber: { type: String, index: true },
    abhaAddress: { type: String, index: true },
    status: { type: String, enum: ['pending_abha', 'linked', 'ready_for_consent', 'shared', 'LOCAL_RECORD_READY', 'VERIFICATION_PENDING', 'ABDM_LINK_PENDING', 'ABDM_LINKED', 'ABDM_LINK_FAILED'], default: 'pending_abha' },
    linkedAt: Date,
    source: String,
    ehrBundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'EHRBundle' }
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
labReportSchema.index({ 'abdmRecordLink.abhaNumber': 1 });
labReportSchema.index({ 'abdmRecordLink.abhaAddress': 1 });

module.exports = mongoose.model('LabReport', labReportSchema);