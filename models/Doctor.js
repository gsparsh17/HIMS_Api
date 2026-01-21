const mongoose = require('mongoose');


// const doctorSchema = new mongoose.Schema({
//   user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
//   doctorId: { type: String, unique: true },
//   firstName: { type: String, required: true },
//   lastName: { type: String, required: true },
//   email: { type: String, required: true, unique: true },
//   phone: { type: String, required: true },
//   dateOfBirth: { type: Date },
//   gender: { type: String, enum: ['male', 'female', 'other'] },
//   address: { type: String },
//   city: { type: String },
//   state: { type: String },
//   zipCode: { type: String },
//   // role: { type: String, enum: ['Doctor', 'Nurse', 'Technician', 'Administrator'] },
//   department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true }, // Can be changed to ObjectId if needed
//   specialization: { type: String },
//   licenseNumber: { type: String, required: true, unique: true },
//   experience: { type: Number },
//   education: { type: String },
//   shift: { type: String },
//   emergencyContact: { type: String },
//   emergencyPhone: { type: String },
//   startDate: { type: Date },
//   salary: { type: Number },
//   isFullTime: { type: Boolean, default: true },
//   // hasInsurance: { type: Boolean, default: true },
//   notes: { type: String },
//   paymentType: { type: String, enum: ['Fee per Visit', 'Per Hour', 'Contractual Salary',''], default: null },
// contractualSalary: { type: Number, default: null },
// feePerVisit: { type: Number, default: null },
// ratePerHour: { type: Number, default: null },
// contractStartDate: { type: Date, default: null },
// contractEndDate: { type: Date, default: null },
// visitsPerWeek: { type: Number, default: null },
// workingDaysPerWeek: { type: Number, default: null },
// timeSlots: [
//   {
//     start: { type: String },
//     end: { type: String }
//   }
// ],
// aadharNumber: { type: String },
// panNumber: { type: String },
//   joined_at: { type: Date, default: Date.now }
// });

// const Hospital = require('./Hospital'); // import Hospital model

// function generateRandomCode(length = 4) {
//   const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
//   let result = '';
//   for (let i = 0; i < length; i++) {
//     result += chars.charAt(Math.floor(Math.random() * chars.length));
//   }
//   return result;
// }

// doctorSchema.pre('save', async function (next) {
//   try {
//     if (!this.doctorId) {
//       const hospital = await Hospital.findOne();
//       if (!hospital || !hospital.hospitalID) {
//         throw new Error('Hospital ID not found');
//       }

//       this.hospitalId = hospital.hospitalID;
//       this.doctorId = `${hospital.hospitalID}-${generateRandomCode(4)}`;
//     }
//     next();
//   } catch (err) {
//     next(err);
//   }
// });

// module.exports = mongoose.model('Doctor', doctorSchema);

const doctorSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  doctorId: { type: String, unique: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
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
  shift: { type: String }, // For full-time doctors only
  emergencyContact: { type: String },
  emergencyPhone: { type: String },
  startDate: { type: Date },
  isFullTime: { type: Boolean, default: true },

  // Payment Details
  paymentType: { type: String, enum: ['Salary', 'Fee per Visit', 'Per Hour', 'Contractual Salary'], required: true },
  amount: { type: Number, required: true },

  // Contract Info (for part-time or contractual doctors)
  contractStartDate: { type: Date, default: null },
  contractEndDate: { type: Date, default: null },
  visitsPerWeek: { type: Number, default: null },
  // workingDaysPerWeek: { type: String, default: null },
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

const Hospital = require('./Hospital'); // import Hospital model

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
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Doctor', doctorSchema);