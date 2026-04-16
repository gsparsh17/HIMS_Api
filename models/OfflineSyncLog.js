const mongoose = require('mongoose');

const offlineSyncLogSchema = new mongoose.Schema({
  // Reference to frontend's localId
  localId: {
    type: String,
    required: true,
    index: true
  },
  
  // Type of entity
  entityType: {
    type: String,
    required: true,
    enum: ['PATIENT', 'APPOINTMENT', 'VITALS', 'PRESCRIPTION']
  },
  
  // Operation type
  operationType: {
    type: String,
    required: true,
    enum: ['CREATE', 'UPDATE', 'DELETE']
  },
  
  // The actual data that was synced
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  
  // Sync status
  status: {
    type: String,
    enum: ['PENDING', 'SYNCED', 'FAILED', 'CONFLICT'],
    default: 'PENDING'
  },
  
  // Server generated IDs after sync
  serverId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'entityType'
  },
  
  // For patient-appointment linking
  tempPatientId: {
    type: String,
    index: true
  },
  
  tempAppointmentId: {
    type: String,
    index: true
  },
  
  // Error tracking
  errorMessage: String,
  retryCount: {
    type: Number,
    default: 0
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  syncedAt: Date
});

// Index for efficient querying
offlineSyncLogSchema.index({ status: 1, createdAt: 1 });
offlineSyncLogSchema.index({ entityType: 1, status: 1 });

module.exports = mongoose.model('OfflineSyncLog', offlineSyncLogSchema);