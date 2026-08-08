'use strict';

const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true
    },
    label: {
      type: String,
      required: true
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
    processType: {
      type: String,
      enum: ['recruitment', 'exit'],
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true
    },
    steps: {
      type: [stepSchema],
      default: []
    },
    active: {
      type: Boolean,
      default: true
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
    processType: 1,
    name: 1
  },
  {
    unique: true
  }
);

module.exports = mongoose.model('HRWorkflowRule', schema);