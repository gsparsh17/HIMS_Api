const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  bedId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bed' },
  effectiveAt: Date
}, { _id: false });

const ipdBedTransferSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  transferNumber: { type: String, required: true },
  source: { type: String, enum: ['manual', 'ot', 'emergency', 'initial_location', 'system_migration'], default: 'manual' },
  idempotencyKey: { type: String, sparse: true },
  from: { type: locationSchema, required: true },
  to: { type: locationSchema, required: true },
  requestedEffectiveAt: Date,
  actualEffectiveAt: Date,
  clinical: {
    reason: { type: String, required: true },
    diagnosisContext: String,
    priority: { type: String, enum: ['routine', 'urgent', 'emergency'], default: 'routine' },
    patientCondition: String,
    isolationRequired: Boolean,
    oxygenRequired: Boolean,
    equipmentNeeds: [String],
    genderPolicy: String
  },
  status: { type: String, enum: ['Requested', 'Reserved', 'Approved', 'In Transfer', 'Completed', 'Cancelled', 'Rejected'], default: 'Requested', index: true },
  people: {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reservedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  timeline: [{ status: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: String }],
  handover: {
    note: String,
    belongings: [String],
    pendingMedications: [String],
    pendingInvestigations: [String],
    sourceNurseAcknowledgedAt: Date,
    receivingNurseAcknowledgedAt: Date,
    conditionOnArrival: String
  },
  reservation: { reservedAt: Date, expiresAt: Date, releasedAt: Date },
  billing: {
    oldSegmentId: { type: mongoose.Schema.Types.ObjectId },
    newSegmentId: { type: mongoose.Schema.Types.ObjectId },
    oldSegmentEndedAt: Date,
    newSegmentStartedAt: Date,
    chargeGenerationStatus: { type: String, enum: ['pending', 'completed', 'failed', 'not_required'], default: 'pending' },
    error: String
  },
  cancellation: { reason: String, cancelledAt: Date, cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
  revision: { type: Number, default: 1 },
  correlationId: String
}, { timestamps: true });

ipdBedTransferSchema.index({ hospitalId: 1, transferNumber: 1 }, { unique: true });
ipdBedTransferSchema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
ipdBedTransferSchema.index({ hospitalId: 1, 'to.bedId': 1, status: 1 });

module.exports = mongoose.model('IPDBedTransfer', ipdBedTransferSchema);
