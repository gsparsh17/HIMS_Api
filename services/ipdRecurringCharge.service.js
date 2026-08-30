'use strict';

const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const IPDAccommodationSegment = require('../models/IPDAccommodationSegment');
const Bed = require('../models/Bed');
const HospitalCharges = require('../models/HospitalCharges');
const { quotePricing, pricingSnapshot } = require('./pricingEngine.service');
const { activeCoverage } = require('./coverage.service');
const { replaceCoverageUtilization } = require('./coverageUtilization.service');
const { resolveFinancialPolicy } = require('./financialPolicy.service');
const { DAILY_TARIFF_CODES, resolveHospitalTariffRate, wardEntitlementFrom } = require('./hospitalTariff.service');
const { userHospitalId, normalizeObjectId } = require('../utils/hospitalScope');
const { loadIPDWorkflowPolicy } = require('./ipdWorkflowPolicy.service');

// ============================================
// Constants
// ============================================

const ACTIVE_IPD_STATUSES = Object.freeze([
  'Admitted',
  'Under Treatment',
  'Discharge Initiated',
  'Discharge Summary Pending',
  'Billing Pending',
  'Payment Pending',
  'Ready for Discharge'
]);

const DEFAULT_TIME_ZONE = process.env.HOSPITAL_TIME_ZONE || 'Asia/Kolkata';

// ============================================
// Date Helpers
// ============================================

