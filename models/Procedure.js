const mongoose = require('mongoose');

/**
 * Hospital procedure master.
 *
 * Every installation operates for one hospital, however hospitalId remains a
 * server-derived technical scope key so imports, audit records and historical
 * references cannot accidentally cross an installation boundary. Clients must
 * never submit or choose this value; controllers derive it from req.user.
 */
const procedureSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  code: { type: String, required: true, trim: true, uppercase: true, index: true },
  name: { type: String, required: true, trim: true, index: true },
  category: { type: String, required: true, trim: true, index: true },
  subcategory: { type: String, trim: true },
  specialty: { type: String, trim: true, index: true },
  serviceDomain: { type: String, enum: ['procedure', 'surgery', 'therapy', 'consultation', 'diagnostic', 'other'], default: 'procedure', index: true },
  description: { type: String, trim: true },
  indications: [{ type: String, trim: true }],
  contraindications: [{ type: String, trim: true }],
  complications: [{ type: String, trim: true }],
  duration_minutes: { type: Number, min: 1, default: 30 },

  // SELF/cash price. Payer prices always live in RateCardItem.
  base_price: { type: Number, min: 0, default: 0 },
  priceHistory: [{
    amount: { type: Number, min: 0, required: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: Date,
    reason: String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  is_billable: { type: Boolean, default: true, index: true },
  allow_zero_price: { type: Boolean, default: false },
  insurance_coverage: {
    type: String,
    enum: ['Full', 'Partial', 'None', 'Pre-authorization Required'],
    default: 'Partial'
  },
  cpt_code: { type: String, trim: true, uppercase: true },
  icd10_codes: [{ type: String, trim: true, uppercase: true }],
  equipment_required: [{ type: String, trim: true }],
  consumables: [{ name: String, quantity: Number, unit: String }],
  personnel_required: { type: [String], default: ['Doctor'] },
  facility_level: { type: [String], enum: ['Primary', 'Secondary', 'Tertiary'], default: ['Primary'] },
  pre_procedure_instructions: { type: String, trim: true },
  post_procedure_instructions: { type: String, trim: true },
  consent_required: { type: Boolean, default: true },
  consent_form_type: { type: String, trim: true },
  department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  specialty_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Specialty' },
  aliases: [{ type: String, trim: true }],
  is_active: { type: Boolean, default: true, index: true },
  archived_reason: { type: String, trim: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  version: { type: String, default: '1.0' },
  tags: [{ type: String, trim: true }],
  notes: { type: String, trim: true },
  usage_count: { type: Number, default: 0, min: 0 },
  last_used: Date
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

procedureSchema.index({ hospitalId: 1, code: 1 }, { unique: true });
procedureSchema.index({ hospitalId: 1, name: 1 });
procedureSchema.index({ hospitalId: 1, category: 1, subcategory: 1 });
procedureSchema.index({ hospitalId: 1, is_active: 1, is_billable: 1 });
procedureSchema.index({ hospitalId: 1, tags: 1 });
procedureSchema.index({ name: 'text', code: 'text', description: 'text', aliases: 'text', tags: 'text' });

procedureSchema.virtual('display_name').get(function displayName() {
  return `${this.code} - ${this.name}`;
});

procedureSchema.pre('validate', function validateBillablePrice(next) {
  if (this.is_active && this.is_billable && Number(this.base_price || 0) === 0 && !this.allow_zero_price) {
    this.invalidate('base_price', 'Active billable procedures require a positive cash price or allow_zero_price=true');
  }
  next();
});

procedureSchema.pre('save', function updateUsage(next) {
  if (this.isModified('usage_count') && this.usage_count > 0) this.last_used = new Date();
  next();
});

procedureSchema.statics.searchProcedures = async function searchProcedures(query, options = {}) {
  const {
    hospitalId,
    limit = 20,
    page = 1,
    category,
    department_id,
    specialty_id,
    facility_level,
    min_price,
    max_price,
    includeInactive = false
  } = options;
  if (!hospitalId) throw new Error('hospitalId is required for procedure search');
  const criteria = { hospitalId };
  if (!includeInactive) criteria.is_active = true;
  if (query) {
    criteria.$or = ['code', 'name', 'description', 'aliases', 'tags'].map((field) => ({
      [field]: { $regex: String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }));
  }
  if (category) criteria.category = category;
  if (department_id) criteria.department_id = department_id;
  if (specialty_id) criteria.specialty_id = specialty_id;
  if (facility_level) criteria.facility_level = { $in: String(facility_level).split(',') };
  if (min_price !== undefined || max_price !== undefined) {
    criteria.base_price = {};
    if (min_price !== undefined) criteria.base_price.$gte = Number(min_price);
    if (max_price !== undefined) criteria.base_price.$lte = Number(max_price);
  }
  const skip = (Number(page) - 1) * Number(limit);
  const [procedures, total] = await Promise.all([
    this.find(criteria).skip(skip).limit(Number(limit)).sort({ usage_count: -1, name: 1 }),
    this.countDocuments(criteria)
  ]);
  return { procedures, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)), hasMore: total > Number(page) * Number(limit) };
};

procedureSchema.statics.getPopularProcedures = function getPopularProcedures(limit = 10, departmentId = null, hospitalId) {
  if (!hospitalId) throw new Error('hospitalId is required');
  const match = { hospitalId, is_active: true, is_billable: true, usage_count: { $gt: 0 } };
  if (departmentId) match.department_id = departmentId;
  return this.find(match).sort({ usage_count: -1, last_used: -1 }).limit(limit);
};

procedureSchema.statics.getProcedureStats = async function getProcedureStats(hospitalId) {
  if (!hospitalId) throw new Error('hospitalId is required');
  const rows = await this.aggregate([
    { $match: { hospitalId: new mongoose.Types.ObjectId(String(hospitalId)), is_active: true } },
    { $group: { _id: '$category', count: { $sum: 1 }, usage: { $sum: '$usage_count' }, averagePrice: { $avg: '$base_price' } } },
    { $sort: { _id: 1 } }
  ]);
  return { total: rows.reduce((sum, row) => sum + row.count, 0), categories: rows };
};

procedureSchema.statics.bulkUpload = async function bulkUpload(proceduresData, hospitalId) {
  if (!hospitalId) throw new Error('hospitalId is required');
  const operations = proceduresData.map((row) => ({
    updateOne: {
      filter: { hospitalId, code: String(row.code).toUpperCase() },
      update: { $set: { ...row, hospitalId, code: String(row.code).toUpperCase() } },
      upsert: true
    }
  }));
  const result = await this.bulkWrite(operations, { ordered: false });
  return { success: true, matched: result.matchedCount, modified: result.modifiedCount, upserted: result.upsertedCount, total: proceduresData.length };
};

procedureSchema.methods.incrementUsage = function incrementUsage() {
  this.usage_count = Number(this.usage_count || 0) + 1;
  this.last_used = new Date();
  return this.save();
};

module.exports = mongoose.model('Procedure', procedureSchema);
