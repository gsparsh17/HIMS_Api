const mongoose = require('mongoose');

const nlemMedicineSchema = new mongoose.Schema({
  // Basic Medicine Information
  medicine_name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  
  // NLEM 2022 Specific Fields
  nlem_code: {
    type: String,
    unique: true,
    sparse: true,
    trim: true
  },
  
  therapeutic_category: {
    type: String,
    trim: true
  },
  
  strength: {
    type: String,
    trim: true
  },
  
  dosage_form: {
    type: String,
    trim: true,
    enum: [
      'Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 
      'Cream', 'Lotion', 'Drops', 'Inhaler', 'Suppository',
      'Powder', 'Suspension', 'Solution', 'Gel', 'Spray',
      'Patch', 'Implants', 'Liquid for inhalation', 'Others'
    ]
  },
  
  route_of_administration: {
    type: String,
    trim: true,
    enum: [
      'Oral', 'Sublingual', 'Topical', 'Intravenous', 'Intramuscular',
      'Subcutaneous', 'Inhalation', 'Rectal', 'Vaginal', 'Ophthalmic',
      'Otic', 'Nasal', 'Transdermal', 'Others'
    ]
  },
  
  healthcare_level: {
    type: [String],
    enum: ['P', 'S', 'T'],
    default: []
  },
  
  // Additional Information
  generic_name: {
    type: String,
    trim: true,
    index: true
  },
  
  brand_names: [{
    type: String,
    trim: true
  }],
  
  atc_code: {
    type: String,
    trim: true
  },
  
  // Pricing and Stock Information
  max_retail_price: {
    type: Number,
    min: 0
  },
  
  essential: {
    type: Boolean,
    default: true
  },
  
  schedule: {
    type: String,
    enum: ['H', 'H1', 'X', 'G', 'N'],
    default: 'N'
  },
  
  // Clinical Information
  indications: [{
    type: String,
    trim: true
  }],
  
  contraindications: [{
    type: String,
    trim: true
  }],
  
  side_effects: [{
    type: String,
    trim: true
  }],
  
  dosage_guidelines: {
    adult: String,
    pediatric: String,
    geriatric: String,
    special_populations: String
  },
  
  // Storage and Handling
  storage_conditions: {
    type: String,
    enum: ['Room Temperature', 'Refrigerated', 'Protect from Light', 'Others'],
    default: 'Room Temperature'
  },
  
  shelf_life: {
    type: String,
    trim: true
  },
  
  // Audit Fields
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  last_updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  is_active: {
    type: Boolean,
    default: true
  },
  
  source: {
    type: String,
    default: 'NLEM 2022'
  },
  
  version: {
    type: String,
    default: '1.0'
  },
  
  notes: {
    type: String,
    trim: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Compound Indexes for Efficient Searching
nlemMedicineSchema.index({ medicine_name: 'text', generic_name: 'text', therapeutic_category: 'text' });
nlemMedicineSchema.index({ healthcare_level: 1, essential: 1 });
nlemMedicineSchema.index({ dosage_form: 1, route_of_administration: 1 });
nlemMedicineSchema.index({ is_active: 1, schedule: 1 });

// Virtual for full display name
nlemMedicineSchema.virtual('display_name').get(function() {
  let name = this.medicine_name;
  if (this.strength) name += ` ${this.strength}`;
  if (this.dosage_form) name += ` (${this.dosage_form})`;
  return name;
});

// Static Methods
nlemMedicineSchema.statics.searchMedicines = async function(query, options = {}) {
  const {
    limit = 20,
    page = 1,
    dosage_form,
    healthcare_level,
    essential,
    schedule
  } = options;
  
  const skip = (page - 1) * limit;
  
  const searchCriteria = {
    is_active: true,
    $or: [
      { medicine_name: { $regex: query, $options: 'i' } },
      { generic_name: { $regex: query, $options: 'i' } },
      { therapeutic_category: { $regex: query, $options: 'i' } }
    ]
  };
  
  // Add filters if provided
  if (dosage_form) searchCriteria.dosage_form = dosage_form;
  if (healthcare_level) searchCriteria.healthcare_level = { $in: healthcare_level.split(',') };
  if (essential !== undefined) searchCriteria.essential = essential === 'true';
  if (schedule) searchCriteria.schedule = schedule;
  
  const medicines = await this.find(searchCriteria)
    .skip(skip)
    .limit(limit)
    .sort({ medicine_name: 1 })
    .select('-__v -createdAt -updatedAt');
  
  const total = await this.countDocuments(searchCriteria);
  
  return {
    medicines,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasMore: total > (page * limit)
  };
};

nlemMedicineSchema.statics.bulkUpload = async function(medicinesData) {
  try {
    const medicines = await this.insertMany(medicinesData, { ordered: false });
    return { success: true, count: medicines.length, inserted: medicines.length };
  } catch (error) {
    // Handle duplicate key errors
    if (error.code === 11000) {
      return { 
        success: true, 
        count: medicinesData.length, 
        inserted: medicinesData.length - error.writeErrors.length,
        duplicates: error.writeErrors.length 
      };
    }
    throw error;
  }
};

nlemMedicineSchema.statics.getStats = async function() {
  const stats = await this.aggregate([
    { $match: { is_active: true } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        essential: { $sum: { $cond: [{ $eq: ['$essential', true] }, 1, 0] } },
        by_dosage_form: { $push: '$dosage_form' },
        by_healthcare_level: { $push: '$healthcare_level' }
      }
    },
    {
      $project: {
        _id: 0,
        total: 1,
        essential: 1,
        non_essential: { $subtract: ['$total', '$essential'] },
        dosage_forms: {
          $reduce: {
            input: '$by_dosage_form',
            initialValue: [],
            in: { $concatArrays: ['$$value', '$$this'] }
          }
        },
        healthcare_levels: {
          $reduce: {
            input: '$by_healthcare_level',
            initialValue: [],
            in: { $concatArrays: ['$$value', '$$this'] }
          }
        }
      }
    }
  ]);
  
  if (stats.length === 0) {
    return { total: 0, essential: 0, non_essential: 0 };
  }
  
  // Count unique dosage forms
  const dosageFormCounts = stats[0].dosage_forms.reduce((acc, form) => {
    acc[form] = (acc[form] || 0) + 1;
    return acc;
  }, {});
  
  // Count healthcare levels
  const healthcareLevelCounts = stats[0].healthcare_levels.reduce((acc, level) => {
    level.forEach(l => {
      acc[l] = (acc[l] || 0) + 1;
    });
    return acc;
  }, { P: 0, S: 0, T: 0 });
  
  return {
    total: stats[0].total,
    essential: stats[0].essential,
    non_essential: stats[0].non_essential,
    dosage_forms: dosageFormCounts,
    healthcare_levels: healthcareLevelCounts
  };
};

const NLEMMedicine = mongoose.model('NLEMMedicine', nlemMedicineSchema);

module.exports = NLEMMedicine;