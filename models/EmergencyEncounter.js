'use strict';

const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');

const codeSchema = new mongoose.Schema(
  {
    codeType: {
      type: String,
      required: true
    },
    activatedAt: {
      type: Date,
      default: operationNow
    },
    activatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    closedAt: {
      type: Date
    },
    notes: {
      type: String
    },
    responses: {
      type: [
        {
          responderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
          },
          respondedAt: {
            type: Date,
            default: operationNow
          },
          action: {
            type: String
          },
          note: {
            type: String
          }
        }
      ]
    }
  },
  {
    _id: true
  }
);

const schema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    emergencyNumber: {
      type: String,
      required: true
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
      index: true
    },
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IPDAdmission',
      index: true
    },
    source: {
      type: String,
      enum: ['standalone', 'front_desk'],
      default: 'standalone'
    },
    readmissionReference: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmergencyEncounter'
    },
    arrivalAt: {
      type: Date,
      default: operationNow
    },
    triage: {
      category: {
        type: String,
        enum: ['red', 'orange', 'yellow', 'green', 'blue'],
        default: 'yellow'
      },
      chiefComplaint: {
        type: String
      },
      vitals: {
        type: mongoose.Schema.Types.Mixed
      },
      triagedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      triagedAt: {
        type: Date
      }
    },
    medicoLegal: {
      isMlc: {
        type: Boolean,
        default: false
      },
      caseNumber: {
        type: String
      },
      policeStation: {
        type: String
      },
      policeInformedAt: {
        type: Date
      },
      notes: {
        type: String
      }
    },
    ambulanceHandoff: {
      ambulanceNumber: {
        type: String
      },
      agency: {
        type: String
      },
      paramedicName: {
        type: String
      },
      preHospitalSummary: {
        type: String
      },
      treatmentGiven: {
        type: String
      },
      vitals: {
        type: mongoose.Schema.Types.Mixed
      },
      deviceReference: {
        type: String
      },
      handoffAt: {
        type: Date
      },
      receivedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    },
    codeActivations: {
      type: [codeSchema],
      default: []
    },
    status: {
      type: String,
      enum: ['registered', 'triaged', 'in_treatment', 'admitted', 'discharged', 'transferred'],
      default: 'registered',
      index: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  {
    timestamps: true,
    minimize: false
  }
);

schema.index(
  {
    hospitalId: 1,
    emergencyNumber: 1
  },
  {
    unique: true
  }
);

schema.index(
  { hospitalId: 1, appointmentId: 1 },
  {
    name: 'uniq_emergency_frontdesk_appointment',
    unique: true,
    partialFilterExpression: { appointmentId: { $type: 'objectId' } }
  }
);

schema.index(
  { hospitalId: 1, admissionId: 1 },
  {
    name: 'uniq_emergency_frontdesk_admission',
    unique: true,
    partialFilterExpression: { admissionId: { $type: 'objectId' } }
  }
);

module.exports = mongoose.model('EmergencyEncounter', schema);