'use strict';

const mongoose = require('mongoose');
const { buildDefaultFinancialPolicy } = require('../config/defaultFinancialPolicy');

const notificationChannelSchema = new mongoose.Schema({
  channel: {
    type: String,
    enum: ['portal', 'email', 'sms', 'whatsapp', 'webhook'],
    required: true
  },
  enabled: { type: Boolean, default: false },
  endpoint: { type: String, trim: true },
  sender: { type: String, trim: true },
  apiKey: { type: String, select: false },
  headers: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });


const paymentModeSchema = new mongoose.Schema({
  allowedModes: {
    type: [String],
    enum: ['FULL_PREPAY', 'PARTIAL_PREPAY', 'POSTPAID', 'TPA_SPONSOR', 'AUTHORIZED_EXCEPTION'],
    default: undefined
  },
  defaultMode: {
    type: String,
    enum: ['FULL_PREPAY', 'PARTIAL_PREPAY', 'POSTPAID', 'TPA_SPONSOR', 'AUTHORIZED_EXCEPTION']
  },
  partial: {
    type: { type: String, enum: ['PERCENTAGE', 'FIXED', 'MINIMUM'], default: 'PERCENTAGE' },
    percentage: { type: Number, min: 0, max: 100, default: 30 },
    fixedAmount: { type: Number, min: 0, default: 0 },
    minimumAmount: { type: Number, min: 0, default: 0 },
    allowUserAmount: { type: Boolean, default: false },
    minUserAmount: { type: Number, min: 0, default: 0 },
    maxUserAmount: { type: Number, min: 0, default: 0 }
  }
}, { _id: false });

