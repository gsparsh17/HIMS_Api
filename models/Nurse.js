const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const nurseSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  first_name: { type: String, required: true },
  last_name: { type: String },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  shift_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  joined_at: { type: Date, default: Date.now }
});

const { registerHRSyncHook } = require('../services/hrProfileSync.service');
registerHRSyncHook(nurseSchema, 'Nurse');

addSoftDeleteFields(nurseSchema);

module.exports = mongoose.model('Nurse', nurseSchema);
