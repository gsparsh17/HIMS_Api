const mongoose = require('mongoose');
const { addSoftDeleteFields } = require('../utils/softDelete');
const { operationNow } = require('../utils/operationTimeContext');
const crypto = require('crypto');

const patientSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: {
    type: String,
    trim: true
  },
  uhid: {
    type: String,
    trim: true
  },
  salutation: {
    type: String,
    enum: ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.', 'Prof.', 'Baby', 'Master', 'Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof'],
  },
  first_name: {
    type: String,
    required: true
  },
  middle_name: {
    type: String
  },
  last_name: {
    type: String
  },
  email: {
    type: String,
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  normalizedPhone: { type: String, trim: true, index: true },
  gender: {
    type: String,
    enum: ['male', 'female', 'other'],
    required: true
  },
  dob: {
    type: Date,
    required: true
  },
  dobPrecision: { type: String, enum: ['EXACT', 'ESTIMATED'], default: 'EXACT' },
  ageEntrySource: { type: String, enum: ['DOB', 'AGE'], default: 'DOB' },
  enteredAgeYears: { type: Number, min: 0, max: 130 },
  enteredAgeMonths: { type: Number, min: 0, max: 11 },
  enteredAgeDays: { type: Number, min: 0, max: 30 },
  ageAsOf: Date,
  age: {
    type: Number,
    computed: function () {
      if (!this.dob) return null;
      const today = new Date();
      let age = today.getFullYear() - this.dob.getFullYear();
      const monthDiff = today.getMonth() - this.dob.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < this.dob.getDate())) {
        age--;
      }
      return age;
    }
  },
  address: {
    type: String
  },
  city: {
    type: String
  },
  state: {
    type: String
  },
  zipCode: {
    type: String
  },
  village: {
    type: String
  },
  district: {
    type: String
  },
  tehsil: {
    type: String
  },
  patient_image: {
    type: String
  },
  emergency_contact: {
    type: String
  },
  emergency_phone: {
    type: String
  },
  medical_history: {
    type: String
  },
  allergies: {
    type: String
  },
  medications: {
    type: String
  },
  blood_group: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', ''],
    default: '',
  },
  patient_type: {
    type: String,
    enum: ['opd', 'ipd', 'walkin'],
    default: 'ipd',
  },
  aadhaar_last4: {
    type: String,
    trim: true,
    select: false
  },
  abha: {
    number: { type: String, trim: true, index: true, sparse: true },
    address: { type: String, trim: true, lowercase: true, index: true, sparse: true },
    status: {
      type: String,
      enum: [
        'UNLINKED', 'OTP_SENT', 'VERIFICATION_PENDING', 'VERIFIED',
        'IDENTITY_MISMATCH',
        'ACTIVE', 'DEACTIVATED', 'DELETED',
        'NOT_ASSOCIATED', 'VERIFIED_ACTIVE', 'LOCAL_ASSOCIATION_RETIRED', 'ABHA_DEACTIVATED', 'ABHA_DELETED',
        'not_linked', 'otp_sent', 'pending_verification', 'manually_captured'
      ],
      default: 'UNLINKED',
      index: true
    },
    type: { type: String, trim: true },
    kycVerified: { type: Boolean, default: false },
    registrationMode: {
      type: String,
      enum: [
        'aadhaar_otp', 'mobile_otp', 'mobile_search', 'profile_share',
        'manual_capture', 'driving_licence', 'face', 'fingerprint', 'iris',
        'password', 'abha_address', 'none'
      ],
      default: 'none'
    },
    linkedAt: Date,
    verifiedAt: Date,
    associationRetiredAt: Date,
    associationRetiredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    associationRetirementReason: { type: String, trim: true },
    externalAccountStatus: {
      type: String,
      enum: ['UNKNOWN', 'ACTIVE', 'DEACTIVATED', 'DELETED'],
      default: 'UNKNOWN'
    },
    verificationMethod: String,
    patientReference: { type: String, index: true, sparse: true },
    lastLinkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    profile: {
      firstName: String,
      middleName: String,
      lastName: String,
      dob: String,
      gender: String,
      mobileMasked: String,
      districtName: String,
      stateName: String,
      pinCode: String
    },
    identityReconciliation: {
      status: {
        type: String,
        enum: ['NOT_CHECKED', 'MATCHED', 'MISMATCH'],
        default: 'NOT_CHECKED'
      },
      checkedAt: Date,
      method: String,
      score: Number,
      matchedFields: [String],
      mismatchedFields: [String],
      unavailableFields: [String],
      profileFingerprint: { type: String, select: false }
    },
    lastOtpTxnId: String,
    lastOtpSentAt: Date,
    mobileVerificationTxnId: String,
    mobileVerificationStatus: String,
    mobileVerifiedAt: Date,
    existingSearchTxnId: String,
    existingLoginTxnId: String,
    existingSelectedIndex: String,
    recordLinks: [{
      recordType: String,
      recordId: mongoose.Schema.Types.ObjectId,
      ehrBundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'EHRBundle' },
      linkedAt: Date,
      status: String
    }],
    lastRecordLinkSyncAt: Date,
    lastEhrBundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'EHRBundle' },
    lastEhrGeneratedAt: Date
  },
  registrationSource: {
    channel: {
      type: String,
      enum: ['internal', 'website', 'kiosk', 'mobile', 'qr', 'abdm_scan_share'],
      default: 'internal',
      index: true
    },
    externalReference: { type: String, trim: true },
    deviceIdentifier: { type: String, trim: true },
    capturedAt: { type: Date, default: Date.now },
    capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  mobileVerification: {
    verified: { type: Boolean, default: false },
    verifiedAt: Date,
    verificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientVerification' },
    phone: { type: String, trim: true }
  },
  identityDocuments: [{
    type: {
      type: String,
      enum: ['aadhaar_last4', 'passport', 'driving_licence', 'voter_id', 'other']
    },
    maskedValue: { type: String, trim: true },
    verified: { type: Boolean, default: false },
    verifiedAt: Date,
    verificationMethod: String
  }],
  paymentPreference: {
    type: String,
    trim: true,
    lowercase: true,
    default: 'cash'
  },
  duplicateReview: {
    status: {
      type: String,
      enum: ['not_checked', 'clear', 'probable_duplicate', 'confirmed_duplicate', 'override_approved'],
      default: 'not_checked'
    },
    candidatePatientIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Patient' }],
    score: Number,
    matchedFields: [String],
    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    overrideReason: String
  },
  registrationStatus: {
    type: String,
    enum: ['DRAFT', 'PENDING_VERIFICATION', 'DUPLICATE_REVIEW', 'REGISTERED', 'MERGED', 'INACTIVE'],
    default: 'REGISTERED',
    index: true
  },
  registrationCompleteness: {
    score: { type: Number, min: 0, max: 100, default: 100 },
    missingFields: [{ type: String, trim: true }],
    evaluatedAt: Date,
    context: { type: String, trim: true, uppercase: true }
  },
  sharingConsents: [{
    purpose: { type: String, trim: true },
    facility: { type: String, trim: true },
    dataCategories: [String],
    status: {
      type: String,
      enum: ['active', 'withdrawn', 'expired'],
      default: 'active'
    },
    grantedAt: { type: Date, default: Date.now },
    expiresAt: Date,
    reference: String,
    capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  offlineSyncMetadata: {
    localId: { type: String, trim: true, index: true },
    capturedOffline: { type: Boolean, default: false },
    capturedAt: Date,
    syncedAt: Date,
    idempotencyKey: { type: String, trim: true }
  },
  sponsor_type: {
    type: String,
    enum: ['self', 'ayushman_bharat', 'insurance', 'company_panel', 'government_scheme', 'other'],
    default: 'self'
  },
  sponsor_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sponsor'
  },
  insurance_provider_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payer',
    index: true
  },
  sponsor_name: {
    type: String,
    trim: true
  },
  sponsor_policy_number: {
    type: String,
    trim: true
  },
  sponsor_valid_until: {
    type: Date
  },
  insurance_coverage_percentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  // Cached suggestion for the next encounter. This is NOT authoritative
  // encounter coverage; every appointment/admission/service may override it.
  // It exists so returning patients can be prefilled with their most recently
  // used payer and beneficiary/policy number without changing patient identity.
  lastCoveragePreference: {
    payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', index: true },
    payerCategory: {
      type: String,
      enum: ['self', 'pmjay', 'cghs', 'state_scheme', 'echs', 'esic', 'government_other', 'corporate', 'private_insurer', 'tpa', 'tpa_managed', 'other'],
      default: 'self'
    },
    payerName: { type: String, trim: true },
    tpaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer' },
    planName: { type: String, trim: true },
    beneficiary: {
      beneficiaryId: { type: String, trim: true },
      schemeCardNumber: { type: String, trim: true },
      policyNumber: { type: String, trim: true },
      memberId: { type: String, trim: true },
      relationship: { type: String, trim: true },
      validFrom: Date,
      validTo: Date,
      coverageLimit: Number,
      coPayPercentage: Number,
      deductibleAmount: Number,
      wardEntitlement: { type: String, trim: true }
    },
    source: {
      type: String,
      enum: ['REGISTRATION', 'OPD', 'IPD', 'LAB', 'RADIOLOGY', 'PROCEDURE', 'OTHER'],
      default: 'REGISTRATION'
    },
    encounterId: mongoose.Schema.Types.ObjectId,
    coverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage' },
    usedAt: Date,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  is_walkin: {
    type: Boolean,
    default: false
  },
  walkin_created_at: {
    type: Date
  },
  last_pharmacy_visit: {
    type: Date
  },
  // Active admissions tracking for quick pharmacy access
  active_admissions: [{
    admission_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IPDAdmission'
    },
    ship_number: String,
    registration_number: String,
    ward_name: String,
    bed_number: String,
    doctor_name: String,
    department_name: String,
    status: {
      type: String,
      enum: ['active', 'discharged', 'transferred'],
      default: 'active'
    }
  }],
  // Pharmacy account summary (denormalized for quick access)
  pharmacy_outstanding_balance: {
    type: Number,
    default: 0
  },
  pharmacy_advance_balance: {
    type: Number,
    default: 0
  },
  last_pharmacy_transaction: {
    type: Date
  },
  registered_at: {
    type: Date,
    default: operationNow
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'registered_at', updatedAt: 'updated_at' },
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for full name
patientSchema.virtual('full_name').get(function () {
  const parts = [this.first_name];
  if (this.middle_name) parts.push(this.middle_name);
  if (this.last_name) parts.push(this.last_name);
  return parts.join(' ');
});

// Virtual for display name with salutation
patientSchema.virtual('display_name').get(function () {
  const salutation = this.salutation ? `${this.salutation} ` : '';
  return `${salutation}${this.full_name}`;
});

// Index for fast pharmacy POS search
patientSchema.index({
  first_name: 'text',
  last_name: 'text',
  phone: 'text',
  uhid: 'text',
  patientId: 'text',
  'abha.number': 'text',
  'abha.address': 'text'
});

// Compound indexes for common pharmacy queries
patientSchema.index({ hospitalId: 1, phone: 1 });
patientSchema.index({ hospitalId: 1, uhid: 1 }, { unique: true, sparse: true });
patientSchema.index({ hospitalId: 1, patientId: 1 }, { unique: true, sparse: true });
patientSchema.index(
  { hospitalId: 1, 'abha.number': 1 },
  {
    unique: true,
    partialFilterExpression: { 'abha.number': { $type: 'string' } }
  }
);
patientSchema.index(
  { hospitalId: 1, 'abha.address': 1 },
  {
    unique: true,
    partialFilterExpression: { 'abha.address': { $type: 'string' } }
  }
);
patientSchema.index({ 'abha.status': 1 });
patientSchema.index({ is_walkin: 1, last_pharmacy_visit: -1 });
patientSchema.index({ sponsor_type: 1, pharmacy_outstanding_balance: -1 });
patientSchema.index({ 'active_admissions.ship_number': 1 });
patientSchema.index({ 'active_admissions.status': 1 });

const Hospital = require('./Hospital');
const HospitalSequence = require('./HospitalSequence');

async function generateStructuredPatientId(hospital, hospitalId) {
  const now = new Date();
  let template = '{HOSPITAL}-{YY}{MM}-{SEQUENCE}';
  try {
    const setting = await mongoose.model('NabhSetting')
      .findOne({ hospitalId })
      .select('patientRegistration.uhidTemplate')
      .lean();
    if (setting?.patientRegistration?.uhidTemplate) {
      template = setting.patientRegistration.uhidTemplate;
    }
  } catch (_error) {
    // Preserve registration when settings have not yet been initialized.
  }
  const sequence = await HospitalSequence.findOneAndUpdate(
    { hospitalId, key: `PATIENT_${now.getFullYear()}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const values = {
    HOSPITAL: hospital.tenantCode || hospital.hospitalID,
    YYYY: String(now.getFullYear()),
    YY: String(now.getFullYear()).slice(-2),
    MM: String(now.getMonth() + 1).padStart(2, '0'),
    DD: String(now.getDate()).padStart(2, '0'),
    SEQUENCE: String(sequence.value).padStart(6, '0'),
    RANDOM: crypto.randomBytes(4).toString('hex').toUpperCase()
  };
  let generated = String(template);
  for (const [key, value] of Object.entries(values)) {
    generated = generated.replaceAll(`{${key}}`, value);
  }
  return generated.toUpperCase().replace(/\s+/g, '-');
}

patientSchema.pre('save', async function (next) {
  try {
    const now = new Date();
    this.updated_at = now;
    this.normalizedPhone = String(this.phone || '').replace(/\D/g, '').slice(-10);

    if (!this.uhid || !this.patientId) {
      const hospital = this.hospitalId ? await Hospital.findById(this.hospitalId) : await Hospital.findOne();
      if (!hospital || !hospital.hospitalID) {
        throw new Error('Hospital ID not found');
      }

      if (!this.hospitalId) this.hospitalId = hospital._id;

      const finalGeneratedId = await generateStructuredPatientId(
        hospital,
        hospital._id
      );
      let checkId = finalGeneratedId;
      let suffixCounter = 0;

      while (
        await mongoose.model('Patient').exists({
          hospitalId: hospital._id,
          $or: [{ uhid: checkId }, { patientId: checkId }]
        })
      ) {
        suffixCounter += 1;
        checkId = `${finalGeneratedId}-${suffixCounter}`;
      }

      this.uhid = checkId;
      this.patientId = checkId;
      this.hospitalId = hospital._id;
    }

    // Set walkin timestamp if applicable
    if (this.is_walkin && !this.walkin_created_at) {
      this.walkin_created_at = now;
    }

    next();
  } catch (err) {
    next(err);
  }
});

patientSchema.index({ hospitalId: 1, normalizedPhone: 1 });
patientSchema.index(
  { hospitalId: 1, 'offlineSyncMetadata.idempotencyKey': 1 },
  {
    unique: true,
    partialFilterExpression: { 'offlineSyncMetadata.idempotencyKey': { $type: 'string' } }
  }
);

addSoftDeleteFields(patientSchema);

module.exports = mongoose.model('Patient', patientSchema);
