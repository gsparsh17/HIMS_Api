const mongoose = require('mongoose');

const rowSchema = new mongoose.Schema({
  rowNumber: Number,
  action: { type: String, enum: ['create', 'update', 'skip', 'invalid'] },
  naturalKey: String,
  errors: [String],
  warnings: [String],
  data: mongoose.Schema.Types.Mixed,
  targetId: mongoose.Schema.Types.ObjectId,
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed
}, { _id: false });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  entity: {
    type: String,
    enum: ['employees', 'medicines', 'lab-tests', 'radiology-tests', 'charges', 'procedures', 'patients', 'appointments', 'ipd-admissions'],
    required: true
  },
  status: {
    type: String,
    enum: ['previewing', 'preview_ready', 'committing', 'committed', 'failed', 'rolled_back'],
    default: 'previewing',
    index: true
  },
  templateVersion: { type: String, default: '2026.07' },
  originalFileName: String,
  fileHash: { type: String, index: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mode: {
    type: String,
    enum: ['CREATE_ONLY', 'UPDATE_BY_KEY'],
    default: 'CREATE_ONLY'
  },
  idempotencyKey: { type: String, required: true, index: true },
  summary: {
    validNew: { type: Number, default: 0 },
    validUpdates: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    invalid: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 }
  },
  rows: [rowSchema],
  commitAt: Date,
  committedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rollbackAt: Date,
  rolledBackBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  error: String
}, { timestamps: true });

schema.index({ hospitalId: 1, entity: 1, idempotencyKey: 1 }, { unique: true });

module.exports = mongoose.model('BulkImportJob', schema);