const financialPolicyRuleSchema = new mongoose.Schema({
  templateKey: { type: String, trim: true, uppercase: true },
  enabled: { type: Boolean, default: true },
  encounterType: { type: String, enum: ['ANY', 'OPD', 'IPD', 'EMERGENCY'], default: 'ANY' },
  urgency: { type: String, enum: ['ANY', 'ROUTINE', 'URGENT', 'STAT', 'EMERGENCY'], default: 'ANY' },
  effectiveFrom: Date,
  effectiveTo: Date,
  serviceType: { type: String, trim: true, uppercase: true },
  serviceCategory: { type: String, trim: true, uppercase: true },
  serviceCode: { type: String, trim: true, uppercase: true },
  payerCategory: { type: String, trim: true, uppercase: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  allowedModes: [{ type: String, enum: ['FULL_PREPAY', 'PARTIAL_PREPAY', 'POSTPAID', 'TPA_SPONSOR', 'AUTHORIZED_EXCEPTION'] }],
  defaultMode: { type: String, enum: ['FULL_PREPAY', 'PARTIAL_PREPAY', 'POSTPAID', 'TPA_SPONSOR', 'AUTHORIZED_EXCEPTION'] },
  partial: {
    type: { type: String, enum: ['PERCENTAGE', 'FIXED', 'MINIMUM'] },
    percentage: { type: Number, min: 0, max: 100 },
    fixedAmount: { type: Number, min: 0 },
    minimumAmount: { type: Number, min: 0 },
    allowUserAmount: Boolean,
    minUserAmount: { type: Number, min: 0 },
    maxUserAmount: { type: Number, min: 0 }
  },
  discount: {
    enabled: Boolean,
    defaultType: { type: String, enum: ['percentage', 'fixed'] },
    defaultValue: { type: Number, min: 0 },
    maxPercentage: { type: Number, min: 0, max: 100 },
    maxFixedAmount: { type: Number, min: 0 },
    registrarMaxPercentage: { type: Number, min: 0, max: 100 },
    financeMaxPercentage: { type: Number, min: 0, max: 100 },
    requireReasonAbove: { type: Number, min: 0 },
    allowFixed: Boolean,
    allowPercentage: Boolean
  },
  tax: {
    enabled: Boolean,
    mode: { type: String, enum: ['exclusive', 'inclusive', 'exempt'] },
    name: String,
    code: String,
    defaultRate: { type: Number, min: 0, max: 100 },
    minRate: { type: Number, min: 0, max: 100 },
    maxRate: { type: Number, min: 0, max: 100 },
    exemptionReason: String
  }
}, { _id: true });

const nabhSettingSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    unique: true,
    index: true
  },
  patientRegistration: {
    requiredFields: {
      type: [String],
      default: ['first_name', 'phone', 'gender', 'dob']
    },
    optionalFields: {
      type: [String],
      default: ['last_name', 'email', 'address', 'city', 'state', 'zipCode', 'identityDocuments', 'aadhaar_last4', 'abha.number', 'sponsor_type', 'sponsor_name', 'sponsor_policy_number', 'paymentPreference']
    },
    enabledChannels: {
      type: [String],
      enum: ['internal', 'website', 'kiosk', 'mobile', 'qr', 'abdm_scan_share'],
      default: ['internal', 'abdm_scan_share']
    },
    requireMobileOtp: { type: Boolean, default: false },
    allowProbableDuplicateOverride: { type: Boolean, default: true },
    duplicateMatchFields: {
      type: [String],
      default: ['phone', 'normalizedPhone', 'abha.number', 'aadhaar_last4', 'first_name', 'dob']
    },
    uhidTemplate: { type: String, default: '{HOSPITAL}-{YY}{MM}-{SEQUENCE}' },
    paymentPreferences: {
      type: [String],
      default: ['cash', 'card', 'upi', 'insurance', 'credit']
    }
  },

  financialPolicy: {
    templateVersion: { type: Number },
    templateName: { type: String, trim: true },
    enabled: { type: Boolean, default: true },
    payment: {
      OPD: { type: paymentModeSchema, default: () => buildDefaultFinancialPolicy().payment.OPD },
      IPD: { type: paymentModeSchema, default: () => buildDefaultFinancialPolicy().payment.IPD },
      EMERGENCY: { type: paymentModeSchema, default: () => buildDefaultFinancialPolicy().payment.EMERGENCY }
    },
    discount: {
      enabled: { type: Boolean, default: () => buildDefaultFinancialPolicy().discount.enabled },
      defaultType: { type: String, enum: ['percentage', 'fixed'], default: () => buildDefaultFinancialPolicy().discount.defaultType },
      defaultValue: { type: Number, min: 0, default: () => buildDefaultFinancialPolicy().discount.defaultValue },
      maxPercentage: { type: Number, min: 0, max: 100, default: () => buildDefaultFinancialPolicy().discount.maxPercentage },
      maxFixedAmount: { type: Number, min: 0, default: () => buildDefaultFinancialPolicy().discount.maxFixedAmount },
      registrarMaxPercentage: { type: Number, min: 0, max: 100, default: () => buildDefaultFinancialPolicy().discount.registrarMaxPercentage },
      financeMaxPercentage: { type: Number, min: 0, max: 100, default: () => buildDefaultFinancialPolicy().discount.financeMaxPercentage },
      requireReasonAbove: { type: Number, min: 0, default: () => buildDefaultFinancialPolicy().discount.requireReasonAbove },
      allowFixed: { type: Boolean, default: () => buildDefaultFinancialPolicy().discount.allowFixed },
      allowPercentage: { type: Boolean, default: () => buildDefaultFinancialPolicy().discount.allowPercentage }
    },
    tax: {
      enabled: { type: Boolean, default: () => buildDefaultFinancialPolicy().tax.enabled },
      mode: { type: String, enum: ['exclusive', 'inclusive', 'exempt'], default: () => buildDefaultFinancialPolicy().tax.mode },
      name: { type: String, trim: true, default: () => buildDefaultFinancialPolicy().tax.name },
      code: { type: String, trim: true, default: () => buildDefaultFinancialPolicy().tax.code },
      defaultRate: { type: Number, min: 0, max: 100, default: () => buildDefaultFinancialPolicy().tax.defaultRate },
      minRate: { type: Number, min: 0, max: 100, default: () => buildDefaultFinancialPolicy().tax.minRate },
      maxRate: { type: Number, min: 0, max: 100, default: () => buildDefaultFinancialPolicy().tax.maxRate },
      exemptionReason: { type: String, trim: true, default: () => buildDefaultFinancialPolicy().tax.exemptionReason }
    },
    rules: { type: [financialPolicyRuleSchema], default: () => buildDefaultFinancialPolicy().rules }
  },
  dischargePolicy: {
    pendingInvestigations: {
      blockLab: { type: Boolean, default: true },
      blockRadiology: { type: Boolean, default: true },
      allowAuthorisedException: { type: Boolean, default: true }
    },
    requireMedicationCompletion: { type: Boolean, default: true },
    requireSummaryFinalized: { type: Boolean, default: true },
    requireStaffCompletedSummary: { type: Boolean, default: true },
    requirePharmacyClearance: { type: Boolean, default: true },
    autoExemptPharmacyWhenNoTransactions: { type: Boolean, default: true },
    requireFinalIPDInvoice: { type: Boolean, default: true },
    requireAdvanceReconciliation: { type: Boolean, default: true },
    requireFinancialClearance: { type: Boolean, default: true },
    unusedIpdAdvanceDisposition: {
      type: String,
      enum: ['REQUIRE_DECISION', 'REQUIRE_REFUND', 'ALLOW_RETAIN'],
      default: 'REQUIRE_DECISION'
    },
    clearanceOrder: {
      type: [String],
      enum: ['PHARMACY_CLEARANCE', 'IPD_FINAL_INVOICE', 'IPD_FINANCIAL_CLEARANCE', 'FINAL_DISCHARGE'],
      default: ['PHARMACY_CLEARANCE', 'IPD_FINAL_INVOICE', 'IPD_FINANCIAL_CLEARANCE', 'FINAL_DISCHARGE']
    },
    doctorRoundCharging: {
      mode: {
        type: String,
        enum: ['AUTO_PER_ROUND', 'ONCE_PER_DAY', 'MANUAL', 'DISABLED'],
        default: 'AUTO_PER_ROUND'
      }
    },
    recurringCharges: {
      bed: { type: Boolean, default: true },
      nursing: { type: Boolean, default: true },
      rmoDutyDoctor: { type: Boolean, default: true }
    }
  },
  notifications: {
    channels: {
      type: [notificationChannelSchema],
      default: [{ channel: 'portal', enabled: true }]
    },
    retryLimit: { type: Number, default: 3, min: 0, max: 10 },
    retryDelayMinutes: { type: Number, default: 5, min: 1, max: 1440 },
    requireAcknowledgementForCritical: { type: Boolean, default: true },
    appointmentRemindersHours: { type: [Number], default: [24, 2] },
    reportReadyEnabled: { type: Boolean, default: true },
    claimStatusEnabled: { type: Boolean, default: true },
    shiftScheduleEnabled: { type: Boolean, default: true }
  },
  security: {
    passwordPolicy: {
      minLength: { type: Number, default: 10, min: 8, max: 128 },
      requireUppercase: { type: Boolean, default: true },
      requireLowercase: { type: Boolean, default: true },
      requireNumbers: { type: Boolean, default: true },
      requireSpecialChars: { type: Boolean, default: true },
      expiryDays: { type: Number, default: 90, min: 0, max: 3650 },
      historyCount: { type: Number, default: 5, min: 0, max: 24 }
    },
    failedLoginTracking: { type: Boolean, default: true },
    maxFailedAttempts: { type: Number, default: 5, min: 3, max: 20 },
    lockoutMinutes: { type: Number, default: 15, min: 1, max: 1440 },
    idleLockMinutes: { type: Number, default: 15, min: 1, max: 480 },
    maxConcurrentSessions: { type: Number, default: 3, min: 1, max: 20 },
    mfaMode: {
      type: String,
      enum: ['disabled', 'optional', 'required_for_admins', 'required'],
      default: 'optional'
    },
    sso: {
      enabled: { type: Boolean, default: false },
      providerName: { type: String, trim: true },
      issuer: { type: String, trim: true },
      audience: { type: String, trim: true },
      assertionSecret: { type: String, select: false },
      allowJustInTimeProvisioning: { type: Boolean, default: false },
      defaultRole: { type: String, default: 'staff' }
    },
    auditRetentionDays: { type: Number, default: 2555, min: 90, max: 7300 },
    requireHttps: { type: Boolean, default: true }
  },
  clinical: {
    notifiableDiseaseCodes: { type: [String], default: [] },
    criticalAlertEscalationMinutes: { type: [Number], default: [0, 5, 15] },
    fallRiskThreshold: { type: Number, default: 45 },
    pressureUlcerRiskThreshold: { type: Number, default: 18 },
    dvtRiskThreshold: { type: Number, default: 2 },
    enableCdss: { type: Boolean, default: true },
    requireCarePlanReview: { type: Boolean, default: true }
  },
  medication: {
    formularyEnforced: { type: Boolean, default: false },
    requireHighRiskDoubleCheck: { type: Boolean, default: true },
    requirePatientBarcodeAtAdministration: { type: Boolean, default: false },
    medicationReconciliationRequired: { type: Boolean, default: true },
    emergencyMedicationReviewDays: { type: Number, default: 30, min: 1, max: 365 }
  },
  operations: {
    archiveAfterDays: { type: Number, default: 1825, min: 30, max: 7300 },
    backupRetentionDays: { type: Number, default: 90, min: 7, max: 3650 },
    backupSchedule: { type: String, default: '0 2 * * *' },
    releaseChannel: {
      type: String,
      enum: ['stable', 'pilot', 'emergency'],
      default: 'stable'
    },
    helpUrl: { type: String, trim: true },
    supportEmail: { type: String, trim: true },
    enableMigrationExports: { type: Boolean, default: true },
    clientSupport: {
      deviceClasses: { type: [String], default: ['desktop', 'laptop', 'tablet', 'smartphone'] },
      browsers: { type: [String], default: ['Chrome', 'Firefox', 'Safari', 'Edge'] },
      mobileOperatingSystems: { type: [String], default: ['Android', 'iOS'] }
    },
    dataClassification: {
      type: [{
        dataClass: { type: String, required: true, trim: true },
        allowedRoles: [{ type: String, trim: true }],
        description: { type: String, trim: true }
      }],
      default: [
        { dataClass: 'clinical', allowedRoles: ['admin', 'doctor', 'nurse', 'staff', 'registrar'] },
        { dataClass: 'financial', allowedRoles: ['admin', 'accountant', 'staff'] }
      ]
    }
  },
  interoperability: {
    icdVersions: { type: [String], default: ['ICD-10', 'ICD-11'] },
    enableSnomed: { type: Boolean, default: true },
    enableLoinc: { type: Boolean, default: true },
    enableDicomMetadata: { type: Boolean, default: true },
    enableNrcesDrugCodes: { type: Boolean, default: true },
    terminologyServiceUrl: { type: String, trim: true },
    dicomWebBaseUrl: { type: String, trim: true }
  },
  version: { type: Number, default: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('NabhSetting', nabhSettingSchema);
