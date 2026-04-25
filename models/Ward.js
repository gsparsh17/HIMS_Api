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

// Generate code before validate (to ensure code is generated before validation)
wardSchema.pre('validate', async function(next) {
  if (!this.code && this.name) {
    try {
      const Ward = mongoose.model('Ward');
      const count = await Ward.countDocuments();
      // Generate code: WRD001, WRD002, etc.
      this.code = `WRD${String(count + 1).padStart(3, '0')}`;
      next();
    } catch (error) {
      next(error);
    }
  } else {
    next();
  }
});

module.exports = mongoose.model('Ward', wardSchema);