const mongoose = require('mongoose');

const movementSchema = new mongoose.Schema({
  action: { type: String, enum: ['issued', 'returned', 'transferred', 'marked_lost', 'recovered', 'archived'], required: true },
  fromHolderType: String,
  fromHolderName: String,
  toHolderType: String,
  toHolderName: String,
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  toDepartmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  purpose: String,
  dueAt: Date,
  performedAt: { type: Date, default: Date.now },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note: String
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  fileNumber: { type: String, required: true, trim: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  recordType: { type: String, enum: ['IPD', 'OPD', 'Emergency', 'Mixed'], default: 'Mixed', index: true },
  currentHolderType: { type: String, enum: ['MRD', 'Doctor', 'Ward', 'Insurance', 'Billing', 'Legal', 'Patient', 'Other'], default: 'MRD' },
  currentHolderName: { type: String, trim: true, default: 'MRD' },
  currentHolderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  currentHolderDepartmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  status: { type: String, enum: ['in_registry', 'issued', 'overdue', 'lost', 'archived'], default: 'in_registry', index: true },
  lastIssuedAt: Date,
  dueAt: { type: Date, index: true },
  lastReturnedAt: Date,
  notes: String,
  movements: [movementSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ hospitalId: 1, fileNumber: 1 }, { unique: true });
schema.index({ hospitalId: 1, patientId: 1, status: 1 });
schema.index({ hospitalId: 1, currentHolderType: 1, dueAt: 1 });

module.exports = mongoose.model('MRDFileTracking', schema);
