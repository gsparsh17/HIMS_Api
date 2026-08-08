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
    completedItems: {
      type: [String]
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed'],
      default: 'pending'
    },
    feedbackScore: {
      type: Number,
      min: 1,
      max: 5
    },
    feedback: {
      type: String
    },
    completedAt: {
      type: Date
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
    employeeId: 1
  },
  {
    unique: true
  }
);

module.exports = mongoose.model('HRInduction', schema);