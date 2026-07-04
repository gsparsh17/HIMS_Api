const mongoose = require("mongoose");

const ipdRoundSchema = new mongoose.Schema(
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
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: true,
    },
    roundDateTime: {
      type: Date,
      default: Date.now,
    },

    patientCondition: {
      type: String,
      enum: [
        "Stable",
        "Improving",
        "Critical",
        "Deteriorating",
        "Serious",
        "Recovering",
      ],
      default: "Stable",
    },
    complaints: String,
    symptoms: String,
    examinationFindings: String,
    dailyHistoryAndExamination: String,
    diagnosis: String,
    treatmentPlan: String,
    medicationChanges: String,
    advice: String,
    prescriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Prescription",
    },

    safetyChecklist: {
      vteProphylaxis: {
        type: String,
        enum: ["Yes", "No", "NA", ""],
      },
      antibiotics: {
        type: String,
        enum: ["Yes", "No", "NA", ""],
      },
      medications: {
        type: String,
        enum: ["Yes", "No", "NA", ""],
      },
      ivLines: {
        type: String,
        enum: ["Yes", "No", "NA", ""],
      },
      catheters: {
        type: String,
        enum: ["Yes", "No", "NA", ""],
      },
      ews: {
        type: String,
        enum: ["Yes", "No", "NA", ""],
      },
    },

    vitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IPDVitals",
    },
    vitalSnapshot: {
      sourceTime: Date,
      bp: String,
      pulse: Number,
      respiratoryRate: Number,
      spo2: Number,
    },

    dischargeSuggested: {
      type: Boolean,
      default: false,
    },
    dischargeAssessment: {
      isFitForDischarge: {
        type: Boolean,
        default: false,
      },
      intendedDischargeDate: Date,
      dischargeInstructions: String,
      consultantSignedAt: Date,
      consultantSignedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    },

    painScore: {
      type: Number,
      min: 0,
      max: 10,
      default: 0,
    },
    notes: String,

    status: {
      type: String,
      enum: ["Draft", "Signed", "Amended"],
      default: "Draft",
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
    amendmentReason: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

ipdRoundSchema.index({ hospitalId: 1, admissionId: 1, roundDateTime: -1 });
ipdRoundSchema.index({ doctorId: 1, roundDateTime: -1 });

module.exports = mongoose.model("IPDRound", ipdRoundSchema);