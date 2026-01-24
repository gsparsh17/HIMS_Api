const mongoose = require('mongoose');

const procedureSchema = new mongoose.Schema({
  // Identification
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
    index: true
  },
  
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  
  // Classification
  category: {
    type: String,
    required: true,
    trim: true,
    enum: [
      'Diagnostic', 'Preventive', 'Restorative', 'Endodontics', 
      'Periodontics', 'Prosthodontics', 'Implant', 'Oral Surgery',
      'Orthodontics', 'Adjunctive', 'Radiology', 'Laboratory',
      'Anesthesia', 'Emergency', 'Consultation', 'Follow-up',
      'Other'
    ]
  },
  
  subcategory: {
    type: String,
    trim: true
  },
  
  // Medical Details
  description: {
    type: String,
    trim: true
  },
  
  indications: [{
    type: String,
    trim: true
  }],
  
  contraindications: [{
    type: String,
    trim: true
  }],
  
  complications: [{
    type: String,
    trim: true
  }],
  
  duration_minutes: {
    type: Number,
    min: 1,
    default: 30
  },
  
  // Financial Information
  base_price: {
    type: Number,
    min: 0,
    default: 0
  },
  
  insurance_coverage: {
    type: String,
    enum: ['Full', 'Partial', 'None', 'Pre-authorization Required'],
    default: 'Partial'
  },
  
  cpt_code: {
    type: String,
    trim: true,
    uppercase: true
  },
  
  icd10_codes: [{
    type: String,
    trim: true,
    uppercase: true
  }],
  
  // Resources Required
  equipment_required: [{
    type: String,
    trim: true
  }],
  
  consumables: [{
    name: String,
    quantity: Number
  }],
  
  personnel_required: {
    type: [String],
    default: ['Doctor']
  },
  
  facility_level: {
    type: [String],
    enum: ['Primary', 'Secondary', 'Tertiary'],
    default: ['Primary']
  },
  
  // Instructions and Guidelines
  pre_procedure_instructions: {
    type: String,
    trim: true
  },
  
  post_procedure_instructions: {
    type: String,
    trim: true
  },
  
  consent_required: {
    type: Boolean,
    default: true
  },
  
  consent_form_type: {
    type: String,
    trim: true
  },
  
  // Department Specific
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department'
  },
  
  specialty_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Specialty'
  },
  
  // Status and Audit
  is_active: {
    type: Boolean,
    default: true
  },
  
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  last_updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  version: {
    type: String,
    default: '1.0'
  },
  
  tags: [{
    type: String,
    trim: true
  }],
  
  notes: {
    type: String,
    trim: true
  },
  
  // Popularity and Usage Tracking
  usage_count: {
    type: Number,
    default: 0,
    min: 0
  },
  
  last_used: {
    type: Date
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for Efficient Searching
procedureSchema.index({ code: 1, name: 1 });
procedureSchema.index({ category: 1, subcategory: 1 });
procedureSchema.index({ is_active: 1, facility_level: 1 });
procedureSchema.index({ tags: 1 });
procedureSchema.index({ '$**': 'text' });

// Virtual for full display
procedureSchema.virtual('display_name').get(function() {
  return `${this.code} - ${this.name}`;
});

// Pre-save hook to update last_used
procedureSchema.pre('save', function(next) {
  if (this.isModified('usage_count') && this.usage_count > 0) {
    this.last_used = new Date();
  }
  next();
});

// Static Methods
procedureSchema.statics.searchProcedures = async function(query, options = {}) {
  const {
    limit = 20,
    page = 1,
    category,
    department_id,
    specialty_id,
    facility_level,
    min_price,
    max_price
  } = options;
  
  const skip = (page - 1) * limit;
  
  const searchCriteria = {
    is_active: true,
    $or: [
      { code: { $regex: query, $options: 'i' } },
      { name: { $regex: query, $options: 'i' } },
      { description: { $regex: query, $options: 'i' } },
      { tags: { $regex: query, $options: 'i' } }
    ]
  };
  
  // Add filters if provided
  if (category) searchCriteria.category = category;
  if (department_id) searchCriteria.department_id = department_id;
  if (specialty_id) searchCriteria.specialty_id = specialty_id;
  if (facility_level) searchCriteria.facility_level = { $in: facility_level.split(',') };
  
  if (min_price !== undefined || max_price !== undefined) {
    searchCriteria.base_price = {};
    if (min_price !== undefined) searchCriteria.base_price.$gte = Number(min_price);
    if (max_price !== undefined) searchCriteria.base_price.$lte = Number(max_price);
  }
  
  const procedures = await this.find(searchCriteria)
    .skip(skip)
    .limit(limit)
    .sort({ usage_count: -1, name: 1 })
    .select('-__v -createdAt -updatedAt');
  
  const total = await this.countDocuments(searchCriteria);
  
  return {
    procedures,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasMore: total > (page * limit)
  };
};

procedureSchema.statics.getPopularProcedures = async function(limit = 10, department_id = null) {
  const matchCriteria = { is_active: true, usage_count: { $gt: 0 } };
  if (department_id) matchCriteria.department_id = department_id;
  
  return await this.find(matchCriteria)
    .sort({ usage_count: -1, last_used: -1 })
    .limit(limit)
    .select('code name category usage_count duration_minutes base_price');
};

procedureSchema.statics.getProcedureStats = async function() {
  const stats = await this.aggregate([
    { $match: { is_active: true } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        total_usage: { $sum: '$usage_count' },
        by_category: { $push: '$category' },
        avg_price: { $avg: '$base_price' },
        min_price: { $min: '$base_price' },
        max_price: { $max: '$base_price' }
      }
    },
    {
      $project: {
        _id: 0,
        total: 1,
        total_usage: 1,
        avg_price: { $round: ['$avg_price', 2] },
        min_price: 1,
        max_price: 1,
        categories: {
          $reduce: {
            input: '$by_category',
            initialValue: {},
            in: {
              $mergeObjects: [
                '$$value',
                { [this.by_category]: { $add: [{ $ifNull: [`$$value.${this.by_category}`, 0] }, 1] } }
              ]
            }
          }
        }
      }
    }
  ]);
  
  return stats[0] || { total: 0, total_usage: 0, avg_price: 0, min_price: 0, max_price: 0, categories: {} };
};

procedureSchema.statics.bulkUpload = async function(proceduresData) {
  const operations = proceduresData.map(proc => ({
    updateOne: {
      filter: { code: proc.code },
      update: { $set: proc },
      upsert: true
    }
  }));
  
  const result = await this.bulkWrite(operations);
  return {
    success: true,
    matched: result.nMatched,
    modified: result.nModified,
    upserted: result.nUpserted,
    total: proceduresData.length
  };
};

procedureSchema.methods.incrementUsage = async function() {
  this.usage_count += 1;
  this.last_used = new Date();
  return await this.save();
};

const Procedure = mongoose.model('Procedure', procedureSchema);

module.exports = Procedure;