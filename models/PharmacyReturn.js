const mongoose = require('mongoose');

const pharmacyReturnItemSchema = new mongoose.Schema({
  transactionGroupId: { type: String, index: true },
  parentGroupId: { type: String, index: true },
  idempotencyKey: { type: String, index: true },
  presentationType: { type: String, trim: true },
  saleItemId: { type: mongoose.Schema.Types.ObjectId },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
  medicineName: { type: String, required: true, trim: true },
  returnedQtyBaseUnits: { type: Number, required: true, min: 0 },
  baseUnit: { type: String, default: 'unit' },
  unitsPerPack: { type: Number, default: 1, min: 1 },
  ratePerBaseUnit: { type: Number, required: true, min: 0 },
  grossAmount: { type: Number, default: 0 },
  discountReversal: { type: Number, default: 0 },
  taxableAmount: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  refundAmount: { type: Number, default: 0 },
  purchaseRatePerBaseUnit: { type: Number, default: 0, select: false },
  condition: { type: String, enum: ['SEALED_USABLE', 'OPENED_UNUSABLE', 'DAMAGED'], default: 'SEALED_USABLE' },
  restock: { type: Boolean, default: true }
}, { _id: true });

const pharmacyReturnSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', index: true },
  returnNumber: { type: String, unique: true },
  originalSaleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', index: true },
  originalSaleNumber: { type: String, trim: true },
  originalInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  returnType: { type: String, enum: ['IPD_UNUSED_MEDICINE', 'OPD_RETURN', 'WALKIN_RETURN'], default: 'IPD_UNUSED_MEDICINE' },
  items: [pharmacyReturnItemSchema],
  totalRefundAmount: { type: Number, default: 0 },
  outstandingReduction: { type: Number, default: 0, min: 0 },
  refundableResidual: { type: Number, default: 0, min: 0 },
  dueBefore: { type: Number, default: 0, min: 0 },
  dueAfter: { type: Number, default: 0, min: 0 },
  transactionGroupId: { type: String, index: true },
  parentGroupId: { type: String, index: true },
  idempotencyKey: { type: String, sparse: true, index: true },
  presentationType: { type: String, trim: true },
  // No advance/refund is the safe default. The service sets a method only for a real paid residual.
  refundMode: { type: String, enum: ['Cash', 'UPI', 'Card', 'IPDAdvance', 'PharmacyAdvance', 'NoRefund'], default: 'NoRefund' },
  refundReference: { type: String, trim: true },
  patientOutstandingAfter: { type: Number, default: 0 },
  pharmacyAdvanceAfter: { type: Number, default: 0 },
  status: { type: String, enum: ['Completed', 'PendingApproval', 'Rejected'], default: 'Completed' },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

pharmacyReturnSchema.pre('validate', async function(next) {
  try {
    if (this.isNew && !this.returnNumber) {
      const count = await mongoose.model('PharmacyReturn').countDocuments();
      this.returnNumber = `SH/PC/DIR/${String(count + 1).padStart(8, '0')}`;
    }
    this.items = (this.items || []).map(item => {
      item.grossAmount = Number((item.grossAmount ?? item.returnedQtyBaseUnits * item.ratePerBaseUnit).toFixed(2));
      item.taxableAmount = Number((item.taxableAmount ?? Math.max(0, item.grossAmount - (item.discountReversal || 0))).toFixed(2));
      item.taxAmount = Number((item.taxAmount ?? item.taxableAmount * ((item.taxRate || 0) / 100)).toFixed(2));
      item.refundAmount = Number((item.refundAmount ?? item.taxableAmount + item.taxAmount).toFixed(2));
      return item;
    });
    this.totalRefundAmount = Number(this.items.reduce((sum, item) => sum + (item.refundAmount || 0), 0).toFixed(2));
    next();
  } catch (error) {
    next(error);
  }
});

pharmacyReturnSchema.index({ admissionId: 1, createdAt: -1 });
pharmacyReturnSchema.index({ patientId: 1, createdAt: -1 });
pharmacyReturnSchema.index({ returnType: 1, createdAt: -1 });
pharmacyReturnSchema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('PharmacyReturn', pharmacyReturnSchema);
