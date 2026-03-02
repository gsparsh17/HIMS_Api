// models/Hospital.js
const mongoose = require('mongoose');

// Function to generate alphanumeric ID
function generateHospitalId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  
  // Generate 2 random letters
  let result = '';
  for (let i = 0; i < 2; i++) {
    result += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  
  // Generate 4 random numbers
  for (let i = 0; i < 4; i++) {
    result += numbers.charAt(Math.floor(Math.random() * numbers.length));
  }
  
  return result;
}

// Function to ensure unique ID
async function generateUniqueHospitalId(HospitalModel) {
  let hospitalId;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;
  console.log('Generating unique hospital ID...');
  while (!isUnique && attempts < maxAttempts) {
    hospitalId = generateHospitalId();
    
    // Check if this ID already exists
    const existingHospital = await HospitalModel.findOne({ hospitalID: hospitalId });
    if (!existingHospital) {
      isUnique = true;
    }
    
    attempts++;
  }
  
  if (!isUnique) {
    throw new Error('Unable to generate unique hospital ID after multiple attempts');
  }
  
  return hospitalId;
}

const hospitalSchema = new mongoose.Schema({
  hospitalID: { 
    type: String, 
    required: true, 
    unique: true 
  },
  registryNo: { 
    type: String, 
    required: true 
  },
  hospitalName: { 
    type: String, 
    required: true 
  },
  logo: { 
    type: String 
  }, 
  companyName: { 
    type: String 
  },
  licenseNumber: { 
    type: String 
  },
  name: { 
    type: String, 
    required: true 
  },
  address: { 
    type: String, 
    required: true 
  },
  contact: { 
    type: String, 
    required: true 
  },
  pinCode: { 
    type: String 
  },
  city: { 
    type: String, 
    required: true 
  },
  state: { 
    type: String, 
    required: true 
  },
  email: { 
    type: String, 
    required: true 
  },
  fireNOC: { 
    type: String 
  },
  policyDetails: { 
    type: String 
  },
  healthBima: { 
    type: String 
  },
  additionalInfo: { 
    type: String 
  },
  vitalsEnabled: { 
    type: Boolean, 
    default: true 
  },
  vitalsController: { 
    type: String, 
    enum: ['doctor', 'nurse', 'registrar'],
    default: 'nurse' 
  },
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  }
}, { timestamps: true });

// Pre-save middleware to generate hospitalID
hospitalSchema.pre('save', async function(next) {
  try {
    // Only generate hospitalID if it's a new document (not updating)
    if (this.isNew && !this.hospitalID) {
      this.hospitalID = await generateUniqueHospitalId(this.constructor);
    }
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Hospital', hospitalSchema);