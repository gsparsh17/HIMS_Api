const mongoose = require('mongoose');

const hospitalChargesSchema = new mongoose.Schema({
  hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },

  // ✅ OPD Charges
  opdCharges: {
    registrationFee: { type: Number, default: 0 },
    discountType: { type: String, enum: ['Percentage', 'Fixed'], default: 'Fixed' },
    discountValue: { type: Number, default: 0 }
  },

  // ✅ IPD Charges
  ipdCharges: {
    roomCharges: [
      {
        type: { type: String, enum: ['General', 'Semi-Private', 'Private', 'ICU'], required: true },
        chargePerDay: { type: Number, required: true }
      }
    ],
    nursingCharges: { type: Number, default: 0 },
    otCharges: { type: Number, default: 0 },
    miscellaneous: { type: Number, default: 0 }
  },

  effectiveFrom: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('HospitalCharges', hospitalChargesSchema);
