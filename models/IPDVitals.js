const mongoose = require('mongoose');

const ipdVitalsSchema = new mongoose.Schema({
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
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recordedAt: {
    type: Date,
    default: Date.now
  },
  temperature: {
    type: Number,
    min: 95,
    max: 110
  },
  temperatureUnit: {
    type: String,
    enum: ['Celsius', 'Fahrenheit'],
    default: 'Celsius'
  },
  pulse: {
    type: Number,
    min: 30,
    max: 250
  },
  bloodPressure: {
    systolic: { type: Number, min: 50, max: 300 },
    diastolic: { type: Number, min: 30, max: 200 }
  },
  bloodPressureString: {
    type: String
  },
  respiratoryRate: {
    type: Number,
    min: 6,
    max: 60
  },
  spo2: {
    type: Number,
    min: 50,
    max: 100
  },
  bloodSugar: {
    type: Number,
    min: 20,
    max: 600
  },
  weight: {
    type: Number,
    min: 1,
    max: 300
  },
  height: {
    type: Number,
    min: 30,
    max: 250
  },
  painScore: {
    type: Number,
    min: 0,
    max: 10
  },
  glasgowComaScale: {
    eyeResponse: { type: Number, min: 1, max: 4 },
    verbalResponse: { type: Number, min: 1, max: 5 },
    motorResponse: { type: Number, min: 1, max: 6 },
    total: { type: Number, min: 3, max: 15 }
  },
  intakeOutput: {
    intake: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
    notes: { type: String }
  },
  remarks: {
    type: String,
    trim: true
  },
  isAbnormal: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Pre-save hook to calculate blood pressure string and check abnormal values
ipdVitalsSchema.pre('save', function(next) {
  if (this.bloodPressure && this.bloodPressure.systolic && this.bloodPressure.diastolic) {
    this.bloodPressureString = `${this.bloodPressure.systolic}/${this.bloodPressure.diastolic}`;
  }
  
  // Check for abnormal values
  if ((this.temperature && (this.temperature < 97 || this.temperature > 99)) ||
      (this.pulse && (this.pulse < 60 || this.pulse > 100)) ||
      (this.spo2 && this.spo2 < 95) ||
      (this.respiratoryRate && (this.respiratoryRate < 12 || this.respiratoryRate > 20))) {
    this.isAbnormal = true;
  } else {
    this.isAbnormal = false;
  }
  
  next();
});

// Indexes
ipdVitalsSchema.index({ admissionId: 1, recordedAt: -1 });
ipdVitalsSchema.index({ patientId: 1, recordedAt: -1 });
ipdVitalsSchema.index({ recordedAt: -1 });

module.exports = mongoose.model('IPDVitals', ipdVitalsSchema);