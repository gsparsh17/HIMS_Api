const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
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
    enum: ['General', 'ICU', 'Private', 'Emergency', 'Operation Theater', 'Operation Theatre', 'OT', 'Deluxe', 'Semi-Private', 'Day Care', 'Isolation', 'Special'], 
    default: 'General' 
  },
  Department: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Department' 
  },
  status: {
    type: String,
    enum: ['Available', 'Occupied', 'Partially Occupied', 'Full', 'Maintenance', 'Closed', 'Cleaning', 'Reserved'],
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

// Sanitize fields and generate room code before validation
roomSchema.pre('validate', async function(next) {
  if (this.wardId === '' || this.wardId === null || this.wardId === undefined) {
    this.wardId = undefined;
  }
  if (this.Department === '' || this.Department === null || this.Department === undefined) {
    this.Department = undefined;
  }
  if (this.assigned_patient_id === '' || this.assigned_patient_id === null || this.assigned_patient_id === undefined) {
    this.assigned_patient_id = undefined;
  }

  if (this.type === 'Operation Theatre' || this.type === 'OT') {
    this.type = 'Operation Theater';
  }

  if (!this.room_number) {
    const Room = mongoose.model('Room');
    const count = await Room.countDocuments();
    this.room_number = `RM${String(count + 1).padStart(3, '0')}`;
  }
  next();
});

roomSchema.index({ hospitalId: 1, room_number: 1 }, { unique: true });
roomSchema.index({ hospitalId: 1, wardId: 1, operationalStatus: 1 });
addSoftDeleteFields(roomSchema);

module.exports = mongoose.model('Room', roomSchema);