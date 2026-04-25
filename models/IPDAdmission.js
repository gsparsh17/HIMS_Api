const mongoose = require('mongoose');

const ipdAdmissionSchema = new mongoose.Schema({
  admissionNumber: {
    type: String,
    unique: true,
    // Remove required: true since we generate it automatically
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital'
  },
  admissionDate: {
    type: Date,
    default: Date.now
  },
  dischargeDate: {
    type: Date
  },
  admissionType: {
    type: String,
    enum: ['Emergency', 'Planned', 'Referral', 'Transfer'],
    default: 'Planned'
  },
  status: {
    type: String,
    enum: [
      'Admitted',
      'Under Treatment',
      'Discharge Initiated',
      'Discharge Summary Pending',
      'Billing Pending',
      'Payment Pending',
      'Ready for Discharge',
      'Discharged',
      'Cancelled',
      'LAMA',
      'DAMA',
      'Expired'
    ],
    default: 'Admitted'
  },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department'
  },
  primaryDoctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true
  },
  secondaryDoctorIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  }],
  bedId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bed'
  },
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room'
  },
  wardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ward'
  },
  provisionalDiagnosis: {
    type: String,
    trim: true
  },
  finalDiagnosis: {
    type: String,
    trim: true
  },
  chiefComplaints: {
    type: String,
    trim: true
  },
  historyOfPresentIllness: {
    type: String,
    trim: true
  },
  pastMedicalHistory: {
    type: String,
    trim: true
  },
  attendant: {
    name: { type: String, trim: true },
    relation: { type: String, trim: true },
    mobile: { type: String, trim: true },
    address: { type: String, trim: true }
  },
  paymentType: {
    type: String,
    enum: ['Cash', 'Insurance', 'Government Scheme', 'Corporate', 'Other'],
    default: 'Cash'
  },
  insuranceDetails: {
    provider: { type: String, trim: true },
    policyNumber: { type: String, trim: true },
    tpaName: { type: String, trim: true },
    preAuthNumber: { type: String, trim: true },
    claimStatus: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected', 'Settled'],
      default: 'Pending'
    }
  },
  advanceAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  totalBillAmount: {
    type: Number,
    default: 0
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  dueAmount: {
    type: Number,
    default: 0
  },
  discountAmount: {
    type: Number,
    default: 0
  },
  discountReason: {
    type: String,
    trim: true
  },
  admissionNotes: {
    type: String,
    trim: true
  },
  dischargeReason: {
    type: String,
    trim: true
  },
  isLAMA: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Generate admission number before validate (to ensure it's generated before validation)
ipdAdmissionSchema.pre('validate', async function(next) {
  if (!this.admissionNumber) {
    try {
      const IPDAdmission = mongoose.model('IPDAdmission');
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const count = await IPDAdmission.countDocuments();
      const sequence = String(count + 1).padStart(4, '0');
      this.admissionNumber = `IPD-${year}${month}${day}-${sequence}`;
      next();
    } catch (error) {
      next(error);
    }
  } else {
    next();
  }
});

// Virtual for length of stay
ipdAdmissionSchema.virtual('lengthOfStay').get(function() {
  const endDate = this.dischargeDate || new Date();
  const diffTime = Math.abs(endDate - this.admissionDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
});

// Virtual for discharge status progression
ipdAdmissionSchema.virtual('canProceedToDischarge').get(function() {
  return this.status === 'Admitted' || this.status === 'Under Treatment';
});

// Indexes
ipdAdmissionSchema.index({ patientId: 1, status: 1 });
ipdAdmissionSchema.index({ primaryDoctorId: 1, status: 1 });
ipdAdmissionSchema.index({ admissionDate: -1 });
ipdAdmissionSchema.index({ bedId: 1, status: 1 });
ipdAdmissionSchema.index({ admissionNumber: 1 });

module.exports = mongoose.model('IPDAdmission', ipdAdmissionSchema);