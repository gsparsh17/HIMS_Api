const mongoose = require('mongoose');


const patientSchema = new mongoose.Schema({
  patientId: { type: String, unique: true },
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  gender: { type: String, enum: ['male', 'female', 'other'], required: true },
  dob: { type: Date, required: true },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zipCode: { type: String },
  emergency_contact: { type: String },
  emergency_phone: { type: String },
  medical_history: { type: String },
  allergies: { type: String },
  medications: { type: String },
  blood_group: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  },
  patient_type: {
    type: String,
    enum: ['opd', 'ipd'],
    default: 'ipd',
  },
  registered_at: { type: Date, default: Date.now },
});

const Hospital = require('./Hospital'); // import hospital model

function generateRandomCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

patientSchema.pre('save', async function (next) {
  try {
    if (!this.patientId) {
      const hospital = await Hospital.findOne();
      if (!hospital || !hospital.hospitalID) {
        throw new Error('Hospital ID not found');
      }

      this.hospitalId = hospital.hospitalID;
      this.patientId = `${hospital.hospitalID}-${generateRandomCode(8)}`;
    }

    next();
  } catch (err) {
    next(err);
  }
});


module.exports = mongoose.model('Patient', patientSchema);