function dateKeyInTimeZone(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(date));

  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${map.year}-${map.month}-${map.day}`;
}

function keyToChargeDate(key) {
  // Midday UTC is stable for Indian hospital calendar dates and avoids the
  // previous-UTC-day problem caused by running a job shortly after midnight IST.
  return new Date(`${key}T12:00:00.000Z`);
}

function dateKeysBetween(fromDate, throughDate, timeZone = DEFAULT_TIME_ZONE) {
  const fromKey = dateKeyInTimeZone(fromDate, timeZone);
  const throughKey = dateKeyInTimeZone(throughDate, timeZone);

  const out = [];
  let cursor = keyToChargeDate(fromKey);
  const end = keyToChargeDate(throughKey);

  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }

  return out;
}

// ============================================
// Segment Helper
// ============================================

function segmentForDate(segments, key, timeZone = DEFAULT_TIME_ZONE) {
  // A transfer closes the old segment and opens the new segment on the same
  // hospital calendar date. More than one segment can therefore match `key`.
  // Always use the latest-started matching segment so transfer-day billing
  // follows the patient's current accommodation instead of the old bed.
  const matches = (segments || []).filter((segment) => {
    if (!segment?.startedAt || segment.status === 'voided') return false;
    const startKey = dateKeyInTimeZone(segment.startedAt, timeZone);
    const endKey = segment.endedAt ? dateKeyInTimeZone(segment.endedAt, timeZone) : null;
    return startKey <= key && (!endKey || endKey >= key);
  });

  return matches.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;
}

// ============================================
// Daily Fallbacks
// ============================================

async function dailyFallbacks(hospitalId) {
  const row = await HospitalCharges.findOne({ hospital: hospitalId }).lean();

  return {
    nursing: Number(row?.ipdCharges?.nursingCharges || 0),
    rmo: Number(row?.ipdCharges?.rmoDutyDoctorCharges || 0)
  };
}

// ============================================
// Create Daily Charge
// ============================================

async function createDailyCharge({
  admission,
  key,
  kind,
  rate,
  description,
  segment,
  bed,
  user
}) {
  const idempotencyKey = `daily:${admission.hospitalId}:${admission._id}:${key}:${kind}`;

  const existing = await IPDCharge.findOne({ idempotencyKey });

  if (existing) {
    return { charge: existing, alreadyExists: true };
  }

  const chargeType = kind === 'bed'
    ? 'Bed'
    : kind === 'nursing'
      ? 'Nursing'
      : 'RMO / Duty Doctor';

  // Before this recurring service existed, admission/day-one and manual bed charge
  // generators could already have posted a bed line. Reuse that row rather than
  // creating a second charge for the same hospital calendar day.
  if (kind === 'bed') {
    const legacy = await IPDCharge.findOne({
      hospitalId: admission.hospitalId,
      admissionId: admission._id,
      chargeType: 'Bed',
      chargeDateKey: key,
      status: { $nin: ['VOIDED', 'CANCELLED'] }
    }).sort({ createdAt: 1 });

    if (legacy) {
      return {
        charge: legacy,
        alreadyExists: true,
        legacyExisting: true
      };
    }
  }

  const serviceType = kind === 'bed'
    ? 'bed'
    : kind === 'nursing'
      ? 'other'
      : 'consultation';

  const externalCode = DAILY_TARIFF_CODES[kind];
  const internalServiceModel = kind === 'bed' && bed?._id ? 'Bed' : undefined;
  const internalServiceId = kind === 'bed' && bed?._id ? bed._id : undefined;
  const chargeDate = keyToChargeDate(key);
  const wardEntitlement = wardEntitlementFrom(segment?.bedType || bed?.bedType);

  const quote = await quotePricing({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
    serviceDate: chargeDate,
    chargeType,
    serviceType,
    externalCode,
    internalServiceModel,
    internalServiceId,
    internalCode: kind === 'bed' ? bed?.bedCode : externalCode,
    standardAmount: Number(rate || 0),
    wardEntitlement,
    quantity: 1
  });

  const coverage = await activeCoverage(admission.hospitalId, admission._id);
  const policy = await resolveFinancialPolicy({
    hospitalId: admission.hospitalId,
    user,
    encounterType: 'IPD',
    serviceType,
    serviceCategory: kind === 'bed' ? 'ACCOMMODATION' : (kind === 'nursing' ? 'NURSING' : 'DOCTOR_VISIT'),
    serviceCode: externalCode,
    payerCategory: coverage?.payerCategory || (coverage ? 'SPONSORED' : 'SELF'),
    departmentId: admission.departmentId,
    urgency: 'ROUTINE',
    effectiveAt: chargeDate,
    selectedMode: undefined,
    inheritedMode: admission.selectedBillingMode,
    patientLiability: quote.amounts.patientLiability,
    sponsorLiability: quote.amounts.sponsorLiability,
    contractedAmount: quote.amounts.contracted,
    adjustments: {}
  });
  quote.amounts = {
    ...quote.amounts,
    patientLiability: policy.amounts.patientLiability,
    sponsorLiability: policy.amounts.sponsorLiability,
    hospitalConcession: Number((Number(quote.amounts.hospitalConcession || 0) + Number(policy.amounts.discountAmount || 0)).toFixed(2))
  };

  try {
    const charge = await IPDCharge.create({
      hospitalId: admission.hospitalId,
      admissionId: admission._id,
      patientId: admission.patientId,
      chargeType,
      description,
      quantity: 1,
      rate: Number(policy.amounts.grossAmount || quote.amounts.contracted || rate || 0),
      discountType: policy.amounts.discountType,
      discountRate: policy.amounts.discountRate,
      discountAmount: policy.amounts.discountAmount,
      discountReason: policy.amounts.discountReason || undefined,
      taxMode: policy.amounts.taxMode,
      taxName: policy.amounts.taxName,
      taxCode: policy.amounts.taxCode,
      taxRate: policy.amounts.taxRate,
      taxAmount: policy.amounts.taxAmount,
      taxExemptionReason: policy.amounts.taxExemptionReason || undefined,
      sourceModule: 'RecurringDaily',
      sourceId: segment?._id || bed?._id,
      sourceReference: {
        module: kind === 'bed' ? 'Bed' : 'IPD',
        documentId: segment?._id || admission._id,
        lineKey: `${externalCode}:${key}`
      },
      chargeDate,
      chargeDateKey: key,
      idempotencyKey,
      isAutoGenerated: true,
      accommodationSegmentId: segment?._id,
      addedBy: user?._id,
      pricingSnapshot: pricingSnapshot(quote, {
        internalServiceModel,
        internalServiceId
      }),
      financialPolicySnapshot: policy.policySnapshot,
      selectedBillingMode: policy.selectedMode,
      requiredNowAmount: policy.requiredNow,
      clearanceState: policy.clearanceState,
      patientLiability: quote.amounts.patientLiability,
      sponsorLiability: quote.amounts.sponsorLiability,
      nonAdmissibleAmount: quote.amounts.nonAdmissible,
      notes: `Automatic IPD daily charge (${externalCode})`
    });

    // A new billable daily charge makes any previous financial clearance stale.
    await IPDAdmission.updateOne(
      { _id: admission._id, hospitalId: admission.hospitalId },
      {
        $set: { financialClearanceStatus: 'in_progress' },
        $unset: { financialClearedAt: 1, financialClearedBy: 1, finalSettlementReceiptNumber: 1 }
      }
    );

    await replaceCoverageUtilization({
      coverage,
      quote,
      hospitalId: admission.hospitalId,
      encounterType: 'IPD',
      admissionId: admission._id,
      patientId: admission.patientId,
      sourceType: 'IPDCharge',
      sourceId: charge._id,
      internalServiceModel,
      internalServiceId,
      userId: user?._id
    });

    return { charge, alreadyExists: false };
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await IPDCharge.findOne({ idempotencyKey });

      if (duplicate) {
        return { charge: duplicate, alreadyExists: true };
      }
    }

    throw error;
  }
}

// ============================================
// Ensure Admission Daily Charges
// ============================================

async function ensureAdmissionDailyCharges(
  admissionId,
  throughDate = new Date(),
  user = null,
  options = {}
) {
  const rawAdmission = await IPDAdmission.findById(admissionId).lean();

  if (!rawAdmission) {
    const error = new Error('IPD admission not found');
    error.statusCode = 404;
    throw error;
  }

  // Some legacy/imported admissions contain Extended JSON serialized as a
  // string, e.g. '{"$oid":"..."}'. Mongoose cannot use that value in an
  // ObjectId query. Normalize at the service boundary and provide a precise
  // data-integrity error instead of allowing a CastError deep in pricing.
  const hospitalId = normalizeObjectId(rawAdmission.hospitalId);
  const patientId = normalizeObjectId(rawAdmission.patientId);

  if (!hospitalId) {
    const error = new Error(
      `Invalid hospitalId stored on IPD admission ${rawAdmission._id}; run the legacy ObjectId normalization migration`
    );
    error.statusCode = 422;
    error.code = 'INVALID_ADMISSION_HOSPITAL_ID';
    throw error;
  }

  if (!patientId) {
    const error = new Error(
      `Invalid patientId stored on IPD admission ${rawAdmission._id}; repair the admission before generating charges`
    );
    error.statusCode = 422;
    error.code = 'INVALID_ADMISSION_PATIENT_ID';
    throw error;
  }

  const admission = { ...rawAdmission, hospitalId, patientId };

  const rawActorHospitalId = userHospitalId(user);
  const actorHospitalId = rawActorHospitalId ? normalizeObjectId(rawActorHospitalId) : null;

  if (rawActorHospitalId && !actorHospitalId) {
    const error = new Error('Authenticated user has an invalid hospital context');
    error.statusCode = 403;
    error.code = 'INVALID_USER_HOSPITAL_ID';
    throw error;
  }

  if (actorHospitalId && String(actorHospitalId) !== String(hospitalId)) {
    const error = new Error('Cross-hospital access is not permitted');
    error.statusCode = 403;
    throw error;
  }

  const requestedThrough = admission.dischargeDate &&
    new Date(admission.dischargeDate) < new Date(throughDate)
      ? new Date(admission.dischargeDate)
      : new Date(throughDate);
  // A frozen admission has reached the audited charge boundary. Recurring
  // catch-up may fill dates up to the freeze timestamp, but never generate a
  // new accommodation/nursing/RMO charge after that boundary.
  const effectiveThrough = admission.chargeFreeze?.status === 'frozen' && admission.chargeFreeze?.frozenAt &&
    new Date(admission.chargeFreeze.frozenAt) < requestedThrough
      ? new Date(admission.chargeFreeze.frozenAt)
      : requestedThrough;

  const requestedFrom = options?.fromDate
    ? new Date(options.fromDate)
    : new Date(admission.admissionDate);

  const effectiveFrom = requestedFrom > new Date(admission.admissionDate)
    ? requestedFrom
    : new Date(admission.admissionDate);

  if (effectiveFrom > effectiveThrough) {
    return {
      admissionId: admission._id,
      processedDays: 0,
      created: 0,
      existing: 0,
      skipped: [],
      charges: []
    };
  }

  const keys = dateKeysBetween(effectiveFrom, effectiveThrough);

  const segments = await IPDAccommodationSegment.find({
    admissionId: admission._id
  })
    .sort({ startedAt: 1 })
    .lean();

  const [fallback, workflowPolicy] = await Promise.all([
    dailyFallbacks(hospitalId),
    loadIPDWorkflowPolicy(hospitalId)
  ]);

  const result = {
    admissionId: admission._id,
    processedDays: 0,
    created: 0,
    existing: 0,
    skipped: [],
    charges: []
  };

  for (const key of keys) {
    const segment = segmentForDate(segments, key);
    let bed = null;

    const segmentBedId = normalizeObjectId(segment?.bedId);
    const admissionBedId = normalizeObjectId(admission.bedId);

    if (segmentBedId) {
      bed = await Bed.findOne({ _id: segmentBedId, hospitalId }).lean();
    }

    if (!bed && admissionBedId) {
      bed = await Bed.findOne({ _id: admissionBedId, hospitalId }).lean();
    }

    const ward = segment?.bedType || bed?.bedType || 'General';

    const bedTariff = await resolveHospitalTariffRate({
      hospitalId: admission.hospitalId,
      externalCode: DAILY_TARIFF_CODES.bed,
      wardEntitlement: ward,
      serviceDate: keyToChargeDate(key)
    });

    const nursingTariff = await resolveHospitalTariffRate({
      hospitalId: admission.hospitalId,
      externalCode: DAILY_TARIFF_CODES.nursing,
      wardEntitlement: ward,
      serviceDate: keyToChargeDate(key)
    });

    const rmoTariff = await resolveHospitalTariffRate({
      hospitalId: admission.hospitalId,
      externalCode: DAILY_TARIFF_CODES.rmo,
      wardEntitlement: ward,
      serviceDate: keyToChargeDate(key)
    });

    const rates = {
      bed: Number(bedTariff?.amount ?? segment?.dailyRate ?? bed?.dailyCharge ?? 0),
      nursing: Number(nursingTariff?.amount ?? fallback.nursing ?? 0),
      rmo: Number(rmoTariff?.amount ?? fallback.rmo ?? 0)
    };

    const labels = {
      bed: `Room / Bed Charges - ${ward} - ${key}`,
      nursing: `Nursing Charges - ${ward} - ${key}`,
      rmo: `RMO & Duty Doctor Charges - ${ward} - ${key}`
    };

    for (const kind of ['bed', 'nursing', 'rmo']) {
      const enabled = kind === 'bed'
        ? workflowPolicy.recurringCharges.bed
        : kind === 'nursing'
          ? workflowPolicy.recurringCharges.nursing
          : workflowPolicy.recurringCharges.rmoDutyDoctor;
      if (!enabled) {
        result.skipped.push({ key, kind, reason: 'Disabled by IPD billing/discharge policy' });
        continue;
      }
      if (!Number.isFinite(rates[kind]) || rates[kind] <= 0) {
        result.skipped.push({
          key,
          kind,
          reason: 'No positive configured tariff/fallback rate'
        });
        continue;
      }

      const posted = await createDailyCharge({
        admission,
        key,
        kind,
        rate: rates[kind],
        description: labels[kind],
        segment,
        bed,
        user
      });

      result.charges.push(posted.charge);

      if (posted.alreadyExists) {
        result.existing += 1;
      } else {
        result.created += 1;
      }
    }

    result.processedDays += 1;
  }

  return result;
}

// ============================================
// Run Daily Charge Catchup
// ============================================

async function runDailyChargeCatchup({
  hospitalId = null,
  throughDate = new Date(),
  fromDate = null,
  user = null,
  limit = 500
} = {}) {
  const filter = { status: { $in: ACTIVE_IPD_STATUSES } };

  const normalizedHospitalId = hospitalId ? normalizeObjectId(hospitalId) : null;

  if (hospitalId && !normalizedHospitalId) {
    const error = new Error('A valid hospital ObjectId is required for daily-charge catch-up');
    error.statusCode = 400;
    error.code = 'INVALID_HOSPITAL_ID';
    throw error;
  }

  if (normalizedHospitalId) {
    filter.hospitalId = normalizedHospitalId;
  }

  const admissions = await IPDAdmission
    .find(filter)
    .sort({ admissionDate: 1 })
    .limit(Number(limit || 500))
    .select('_id hospitalId')
    .lean();

  const summary = {
    admissions: admissions.length,
    created: 0,
    existing: 0,
    skipped: 0,
    errors: []
  };

  for (const admission of admissions) {
    try {
      const result = await ensureAdmissionDailyCharges(
        admission._id,
        throughDate,
        user,
        { fromDate }
      );

      summary.created += result.created;
      summary.existing += result.existing;
      summary.skipped += result.skipped.length;
    } catch (error) {
      summary.errors.push({
        admissionId: admission._id,
        error: error.message
      });
    }
  }

  return summary;
}

module.exports = {
  ACTIVE_IPD_STATUSES,
  DEFAULT_TIME_ZONE,
  dateKeyInTimeZone,
  dateKeysBetween,
  segmentForDate,
  ensureAdmissionDailyCharges,
  runDailyChargeCatchup
};