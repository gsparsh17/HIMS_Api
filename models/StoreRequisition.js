const mongoose = require('mongoose');

function makeReqNo() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `SR-${y}${m}-${rand}`;
}

const storeRequisitionSchema = new mongoose.Schema({
  requisition_number: { type: String, unique: true, trim: true },
  request_date: { type: Date, default: Date.now },
  department: { type: String, required: true, trim: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approved_at: { type: Date },
  items: [{
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
    requested_quantity: { type: Number, required: true, min: 1 },
    approved_quantity: { type: Number, default: 0, min: 0 },
    issued_quantity: { type: Number, default: 0, min: 0 },
    remarks: { type: String, trim: true }
  }],
  priority: { type: String, enum: ['Low', 'Normal', 'High', 'Urgent'], default: 'Normal' },
  status: { type: String, enum: ['Pending', 'Approved', 'Partially Issued', 'Issued', 'Rejected', 'Cancelled'], default: 'Pending' },
  purpose: { type: String, trim: true },
  rejection_reason: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' }
}, { timestamps: true });

storeRequisitionSchema.pre('save', function(next) {
  if (!this.requisition_number) this.requisition_number = makeReqNo();
  next();
});

storeRequisitionSchema.index({ hospital_id: 1, request_date: -1 });
storeRequisitionSchema.index({ status: 1 });
storeRequisitionSchema.index({ department: 1 });

module.exports = mongoose.model('StoreRequisition', storeRequisitionSchema);
