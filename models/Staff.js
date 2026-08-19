const mongoose = require('mongoose');


const { addSoftDeleteFields } = require('../utils/softDelete');
const staffSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  staffId: { type: String, unique: true },
  first_name: { type: String, required: true },
  last_name: { type: String },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  role: { type: String, required: true }, // e.g., Doctor, Nurse, Admin
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department'},
  shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  specialization: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  status: { type: String, enum: ['Active', 'Inactive', 'On Leave'], default: 'Active' },
  aadharNumber: { type: String },
  panNumber: { type: String },
  joined_at: { type: Date, default: Date.now }
});

const Hospital = require('./Hospital'); 

function generateRandomCode(length = 4) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

staffSchema.pre('save', async function (next) {
  try {
    if (!this.staffId) {
      const hospital = this.hospitalId
        ? await Hospital.findById(this.hospitalId)
        : await Hospital.findOne();
      if (!hospital || !hospital.hospitalID) {
        throw new Error('Hospital ID not found');
      }

      this.hospitalId = hospital._id;
      this.staffId = `${hospital.hospitalID}-${generateRandomCode(4)}`;
    }
    next();
  } catch (err) {
    next(err);
  }
});

const { registerHRSyncHook } = require('../services/hrProfileSync.service');
registerHRSyncHook(staffSchema, 'Staff');

addSoftDeleteFields(staffSchema);

module.exports = mongoose.model('Staff', staffSchema);
