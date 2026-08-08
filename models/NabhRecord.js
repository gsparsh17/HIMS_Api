'use strict';

const mongoose = require('mongoose');

const checklistItemSchema = new mongoose.Schema({
  code: { type: String, trim: true },
  label: { type: String, required: true, trim: true },
  sourceStep: { type: String, trim: true },
  status: {
    type: String,
    enum: ['pending', 'done', 'not_applicable', 'failed'],
    default: 'pending'
  },
  notes: { type: String, trim: true },
  evidence: [{
    name: String,
    url: String,
    mimeType: String,
    checksum: String,
    capturedAt: { type: Date, default: Date.now }
  }],
  completedAt: Date,
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const timelineItemSchema = new mongoose.Schema({
  event: { type: String, required: true, trim: true },
  fromStatus: String,
  toStatus: String,
  notes: String,
  data: mongoose.Schema.Types.Mixed,
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const nabhRecordSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    index: true
  },
  recordNumber: { type: String, required: true, trim: true, uppercase: true },
  testCaseIds: { type: [String], default: [], index: true },
  domain: {
    type: String,
    enum: ['AAC', 'COP', 'MOM', 'DAC', 'DOM', 'FPM', 'HRM', 'IMS'],
    required: true,
    index: true
  },
  workflowType: { type: String, required: true, trim: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  objective: { type: String, trim: true },
  expectedOutcome: { type: String, trim: true },
  sourcePages: { type: String, trim: true },

  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, index: true },
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClaimCase', index: true },
  relatedRecordIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'NabhRecord' }],

  status: {
    type: String,
    enum: [
      'draft', 'open', 'scheduled', 'in_progress', 'pending_review',
      'approved', 'completed', 'cancelled', 'rejected', 'archived'
    ],
    default: 'open',
    index: true
  },
  priority: {
    type: String,
    enum: ['low', 'routine', 'urgent', 'critical'],
    default: 'routine',
    index: true
  },
  source: { type: String, default: 'nabh_workspace', trim: true },
  externalReference: { type: String, trim: true },
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  dueAt: Date,
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  checklist: { type: [checklistItemSchema], default: [] },
  timeline: { type: [timelineItemSchema], default: [] },
  tags: { type: [String], default: [] },
  attachments: [{
    name: String,
    url: String,
    mimeType: String,
    checksum: String,
    addedAt: { type: Date, default: Date.now },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],

  finalisedAt: Date,
  finalisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amendmentOf: { type: mongoose.Schema.Types.ObjectId, ref: 'NabhRecord' },
  amendmentReason: String,
  version: { type: Number, default: 1 },
  archivedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

nabhRecordSchema.index({ hospitalId: 1, recordNumber: 1 }, { unique: true });
nabhRecordSchema.index({ hospitalId: 1, workflowType: 1, status: 1, createdAt: -1 });
nabhRecordSchema.index({ hospitalId: 1, patientId: 1, createdAt: -1 });
nabhRecordSchema.index({ hospitalId: 1, staffId: 1, createdAt: -1 });

module.exports = mongoose.model('NabhRecord', nabhRecordSchema);
