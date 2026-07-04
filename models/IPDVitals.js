const mongoose = require("mongoose");
const { DEFAULT_TIMEZONE, EWS_CONFIG } = require("../config/clinicalScoring");
const { clinicalContext } = require("../utils/clinicalDate");

const round1 = (n) => Math.round((Number(n) + Number.EPSILON) * 10) / 10;

function fahrenheit(value, unit) {
  if (value === undefined || value === null || value === "") return undefined;
  return unit === "Fahrenheit"
    ? Number(value)
    : round1((Number(value) * 9) / 5 + 32);
}

function calculateEws(doc) {
  const parameterScores = EWS_CONFIG.score({
    respiratoryRate: doc.respiratoryRate,
    spo2: doc.spo2,
    pulse: doc.pulse,
    systolicBP: doc.bloodPressure?.systolic,
    temperatureF: fahrenheit(doc.temperature, doc.temperatureUnit),
    consciousnessResponse: doc.consciousnessResponse,
    noUrineOverSixHours: doc.noUrineOverSixHours,
  });

  const ewsTotal = Object.values(parameterScores).reduce(
    (sum, n) => sum + (Number(n) || 0),
    0
  );
  const triggerReason = [];

  if (ewsTotal >= EWS_CONFIG.escalationTotal) {
    triggerReason.push(`EWS total >= ${EWS_CONFIG.escalationTotal}`);
  }

  if (
    Object.values(parameterScores).some(
      (n) => n >= EWS_CONFIG.escalationParameterScore
    )
  ) {
    triggerReason.push(
      `Single parameter score >= ${EWS_CONFIG.escalationParameterScore}`
    );
  }

  return {
    parameterScores,
    ewsTotal,
    triggerReason,
    escalationRequired: triggerReason.length > 0,
  };
}

