'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  slug: { type: String, required: true, trim: true, lowercase: true },
  category: { type: String, enum: ['documentation','faq','tutorial'], required: true, index: true },
  title: { type: String, required: true, trim: true },
  content: { type: String, required: true },
  keywords: [{ type: String, trim: true, lowercase: true }],
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, slug: 1 }, { unique: true, sparse: true });
module.exports = mongoose.model('HelpArticle', schema);
