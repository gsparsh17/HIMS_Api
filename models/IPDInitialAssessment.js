const mongoose = require('mongoose');

const ipdInitialAssessmentSchema = new mongoose.Schema({
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  
  // Header
  assessmentTime: { type: Date, default: Date.now },
  admittedBy: { type: String },
  relation: { type: String },
  caseType: { type: String, enum: ['MLC', 'Non MLC'], default: 'Non MLC' },

  // PAGE 1
  allergies: {
    bloodTransfusion: { type: String },
    drug: { type: String },
    foodAndBeverages: { type: String },
    none: { type: Boolean, default: false },
    other: { type: String }
  },
  chiefComplaints: { type: String },
  historyOfPresentingIllness: { type: String },
  
  personalHistory: {
    occupationalHistory: {
      significant: { type: Boolean },
      details: { type: String }
    },
    diet: { type: String },
    habits: [{
      type: { type: String }, // Cigarette, Tobacco, Alcohol, Drugs
      optionalYesNo: { type: String },
      durationSince: { type: String },
      frequency: { type: String },
      quitSince: { type: String }
    }]
  },

  pastHistoryMedical: {
    disorders: [{
      particulars: { type: String }, // Hypertension, COPD, Diabetes, etc.
      yesNo: { type: String },
      sinceWhen: { type: String },
      therapy: { type: String }
    }],
    obstetricHistory: {
      isApplicable: { type: Boolean, default: false },
      menarche: { type: String },
      lmp: { type: String },
      gravida: { type: String },
      para: { type: String },
      live: { type: String },
      abortion: { type: String }
    },
    other: { type: String }
  },

  // PAGE 2
  generalExamination: {
    height: { type: String },
    weight: { type: String },
    levelOfConsciousness: { type: String }, // Conscious, Drowsy, Unresponsive
    gcs: {
      e: { type: String },
      v: { type: String },
      m: { type: String },
      total: { type: String }
    },
    orientation: {
      time: { type: Boolean },
      place: { type: Boolean },
      person: { type: Boolean }
    },
    vitals: {
      temp: { type: String },
      pulse: { type: String },
      bp: { type: String },
      rr: { type: String },
      spo2: { type: String },
      rbs: { type: String }
    },
    physicalSigns: {
      pallor: { type: String },
      clubbing: { type: String },
      icterus: { type: String },
      edema: { type: String },
      emaciated: { type: String }
    },
    bodyHabitus: { type: String }, // Obese, Average Built, Thin, Cachecic
    psychological: {
      anxious: { type: Boolean },
      depressed: { type: Boolean },
      angry: { type: Boolean },
      suicidal: { type: Boolean },
      homicidal: { type: Boolean },
      other: { type: String }
    }
  },

  painScore: {
    score: { type: Number, min: 0, max: 10 },
    duration: { type: String },
    location: { type: String },
    increasingFactor: { type: String },
    decreasingFactor: { type: String }
  },

  systemicExamination: [{
    system: { type: String }, // Constitutional, CVS, Endocrine, etc.
    nad: { type: Boolean },
    finding: { type: String }
  }],

  // PAGE 3
  triageAndTrauma: {
    airway: { type: String }, // Clear, Silent, Snoring, Gurgling
    breathing: {
      rr: { type: String },
      breatheSounds: { type: String },
      percussionNote: { type: String },
      spo2RoomAir: { type: String },
      spo2WithO2: { type: String }
    },
    circulation: {
      pulse: { type: String },
      peripheralPulse: { type: String },
      bloodPressure: { type: String },
      others: { type: String }
    },
    triageCategory: { type: String }, // Red, Yellow, Green, Black
    
    burnChart: {
      totalScore: { type: Number },
      allegedCause: { type: String },
      gastricLavageSample: { type: String },
      causeOfBurn: { type: String },
      foreignBodiesFound: { type: String }
    },
    
    identificationMarks: {
      mark1: { type: String },
      mark2: { type: String }
    },
    externalInjuries: { type: String }
  },

  investigationAdvised: {
    pathology: [{ type: String }],
    radiology: [{ type: String }],
    otherPathology: { type: String },
    otherRadiology: { type: String }
  },

  // PAGE 4
  planAndDisposition: {
    provisionalDiagnosis: { type: String },
    proceduresPerformedInER: [{
      procedure: { type: String },
      performedBy: { type: String },
      sedationUsed: { type: String },
      time: { type: String },
      consentObtained: { type: String },
      sign: { type: String }
    }],
    treatmentPlanned: [{
      drugNameAndForm: { type: String },
      dose: { type: String },
      route: { type: String },
      frequency: { type: String }
    }],
    otherPlan: { type: String },
    followUpInstructions: { type: String },
    
    patientStatus: {
      disposition: { type: String }, // Home, Ward, OT
      referDetails: {
        hospitalName: { type: String },
        reason: { type: String },
        referBy: { type: String }
      }
    }
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true
});

module.exports = mongoose.model('IPDInitialAssessment', ipdInitialAssessmentSchema);
