// const mongoose = require('mongoose');

// const invoiceItemSchema = new mongoose.Schema({
//   medicine_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
//   name: { type: String, required: true },
//   quantity: { type: Number, required: true },
//   price: { type: Number, required: true },
// });

// const pharmacyInvoiceSchema = new mongoose.Schema({
//   patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
//   doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
//   items: [invoiceItemSchema],
//   total_amount: { type: Number, required: true },
//   payment_mode: { type: String, required: true, enum: ['Cash', 'Card', 'Online'] },
//   status: { type: String, required: true, enum: ['Paid', 'Unpaid', 'Cancelled'], default: 'Paid' },
// }, { timestamps: true });

// // The model name is now 'PharmacyInvoice'
// module.exports = mongoose.model('PharmacyInvoice', pharmacyInvoiceSchema);