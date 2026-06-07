const mongoose = require('mongoose');

const ipdAdmissionSchema = new mongoose.Schema({
  admissionNumber: {
    type: String,
    unique: true,
  },
  // NEW: SHIP number for pharmacy billing and tracking
  shipNumber: {
    type: String,
    unique: true,
    sparse: true,
    index: true
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
  clinicalAssessmentCompleted: {
    type: Boolean,
    default: false
  },
  clinicalAssessmentCompletedAt: {
    type: Date
  },
  clinicalAssessmentCompletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
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
  // NEW: Sponsor information for pharmacy billing
  sponsorType: {
    type: String,
    enum: ['self', 'ayushman_bharat', 'insurance', 'company_panel', 'government_scheme', 'other'],
    default: 'self'
  },
  sponsorName: {
    type: String,
    trim: true
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
  // NEW: Pharmacy clearance tracking
  pharmacyClearanceStatus: {
    type: String,
    enum: ['pending', 'in_progress', 'cleared', 'exempted'],
    default: 'pending'
  },
  pharmacyClearanceDate: {
    type: Date
  },
  pharmacyClearanceBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  pharmacyFinalBalance: {
    type: Number,
    default: 0
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

// Generate SHIP number and admission number
ipdAdmissionSchema.pre('validate', async function(next) {
  try {
    const IPDAdmission = mongoose.model('IPDAdmission');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    
    if (!this.admissionNumber) {
      const count = await IPDAdmission.countDocuments();
      const sequence = String(count + 1).padStart(4, '0');
      this.admissionNumber = `IPD-${dateStr}-${sequence}`;
    }
    
    if (!this.shipNumber) {
      // Generate SHIP number: SHIP-{date}-{patientId last 6 chars}
      const patientIdStr = this.patientId.toString().slice(-6);
      this.shipNumber = `SHIP-${dateStr}-${patientIdStr}`;
    }
    next();
  } catch (error) {
    next(error);
  }
});

// REMOVED: post('save') hook - let controller handle patient update manually

// Update patient when admission status changes to discharged
ipdAdmissionSchema.post('findOneAndUpdate', async function(doc) {
  if (doc && doc.status === 'Discharged') {
    try {
      const Patient = mongoose.model('Patient');
      await Patient.updateOne(
        { _id: doc.patientId },
        {
          $pull: {
            active_admissions: { admission_id: doc._id }
          },
          $set: {
            patient_type: 'opd'
          }
        }
      );
    } catch (err) {
      console.error('Error removing discharged admission from patient:', err);
    }
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

// Virtual for pharmacy clearance needed
ipdAdmissionSchema.virtual('pharmacyClearanceNeeded').get(function() {
  return this.pharmacyClearanceStatus === 'pending' && 
         this.status !== 'Discharged' &&
         (this.pharmacyFinalBalance > 0 || this.pharmacyClearanceStatus === 'in_progress');
});

// Indexes
ipdAdmissionSchema.index({ patientId: 1, status: 1 });
ipdAdmissionSchema.index({ primaryDoctorId: 1, status: 1 });
ipdAdmissionSchema.index({ admissionDate: -1 });
ipdAdmissionSchema.index({ bedId: 1, status: 1 });
ipdAdmissionSchema.index({ admissionNumber: 1 });
ipdAdmissionSchema.index({ shipNumber: 1 });
ipdAdmissionSchema.index({ clinicalAssessmentCompleted: 1 });
ipdAdmissionSchema.index({ pharmacyClearanceStatus: 1 });
ipdAdmissionSchema.index({ status: 1, pharmacyClearanceStatus: 1 });

module.exports = mongoose.model('IPDAdmission', ipdAdmissionSchema);