const mongoose = require('mongoose');

const mappingSchema = new mongoose.Schema({
  model: { type: String, enum: ['LabTest', 'ImagingTest', 'Procedure', 'Bed', 'BillingServiceMaster', 'Medicine', 'Other'] },
  id: { type: mongoose.Schema.Types.ObjectId },
  code: String,
  name: String,
  mappingStatus: { type: String, enum: ['unmapped', 'suggested', 'reviewed', 'approved', 'rejected'], default: 'unmapped', index: true },
  confidence: { type: Number, min: 0, max: 1 },
  rationale: String,
  suggestedBy: { type: String, enum: ['system', 'user', 'import'] },
  suggestedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: Date,
  rejectionReason: String
}, { _id: false });

const packageComponentSchema = new mongoose.Schema({
  componentType: { type: String, enum: ['service', 'service_type', 'category', 'medicine', 'consumable', 'room', 'equipment', 'professional_fee', 'investigation', 'other'], required: true },
  model: { type: String, enum: ['LabTest', 'ImagingTest', 'Procedure', 'Bed', 'BillingServiceMaster', 'Medicine', 'Other'] },
  internalServiceId: mongoose.Schema.Types.ObjectId,
  internalCode: String,
  serviceType: String,
  category: String,
  namePattern: String,
  quantityLimit: Number,
  amountLimit: Number,
  frequency: { type: String, enum: ['per_package', 'per_day', 'per_encounter', 'unlimited'], default: 'unlimited' },
  patientPays: { type: Boolean, default: false },
  notes: String
}, { _id: false });

const rateCardItemSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  rateCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCard', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  externalCode: { type: String, required: true, trim: true, uppercase: true },
  externalName: { type: String, required: true, trim: true },
  serviceType: { type: String, enum: ['consultation', 'laboratory', 'radiology', 'procedure', 'ot', 'bed', 'pharmacy', 'equipment', 'other'], required: true },
  // Optional clinician-specific tariff dimensions. This keeps patient-facing
  // consultation pricing in the central rate-card rather than Doctor payroll fields.
  clinicianContext: {
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', index: true },
    encounterType: { type: String, enum: ['OPD', 'IPD', 'ANY'], default: 'ANY' },
    visitType: { type: String, enum: ['NEW', 'FOLLOW_UP', 'ROUND', 'ANY'], default: 'ANY' },
    wardEntitlement: { type: String, enum: ['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care', 'not_applicable', 'ANY'], default: 'ANY' }
  },
  specialty: { type: String, trim: true },
  category: { type: String, trim: true },
  normalizedCategory: { type: String, trim: true, lowercase: true, index: true },
  pricingMode: { type: String, enum: ['matrix', 'flat', 'exact_ward', 'package', 'non_admissible'], default: 'matrix', index: true },
  internalService: { type: mappingSchema, default: () => ({ mappingStatus: 'unmapped' }) },
  mappingOptions: {
    allowMultipleExternalCodes: { type: Boolean, default: false },
    requiredForBilling: { type: Boolean, default: true, index: true },
    unavailableAtHospital: { type: Boolean, default: false, index: true },
    note: String
  },
  rates: {
    tierI: { nonNabh: Number, nabh: Number, superSpeciality: Number },
    tierII: { nonNabh: Number, nabh: Number, superSpeciality: Number },
    tierIII: { nonNabh: Number, nabh: Number, superSpeciality: Number },
    flatAmount: Number,
    exactWard: {
      general: Number,
      semiPrivate: Number,
      private: Number,
      deluxe: Number,
      icu: Number,
      dayCare: Number,
      notApplicable: Number
    }
  },
  timeSlabs: [{
    sequence: Number,
    fromHour: Number,
    toHour: Number,
    amount: Number,
    unit: { type: String, enum: ['hour', 'day', 'visit', 'procedure'], default: 'hour' }
  }],
  patientShare: {
    mode: { type: String, enum: ['coverage_default', 'percentage', 'fixed', 'sponsor_cap', 'patient_full'], default: 'coverage_default' },
    percentage: { type: Number, min: 0, max: 100 },
    fixedAmount: { type: Number, min: 0 },
    sponsorCap: { type: Number, min: 0 }
  },
  packagePeriodDays: { type: Number, min: 0 },
  packageDefinition: {
    isPackage: { type: Boolean, default: false },
    triggerOnCharge: { type: Boolean, default: true },
    startsAt: { type: String, enum: ['procedure_time', 'admission_time', 'charge_time'], default: 'procedure_time' },
    inclusions: [packageComponentSchema],
    exclusions: [packageComponentSchema],
    defaultUnlistedComponentTreatment: { type: String, enum: ['included', 'excluded', 'cash_fallback', 'payer_rate'], default: 'excluded' },
    includesMedicines: { type: Boolean, default: false },
    includesConsumables: { type: Boolean, default: false },
    includesInvestigations: { type: Boolean, default: false },
    includesRoom: { type: Boolean, default: false },
    includesProfessionalFees: { type: Boolean, default: false }
  },
  wardUniform: { type: Boolean, default: false },
  allowedWards: [{ type: String }],
  inclusions: [{ type: String }],
  exclusions: [{ type: String }],
  nonAdmissibleRules: [{ code: String, description: String, amount: Number, percentage: Number, patientCollectible: { type: Boolean, default: true } }],
  claimRules: {
    preAuthorisationRequired: { type: Boolean, default: false },
    documentationCodes: [String],
    maximumUnits: Number,
    frequencyLimitDays: Number,
    notes: String
  },
  validation: {
    status: { type: String, enum: ['not_validated', 'valid', 'pending', 'warning', 'invalid'], default: 'not_validated', index: true },
    issues: [{ code: String, severity: { type: String, enum: ['error', 'warning', 'info'] }, message: String }],
    validatedAt: Date
  },
  active: { type: Boolean, default: true },
  sourceRow: { page: Number, serialNumber: Number, sheet: String, annexure: String, raw: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

// One external payer code may legitimately have multiple clinician-context
// variants (doctor/new-vs-follow-up/IPD ward). Keep normal service rows unique
// while allowing those tariff dimensions to coexist in the same rate card.
rateCardItemSchema.index({
  rateCardId: 1,
  externalCode: 1,
  'clinicianContext.doctorId': 1,
  'clinicianContext.encounterType': 1,
  'clinicianContext.visitType': 1,
  'clinicianContext.wardEntitlement': 1
}, { unique: true, name: 'rateCard_external_clinician_context_unique' });
rateCardItemSchema.index({ hospitalId: 1, 'internalService.model': 1, 'internalService.id': 1, 'internalService.mappingStatus': 1 });
rateCardItemSchema.index({ hospitalId: 1, serviceType: 1, normalizedCategory: 1 });
rateCardItemSchema.index({ hospitalId: 1, rateCardId: 1, 'clinicianContext.doctorId': 1, 'clinicianContext.encounterType': 1, 'clinicianContext.visitType': 1, 'clinicianContext.wardEntitlement': 1 });

rateCardItemSchema.pre('validate', function normalize(next) {
  this.externalCode = String(this.externalCode || '').trim().toUpperCase();
  this.externalName = String(this.externalName || '').trim();
  this.category = String(this.category || '').trim();
  this.normalizedCategory = this.category.toLocaleLowerCase('en-IN').replace(/\s+/g, ' ').trim();
  if (this.packageDefinition?.isPackage) this.pricingMode = 'package';
  next();
});

module.exports = mongoose.model('RateCardItem', rateCardItemSchema);
