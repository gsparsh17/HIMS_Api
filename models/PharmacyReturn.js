const mongoose = require('mongoose');

const pharmacyReturnItemSchema = new mongoose.Schema({
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
  medicineName: { type: String, required: true, trim: true },
  returnedQtyBaseUnits: { type: Number, required: true, min: 0 },
  baseUnit: { type: String, default: 'unit' },
  unitsPerPack: { type: Number, default: 1, min: 1 },
  ratePerBaseUnit: { type: Number, required: true, min: 0 },
  grossAmount: { type: Number, default: 0 },
  discountReversal: { type: Number, default: 0 },
  refundAmount: { type: Number, default: 0 },
  condition: { type: String, enum: ['SEALED_USABLE', 'OPENED_UNUSABLE', 'DAMAGED'], default: 'SEALED_USABLE' },
  restock: { type: Boolean, default: true }
}, { _id: true });

const pharmacyReturnSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', index: true },
  returnNumber: { type: String, unique: true },
  originalSaleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
  originalInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  returnType: { type: String, enum: ['IPD_UNUSED_MEDICINE', 'OPD_RETURN', 'WALKIN_RETURN'], default: 'IPD_UNUSED_MEDICINE' },
  items: [pharmacyReturnItemSchema],
  totalRefundAmount: { type: Number, default: 0 },
  refundMode: { type: String, enum: ['Cash', 'UPI', 'Card', 'IPDAdvance', 'PharmacyAdvance', 'NoRefund'], default: 'IPDAdvance' },
  status: { type: String, enum: ['Completed', 'PendingApproval', 'Rejected'], default: 'Completed' },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

pharmacyReturnSchema.pre('validate', async function(next) {
  if (this.isNew && !this.returnNumber) {
    const count = await mongoose.model('PharmacyReturn').countDocuments();
    this.returnNumber = `PHR-${Date.now()}-${count + 1}`;
  }
  this.items = (this.items || []).map(item => {
    item.grossAmount = Number((item.returnedQtyBaseUnits * item.ratePerBaseUnit).toFixed(2));
    item.refundAmount = Number((item.grossAmount - (item.discountReversal || 0)).toFixed(2));
    return item;
  });
  this.totalRefundAmount = Number(this.items.reduce((sum, item) => sum + (item.refundAmount || 0), 0).toFixed(2));
  next();
});

pharmacyReturnSchema.index({ admissionId: 1, createdAt: -1 });
pharmacyReturnSchema.index({ returnType: 1, createdAt: -1 });

module.exports = mongoose.model('PharmacyReturn', pharmacyReturnSchema);
