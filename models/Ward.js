const mongoose = require('mongoose');

const wardSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    unique: true,
    required: true,
    uppercase: true,
    trim: true
  },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department'
  },
  floor: {
    type: String,
    trim: true
  },
  type: {
    type: String,
    enum: ['General', 'ICU', 'Emergency', 'Maternity', 'Pediatric', 'Surgical', 'Other'],
    default: 'General'
  },
  description: {
    type: String,
    trim: true
  },
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

// Generate code before save
wardSchema.pre('save', async function(next) {
  if (!this.code) {
    const count = await mongoose.model('Ward').countDocuments();
    this.code = `WRD${String(count + 1).padStart(3, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Ward', wardSchema);