const mongoose = require('mongoose');

const rateCardItemSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  rateCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCard', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  externalCode: { type: String, required: true, trim: true, uppercase: true },
  externalName: { type: String, required: true, trim: true },
  serviceType: { type: String, enum: ['consultation', 'laboratory', 'radiology', 'procedure', 'ot', 'bed', 'pharmacy', 'equipment', 'other'], required: true },
  specialty: { type: String, trim: true },
  category: { type: String, trim: true },
  internalService: {
    model: { type: String, enum: ['LabTest', 'ImagingTest', 'Procedure', 'Bed', 'BillingServiceMaster', 'Medicine', 'Other'] },
    id: { type: mongoose.Schema.Types.ObjectId },
    code: String,
    mappingStatus: { type: String, enum: ['unmapped', 'suggested', 'reviewed', 'approved', 'rejected'], default: 'unmapped' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date
  },
  rates: {
    tierI: { nonNabh: Number, nabh: Number, superSpeciality: Number },
    tierII: { nonNabh: Number, nabh: Number, superSpeciality: Number },
    tierIII: { nonNabh: Number, nabh: Number, superSpeciality: Number },
    flatAmount: Number
  },
  packagePeriodDays: { type: Number, min: 0 },
  wardUniform: { type: Boolean, default: false },
  allowedWards: [{ type: String }],
  inclusions: [{ type: String }],
  exclusions: [{ type: String }],
  nonAdmissibleRules: [{ code: String, description: String, amount: Number, percentage: Number }],
  active: { type: Boolean, default: true },
  sourceRow: { page: Number, serialNumber: Number, raw: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

rateCardItemSchema.index({ rateCardId: 1, externalCode: 1 }, { unique: true });
rateCardItemSchema.index({ hospitalId: 1, 'internalService.model': 1, 'internalService.id': 1 });
rateCardItemSchema.index({ hospitalId: 1, serviceType: 1, category: 1 });

module.exports = mongoose.model('RateCardItem', rateCardItemSchema);
