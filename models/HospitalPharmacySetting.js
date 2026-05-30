const mongoose = require('mongoose');

const hospitalPharmacySettingSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy' },
  ipdAdvanceMode: {
    type: String,
    enum: ['SHARED_IPD_ADVANCE', 'PHARMACY_SEPARATE_ADVANCE', 'HYBRID'],
    default: 'HYBRID'
  },
  allowNegativeIpdPharmacyBalance: { type: Boolean, default: false },
  defaultIpdBillingMode: {
    type: String,
    enum: ['DEDUCT_FROM_ADVANCE', 'COLLECT_AT_COUNTER', 'SPLIT_PAYMENT'],
    default: 'DEDUCT_FROM_ADVANCE'
  },
  allowCashRefundOnReturn: { type: Boolean, default: true },
  allowLooseTabletSale: { type: Boolean, default: true },
  requireReturnApproval: { type: Boolean, default: false },
  maxDiscountPercentWithoutApproval: { type: Number, default: 5, min: 0 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

hospitalPharmacySettingSchema.index({ hospitalId: 1, pharmacyId: 1 }, { unique: false });

module.exports = mongoose.model('HospitalPharmacySetting', hospitalPharmacySettingSchema);
