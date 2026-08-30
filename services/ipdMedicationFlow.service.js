const Pharmacy = require('../models/Pharmacy');
const NursingNote = require('../models/NursingNote');
const { frequencyToPerDay, parseDurationDays } = require('./pharmacyTransaction.service');
const { userHospitalId, isPlatformAdmin } = require('../utils/hospitalScope');
const { operationNow } = require('../utils/operationTimeContext');
const { hospitalDateKey, dateKeyToStorageDate, addDateKeyDays } = require('../utils/hospitalDateTime');

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

function generateTimingSlots(frequency, durationDays, startDate = operationNow()) {
  const map = {
    OD: ['08:00'], BD: ['08:00', '20:00'], TDS: ['08:00', '14:00', '20:00'],
    QDS: ['06:00', '12:00', '18:00', '22:00'], q4h: ['02:00', '06:00', '10:00', '14:00', '18:00', '22:00'],
    q6h: ['00:00', '06:00', '12:00', '18:00'], q8h: ['06:00', '14:00', '22:00'],
    q12h: ['08:00', '20:00'], Stat: ['now'], SOS: []
  };
  const count = Math.max(1, Number(durationDays || 1));
  const day0Key = hospitalDateKey(startDate);
  const times = map[frequency] || ['08:00'];
  const slots = [];
  for (let day = 0; day < count; day += 1) {
    const date = dateKeyToStorageDate(addDateKeyDays(day0Key, day));
    for (const time of times) {
      slots.push({ date, time, status: 'Pending' });
    }
  }
  return slots;
}

async function findActivePharmacy(hospitalId, preferredPharmacyId, session = null) {
  if (!hospitalId) throw new Error('Hospital context is required before selecting a pharmacy.');
  if (preferredPharmacyId) {
    const pharmacy = await Pharmacy.findOne({ _id: preferredPharmacyId, hospitalId, status: 'Active' }).session(session || null);
    if (pharmacy) return pharmacy;
  }
  return Pharmacy.findOne({ hospitalId, status: 'Active' }).sort({ registeredAt: 1 }).session(session || null);
}

async function createOrUpdatePharmacyRequest({ medication, requestedQuantity, requestedBy, pharmacyId, notePrefix = 'Pharmacy request', session = null }) {
  const quantity = Number(requestedQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Requested quantity must be greater than zero.');
  if (medication.pharmacyRequest?.dispensedFromPharmacy && Number(medication.pharmacyRequest?.dispensedQuantity || 0) >= Number(medication.pharmacyRequest?.requestedQuantity || 0)) {
    throw new Error('Medication has already been fully dispensed. Create a new medication order for an additional issue.');
  }

  const pharmacy = await findActivePharmacy(medication.hospitalId, pharmacyId || medication.pharmacyRequest?.pharmacyId, session);
  if (!pharmacy) throw new Error('No active pharmacy is configured for this hospital.');

  const existingNumber = medication.pharmacyRequest?.pharmacyRequestNumber;
  medication.pharmacyRequest = {
    ...((medication.pharmacyRequest && medication.pharmacyRequest.toObject) ? medication.pharmacyRequest.toObject() : medication.pharmacyRequest || {}),
    requestedToPharmacy: true,
    requestedAt: operationNow(),
    requestedBy: requestedBy || medication.createdBy || medication.prescribedBy,
    requestedQuantity: Math.ceil(quantity),
    pharmacyId: pharmacy._id,
    pharmacyRequestNumber: existingNumber || `PHARM-REQ-${Date.now()}-${String(medication._id).slice(-6)}`,
    pharmacyStatus: Number(medication.pharmacyRequest?.dispensedQuantity || 0) > 0 ? 'PartiallyDispensed' : 'Pending',
    dispensedFromPharmacy: Boolean(medication.pharmacyRequest?.dispensedFromPharmacy),
    dispensedQuantity: Number(medication.pharmacyRequest?.dispensedQuantity || 0),
    dispensedBatchId: medication.pharmacyRequest?.dispensedBatchId || null,
    dispensedAt: medication.pharmacyRequest?.dispensedAt || null,
    stockReceivedByNurse: Boolean(medication.pharmacyRequest?.stockReceivedByNurse),
    stockReceivedAt: medication.pharmacyRequest?.stockReceivedAt || null,
    stockReceivedBy: medication.pharmacyRequest?.stockReceivedBy || null,
    saleId: medication.pharmacyRequest?.saleId || null,
    saleIds: medication.pharmacyRequest?.saleIds || [],
    dispenseHistory: medication.pharmacyRequest?.dispenseHistory || []
  };
  medication.status = 'Requested';
  medication.stockReceiptStatus = 'PENDING_RECEIPT';
  await medication.save(session ? { session } : undefined);

  const nursingNote = {
    hospitalId: medication.hospitalId,
    admissionId: medication.admissionId,
    patientId: medication.patientId,
    noteType: 'Medication',
    note: `${notePrefix} for ${medication.medicineName}: ${Math.ceil(quantity)} ${medication.medicineId ? 'base unit(s)' : 'unit(s)'}.`,
    priority: medication.isHighRisk ? 'Important' : 'Normal',
    createdBy: requestedBy || medication.createdBy || medication.prescribedBy
  };
  if (session) await NursingNote.create([nursingNote], { session });
  else await NursingNote.create(nursingNote);
  return medication;
}

function assertAdmissionHospitalAccess(req, admission) {
  if (isPlatformAdmin(req.user)) return;
  const scopedHospitalId = userHospitalId(req.user);
  if (scopedHospitalId && admission?.hospitalId && String(scopedHospitalId) !== String(admission.hospitalId)) {
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
