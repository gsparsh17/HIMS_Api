// const mongoose = require('mongoose');

// const medicineSchema = new mongoose.Schema({
//   name: { type: String, required: true },
//   category: { type: String },
//   batch_number: { type: String, required: true },
//   stock_quantity: { type: Number, required: true },
//   expiry_date: { type: Date, required: true },
//   price_per_unit: { type: Number, required: true },
//   supplier: { type: String },
//   created_at: { type: Date, default: Date.now }
// });

// module.exports = mongoose.model('Medicine', medicineSchema);


const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  generic_name: { type: String, trim: true },
  brand: { type: String, trim: true },
  category: { type: String, required: true },
  // dosage_form: { type: String, enum: ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 'Drops', 'Inhaler', 'Other'] },
  strength: { type: String },
  description: { type: String },
  min_stock_level: { type: Number, default: 10 },
  // price_per_unit: { type: Number, required: true, min: 0 },
  // cost_price: { type: Number, min: 0 },
  prescription_required: { type: Boolean, default: false },
  // tax_rate: { type: Number, default: 0 },
  location: {
    shelf: { type: String },
    rack: { type: String }
  },
  is_active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

medicineSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

module.exports = mongoose.model('Medicine', medicineSchema);

