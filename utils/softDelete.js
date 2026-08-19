const mongoose = require('mongoose');

/**
 * Adds a consistent soft-delete contract without hiding historical references.
 *
 * IMPORTANT: this helper intentionally does NOT install global query middleware.
 * Historical clinical/financial records must still be able to populate an
 * inactive referenced document. List/search controllers should add
 * `is_active: { $ne: false }` when they want only current records.
 */
function addSoftDeleteFields(schema) {
  const fields = {};

  if (!schema.path('is_active')) {
    fields.is_active = { type: Boolean, default: true, index: true };
  }
  if (!schema.path('deleted_at')) {
    fields.deleted_at = { type: Date, default: null };
  }
  if (!schema.path('deleted_by')) {
    fields.deleted_by = { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null };
  }
  if (!schema.path('deletion_reason')) {
    fields.deletion_reason = { type: String, trim: true, default: '' };
  }

  if (Object.keys(fields).length) {
    schema.add(fields);
  }

  schema.methods.softDelete = async function softDelete({ userId = null, reason = '' } = {}) {
    this.is_active = false;
    this.deleted_at = new Date();
    this.deleted_by = userId || null;
    this.deletion_reason = String(reason || '').trim();
    return this.save();
  };

  schema.methods.restoreSoftDeleted = async function restoreSoftDeleted() {
    this.is_active = true;
    this.deleted_at = null;
    this.deleted_by = null;
    this.deletion_reason = '';
    return this.save();
  };

  schema.statics.activeOnly = function activeOnly(filter = {}) {
    return { ...filter, is_active: { $ne: false } };
  };

  schema.statics.softDeleteOne = function softDeleteOne(filter, { userId = null, reason = '' } = {}) {
    return this.findOneAndUpdate(
      filter,
      {
        $set: {
          is_active: false,
          deleted_at: new Date(),
          deleted_by: userId || null,
          deletion_reason: String(reason || '').trim()
        }
      },
      { new: true }
    );
  };
}

function activeFilter(filter = {}) {
  return { ...filter, is_active: { $ne: false } };
}

function softDeleteUpdate({ userId = null, reason = '', extra = {} } = {}) {
  return {
    $set: {
      ...extra,
      is_active: false,
      deleted_at: new Date(),
      deleted_by: userId || null,
      deletion_reason: String(reason || '').trim()
    }
  };
}

module.exports = {
  addSoftDeleteFields,
  activeFilter,
  softDeleteUpdate
};
