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
  aadhaar_number: {
    type: String,
    trim: true,
    // Removed strict 'required' to allow fallback logic for patients without Aadhaar
    validate: {
      validator: function(v) {
        if (!v) return true; // Allow empty so fallback logic can run
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

// Helper for the OLD logic (Fallback)
function generateStructuredPatientId(firstName, lastName, phone, hospitalCode) {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const namePart = (firstName.substring(0, 3) + (lastName ? lastName.substring(0, 1) : '')).toUpperCase();
  const phonePart = phone.slice(-4);
  return `${hospitalCode}-${namePart}${phonePart}-${year}${month}`;
}

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
        this.uhid = existingPatient.uhid || existingPatient.patientId;
        this.patientId = existingPatient.patientId;
        this.hospitalId = existingPatient.hospitalId;
      } else {
        let finalGeneratedId = '';

        // --- CONDITION: If Aadhaar is present, use New Logic ---
        if (this.aadhaar_number && this.aadhaar_number.length === 12) {
          const date = new Date();
          const yymm = `${date.getFullYear().toString().slice(-2)}${(date.getMonth() + 1).toString().padStart(2, '0')}`;
          
          let hospitalPrefix = 'HS'; 
          const hName = hospital.hospitalName || hospital.name;
          if (hName) {
            const words = hName.trim().split(/\s+/).filter(w => w.length > 0);
            if (words.length > 0) {
              hospitalPrefix = words.map(w => w[0]).join('').toUpperCase();
            }
          }
          const uniqueSuffix = this.aadhaar_number.slice(-8);
          finalGeneratedId = `${hospitalPrefix}${yymm}${uniqueSuffix}`;
        } 
        // --- FALLBACK: If Aadhaar is NOT present, use Old Logic ---
        else {
          finalGeneratedId = generateStructuredPatientId(
            this.first_name,
            this.last_name || '',
            this.phone,
            hospital.hospitalID
          );
        }

        // Guarantee uniqueness for whichever logic was used
        let isUnique = false;
        let suffixCounter = 0;
        let checkId = finalGeneratedId;

        while (!isUnique) {
          checkId = suffixCounter === 0 ? finalGeneratedId : `${finalGeneratedId}-${suffixCounter}`;
          const exists = await mongoose.model('Patient').findOne({ 
            $or: [{ uhid: checkId }, { patientId: checkId }] 
          });
          
          if (!exists) {
            isUnique = true;
          } else {
            suffixCounter++;
          }
        }
        
        this.uhid = checkId;
        this.patientId = checkId; 
        this.hospitalId = hospital.hospitalID;
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Patient', patientSchema);