const mongoose = require('mongoose');

const domainEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  eventType: { type: String, required: true, index: true },
  occurredAt: { type: Date, default: Date.now, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  encounterId: { type: mongoose.Schema.Types.ObjectId, index: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  actorRole: { type: String, trim: true },
  sourceIp: { type: String, trim: true },
  userAgent: { type: String, trim: true },
  entityType: { type: String, required: true, trim: true, index: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  revision: { type: Number, default: 1 },
  beforeSummary: mongoose.Schema.Types.Mixed,
  afterSummary: mongoose.Schema.Types.Mixed,
  reasonCode: { type: String, trim: true },
  comments: { type: String, trim: true },
  correlationId: { type: String, trim: true, index: true },
  metadata: mongoose.Schema.Types.Mixed
}, { timestamps: false, versionKey: false });

domainEventSchema.index({ hospitalId: 1, eventType: 1, occurredAt: -1 });
domainEventSchema.index({ hospitalId: 1, entityType: 1, entityId: 1, occurredAt: -1 });

module.exports = mongoose.model('DomainEvent', domainEventSchema);
