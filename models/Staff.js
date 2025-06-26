const mongoose = require('mongoose');


const staffSchema = new mongoose.Schema({
  staffId: { type: String, unique: true },
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  role: { type: String, required: true }, // e.g., Doctor, Nurse, Admin
  department: { type: String },
  specialization: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  status: { type: String, enum: ['Active', 'Inactive', 'On Leave'], default: 'Active' },
  joined_at: { type: Date, default: Date.now }
});

const Hospital = require('./Hospital'); // import the Hospital model

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
      const hospital = await Hospital.findOne();
      if (!hospital || !hospital.hospitalID) {
        throw new Error('Hospital ID not found');
      }

      this.hospitalId = hospital.hospitalID;
      this.staffId = `${hospital.hospitalID}-${generateRandomCode(4)}`;
    }
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Staff', staffSchema);
