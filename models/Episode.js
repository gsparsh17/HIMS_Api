const mongoose = require('mongoose');

const episodeSchema = new mongoose.Schema({
  // Unique identifier for the episode
  episodeId: {
    type: String,
    unique: true,
    index: true
  },
  
  // Reference to patient
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  
  // Episode details
  title: {
    type: String,
    required: true
  },
  
  episodeType: {
    type: String,
    enum: [
      'Pregnancy',
      'Diabetes Care',
      'Hypertension Management',
      'Post-Surgery Follow-up',
      'Cardiac Care',
      'Respiratory Care',
      'Orthopedic Care',
      'Mental Health',
      'Chronic Disease Management',
      'Rehabilitation',
      'Palliative Care',
      'General',
      'Other'
    ],
    default: 'General'
  },
  
  diagnosis: {
    type: String,
    required: true
  },
  
  icdCode: {
    type: String,
    comment: 'ICD-11 or ICD-10 code for the diagnosis'
  },
  
  startDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  
  endDate: {
    type: Date
  },
  
  status: {
    type: String,
    enum: ['Active', 'Resolved', 'Closed', 'Transferred'],
    default: 'Active'
  },
  
  // Clinical notes
  chiefComplaint: String,
  clinicalNotes: String,
  treatmentPlan: String,
  
  // Outcome tracking
  outcome: {
    type: String,
    enum: ['Improved', 'Stable', 'Worsened', 'Resolved', 'Referred', 'Expired', 'Unknown'],
    default: 'Unknown'
  },
  
  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  
  createdByRole: {
    type: String,
    enum: ['doctor', 'nurse', 'admin', 'staff']
  },
  
  closedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  
  closedReason: String,
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for getting all appointments in this episode
episodeSchema.virtual('appointments', {
  ref: 'Appointment',
  localField: '_id',
  foreignField: 'episodeId',
  options: { sort: { appointment_date: 1 } }
});

// Virtual for getting all prescriptions in this episode
episodeSchema.virtual('prescriptions', {
  ref: 'Prescription',
  localField: '_id',
  foreignField: 'episodeId',
  options: { sort: { created_at: 1 } }
});

// Virtual for getting all lab reports in this episode
episodeSchema.virtual('labReports', {
  ref: 'LabReport',
  localField: '_id',
  foreignField: 'episodeId',
  options: { sort: { created_at: 1 } }
});

// Virtual for calculating episode duration in days
episodeSchema.virtual('durationDays').get(function() {
  const end = this.endDate || new Date();
  const diffTime = Math.abs(end - this.startDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
});

// Pre-save middleware to generate episodeId
episodeSchema.pre('save', async function(next) {
  if (this.isNew && !this.episodeId) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const prefix = 'EP';
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.episodeId = `${prefix}-${year}${month}-${random}`;
  }
  this.updatedAt = new Date();
  next();
});

// Indexes for better query performance
episodeSchema.index({ patientId: 1, status: 1 });
episodeSchema.index({ patientId: 1, episodeType: 1 });
episodeSchema.index({ startDate: -1 });

module.exports = mongoose.model('Episode', episodeSchema);