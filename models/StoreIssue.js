const mongoose = require('mongoose');

function makeIssueNo() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `SI-${y}${m}-${rand}`;
}

const storeIssueSchema = new mongoose.Schema({
  issue_number: { type: String, unique: true, trim: true },
  issue_date: { type: Date, default: Date.now },
  department: { type: String, required: true, trim: true },
  issued_to_name: { type: String, trim: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  issued_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  requisition: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreRequisition' },
  items: [{
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
    quantity: { type: Number, required: true, min: 1 },
    unit_cost: { type: Number, default: 0, min: 0 },
    total_cost: { type: Number, default: 0, min: 0 },
    remarks: { type: String, trim: true }
  }],
  status: { type: String, enum: ['Issued', 'Returned', 'Cancelled'], default: 'Issued' },
  notes: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' }
}, { timestamps: true });

storeIssueSchema.pre('save', function(next) {
  if (!this.issue_number) this.issue_number = makeIssueNo();
  this.items.forEach((line) => {
    line.total_cost = Number(line.quantity || 0) * Number(line.unit_cost || 0);
  });
  next();
});

storeIssueSchema.index({ hospital_id: 1, issue_date: -1 });
storeIssueSchema.index({ department: 1 });
storeIssueSchema.index({ issue_number: 1 });

module.exports = mongoose.model('StoreIssue', storeIssueSchema);
