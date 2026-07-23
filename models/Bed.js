const mongoose = require('mongoose');

const bedSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  bedNumber: {
    type: String,
    required: true,
    trim: true
  },
  bedCode: {
    type: String,
    uppercase: true,
    trim: true
  },
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true
  },
  wardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ward'
  },
  bedType: {
    type: String,
    enum: ['General', 'Semi Private', 'Private', 'ICU', 'Emergency', 'NICU', 'Deluxe'],
    required: true
  },
  status: {
    type: String,
    enum: ['Available', 'Occupied', 'Reserved', 'Cleaning', 'Maintenance'],
    default: 'Available'
  },
  currentAdmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission'
  },
  reservedTransferId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDBedTransfer', index: true },
  reservationExpiresAt: Date,
  cleaningStartedAt: Date,
  cleaningCompletedAt: Date,
  cleaningNote: String,
  genderPolicy: { type: String, enum: ['any', 'male', 'female'], default: 'any' },
  isolationCapable: { type: Boolean, default: false },
  equipmentFeatures: [String],
  dailyCharge: {
    type: Number,
    default: 0,
    min: 0
  },
  features: [{
    type: String,
    trim: true
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Generate bed code before validate (to ensure code is generated before validation)
bedSchema.pre('validate', async function(next) {
  if (!this.bedCode && this.bedNumber) {
    try {
      const Bed = mongoose.model('Bed');
      const count = await Bed.countDocuments();
      // Generate code: BED0001, BED0002, etc.
      this.bedCode = `BED${String(count + 1).padStart(4, '0')}`;
      next();
    } catch (error) {
      next(error);
    }
  } else {
    next();
  }
});

// Indexes
bedSchema.index({ hospitalId: 1, status: 1, wardId: 1, bedType: 1 });
bedSchema.index({ hospitalId: 1, bedCode: 1 }, { unique: true });
bedSchema.index({ hospitalId: 1, roomId: 1, bedNumber: 1 }, { unique: true });
bedSchema.index({ roomId: 1 });
bedSchema.index({ currentAdmissionId: 1 });

module.exports = mongoose.model('Bed', bedSchema);