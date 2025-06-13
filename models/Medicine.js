const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String },
  stock_quantity: { type: Number, required: true },
  expiry_date: { type: Date, required: true },
  price_per_unit: { type: Number, required: true },
  supplier: { type: String },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Medicine', medicineSchema);
