const mongoose = require('mongoose');

const immunizationSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    vaccineName: { type: String, required: true },
    vaccineCode: String,
    occurrenceDate: { type: Date, required: true, index: true },
    doseNumber: String,
    seriesDoses: String,
    batchNumber: String,
    manufacturer: String,
    route: String,
    site: String,
    performerName: String,
    status: { type: String, enum: ['completed', 'entered-in-error', 'not-done'], default: 'completed' },
    notes: String,
    abdmRecordLink: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

module.exports = mongoose.model('Immunization', immunizationSchema);
