'use strict';

const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');

const itemSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true
    },
    label: {
      type: String,
      required: true
    },
    medicineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Medicine'
    },
    available: {
      type: Boolean
    },
    quantity: {
      type: Number,
      min: 0
    },
    expiryChecked: {
      type: Boolean
    },
    complete: {
      type: Boolean,
      default: false
    },
    note: {
      type: String
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
    location: {
      type: String,
      required: true,
      index: true
    },
    checklistDate: {
      type: Date,
      default: operationNow,
      index: true
    },
    items: {
      type: [itemSchema],
      default: []
    },
    status: {
      type: String,
      enum: ['draft', 'completed'],
      default: 'draft'
    },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    completedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('EmergencyMedicationChecklist', schema);