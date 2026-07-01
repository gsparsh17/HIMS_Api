const Pharmacy = require('../models/Pharmacy');
const NursingNote = require('../models/NursingNote');
const { frequencyToPerDay, parseDurationDays } = require('./pharmacyTransaction.service');

function normaliseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}

function resolveDoseQtyBaseUnits(item = {}) {
  const explicit = item.doseQtyBaseUnits ?? item.dose_qty_base_units ?? item.dose_quantity ?? item.doseQty ?? item.dose_qty;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // A dosage/strength such as "500mg" describes strength, not 500 tablets.
  // Only accept an inferred quantity when the free text explicitly carries a
  // dispensing unit, e.g. "2 tablets" or "1 vial".
  const raw = String(item.dosage || '').toLowerCase();
  const unitMatch = raw.match(/(\d+(?:\.\d+)?)\s*(tablet|tab|capsule|cap|vial|ampoule|sachet|puff|drop|ml|unit|piece)s?\b/);
  if (unitMatch) return Number(unitMatch[1]);
  return 1;
}

function calculateMedicationRequiredBaseUnits(item = {}) {
  const explicit = item.requiredQtyBaseUnits ?? item.required_qty_base_units;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  }
  const doseQty = resolveDoseQtyBaseUnits(item);
  const perDay = Number(frequencyToPerDay(item.frequency || 'OD'));
  const durationDays = Number(parseDurationDays(item.duration || 1, item.durationUnit || item.duration_unit || 'Days'));
  if (!Number.isFinite(perDay) || perDay <= 0) return Math.max(1, Math.ceil(doseQty)); // SOS/PRN starts with one unit; nurse indents more as needed.
  return Math.max(1, Math.ceil(doseQty * perDay * Math.max(1, durationDays)));
}

function generateTimingSlots(frequency, durationDays, startDate = new Date()) {
  const map = {
    OD: ['08:00'], BD: ['08:00', '20:00'], TDS: ['08:00', '14:00', '20:00'],
    QDS: ['06:00', '12:00', '18:00', '22:00'], q4h: ['02:00', '06:00', '10:00', '14:00', '18:00', '22:00'],
    q6h: ['00:00', '06:00', '12:00', '18:00'], q8h: ['06:00', '14:00', '22:00'],
    q12h: ['08:00', '20:00'], Stat: ['now'], SOS: []
  };
  const count = Math.max(1, Number(durationDays || 1));
  const day0 = new Date(startDate);
  day0.setHours(0, 0, 0, 0);
  const times = map[frequency] || ['08:00'];
  const slots = [];
  for (let day = 0; day < count; day += 1) {
    for (const time of times) {
      const date = new Date(day0);
      date.setDate(date.getDate() + day);
      slots.push({ date, time, status: 'Pending' });
    }
  }
  return slots;
}

async function findActivePharmacy(preferredPharmacyId) {
  if (preferredPharmacyId) {
    const pharmacy = await Pharmacy.findOne({ _id: preferredPharmacyId, status: 'Active' });
    if (pharmacy) return pharmacy;
  }
  return Pharmacy.findOne({ status: 'Active' }).sort({ registeredAt: 1 });
}

async function createOrUpdatePharmacyRequest({ medication, requestedQuantity, requestedBy, pharmacyId, notePrefix = 'Pharmacy request' }) {
  const quantity = Number(requestedQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Requested quantity must be greater than zero.');
  if (medication.pharmacyRequest?.dispensedFromPharmacy) throw new Error('Medication has already been dispensed. Create a new medication order for an additional issue.');

  const pharmacy = await findActivePharmacy(pharmacyId || medication.pharmacyRequest?.pharmacyId);
  if (!pharmacy) throw new Error('No active pharmacy is configured for this hospital.');

  const existingNumber = medication.pharmacyRequest?.pharmacyRequestNumber;
  medication.pharmacyRequest = {
    ...((medication.pharmacyRequest && medication.pharmacyRequest.toObject) ? medication.pharmacyRequest.toObject() : medication.pharmacyRequest || {}),
    requestedToPharmacy: true,
    requestedAt: new Date(),
    requestedBy: requestedBy || medication.createdBy || medication.prescribedBy,
    requestedQuantity: Math.ceil(quantity),
    pharmacyId: pharmacy._id,
    pharmacyRequestNumber: existingNumber || `PHARM-REQ-${Date.now()}-${String(medication._id).slice(-6)}`,
    pharmacyStatus: 'Pending',
    dispensedFromPharmacy: false,
    dispensedQuantity: 0,
    dispensedBatchId: null,
    dispensedAt: null,
    stockReceivedByNurse: false,
    stockReceivedAt: null,
    stockReceivedBy: null,
    saleId: null
  };
  medication.status = 'Requested';
  medication.stockReceiptStatus = 'PENDING_RECEIPT';
  await medication.save();

  await NursingNote.create({
    admissionId: medication.admissionId,
    patientId: medication.patientId,
    noteType: 'Medication',
    note: `${notePrefix} for ${medication.medicineName}: ${Math.ceil(quantity)} ${medication.medicineId ? 'base unit(s)' : 'unit(s)'}.`,
    priority: medication.isHighRisk ? 'Important' : 'Normal',
    createdBy: requestedBy || medication.createdBy || medication.prescribedBy
  });
  return medication;
}

function assertAdmissionHospitalAccess(req, admission) {
  const role = req.user?.role;
  if (role === 'mediqliq_super_admin') return;
  const userHospitalId = req.user?.hospital_id || req.user?.hospitalId;
  if (userHospitalId && admission?.hospitalId && String(userHospitalId) !== String(admission.hospitalId)) {
    const error = new Error('This admission belongs to a different hospital.');
    error.statusCode = 403;
    throw error;
  }
}

module.exports = {
  normaliseBoolean,
  resolveDoseQtyBaseUnits,
  calculateMedicationRequiredBaseUnits,
  generateTimingSlots,
  createOrUpdatePharmacyRequest,
  assertAdmissionHospitalAccess
};
