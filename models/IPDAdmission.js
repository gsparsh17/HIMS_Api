const mongoose = require('mongoose');
const { addSoftDeleteFields } = require('../utils/softDelete');
const { operationNow } = require('../utils/operationTimeContext');
const { hospitalDateKey, hospitalDayBounds } = require('../utils/hospitalDateTime');
const DailySequence = require('./DailySequence');

const ipdAdmissionSchema = new mongoose.Schema({
  admissionNumber: {
    type: String,
    trim: true
  },
  // NEW: SHIP number for pharmacy billing and tracking
  shipNumber: {
    type: String,
    trim: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    index: true
  },
  coverageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AdmissionCoverage',
    index: true
  },
  currentLocationEffectiveAt: {
    type: Date
  },
  admissionDate: {
    type: Date,
    default: operationNow
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
  selectedBillingMode: {
    type: String,
    enum: ['FULL_PREPAY', 'PARTIAL_PREPAY', 'POSTPAID', 'TPA_SPONSOR', 'AUTHORIZED_EXCEPTION']
  },
  financialPolicySnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Durable post-admission finance bootstrap. A clinically valid admission/bed
  // remains committed even if initial billing fails; this state makes recovery
  // visible after refresh/logout and stores only the inputs needed for an
  // idempotent retry.
  financeInitialization: {
    status: { type: String, enum: ['ready', 'pending'], default: 'ready', index: true },
    requestedCollection: { type: Number, default: 0, min: 0 },
    requestedDeposit: { type: Number, default: 0, min: 0 },
    paymentMethod: { type: String, trim: true, default: 'Cash' },
    selectedMode: { type: String, trim: true },
    payerCategory: { type: String, trim: true },
    billingModeOverrideReason: { type: String, trim: true },
    // Persist the original allocation plan before any payment/advance mutation.
    // This makes a retry safe even when a prior payment committed but a later
    // stage failed: current invoice balance must not be reinterpreted as excess.
    initialInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    plannedInvoiceCollection: { type: Number, min: 0 },
    plannedAdvanceAmount: { type: Number, min: 0 },
    retryCount: { type: Number, default: 0, min: 0 },
    lastAttemptAt: Date,
    completedAt: Date,
    errorCode: { type: String, trim: true },
    errorMessage: { type: String, trim: true },
    lastAttemptBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  // A real charge freeze is separate from admission/discharge status. Final IPD
  // billing and final financial clearance require this state. Reopening is
  // explicit/audited and invalidates prior financial clearance.
  chargeFreeze: {
    status: { type: String, enum: ['open', 'frozen'], default: 'open', index: true },
    frozenAt: Date,
    frozenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    freezeReason: { type: String, trim: true },
    reopenedAt: Date,
    reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reopenReason: { type: String, trim: true },
    reopenCount: { type: Number, default: 0, min: 0 }
  },
  requiredNowAmount: { type: Number, default: 0, min: 0 },
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
  patientReceivable: { type: Number, default: 0, min: 0 },
  sponsorReceivable: { type: Number, default: 0, min: 0 },
  approvedSponsorAmount: { type: Number, default: 0, min: 0 },
  claimSubmittedAmount: { type: Number, default: 0, min: 0 },
  sponsorPaidAmount: { type: Number, default: 0, min: 0 },
  nonAdmissibleAmount: { type: Number, default: 0, min: 0 },
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
  // Canonical discharge outcome used by clinical summaries and final finance documents.
  // Historical status values (DAMA/Expired/etc.) remain readable through controller
  // normalization but new writes use this stable vocabulary.
  dischargeType: {
    type: String,
    enum: ['Normal', 'DOR', 'LAMA', 'Referred', 'Death'],
    default: 'Normal',
    index: true
  },
  deathDetails: {
    chiefComplaints: { type: String, trim: true },
    causeOfDeath: { type: String, trim: true },
    summary: { type: String, trim: true },
    deathDate: Date,
    deathTime: { type: String, trim: true },
    deathAt: Date
  },
  isLAMA: {
    type: Boolean,
    default: false
  },
  plannedDischargeAt: { type: Date, index: true },
  plannedDischargeType: {
    type: String,
    enum: ['PLANNED', 'LAMA', 'DAMA', 'DISAPPEARED', 'TRANSFER', 'OTHER']
  },
  plannedDischargeReason: { type: String, trim: true },
  dischargeClinicalException: {
    reason: { type: String, trim: true },
    categories: [{ type: String, enum: ['LAB_PENDING', 'RADIOLOGY_PENDING', 'MEDICATION_PENDING', 'PROCEDURE_PENDING', 'OT_PENDING', 'OTHER'] }],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date
  },
  dischargeChecklist: {
    checkpoints: [{
      key: { type: String, required: true },
      label: String,
      completed: { type: Boolean, default: false },
      completedAt: Date,
      completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      note: String
    }],
    delayReasons: [{
      reason: { type: String, required: true },
      recordedAt: { type: Date, default: operationNow },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    }],
    updatedAt: Date
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

  // Financial settlement state. advanceAmount represents currently available
  // IPD advance; received/utilized/refunded fields preserve the audit trail.
  advanceReceivedAmount: { type: Number, default: 0, min: 0 },
  advanceUtilizedAmount: { type: Number, default: 0, min: 0 },
  advanceRefundedAmount: { type: Number, default: 0, min: 0 },
  advanceClearanceDisposition: {
    type: String,
    enum: ['pending', 'retain', 'carry_forward', 'refunded', 'none'],
    default: 'pending'
  },
  advanceClearanceDispositionAt: Date,
  advanceClearanceDispositionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  advanceClearanceDispositionNote: { type: String, trim: true },
  invoicedAmount: { type: Number, default: 0, min: 0 },
  financialClearanceStatus: {
    type: String,
    enum: ['pending', 'in_progress', 'cleared', 'exception_approved'],
    default: 'pending',
    index: true
  },
  financialClearanceException: {
    reason: { type: String, trim: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    outstandingAccepted: { type: Number, default: 0 }
  },
  financialClearedAt: Date,
  financialClearedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  finalInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  finalSettlementReceiptNumber: { type: String, trim: true },
  finalDischargedAt: Date,
  finalDischargedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  abdmRecordLink: {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    abhaNumber: { type: String, index: true },
    abhaAddress: { type: String, index: true },
    status: { type: String, enum: ['pending_abha', 'linked', 'ready_for_consent', 'shared', 'LOCAL_RECORD_READY', 'VERIFICATION_PENDING', 'ABDM_LINK_PENDING', 'ABDM_LINKED', 'ABDM_LINK_FAILED'], default: 'pending_abha' },
    linkedAt: Date,
    source: String,
    ehrBundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'EHRBundle' }
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

// Generate collision-safe SHIP and admission numbers.
// countDocuments() cannot be used for numbering because deleted/imported rows and
// concurrent requests can both produce the same "count + 1" value.
async function nextDailySequence({ hospitalId, key, seedValue = 0, session }) {
  const options = { new: true, upsert: true, setDefaultsOnInsert: true };
  if (session) options.session = session;

  try {
    const normalizedSeed = Math.max(0, Number(seedValue) || 0);
    const counter = await DailySequence.findOneAndUpdate(
      { hospitalId, key },
      [
        {
          $set: {
            hospitalId: { $ifNull: ['$hospitalId', hospitalId] },
            key: { $ifNull: ['$key', key] },
            value: {
              $add: [
                { $max: [{ $ifNull: ['$value', 0] }, normalizedSeed] },
                1
              ]
            }
          }
        }
      ],
      options
    );
    return counter.value;
  } catch (error) {
    // Two first requests can race while creating the counter document. The
    // unique index chooses one winner; the loser simply increments it.
    if (error?.code !== 11000) throw error;

    const retryOptions = { new: true };
    if (session) retryOptions.session = session;
    const counter = await DailySequence.findOneAndUpdate(
      { hospitalId, key },
      { $inc: { value: 1 } },
      retryOptions
    );
    if (!counter) throw error;
    return counter.value;
  }
}

function sequenceFromValue(value, prefix) {
  const match = String(value || '').match(new RegExp(`^${prefix}(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

ipdAdmissionSchema.pre('validate', async function(next) {
  try {
    const IPDAdmission = mongoose.model('IPDAdmission');
    const session = typeof this.$session === 'function' ? this.$session() : null;
    const now = this.admissionDate ? new Date(this.admissionDate) : operationNow();
    const admissionDateKey = hospitalDateKey(now);
    const dateStr = admissionDateKey.replace(/-/g, '');
    const { start: dayStart, end: dayEnd } = hospitalDayBounds(admissionDateKey);

    if (!this.admissionNumber) {
      const query = IPDAdmission.findOne({
        hospitalId: this.hospitalId,
        admissionNumber: { $regex: `^IPD-${dateStr}-\\d+$` }
      }).sort({ admissionNumber: -1 }).select('admissionNumber');
      if (session) query.session(session);
      const latest = await query.lean();
      const seedValue = sequenceFromValue(latest?.admissionNumber, `IPD-${dateStr}-`);
      const sequence = await nextDailySequence({
        hospitalId: this.hospitalId,
        key: `ipd-admission:${dateStr}`,
        seedValue,
        session
      });
      this.admissionNumber = `IPD-${dateStr}-${String(sequence).padStart(4, '0')}`;
    }

    if (!this.shipNumber) {
      const patientIdStr = this.patientId.toString().slice(-6);
      const shipPrefix = `SHIP-${dateStr}-${patientIdStr}-`;
      const query = IPDAdmission.findOne({
        hospitalId: this.hospitalId,
        patientId: this.patientId,
        admissionDate: { $gte: dayStart, $lt: dayEnd },
        shipNumber: { $regex: `^${shipPrefix}\\d+$` }
      }).sort({ shipNumber: -1 }).select('shipNumber');
      if (session) query.session(session);
      const latest = await query.lean();
      const seedValue = sequenceFromValue(latest?.shipNumber, shipPrefix);
      const sequence = await nextDailySequence({
        hospitalId: this.hospitalId,
        key: `ipd-ship:${dateStr}:${this.patientId}`,
        seedValue,
        session
      });
      this.shipNumber = `${shipPrefix}${String(sequence).padStart(2, '0')}`;
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
  const endDate = this.dischargeDate || operationNow();
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
ipdAdmissionSchema.index({ hospitalId: 1, admissionNumber: 1 }, { unique: true });
ipdAdmissionSchema.index({ hospitalId: 1, shipNumber: 1 }, { unique: true, sparse: true });
ipdAdmissionSchema.index({ clinicalAssessmentCompleted: 1 });
ipdAdmissionSchema.index({ pharmacyClearanceStatus: 1 });
ipdAdmissionSchema.index({ status: 1, pharmacyClearanceStatus: 1 });
ipdAdmissionSchema.index({ 'abdmRecordLink.abhaNumber': 1 });
ipdAdmissionSchema.index({ 'abdmRecordLink.abhaAddress': 1 });

ipdAdmissionSchema.index({ hospitalId: 1, status: 1, wardId: 1 });
addSoftDeleteFields(ipdAdmissionSchema);

module.exports = mongoose.model('IPDAdmission', ipdAdmissionSchema);