const mongoose = require('mongoose');

const bedTransferSchema = new mongoose.Schema({
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
  fromBedId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bed',
    required: true
  },
  fromRoomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room'
  },
  fromWardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ward'
  },
  toBedId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bed',
    required: true
  },
  toRoomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room'
  },
  toWardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ward'
  },
  transferDateTime: {
    type: Date,
    default: Date.now
  },
  reason: {
    type: String,
    enum: ['Clinical', 'Upgrade', 'Downgrade', 'Emergency', 'Maintenance', 'Other'],
    required: true
  },
  reasonDetails: {
    type: String,
    trim: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Completed', 'Cancelled'],
    default: 'Pending'
  },
  notes: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Indexes
bedTransferSchema.index({ admissionId: 1, transferDateTime: -1 });
bedTransferSchema.index({ fromBedId: 1, toBedId: 1 });
bedTransferSchema.index({ status: 1 });

module.exports = mongoose.model('BedTransfer', bedTransferSchema);