const mongoose = require('mongoose');

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
    enum: ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.', 'Prof.', 'Baby', 'Master'],
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
    required: true
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other'],
    required: true
  },
  dob: {
    type: Date,
    required: true
  },
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
  aadhaar_number: {
    type: String,
    trim: true,
    select: false,
    validate: {
      validator: function (v) {
        if (!v) return true;
        return /^\d{12}$/.test(v);
      },
      message: 'Aadhaar number must be exactly 12 digits'
    }
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
        'ACTIVE', 'DEACTIVATED', 'DELETED',
        'not_linked', 'otp_sent', 'pending_verification', 'manually_captured'
      ],
      default: 'UNLINKED',
      index: true
    },
    type: { type: String, trim: true },
    kycVerified: { type: Boolean, default: false },
    registrationMode: {
      type: String,
      enum: ['aadhaar_otp', 'mobile_otp', 'mobile_search', 'profile_share', 'manual_capture', 'none'],
      default: 'none'
    },
    linkedAt: Date,
    verifiedAt: Date,
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
    lastOtpTxnId: String,
    lastOtpSentAt: Date,
    mobileVerificationTxnId: String,
    mobileVerificationStatus: String,
    mobileVerifiedAt: Date,
    existingSearchTxnId: String,
    existingLoginTxnId: String,
    existingSelectedIndex: String,
    session: {
      xToken: { type: String, select: false },
      refreshToken: { type: String, select: false },
      expiresAt: Date,
      refreshExpiresAt: Date
    },
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
    ref: 'InsuranceProvider',
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
    default: Date.now
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
patientSchema.index({ 'abha.number': 1 });
patientSchema.index({ 'abha.address': 1 });
patientSchema.index({ 'abha.status': 1 });
patientSchema.index({ is_walkin: 1, last_pharmacy_visit: -1 });
patientSchema.index({ sponsor_type: 1, pharmacy_outstanding_balance: -1 });
patientSchema.index({ 'active_admissions.ship_number': 1 });
patientSchema.index({ 'active_admissions.status': 1 });

const Hospital = require('./Hospital');

function generateStructuredPatientId(firstName, lastName, phone, hospitalCode) {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const namePart = (firstName.substring(0, 3) + (lastName ? lastName.substring(0, 1) : '')).toUpperCase();
  const phonePart = phone.slice(-4);
  return `${hospitalCode}-${namePart}${phonePart}-${year}${month}`;
}

patientSchema.pre('save', async function (next) {
  try {
    const now = new Date();
    this.updated_at = now;

    if (!this.uhid || !this.patientId) {
      const hospital = this.hospitalId ? await Hospital.findById(this.hospitalId) : await Hospital.findOne();
      if (!hospital || !hospital.hospitalID) {
        throw new Error('Hospital ID not found');
      }

      if (!this.hospitalId) this.hospitalId = hospital._id;

      const existingPatient = await mongoose.model('Patient').findOne({
        hospitalId: hospital._id,
        first_name: this.first_name,
        last_name: this.last_name,
        phone: this.phone
      });

      if (existingPatient) {
        this.uhid = existingPatient.uhid || existingPatient.patientId;
        this.patientId = existingPatient.patientId;
        this.hospitalId = existingPatient.hospitalId || hospital._id;
      } else {
        let finalGeneratedId = '';

        if (this.aadhaar_number && this.aadhaar_number.length === 12) {
          const date = new Date();
          const yymm = `${date.getFullYear().toString().slice(-2)}${(date.getMonth() + 1).toString().padStart(2, '0')}`;

          let hospitalPrefix = 'HS';
          const hName = hospital.hospitalName || hospital.name;
          if (hName) {
            const words = hName.trim().split(/\s+/).filter(w => w.length > 0);
            if (words.length > 0) {
              hospitalPrefix = words.map(w => w[0]).join('').toUpperCase();
            }
          }
          const uniqueSuffix = this.aadhaar_number.slice(-8);
          finalGeneratedId = `${hospitalPrefix}${yymm}${uniqueSuffix}`;
        } else {
          finalGeneratedId = generateStructuredPatientId(
            this.first_name,
            this.last_name || '',
            this.phone,
            hospital.hospitalID
          );
        }

        let isUnique = false;
        let suffixCounter = 0;
        let checkId = finalGeneratedId;

        while (!isUnique) {
          checkId = suffixCounter === 0 ? finalGeneratedId : `${finalGeneratedId}-${suffixCounter}`;
          const exists = await mongoose.model('Patient').findOne({
            hospitalId: hospital._id,
            $or: [{ uhid: checkId }, { patientId: checkId }]
          });

          if (!exists) {
            isUnique = true;
          } else {
            suffixCounter++;
          }
        }

        this.uhid = checkId;
        this.patientId = checkId;
        this.hospitalId = hospital._id;
      }
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

module.exports = mongoose.model('Patient', patientSchema);