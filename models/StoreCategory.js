const mongoose = require('mongoose');

const storeCategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true, uppercase: true },
  description: { type: String, trim: true },
  is_active: { type: Boolean, default: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

storeCategorySchema.index({ hospital_id: 1, name: 1 }, { unique: true });
storeCategorySchema.index({ is_active: 1 });

module.exports = mongoose.model('StoreCategory', storeCategorySchema);
