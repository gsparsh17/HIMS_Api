const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  room_number: { 
    type: String, 
    required: true, 
    unique: true 
  },
  wardId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Ward' 
  },
  type: { 
    type: String, 
    enum: ['General', 'ICU', 'Private', 'Emergency', 'Operation Theater'], 
    default: 'General' 
  },
  Department: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Department' 
  },
  status: { 
    type: String, 
    enum: ['Available', 'Occupied', 'Maintenance'], 
    default: 'Available' 
  },
  assigned_patient_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Patient' 
  },
  floor: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Generate room code before save
roomSchema.pre('validate', async function(next) {
  if (!this.room_number) {
    const Room = mongoose.model('Room');
    const count = await Room.countDocuments();
    this.room_number = `RM${String(count + 1).padStart(3, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Room', roomSchema);