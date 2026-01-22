const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema({
  patientId: { 
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
    validate: {
      validator: function(v) {
        // Validate 12-digit Aadhaar number (optional)
        if (!v) return true; // Allow empty
        return /^\d{12}$/.test(v);
      },
      message: 'Aadhaar number must be 12 digits'
    }
  },
  registered_at: { 
    type: Date, 
    default: Date.now 
  },
});

const Hospital = require('./Hospital');

// Helper function to generate structured patient ID
function generateStructuredPatientId(firstName, lastName, phone, hospitalCode) {
  // Format: HOSPITALCODE-NAMEPHONE-DATE-RANDOM
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  
  // Get first 3 letters of first name (uppercase)
  const namePart = (firstName.substring(0, 3) + lastName.substring(0, 1)).toUpperCase();
  
  // Get last 4 digits of phone
  const phonePart = phone.slice(-4);
  
  // Format: HOSP-NAME-YYYYMM
  return `${hospitalCode}-${namePart}${phonePart}-${year}${month}`;
}

patientSchema.pre('save', async function (next) {
  try {
    if (!this.patientId) {
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
        // Use existing patient ID instead of creating new
        this.patientId = existingPatient.patientId;
        this.hospitalId = existingPatient.hospitalId;
      } else {
        // Generate new ID with retry logic
        let patientId;
        let attempts = 0;
        const maxAttempts = 5;

        do {
          patientId = generateStructuredPatientId(
            this.first_name,
            this.last_name,
            this.phone,
            hospital.hospitalID,
          );
          attempts++;
          
          // Check if this ID already exists
          const exists = await mongoose.model('Patient').findOne({ patientId });
          if (!exists) break;
          
          if (attempts >= maxAttempts) {
            throw new Error('Could not generate unique patient ID');
          }
        } while (true);

        this.patientId = patientId;
        this.hospitalId = hospital.hospitalID;
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Patient', patientSchema);