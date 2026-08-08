'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    trainingEventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HRTrainingEvent',
      required: true,
      index: true
    },
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HRStaffProfile',
      required: true,
      index: true
    },
    attendanceStatus: {
      type: String,
      enum: ['present', 'absent', 'partial'],
      required: true
    },
    feedbackScore: {
      type: Number,
      min: 1,
      max: 5
    },
    feedback: {
      type: String
    },
    assessmentScore: {
      type: Number,
      min: 0,
      max: 100
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  {
    timestamps: true
  }
);

schema.index(
  {
    hospitalId: 1,
    trainingEventId: 1,
    employeeId: 1
  },
  {
    unique: true
  }
);

module.exports = mongoose.model('HRTrainingAttendance', schema);