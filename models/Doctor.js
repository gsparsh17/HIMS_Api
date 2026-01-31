const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  doctorId: { type: String, unique: true },
  firstName: { type: String, required: true },
  lastName: { type: String },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  dateOfBirth: { type: Date },
  gender: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zipCode: { type: String },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  specialization: { type: String },
  licenseNumber: { type: String, required: true, unique: true },
  experience: { type: Number },
  education: { type: String },
  shift: { type: String },
  emergencyContact: { type: String },
  emergencyPhone: { type: String },
  startDate: { type: Date },
  isFullTime: { type: Boolean, default: true },

  // Payment Details
  paymentType: { type: String, enum: ['Salary', 'Fee per Visit', 'Per Hour', 'Contractual Salary'], required: true },
  amount: { type: Number, required: true },
  
  // NEW FIELD: Revenue split percentage for part-time doctors only
  revenuePercentage: { 
    type: Number, 
    min: 0, 
    max: 100, 
    default: 100,
    validate: {
      validator: function(v) {
        // Only require validation for part-time doctors
        if (!this.isFullTime) {
          return v >= 0 && v <= 100;
        }
        return true;
      },
      message: 'Revenue percentage must be between 0 and 100 for part-time doctors'
    }
  },

  // Contract Info
  contractStartDate: { type: Date, default: null },
  contractEndDate: { type: Date, default: null },
  visitsPerWeek: { type: Number, default: null },
  workingDaysPerWeek: [{ type: String }],
  timeSlots: [
    {
      start: { type: String },
      end: { type: String }
    }
  ],

  aadharNumber: { type: String },
  panNumber: { type: String },
  notes: { type: String },

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

doctorSchema.pre('save', async function (next) {
  try {
    if (!this.doctorId) {
      const hospital = await Hospital.findOne();
      if (!hospital || !hospital.hospitalID) {
        throw new Error('Hospital ID not found');
      }

      this.hospitalId = hospital.hospitalID;
      this.doctorId = `${hospital.hospitalID}-${generateRandomCode(4)}`;
    }
    
    if (!this.isFullTime && this.revenuePercentage === 100) {
      this.revenuePercentage = 80;
    } else if (this.isFullTime) {
      this.revenuePercentage = 100;
    }
    
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Doctor', doctorSchema);