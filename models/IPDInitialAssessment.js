const mongoose = require('mongoose');

const amendmentSchema = new mongoose.Schema({
  amendedAt: { type: Date, default: Date.now },
  amendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reason: { type: String, required: true, trim: true },
  snapshot: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const ipdInitialAssessmentSchema = new mongoose.Schema({
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true, unique: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },

  encounterContext: { type: String, enum: ['OPD', 'IPD', 'Emergency'], default: 'IPD' },
  arrivalDateTime: Date,
  assessmentTime: { type: Date, default: Date.now },
  admittedBy: String,
  relation: String,
  caseType: { type: String, enum: ['MLC', 'Non MLC'], default: 'Non MLC' },

  allergies: {
    bloodTransfusion: String,
    drug: String,
    foodAndBeverages: String,
    none: { type: Boolean, default: false },
    other: String
  },
  chiefComplaints: String,
  historyOfPresentingIllness: String,

  personalHistory: {
    occupationalHistory: { significant: Boolean, details: String },
    diet: String,
    habits: [{
      type: String,
      optionalYesNo: String,
      durationSince: String,
      frequency: String,
      quitSince: String
    }]
  },

  pastHistoryMedical: {
    disorders: [{
      particulars: String,
      yesNo: String,
      sinceWhen: String,
      therapy: String
    }],
    obstetricHistory: {
      isApplicable: { type: Boolean, default: false },
      menarche: String,
      lmp: String,
      gravida: String,
      para: String,
      live: String,
      abortion: String
    },
    other: String
  },

  generalExamination: {
    height: {
      value: Number,
      unit: { type: String, enum: ['cm', 'm', 'ft', ''] },
      legacy: String
    },
    weight: {
      value: Number,
      unit: { type: String, enum: ['kg', 'lb', ''] },
      legacy: String
    },
    levelOfConsciousness: String,
    gcs: {
      e: String,
      v: String,
      m: String,
      total: String
    },
    orientation: {
      time: Boolean,
      place: Boolean,
      person: Boolean,
      details: String
    },
    vitals: {
      temp: String,
      pulse: String,
      bp: String,
      rr: String,
      spo2: String,
      rbs: String
    },
    physicalSigns: {
      pallor: String,
      clubbing: String,
      icterus: String,
      edema: String,
      emaciated: String
    },
    bodyHabitus: String,
    psychological: {
      anxious: Boolean,
      depressed: Boolean,
      angry: Boolean,
      suicidal: Boolean,
      homicidal: Boolean,
      other: String
    }
  },

  painScore: {
    score: { type: Number, min: 0, max: 10 },
    duration: String,
    location: String,
    increasingFactor: String,
    decreasingFactor: String
  },
  systemicExamination: [{
    system: String,
    nad: Boolean,
    finding: String
  }],

  triageAndTrauma: {
    airway: { status: String, details: String },
    breathing: {
      rr: String,
      breatheSounds: String,
      percussionNote: String,
      spo2RoomAir: String,
      spo2WithO2: String
    },
    circulation: {
      pulse: String,
      peripheralPulse: String,
      bloodPressure: String,
      others: String
    },
    triageCategory: String,
    burnChart: {
      totalScore: Number,
      burnAreas: [{ area: String, percentage: Number }],
      allegedCause: String,
      gastricLavageSample: String,
      causeOfBurn: String,
      foreignBodiesFound: String
    },
    identificationMarks: {
      mark1: String,
      mark2: String
    },
    externalInjuries: String
  },

  investigationAdvised: {
    pathology: [String],
    radiology: [String],
    otherPathology: String,
    otherRadiology: String
  },

  planAndDisposition: {
    provisionalDiagnosis: String,
    proceduresPerformedInER: [{
      procedure: String,
      performedBy: String,
      sedationUsed: String,
      time: String,
      consentObtained: String,
      consentSignedBy: String,
      sign: String
    }],
    treatmentPlanned: [{
      drugNameAndForm: String,
      dose: String,
      route: String,
      frequency: String
    }],
    otherPlan: String,
    followUpInstructions: String,
    intendedDischargeDate: Date,
    patientStatus: {
      disposition: String,
      referDetails: {
        hospitalName: String,
        reason: String,
        referBy: String
      }
    }
  },

  formStatus: {
    type: String,
    enum: ['Draft', 'Completed', 'Signed', 'Amended'],
    default: 'Draft',
    index: true
  },
  signedAt: Date,
  signedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  signerName: String,
  amendments: [amendmentSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

ipdInitialAssessmentSchema.index({ hospitalId: 1, admissionId: 1 });

module.exports = mongoose.model('IPDInitialAssessment', ipdInitialAssessmentSchema);