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
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HRStaffProfile',
      required: true,
      index: true
    },
    period: {
      type: String,
      required: true
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true
    },
    goals: {
      type: [String]
    },
    strengths: {
      type: [String]
    },
    improvementAreas: {
      type: [String]
    },
    comments: {
      type: String
    },
    appraisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    appraisedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

schema.index(
  {
    hospitalId: 1,
    employeeId: 1,
    period: 1
  },
  {
    unique: true
  }
);

module.exports = mongoose.model('HRAppraisal', schema);