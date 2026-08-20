const Doctor = require('../models/Doctor');
const HospitalCharges = require('../models/HospitalCharges');
const Bed = require('../models/Bed');
const { quotePricing } = require('./pricingEngine.service');
const { wardEntitlementFrom } = require('./hospitalTariff.service');
const { operationNow } = require('../utils/operationTimeContext');

function httpError(message, statusCode = 400, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function normalizeVisitType(value, encounterType) {
  if (String(encounterType).toUpperCase() === 'IPD') return 'ROUND';
  const raw = String(value || 'NEW').trim().toUpperCase().replace(/[ -]+/g, '_');
  if (['FOLLOWUP', 'FOLLOW_UP', 'REVISIT'].includes(raw)) return 'FOLLOW_UP';
  return 'NEW';
}

async function fallbackStandardAmount({ hospitalId, doctor, encounterType, serviceDate }) {
  const at = new Date(serviceDate || operationNow());
  const charges = await HospitalCharges.findOne({
    hospital: hospitalId,
    effectiveFrom: { $lte: at },
    is_active: { $ne: false },
  }).sort({ effectiveFrom: -1, createdAt: -1 }).lean();

  if (String(encounterType).toUpperCase() === 'OPD') {
    // opdConsultationFee is a legacy patient-facing tariff, deliberately separate
    // from Doctor.amount (salary/Fee-per-Visit). Central RateCard still wins.
    if (Number.isFinite(Number(doctor.opdConsultationFee))) return Number(doctor.opdConsultationFee);
    return Number(charges?.opdCharges?.consultationFee || 0);
  }
  return Number(charges?.ipdCharges?.consultationFee || 0);
}

async function resolveDoctorTariff({
  hospitalId,
  doctorId,
  encounterType = 'OPD',
  visitType,
  admissionId,
  appointmentId,
  wardEntitlement,
  serviceDate,
  coverage,
}) {
  if (!hospitalId || !doctorId) throw httpError('Hospital and doctor are required', 400, 'DOCTOR_TARIFF_CONTEXT_REQUIRED');

  const doctor = await Doctor.findOne({ _id: doctorId, hospitalId, is_active: { $ne: false } }).lean();
  if (!doctor) throw httpError('Doctor not found for this hospital', 404, 'DOCTOR_NOT_FOUND');

  let ward = wardEntitlement;
  if (!ward && admissionId) {
    const IPDAdmission = require('../models/IPDAdmission');
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId, is_active: { $ne: false } })
      .select('bedId')
      .lean();
    if (admission?.bedId) {
      const bed = await Bed.findOne({ _id: admission.bedId, hospitalId, is_active: { $ne: false } }).select('bedType').lean();
      ward = wardEntitlementFrom(bed?.bedType);
    }
  }
  ward = wardEntitlementFrom(ward || 'general');

  const normalizedEncounter = String(encounterType || 'OPD').toUpperCase() === 'IPD' ? 'IPD' : 'OPD';
  const normalizedVisit = normalizeVisitType(visitType, normalizedEncounter);
  const fallback = await fallbackStandardAmount({ hospitalId, doctor, encounterType: normalizedEncounter, serviceDate });

  const quote = await quotePricing({
    hospitalId,
    doctorId,
    encounterType: normalizedEncounter,
    visitType: normalizedVisit,
    wardEntitlement: ward,
    serviceType: 'consultation',
    chargeType: normalizedEncounter === 'IPD' ? 'Doctor Visit' : 'Consultation',
    serviceDate: serviceDate || operationNow(),
    standardAmount: fallback,
    admissionId,
    appointmentId,
    coverage,
    quantity: 1,
  });

  return {
    doctorId: doctor._id,
    encounterType: normalizedEncounter,
    visitType: normalizedVisit,
    wardEntitlement: ward,
    quote,
    amount: Number(quote?.amounts?.contracted ?? quote?.amounts?.patientLiability ?? fallback),
    pricingSnapshot: {
      doctorId: doctor._id,
      encounterType: normalizedEncounter,
      visitType: normalizedVisit,
      wardEntitlement: ward,
      rateCard: quote?.rateCard || null,
      rateCardItemId: quote?.rateCardItemId || null,
      resultType: quote?.resultType,
      amounts: quote?.amounts || {},
      explanation: quote?.explanation || [],
      ruleTrace: quote?.ruleTrace || [],
      payrollAmountUsed: false,
      resolvedAt: operationNow(),
    },
  };
}

module.exports = { resolveDoctorTariff, normalizeVisitType };
