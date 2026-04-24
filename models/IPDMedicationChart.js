const mongoose = require('mongoose');

const medicationTimingSchema = new mongoose.Schema({
  time: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['Pending', 'Administered', 'Skipped', 'Held', 'Refused', 'Missed'],
    default: 'Pending'
  },
  administeredAt: {
    type: Date
  },
  administeredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse'
  },
  remarks: {
    type: String,
    trim: true
  },
  witnessedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse'
  }
});

const ipdMedicationChartSchema = new mongoose.Schema({
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
  prescribedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true
  },
  medicineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine'
  },
  medicineName: {
    type: String,
    required: true,
    trim: true
  },
  genericName: {
    type: String,
    trim: true
  },
  route: {
    type: String,
    required: true
  },
  dosage: {
    type: String,
    required: true
  },
  frequency: {
    type: String,
    required: true
  },
  startDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  endDate: {
    type: Date
  },
  duration: {
    type: Number,
    default: 1
  },
  durationUnit: {
    type: String,
    enum: ['Days', 'Weeks', 'Months'],
    default: 'Days'
  },
  specialInstructions: {
    type: String,
    trim: true
  },
  timing: [medicationTimingSchema],
  status: {
    type: String,
    enum: ['Active', 'Stopped', 'Completed', 'Pending'],
    default: 'Active'
  },
  isHighRisk: {
    type: Boolean,
    default: false
  },
  requiresDoubleVerification: {
    type: Boolean,
    default: false
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse'
  },
  verifiedAt: {
    type: Date
  },
  stoppedReason: {
    type: String,
    trim: true
  },
  stoppedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Generate timing schedule before save
ipdMedicationChartSchema.pre('save', async function(next) {
  if (this.isNew && this.startDate && this.frequency && this.timing.length === 0) {
    const startDate = new Date(this.startDate);
    const endDate = this.endDate || new Date(startDate.getTime() + this.duration * 24 * 60 * 60 * 1000);
    
    // Generate timings based on frequency
    const timings = [];
    const times = this.getTimingTimes(this.frequency);
    
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      for (const time of times) {
        timings.push({
          time: `${currentDate.toISOString().split('T')[0]}T${time}`,
          status: 'Pending'
        });
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    this.timing = timings;
  }
  next();
});

ipdMedicationChartSchema.methods.getTimingTimes = function(frequency) {
  const frequencyMap = {
    'OD': ['09:00'],
    'BD': ['09:00', '21:00'],
    'TDS': ['09:00', '14:00', '21:00'],
    'QDS': ['09:00', '13:00', '17:00', '21:00'],
    'QID': ['09:00', '13:00', '17:00', '21:00'],
    'q4h': ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
    'q6h': ['00:00', '06:00', '12:00', '18:00'],
    'q8h': ['00:00', '08:00', '16:00'],
    'q12h': ['08:00', '20:00'],
    'Mane': ['08:00'],
    'Nocte': ['20:00']
  };
  
  return frequencyMap[frequency] || ['09:00'];
};

// Indexes
ipdMedicationChartSchema.index({ admissionId: 1, status: 1 });
ipdMedicationChartSchema.index({ patientId: 1, startDate: -1 });
ipdMedicationChartSchema.index({ medicineName: 1 });

module.exports = mongoose.model('IPDMedicationChart', ipdMedicationChartSchema);