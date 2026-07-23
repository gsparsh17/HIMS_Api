const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  room_number: { 
    type: String, 
    required: true 
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
    enum: ['Available', 'Occupied', 'Partially Occupied', 'Full', 'Maintenance', 'Closed'],
    default: 'Available'
  },
  capacity: { type: Number, default: 1, min: 1 },
  operationalStatus: { type: String, enum: ['open', 'maintenance', 'closed'], default: 'open' },
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

roomSchema.index({ hospitalId: 1, room_number: 1 }, { unique: true });
roomSchema.index({ hospitalId: 1, wardId: 1, operationalStatus: 1 });
module.exports = mongoose.model('Room', roomSchema);