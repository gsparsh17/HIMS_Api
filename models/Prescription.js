const mongoose = require('mongoose');

const prescriptionItemSchema = new mongoose.Schema({
  medicine_name: { 
    type: String, 
    required: true, 
    trim: true 
  },
  generic_name: { 
    type: String, 
    trim: true 
  },
  medicine_type: { 
    type: String, 
    enum: {
      values: ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 'Drops', 'Inhaler', 'Other', ''],
      message: 'Please select a valid medicine type'
    },
    trim: true,
    default: ''
  }, // e.g., "Tablet", "Capsule", "Syrup"
  route_of_administration: { 
    type: String, 
    enum: {
      values: [
                                              "Oral",
                                              "Sublingual",
                                              "Intramuscular Injection",
                                              "Intravenous Injection",
                                              "Subcutaneous Injection",
                                              "Topical Application",
                                              "Inhalation",
                                              "Nasal",
                                              "Eye Drops",
                                              "Ear Drops",
                                              "Rectal",
                                              "Other"
                                            ],
      message: 'Please select a valid route of administration'
    },
    trim: true,
    default: ''
  }, // Route through which patient will intake
  dosage: { 
    type: String, 
    required: false 
  }, // e.g., "500mg", "10ml"
  frequency: { 
    type: String, 
    required: true 
  }, // e.g., "Twice daily", "Once at night"
  duration: { 
    type: String, 
    required: true 
  }, // e.g., "7 days", "30 days"
  quantity: { 
    type: Number, 
    required: false, 
    min: 1 
  }, // Number of units to dispense
  instructions: { 
    type: String, 
    trim: true 
  }, // Additional instructions
  timing: { 
    type: String, 
    enum: ['Before food', 'After food', 'With food', 'Anytime'] 
  },
  is_dispensed: { 
    type: Boolean, 
    default: false 
  },
  dispensed_quantity: { 
    type: Number, 
    default: 0 
  },
  dispensed_date: { 
    type: Date 
  }
});

const prescriptionSchema = new mongoose.Schema({
  prescription_number: { 
    type: String, 
    unique: true 
  },
  patient_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Patient', 
    required: true 
  },
  doctor_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Doctor', 
    required: true 
  },
  appointment_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Appointment' 
  },
  diagnosis: { 
    type: String, 
    trim: true 
  },
  symptoms: { 
    type: String, 
    trim: true 
  },
  investigation: {
    type: String,
    trim: true
  },
  items: [prescriptionItemSchema],
  notes: { 
    type: String, 
    trim: true 
  },
  prescription_image: { 
    type: String 
  }, // Cloudinary URL or file path
  status: { 
    type: String, 
    enum: ['Active', 'Completed', 'Cancelled', 'Expired'], 
    default: 'Active' 
  },
  issue_date: { 
    type: Date, 
    default: Date.now 
  },
  validity_days: { 
    type: Number, 
    default: 30 
  }, // Prescription validity period
  follow_up_date: { 
    type: Date 
  },
  is_repeatable: { 
    type: Boolean, 
    default: false 
  },
  repeat_count: { 
    type: Number, 
    default: 0 
  }, // Number of times prescription can be repeated
  created_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }
}, { 
  timestamps: true 
});

// Generate prescription number before saving
prescriptionSchema.pre('save', async function(next) {
  if (this.isNew && !this.prescription_number) {
    const count = await mongoose.model('Prescription').countDocuments();
    const date = new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    this.prescription_number = `RX${year}${month}${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

// Calculate expiry date virtual
prescriptionSchema.virtual('expiry_date').get(function() {
  const expiryDate = new Date(this.issue_date);
  expiryDate.setDate(expiryDate.getDate() + this.validity_days);
  return expiryDate;
});

// Check if prescription is expired
prescriptionSchema.virtual('is_expired').get(function() {
  return new Date() > this.expiry_date;
});

// Check if all items are dispensed
prescriptionSchema.virtual('is_fully_dispensed').get(function() {
  return this.items.every(item => item.is_dispensed);
});

// Index for better query performance
prescriptionSchema.index({ patient_id: 1, issue_date: -1 });
prescriptionSchema.index({ doctor_id: 1, issue_date: -1 });
prescriptionSchema.index({ prescription_number: 1 });
prescriptionSchema.index({ status: 1 });

module.exports = mongoose.model('Prescription', prescriptionSchema);