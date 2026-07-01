const mongoose = require('mongoose');

const isPositiveNumber = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const fail = (res, message) => res.status(400).json({ success: false, error: message });

exports.validatePrescriptionMedicationFlow = (req, res, next) => {
  const isIPD = String(req.body.source_type || '').toUpperCase() === 'IPD';
  if (!isIPD) return next();
  if (!isObjectId(req.body.ipd_admission_id)) return fail(res, 'A valid ipd_admission_id is required for an IPD prescription.');
  if (!isObjectId(req.body.patient_id) || !isObjectId(req.body.doctor_id)) return fail(res, 'A valid patient_id and doctor_id are required.');
  for (const [index, item] of (req.body.items || []).entries()) {
    if (!String(item.medicine_name || '').trim()) return fail(res, `Medicine name is required for item ${index + 1}.`);
    if (!String(item.frequency || '').trim() || !item.duration) return fail(res, `Frequency and duration are required for ${item.medicine_name}.`);
    if (item.dose_quantity != null && !isPositiveNumber(item.dose_quantity)) return fail(res, `Dose units must be greater than zero for ${item.medicine_name}.`);
    // Clinical prescriptions are authored from NLEM/generic data. Inventory mapping
    // happens later in the pharmacy POS, where a pharmacist selects the actual
    // stocked product and batch.
  }
  next();
};

exports.validateIndent = (req, res, next) => {
  if (!isPositiveNumber(req.body.quantity)) return fail(res, 'quantity must be a positive number of base units.');
  next();
};

exports.validatePharmacyProcess = (req, res, next) => {
  const { action, batchId, dispensedQuantity } = req.body;
  if (!['approve', 'reject', 'out_of_stock'].includes(action)) return fail(res, 'action must be approve, reject, or out_of_stock.');
  if (action === 'approve') {
    if (!isObjectId(batchId)) return fail(res, 'A valid batchId is required to dispense a medication.');
    if (!isPositiveNumber(dispensedQuantity)) return fail(res, 'dispensedQuantity must be a positive number of base units.');
  }
  next();
};

exports.validateAdministration = (req, res, next) => {
  if (!isObjectId(req.body.timingId)) return fail(res, 'A valid timingId is required.');
  next();
};
