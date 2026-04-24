const mongoose = require('mongoose');

const nursingNoteSchema = new mongoose.Schema({
  admissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission',
    required: true,
    index: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true
  },
  nurseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse',
    required: true
  },
  noteDateTime: {
    type: Date,
    default: Date.now
  },
  noteType: {
    type: String,
    enum: ['General', 'Shift Note', 'Critical Alert', 'Medication', 'Procedure', 'Handover', 'Assessment'],
    default: 'General'
  },
  note: {
    type: String,
    required: true,
    trim: true
  },
  priority: {
    type: String,
    enum: ['Normal', 'Important', 'Critical'],
    default: 'Normal'
  },
  shift: {
    type: String,
    enum: ['Morning', 'Evening', 'Night'],
    default: 'Morning'
  },
  shiftHandoverFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse'
  },
  shiftHandoverTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse'
  },
  attachments: [{
    type: String
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes
nursingNoteSchema.index({ admissionId: 1, noteDateTime: -1 });
nursingNoteSchema.index({ nurseId: 1, shift: 1 });

module.exports = mongoose.model('NursingNote', nursingNoteSchema);