const ipdVitalsSchema = new mongoose.Schema(
  {
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IPDAdmission",
      required: true,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      index: true,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    recordedByName: {
      type: String,
      trim: true,
    },
    recordedByInitials: {
      type: String,
      trim: true,
    },
    recordedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    recordedTimezone: {
      type: String,
      default: DEFAULT_TIMEZONE,
    },
    chartDate: {
      type: String,
      index: true,
    },
    clinicalShift: {
      type: String,
      enum: ["M", "E", "N"],
      index: true,
    },

    temperature: {
      type: Number,
      min: 80,
      max: 115,
    },
    temperatureUnit: {
      type: String,
      enum: ["Celsius", "Fahrenheit"],
      default: "Celsius",
    },
    pulse: {
      type: Number,
      min: 20,
      max: 280,
    },
    bloodPressure: {
      systolic: {
        type: Number,
        min: 40,
        max: 320,
      },
      diastolic: {
        type: Number,
        min: 20,
        max: 220,
      },
      map: {
        type: Number,
      },
    },
    bloodPressureString: String,
    respiratoryRate: {
      type: Number,
      min: 4,
      max: 80,
    },
    spo2: {
      type: Number,
      min: 40,
      max: 100,
    },
    consciousnessResponse: {
      type: String,
      enum: ["Alert", "Voice", "Pain", "Unresponsive", "Confusion", ""],
    },
    bloodSugar: {
      type: Number,
      min: 20,
      max: 800,
    },
    weight: {
      type: Number,
      min: 0.5,
      max: 350,
    },
    height: {
      type: Number,
      min: 20,
      max: 260,
    },
    painScore: {
      type: Number,
      min: 0,
      max: 10,
    },
    glasgowComaScale: {
      eyeResponse: {
        type: Number,
        min: 1,
        max: 4,
      },
      verbalResponse: {
        type: Number,
        min: 1,
        max: 5,
      },
      motorResponse: {
        type: Number,
        min: 1,
        max: 6,
      },
      total: {
        type: Number,
        min: 3,
        max: 15,
      },
    },

    onOxygen: {
      type: Boolean,
      default: false,
    },
    roomAir: {
      type: Boolean,
      default: true,
    },
    oxygenDevice: {
      type: String,
      trim: true,
    },
    oxygenFlowLpm: {
      type: Number,
      min: 0,
      max: 80,
    },

    ivFluidsMl: {
      type: Number,
      min: 0,
      default: 0,
    },
    oralRtMl: {
      type: Number,
      min: 0,
      default: 0,
    },
    urineMl: {
      type: Number,
      min: 0,
      default: 0,
    },
    rtOutputMl: {
      type: Number,
      min: 0,
      default: 0,
    },
    vomitMl: {
      type: Number,
      min: 0,
      default: 0,
    },
    bowelMovement: {
      type: String,
      trim: true,
    },
    noUrineOverSixHours: {
      type: Boolean,
      default: false,
    },
    outputNotes: {
      type: String,
      trim: true,
    },
    intakeOutput: {
      intake: {
        type: Number,
        default: 0,
      },
      output: {
        type: Number,
        default: 0,
      },
      notes: String,
    },

    ewsVersion: {
      type: String,
      default: EWS_CONFIG.version,
    },
    scoringPendingClinicalApproval: {
      type: Boolean,
      default: !EWS_CONFIG.approved,
    },
    parameterScores: {
      heartRate: Number,
      respiratoryRate: Number,
      systolicBP: Number,
      temperature: Number,
      spo2: Number,
      consciousness: Number,
      urineSelfVoiding: Number,
      urineMeasured: Number,
    },
    ewsTotal: {
      type: Number,
      default: 0,
    },
    triggerReason: [String],
    escalationRequired: {
      type: Boolean,
      default: false,
    },
    escalationLevel: {
      type: String,
      trim: true,
    },
    escalationAcknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    escalationAcknowledgedAt: Date,
    escalationAction: {
      type: String,
      trim: true,
    },

    remarks: {
      type: String,
      trim: true,
    },
    isAbnormal: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["Draft", "Signed", "Amended"],
      default: "Draft",
      index: true,
    },
    signedAt: Date,
    signedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    amendedAt: Date,
    amendedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    amendmentReason: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

ipdVitalsSchema.pre("validate", function (next) {
  const context = clinicalContext(
    this.recordedAt,
    this.recordedTimezone || DEFAULT_TIMEZONE
  );
  this.chartDate = context.chartDate;
  this.clinicalShift = context.clinicalShift;

  if (this.bloodPressure?.systolic && this.bloodPressure?.diastolic) {
    this.bloodPressureString = `${this.bloodPressure.systolic}/${this.bloodPressure.diastolic}`;
    this.bloodPressure.map = round1(
      (Number(this.bloodPressure.systolic) + 2 * Number(this.bloodPressure.diastolic)) /
        3
    );
  }

  this.intakeOutput = this.intakeOutput || {};
  this.intakeOutput.intake =
    Number(this.ivFluidsMl || 0) + Number(this.oralRtMl || 0);
  this.intakeOutput.output =
    Number(this.urineMl || 0) +
    Number(this.rtOutputMl || 0) +
    Number(this.vomitMl || 0);

  const score = calculateEws(this);
  this.parameterScores = score.parameterScores;
  this.ewsTotal = score.ewsTotal;
  this.triggerReason = score.triggerReason;
  this.escalationRequired = score.escalationRequired;
  this.scoringPendingClinicalApproval = !EWS_CONFIG.approved;

  const tempF = fahrenheit(this.temperature, this.temperatureUnit);
  this.isAbnormal =
    this.escalationRequired ||
    (Number.isFinite(tempF) && (tempF < 97 || tempF > 99.5)) ||
    (this.pulse && (this.pulse < 60 || this.pulse > 100)) ||
    (this.spo2 && this.spo2 < 95) ||
    (this.respiratoryRate && (this.respiratoryRate < 12 || this.respiratoryRate > 20));

  next();
});

ipdVitalsSchema.statics.calculateEws = calculateEws;

ipdVitalsSchema.index({
  hospitalId: 1,
  admissionId: 1,
  chartDate: 1,
  recordedAt: 1,
});
ipdVitalsSchema.index({ admissionId: 1, recordedAt: -1 });
ipdVitalsSchema.index({ patientId: 1, recordedAt: -1 });

module.exports = mongoose.model("IPDVitals", ipdVitalsSchema);