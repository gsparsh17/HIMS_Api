'use strict';

const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true
    },
    text: {
      type: Map,
      of: String,
      required: true
    },
    type: {
      type: String,
      enum: ['rating_1_5', 'text', 'yes_no'],
      default: 'rating_1_5'
    },
    required: {
      type: Boolean,
      default: true
    }
  },
  {
    _id: false
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
    surveyType: {
      type: String,
      enum: ['feedback', 'prom', 'prem'],
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    version: {
      type: Number,
      default: 1,
      min: 1
    },
    questions: {
      type: [questionSchema],
      default: []
    },
    active: {
      type: Boolean,
      default: true,
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
    timestamps: true
  }
);

schema.index(
  {
    hospitalId: 1,
    surveyType: 1,
    name: 1,
    version: 1
  },
  {
    unique: true
  }
);

module.exports = mongoose.model('PatientExperienceSurvey', schema);