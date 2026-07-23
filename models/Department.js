const mongoose = require('mongoose');

function generatedDepartmentCode(name, documentId) {
  const base = String(name || 'DEPT')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 24) || 'DEPT';

  const suffix = String(documentId || new mongoose.Types.ObjectId())
    .slice(-6)
    .toUpperCase();

  return `${base}-${suffix}`;
}

const departmentSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    head_doctor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doctor'
    },
    active: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

departmentSchema.pre('validate', function generateCode(next) {
  if (!this.code) {
    this.code = generatedDepartmentCode(this.name, this._id);
  }

  next();
});

departmentSchema.index(
  {
    hospitalId: 1,
    name: 1
  },
  {
    unique: true
  }
);

/*
 * Keep sparse:true to remain compatible with the existing production index.
 * New and migrated records always receive a code, so null code collisions no
 * longer occur.
 */
departmentSchema.index(
  {
    hospitalId: 1,
    code: 1
  },
  {
    unique: true,
    sparse: true
  }
);

departmentSchema.statics.generatedCode = generatedDepartmentCode;

module.exports = mongoose.model('Department', departmentSchema);
