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
    reserved_quantity: { type: Number, default: 0, min: 0 },
    issued_quantity: { type: Number, default: 0, min: 0 },
    returned_quantity: { type: Number, default: 0, min: 0 },
    substituted_item: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem' },
    line_status: { type: String, enum: ['Pending', 'Approved', 'Reserved', 'Partially Issued', 'Issued', 'Returned', 'Rejected', 'Cancelled'], default: 'Pending' },
    remarks: { type: String, trim: true }
  }],
  priority: { type: String, enum: ['Low', 'Normal', 'High', 'Urgent'], default: 'Normal' },
  status: { type: String, enum: ['Draft', 'Submitted', 'Department Approved', 'Store Reviewed', 'Approved', 'Reserved', 'Partially Reserved', 'Partially Issued', 'Issued', 'Acknowledged', 'Returned', 'Closed', 'Rejected', 'Cancelled'], default: 'Draft' },
  source_location_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation' },
  destination_location_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation' },
  admission_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission' },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  ot_case_id: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest' },
  reservation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockReservation' },
  acknowledged_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acknowledged_at: Date,
  version: { type: Number, default: 1 },
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
