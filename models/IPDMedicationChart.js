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

const pharmacyRequestSchema = new mongoose.Schema({
  requestedToPharmacy: {
    type: Boolean,
    default: false
  },
  requestedAt: {
    type: Date
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  pharmacyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Pharmacy'
  },
  pharmacyRequestNumber: {
    type: String
  },
  pharmacyStatus: {
    type: String,
    enum: ['Pending', 'Approved', 'Dispatched', 'Delivered', 'Rejected', 'OutOfStock'],
    default: 'Pending'
  },
  dispensedFromPharmacy: {
    type: Boolean,
    default: false
  },
  dispensedQuantity: {
    type: Number,
    default: 0
  },
  dispensedBatchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicineBatch'
  },
  dispensedAt: {
    type: Date
  },
  pharmacyNotes: {
    type: String,
    trim: true
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
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDRound'
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
    required: true,
    enum: ['Oral', 'Intravenous', 'Intramuscular', 'Subcutaneous', 'Topical', 'Inhalation', 'Other']
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
    enum: ['Active', 'Stopped', 'Completed', 'Pending', 'Requested'],
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
  
  // Pharmacy Integration
  pharmacyRequest: pharmacyRequestSchema,
  
  // For medicines from in-house pharmacy
  requiresPharmacyDispense: {
    type: Boolean,
    default: false
  },
  
  // Billing
  costPerUnit: {
    type: Number,
    default: 0
  },
  totalCost: {
    type: Number,
    default: 0
  },
  isBilled: {
    type: Boolean,
    default: false
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
  if (this.isNew && this.startDate && this.frequency && (!this.timing || this.timing.length === 0)) {
    const startDate = new Date(this.startDate);
    const endDate = this.endDate || new Date(startDate.getTime() + this.duration * 24 * 60 * 60 * 1000);
    
    const timings = [];
    const times = this.getTimingTimes(this.frequency);
    
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);
    
    while (currentDate <= endDate) {
      for (const time of times) {
        const [hour, minute] = time.split(':');
        const scheduleDateTime = new Date(currentDate);
        scheduleDateTime.setHours(parseInt(hour), parseInt(minute), 0, 0);
        
        timings.push({
          time: scheduleDateTime,
          status: 'Pending'
        });
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    this.timing = timings;
  }
  
  // Calculate total cost
  if (this.costPerUnit && this.timing) {
    const totalDoses = this.timing.filter(t => t.status !== 'Skipped' && t.status !== 'Held').length;
    this.totalCost = this.costPerUnit * totalDoses;
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
    'Nocte': ['20:00'],
    'SOS': ['As needed']
  };
  
  return frequencyMap[frequency] || ['09:00'];
};

// Indexes
ipdMedicationChartSchema.index({ admissionId: 1, status: 1 });
ipdMedicationChartSchema.index({ patientId: 1, startDate: -1 });
ipdMedicationChartSchema.index({ medicineName: 1 });
ipdMedicationChartSchema.index({ 'pharmacyRequest.pharmacyStatus': 1 });

module.exports = mongoose.model('IPDMedicationChart', ipdMedicationChartSchema);