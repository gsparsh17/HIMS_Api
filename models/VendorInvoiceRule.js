'use strict';

const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema(
  {
    field: {
      type: String,
      required: true
    },
    rule: {
      type: String,
      enum: ['required', 'min', 'max', 'regex', 'allowed'],
      required: true
    },
    value: {
      type: mongoose.Schema.Types.Mixed
    },
    message: {
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
    name: {
      type: String,
      required: true,
      trim: true
    },
    rules: {
      type: [ruleSchema],
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
    name: 1
  },
  {
    unique: true
  }
);

module.exports = mongoose.model('VendorInvoiceRule', schema);