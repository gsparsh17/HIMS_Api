const mongoose = require('mongoose');

const storeLocationSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['Central Store', 'Sub Store', 'Department', 'Ward', 'OT', 'Bin', 'Transit', 'Quarantine'], default: 'Sub Store' },
  parentLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation' },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  binCode: { type: String, trim: true },
  responsibleUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  allowIssue: { type: Boolean, default: true },
  allowReceipt: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

storeLocationSchema.index({ hospitalId: 1, code: 1 }, { unique: true });
storeLocationSchema.index({ hospitalId: 1, type: 1, isActive: 1 });

module.exports = mongoose.model('StoreLocation', storeLocationSchema);
