const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema({
  patientId: { 
    type: String, 
    unique: true 
  },
  uhid: {
    type: String,
    unique: true
  },
  salutation: {
    type: String,
    enum: ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.', 'Prof.', 'Baby', 'Master'],
  },
  first_name: { 
    type: String, 
    required: true 
  },
  middle_name: {
    type: String
  },
  last_name: { 
    type: String
  },
  email: { 
  type: String,
},
  phone: { 
    type: String, 
    required: true 
  },
  gender: { 
    type: String, 
    enum: ['male', 'female', 'other'], 
    required: true 
  },
  dob: { 
    type: Date, 
    required: true 
  },
  address: { 
    type: String 
  },
  city: { 
    type: String 
  },
  state: { 
    type: String 
  },
  zipCode: { 
    type: String 
  },
  village: {
    type: String
  },
  district: {
    type: String
  },
  tehsil: {
    type: String
  },
  patient_image: {
    type: String
  },
  emergency_contact: { 
    type: String 
  },
  emergency_phone: { 
    type: String 
  },
  medical_history: { 
    type: String 
  },
  allergies: { 
    type: String 
  },
  medications: { 
    type: String 
  },
  blood_group: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', ''],
    default: '',
  },
  patient_type: {
    type: String,
    enum: ['opd', 'ipd'],
    default: 'ipd',
  },
  aadhaar_number: {  // Added Aadhaar number field
    type: String,
    trim: true,
    required: [true, 'Aadhaar number is strictly required'],
    validate: {
      validator: function(v) {
        return /^\d{12}$/.test(v);
      },
      message: 'Aadhaar number must be exactly 12 digits'
    }
  },
  registered_at: { 
    type: Date, 
    default: Date.now 
  },
});

const Hospital = require('./Hospital');

// Helper function removed because we now generate a modern UHID

patientSchema.pre('save', async function (next) {
  try {
    if (!this.uhid || !this.patientId) {
      const hospital = await Hospital.findOne();
      if (!hospital || !hospital.hospitalID) {
        throw new Error('Hospital ID not found');
      }

      // Try to find existing patient with same name and phone
      const existingPatient = await mongoose.model('Patient').findOne({
        first_name: this.first_name,
        last_name: this.last_name,
        phone: this.phone
      });

      if (existingPatient) {
        // Reuse original UHID for same patient entering as follow-up
        this.uhid = existingPatient.uhid || existingPatient.patientId;
        this.patientId = existingPatient.patientId; // backward compatibility
        this.hospitalId = existingPatient.hospitalId;
      } else {
        const date = new Date();
        const yymm = `${date.getFullYear().toString().slice(-2)}${(date.getMonth()+1).toString().padStart(2, '0')}`;
        
        // Extract Hospital Initials
        let hospitalPrefix = 'HS'; // Fallback
        const hName = hospital.hospitalName || hospital.name;
        if (hName) {
           const words = hName.trim().split(/\s+/).filter(w => w.length > 0);
           if (words.length > 0) {
             hospitalPrefix = words.map(w => w[0]).join('').toUpperCase();
           }
        }
        
        // Aadhaar number last 8 digits, fallback to phone
        let uniqueSuffix = '';
        if (this.aadhaar_number && this.aadhaar_number.length >= 8) {
          uniqueSuffix = this.aadhaar_number.slice(-8);
        } else if (this.phone && this.phone.length >= 8) {
          uniqueSuffix = this.phone.slice(-8);
        } else {
          uniqueSuffix = Math.floor(10000000 + Math.random() * 90000000).toString();
        }

        let newUhid = `${hospitalPrefix}${yymm}${uniqueSuffix}`;
        
        // Guarantee uniqueness in edge cases
        let isUnique = false;
        let suffixCounter = 0;
        
        while (!isUnique) {
          const checkUhid = suffixCounter === 0 ? newUhid : `${newUhid}-${suffixCounter}`;
          const exists = await mongoose.model('Patient').findOne({ $or: [{ uhid: checkUhid }, { patientId: checkUhid }] });
          if (!exists) {
             newUhid = checkUhid;
             isUnique = true;
          } else {
             suffixCounter++;
          }
        }
        
        this.uhid = newUhid;
        this.patientId = newUhid; // replace patientId completely as UHID
        this.hospitalId = hospital.hospitalID;
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Patient', patientSchema);