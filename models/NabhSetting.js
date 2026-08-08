'use strict';

const mongoose = require('mongoose');

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
