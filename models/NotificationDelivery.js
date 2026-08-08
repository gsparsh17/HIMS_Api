'use strict';

const mongoose = require('mongoose');

const attemptSchema = new mongoose.Schema({
  channel: String,
  provider: String,
  attemptedAt: { type: Date, default: Date.now },
  success: Boolean,
  statusCode: Number,
  providerMessageId: String,
  response: mongoose.Schema.Types.Mixed,
  error: String
}, { _id: true });

const notificationDeliverySchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    index: true
  },
  eventType: { type: String, required: true, index: true },
  correlationId: { type: String, trim: true, index: true },
  recipientType: {
    type: String,
    enum: ['patient', 'doctor', 'staff', 'supplier', 'facility', 'external'],
    default: 'external'
  },
  recipientId: mongoose.Schema.Types.ObjectId,
  recipientName: String,
  contact: {
    email: String,
    phone: String,
    portalUserId: mongoose.Schema.Types.ObjectId,
    webhookUrl: String
  },
  requestedChannels: {
    type: [String],
    enum: ['portal', 'email', 'sms', 'whatsapp', 'webhook'],
    default: ['portal']
  },
  subject: String,
  body: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'critical'],
    default: 'normal'
  },
  requireAcknowledgement: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['queued', 'sending', 'sent', 'partially_sent', 'failed', 'acknowledged', 'cancelled'],
    default: 'queued',
    index: true
  },
  attempts: { type: [attemptSchema], default: [] },
  retryCount: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  sentAt: Date,
  acknowledgedAt: Date,
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acknowledgementNote: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

notificationDeliverySchema.index({ hospitalId: 1, status: 1, nextAttemptAt: 1 });
notificationDeliverySchema.index({ hospitalId: 1, correlationId: 1, eventType: 1 });

module.exports = mongoose.model('NotificationDelivery', notificationDeliverySchema);
