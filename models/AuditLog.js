const mongoose = require('mongoose');

const actorSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: String,
  email: String,
  role: String,
}, { _id: false });

const requestSchema = new mongoose.Schema({
  method: { type: String, required: true, index: true },
  originalUrl: { type: String, required: true, index: true },
  baseUrl: String,
  path: String,
  params: mongoose.Schema.Types.Mixed,
  query: mongoose.Schema.Types.Mixed,
  body: mongoose.Schema.Types.Mixed,
  headers: mongoose.Schema.Types.Mixed,
  ip: { type: String, index: true },
  userAgent: String,
}, { _id: false });

const responseSchema = new mongoose.Schema({
  statusCode: { type: Number, index: true },
  success: { type: Boolean, index: true },
  responseTimeMs: Number,
}, { _id: false });

const auditLogSchema = new mongoose.Schema({
  requestId: { type: String, required: true, index: true },
  actor: actorSchema,
  request: requestSchema,
  response: responseSchema,
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  resource: {
    type: { type: String },
    id: String,
  },
  error: {
    message: String,
    stack: String,
  },
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ 'actor.email': 1, createdAt: -1 });
auditLogSchema.index({ 'actor.role': 1, createdAt: -1 });
auditLogSchema.index({ 'request.method': 1, 'request.originalUrl': 1, createdAt: -1 });
auditLogSchema.index({ 'response.statusCode': 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
