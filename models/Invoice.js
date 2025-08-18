const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  amount: { type: Number, required: true },
});

const paymentSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  reference: { type: String },
  status: { type: String, default: 'Completed' },
});

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  issueDate: { type: Date, default: Date.now },
  dueDate: { type: Date, required: true },
  status: { type: String, enum: ['Paid', 'Pending', 'Partial', 'Overdue', 'Cancelled'], default: 'Pending' },
  services: [serviceSchema],
  subtotal: { type: Number, required: true },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
  amountPaid: { type: Number, default: 0 },
  paymentHistory: [paymentSchema],
},{ timestamps: true });

module.exports = mongoose.model('Invoice', invoiceSchema);