const mongoose = require('mongoose');

const hospitalGroupSchema = new mongoose.Schema({
  groupId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  name: { 
    type: String, 
    required: true 
  },
  type: {
    type: String,
    enum: ['personal', 'chain', 'network'],
    default: 'personal'
  },
  is_single_hospital: {
    type: Boolean,
    default: true
  },
  can_expand: {
    type: Boolean,
    default: true
  },
  address: { 
    type: String 
  },
  contact_email: { 
    type: String 
  },
  contact_phone: { 
    type: String 
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  is_active: { 
    type: Boolean, 
    default: true 
  }
}, { 
  timestamps: true 
});

module.exports = mongoose.model('HospitalGroup', hospitalGroupSchema);