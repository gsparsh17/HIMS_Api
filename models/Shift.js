const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const shiftSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  name: { type: String, required: true, trim: true }, // Morning, Evening, Night
  start_time: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  end_time: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  spans_next_day: { type: Boolean, default: false }
}, { timestamps: true });

shiftSchema.index(
  { hospitalId: 1, name: 1 },
  { unique: true, partialFilterExpression: { hospitalId: { $type: 'objectId' }, is_active: true } }
);

addSoftDeleteFields(shiftSchema);

module.exports = mongoose.model('Shift', shiftSchema);
