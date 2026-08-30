const mongoose = require('mongoose');
const { addSoftDeleteFields } = require('../utils/softDelete');
const { operationNow } = require('../utils/operationTimeContext');

const nursingNoteSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    index: true
  },
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
    ref: 'Nurse'
  },
  // Authentication/audit identity is always a User. nurseId remains an
  // optional professional-profile reference for legacy reports/population.
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  actorRole: { type: String, trim: true },
  actorNameSnapshot: { type: String, trim: true },
  noteDateTime: {
    type: Date,
    default: operationNow
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
  copiedFromNoteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'NursingNote'
  },
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

addSoftDeleteFields(nursingNoteSchema);

module.exports = mongoose.model('NursingNote', nursingNoteSchema);