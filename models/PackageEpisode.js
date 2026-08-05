const mongoose = require('mongoose');

const utilizationSchema = new mongoose.Schema({
  sourceType: { type: String, enum: ['IPDCharge', 'BillItem', 'PharmacySale', 'LabRequest', 'RadiologyRequest', 'ProcedureRequest', 'Other'], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceLineId: mongoose.Schema.Types.ObjectId,
  serviceType: String,
  internalServiceModel: String,
  internalServiceId: mongoose.Schema.Types.ObjectId,
  internalCode: String,
  description: String,
  quantity: { type: Number, default: 1 },
  standardAmount: { type: Number, default: 0 },
  absorbedAmount: { type: Number, default: 0 },
  patientAmount: { type: Number, default: 0 },
  sponsorAmount: { type: Number, default: 0 },
  decision: { type: String, enum: ['included', 'excluded', 'limit_exceeded', 'outside_period', 'not_matched', 'reversed'], required: true },
  rule: mongoose.Schema.Types.Mixed,
  adjudicatedAt: { type: Date, default: Date.now },
  reversedAt: Date,
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reversalReason: String
}, { _id: true });

const packageEpisodeSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  coverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage', required: true, index: true },
  encounterType: { type: String, enum: ['OPD', 'IPD'], required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  rateCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCard', required: true },
  rateCardItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCardItem', required: true },
  packageCode: { type: String, required: true, uppercase: true, trim: true },
  packageName: { type: String, required: true },
  triggerSourceType: String,
  triggerSourceId: mongoose.Schema.Types.ObjectId,
  triggerSourceLineId: mongoose.Schema.Types.ObjectId,
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  contractedAmount: { type: Number, default: 0 },
  approvedAmountCap: Number,
  status: { type: String, enum: ['planned', 'active', 'completed', 'cancelled', 'expired'], default: 'active', index: true },
  packageSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  totals: {
    standardConsumed: { type: Number, default: 0 },
    absorbed: { type: Number, default: 0 },
    separatelyBillablePatient: { type: Number, default: 0 },
    separatelyBillableSponsor: { type: Number, default: 0 }
  },
  utilization: [utilizationSchema],
  revision: { type: Number, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

packageEpisodeSchema.index({ hospitalId: 1, coverageId: 1, packageCode: 1, startsAt: 1 });
packageEpisodeSchema.index({ hospitalId: 1, coverageId: 1, triggerSourceType: 1, triggerSourceId: 1, triggerSourceLineId: 1 });
packageEpisodeSchema.index({ hospitalId: 1, admissionId: 1, status: 1 });
packageEpisodeSchema.index({ hospitalId: 1, appointmentId: 1, status: 1 });

module.exports = mongoose.model('PackageEpisode', packageEpisodeSchema);
