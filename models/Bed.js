const mongoose = require('mongoose');

const bedSchema = new mongoose.Schema({
  bedNumber: {
    type: String,
    required: true,
    trim: true
  },
  bedCode: {
    type: String,
    unique: true,
    required: true,
    uppercase: true
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

// Generate bed code before save
bedSchema.pre('save', async function(next) {
  if (!this.bedCode) {
    const count = await mongoose.model('Bed').countDocuments();
    this.bedCode = `BED${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

// Indexes
bedSchema.index({ status: 1, wardId: 1, bedType: 1 });
bedSchema.index({ roomId: 1 });
bedSchema.index({ currentAdmissionId: 1 });

module.exports = mongoose.model('Bed', bedSchema);