const mongoose = require('mongoose');

const purchaseSchema = new mongoose.Schema({
  itemName: { type: String, required: true },
  quantity: { type: Number, required: true },
  amount: { type: Number, required: true },
  paymentMode: { type: String, required: true },
  status: { type: String, required: true },
  date: { type: Date, default: Date.now }
});

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, unique: true, sparse: true }, // Allows null emails but unique if provided
  address: { type: String },
  description: { type: String },
  purchases: [purchaseSchema],
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Customer', customerSchema);