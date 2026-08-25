const { operationNow, operationDateKey } = require('../utils/operationTimeContext');
const { hospitalDayBounds } = require('../utils/hospitalDateTime');
const { semanticDateRange } = require('../utils/hospitalDateRange');
const IPDAdmission = require('../models/IPDAdmission');
const Bed = require('../models/Bed');
const Ward = require('../models/Ward');
const Room = require('../models/Room');
const Patient = require('../models/Patient');
const IPDCharge = require('../models/IPDCharge');
const IPDRound = require('../models/IPDRound');
const LabReport = require('../models/LabReport');
const NursingNote = require('../models/NursingNote');
const IPDVitals = require('../models/IPDVitals');
const DischargeSummary = require('../models/DischargeSummary');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const ProcedureRequest = require('../models/ProcedureRequest');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const moment = require('moment');
const mongoose = require('mongoose');
const { checkModuleAccess, _hasActionPermission } = require('../middlewares/auth');

// Consolidated implementation support
const { requireHospitalId: requireAdmissionHospitalId } = require('../services/tenantScope.service');
const Payer2026 = require('../models/Payer');
const AdmissionCoverage2026 = require('../models/AdmissionCoverage');
const IPDBedTransfer2026 = require('../models/IPDBedTransfer');
const IPDAccommodationSegment2026 = require('../models/IPDAccommodationSegment');
const {
  createCoverage: createAdmissionCoverage2026,
  activeCoverage: activeAdmissionCoverage2026
} = require('../services/coverage.service');
const { quotePricing: quoteAdmissionPricing2026 } = require('../services/pricingEngine.service');
const { buildPatientFileDto: buildPatientFileDto2026 } = require('../services/ipdPatientFileDto.service');
const { assertPatientReadyForContext } = require('../services/patientRegistration.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { bedOccupancyData } = require('../services/ipdAccommodationPrint.service');
const { DAILY_TARIFF_CODES, wardEntitlementFrom } = require('../services/hospitalTariff.service');
const { dateKeyInTimeZone, ensureAdmissionDailyCharges } = require('../services/ipdRecurringCharge.service');
const HospitalCharges2026 = require('../models/HospitalCharges');
const { resolveFinancialPolicy: resolveAdmissionFinancialPolicy2026 } = require('../services/financialPolicy.service');
const ipdFinancial2026 = require('../services/ipdFinancial.service');

function activeAdmissionFilter2026() {
  return {
    $in: [
      'Admitted',
      'Under Treatment',
      'Discharge Initiated',
      'Discharge Summary Pending',
      'Billing Pending',
      'Payment Pending',
      'Ready for Discharge'
    ]
  };
}

function normalizedPricingSnapshot2026(quote) {
  return {
    rateCardId: quote.rateCard?.id,
    rateCardVersion: quote.rateCard?.version,
    rateCardItemId: quote.rateCardItemId,
    serviceCode: quote.serviceCode,
    packageCode: quote.packageCode,
    inputs: quote.inputs,
    amounts: quote.amounts,
    explanation: quote.explanation,
    ruleTrace: quote.ruleTrace,
    pricedAt: operationNow()
  };
}

async function quoteWithStandardFallback2026(input) {
  try {
    return await quoteAdmissionPricing2026(input);
  } catch (error) {
    const total = Number(input.standardAmount ?? input.rate ?? 0) * Number(input.quantity || 1);
    return {
      serviceCode: input.externalCode || null,
      rateCard: null,
      inputs: {
        payer: 'PENDING_MAPPING',
        serviceDate: input.serviceDate || operationNow(),
        fallbackReason: error.message
      },
      amounts: {
        hospitalStandard: total,
        contracted: total,
        patientLiability: total,
        sponsorLiability: 0,
        nonAdmissible: 0,
        hospitalAdjustment: 0
      },
      explanation: ['Standard hospital amount used while payer mapping is pending'],
      ruleTrace: []
    };
  }
}

async function ensureSelfPayer2026(hospitalId, userId, session) {
  let payer = await Payer2026.findOne({ hospitalId, code: 'SELF' }).session(session || null);

  if (!payer) {
    [payer] = await Payer2026.create([{
      hospitalId,
      code: 'SELF',
      name: 'Self Pay',
      type: 'self',
      empanelment: { status: 'not_required' },
      isActive: true,
      createdBy: userId,
      updatedBy: userId
    }], { session });
  }

  return payer;
}

async function createInitialCharge2026({
  hospitalId,
  admission,
  chargeType,
  description,
  rate,
  sourceModule,
  sourceId,
  addedBy,
  coverage,
  serviceType,
  internalServiceModel,
  internalServiceId,
  externalCode,
  wardEntitlement,
  serviceDate = operationNow(),
  idempotencyKey,
  chargeDateKey,
  session,
  isBilled = false,
  invoiceId,
  user,
  selectedMode,
  adjustments = {},
  requestedDeposit,
  overrideReason
}) {
  const quote = await quoteWithStandardFallback2026({
    hospitalId,
    admissionId: admission._id,
    coverage,
    serviceDate,
    chargeType,
    serviceType,
    internalServiceModel,
    internalServiceId,
    externalCode,
    wardEntitlement,
    standardAmount: Number(rate || 0),
    quantity: 1
  });

  const policy = await resolveAdmissionFinancialPolicy2026({
    hospitalId,
    user,
    encounterType: 'IPD',
    serviceType: serviceType || chargeType,
    serviceCode: quote.serviceCode || externalCode,
    payerCategory: coverage?.payerCategory || coverage?.payerId?.type || 'SELF',
    departmentId: admission.departmentId,
    selectedMode,
    requestedDeposit,
    patientLiability: Number(quote.amounts?.patientLiability || 0),
    sponsorLiability: Number(quote.amounts?.sponsorLiability || 0),
    contractedAmount: Number(quote.amounts?.contracted ?? rate ?? 0),
    adjustments,
    overrideReason
  });

  const amounts = policy.amounts;
  const [charge] = await IPDCharge.create([{
    hospitalId,
    admissionId: admission._id,
    patientId: admission.patientId,
    chargeType,
    description,
    quantity: 1,
    rate: Number(quote.amounts?.contracted ?? rate ?? 0),
    grossAmount: Number(amounts.grossAmount || 0),
    amount: Number(amounts.grossAmount || 0),
    discountType: amounts.discountType,
    discountRate: Number(amounts.discountRate || 0),
    discountAmount: Number(amounts.discountAmount || 0),
    discountReason: amounts.discountReason || undefined,
    taxableAmount: Number(amounts.taxableAmount || 0),
    taxMode: amounts.taxMode,
    taxName: amounts.taxName || undefined,
    taxCode: amounts.taxCode || undefined,
    taxRate: Number(amounts.taxRate || 0),
    taxAmount: Number(amounts.taxAmount || 0),
    taxExemptionReason: amounts.taxExemptionReason || undefined,
    netAmount: Number(amounts.netAmount || 0),
    sourceModule,
    sourceId,
    isAutoGenerated: true,
    isBilled,
    invoiceId,
    addedBy,
    chargeDate: serviceDate,
    chargeDateKey: chargeDateKey || dateKeyInTimeZone(serviceDate),
    idempotencyKey,
    pricingSnapshot: normalizedPricingSnapshot2026(quote),
    patientLiability: Number(amounts.patientLiability || 0),
    sponsorLiability: Number(amounts.sponsorLiability || 0),
    nonAdmissibleAmount: Number(quote.amounts?.nonAdmissible || 0),
    selectedBillingMode: policy.selectedMode,
    financialPolicySnapshot: policy.policySnapshot,
    requiredNowAmount: Number(policy.requiredNow || 0),
    clearanceState: policy.clearanceState
  }], { session });

  return charge;
}

// Legacy raw-fee Paid Bill helpers removed: admission fees are canonical server-priced charges.

// ========== HELPER: Create IPD Charge ==========
async function createIPDCharge({
  admissionId,
  patientId,
  chargeType,
  description,
  quantity,
  rate,
  sourceModule,
  sourceId,
  isAutoGenerated = true,
  isBilled = false,
  invoiceId = null,
  addedBy,
  notes,
  chargeDate = operationNow()
}) {
  const netAmount = (quantity || 1) * (rate || 0);

  const charge = new IPDCharge({
    admissionId,
    patientId,
    chargeType,
    description,
    quantity: quantity || 1,
    rate: rate || 0,
    amount: netAmount,
    netAmount,
    sourceModule,
    sourceId,
    isAutoGenerated,
    isBilled,
    invoiceId,
    addedBy,
    notes,
    chargeDate
  });

  await charge.save();
  return charge;
}

// ========== ADMISSION CRUD ==========

// Create new IPD admission
function normalizeAdmissionSponsorType(value) {
  const raw = String(value || 'self').trim().toLowerCase();
  const direct = new Set(['self', 'ayushman_bharat', 'insurance', 'company_panel', 'government_scheme', 'other']);
  if (direct.has(raw)) return raw;
  if (['private_insurer', 'tpa', 'tpa_managed'].includes(raw)) return 'insurance';
  if (raw === 'corporate') return 'company_panel';
  if (['pmjay'].includes(raw)) return 'ayushman_bharat';
  if (['cghs', 'state_scheme', 'echs', 'esic', 'government_other'].includes(raw)) return 'government_scheme';
  return 'other';
}

exports.createAdmission = async (req, res) => {
  const session = await mongoose.startSession();
  let admission;
  let patient;
  let bed;
  let coverage;
  let configuredRegistrationFee = 0;
  let configuredAdmissionFee = 0;
  const charges = [];

  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const payload = req.body || {};
    const requestedCollectionAtAdmission = Math.max(0, Number(payload.amountPaid ?? payload.paymentAmount ?? 0));
    if (requestedCollectionAtAdmission > 0 && (!checkModuleAccess(req.user, 'billing_finance', 'manage') || !_hasActionPermission(req.user, 'settlement'))) {
      const error = new Error('Admission can be created, but this user is not permitted to collect money. Set collection to ₹0 and hand off to Finance/authorised Front Desk.');
      error.statusCode = 403;
      error.code = 'ADMISSION_COLLECTION_PERMISSION_REQUIRED';
      throw error;
    }

    const requireObjectId = (value, field) => {
      if (!mongoose.isValidObjectId(value)) {
        const error = new Error(`${field} must be a valid ObjectId`);
        error.statusCode = 400;
        error.code = 'INVALID_OBJECT_ID';
        throw error;
      }
    };

    requireObjectId(payload.patientId, 'patientId');
    requireObjectId(payload.primaryDoctorId, 'primaryDoctorId');
    if (payload.departmentId) requireObjectId(payload.departmentId, 'departmentId');
    if (payload.bedId) requireObjectId(payload.bedId, 'bedId');

    await session.withTransaction(async () => {
      patient = await Patient.findOne({ _id: payload.patientId, hospitalId }).session(session);

      if (!patient) {
        const error = new Error('Patient not found in this hospital');
        error.statusCode = 404;
        throw error;
      }

      await assertPatientReadyForContext({
        hospitalId,
        patientId: patient._id,
        context: 'IPD',
        userId: req.user?._id,
        session
      });

      const existing = await IPDAdmission.findOne({
        hospitalId,
        patientId: patient._id,
        status: activeAdmissionFilter2026()
      }).session(session);

      if (existing) {
        const error = new Error(`Patient already has active admission ${existing.admissionNumber}`);
        error.statusCode = 409;
        throw error;
      }

      if (!payload.primaryDoctorId || !(await Doctor.exists({
        _id: payload.primaryDoctorId,
        hospitalId
      }).session(session))) {
        const error = new Error('Primary doctor not found in this hospital');
        error.statusCode = 400;
        throw error;
      }

      if (payload.departmentId && !(await Department.exists({
        _id: payload.departmentId,
        hospitalId
      }).session(session))) {
        const error = new Error('Department not found in this hospital');
        error.statusCode = 400;
        throw error;
      }

      let roomId;
      let wardId;
      let dailyBedCharge = 0;

      if (payload.bedId) {
        bed = await Bed.findOne({
          _id: payload.bedId,
          hospitalId,
          isActive: true,
          status: 'Available'
        }).session(session);

        if (!bed) {
          const error = new Error('Selected bed is not available');
          error.statusCode = 409;
          throw error;
        }

        roomId = bed.roomId;
        wardId = bed.wardId;
        dailyBedCharge = Number(bed.dailyCharge || 0);
      }

      [admission] = await IPDAdmission.create([{
        hospitalId,
        patientId: patient._id,
        admissionType: payload.admissionType,
        departmentId: payload.departmentId,
        primaryDoctorId: payload.primaryDoctorId,
        secondaryDoctorIds: payload.secondaryDoctorIds || [],
        bedId: bed?._id,
        roomId,
        wardId,
        currentLocationEffectiveAt: operationNow(),
        provisionalDiagnosis: payload.provisionalDiagnosis,
        chiefComplaints: payload.chiefComplaints,
        historyOfPresentIllness: payload.historyOfPresentIllness,
        pastMedicalHistory: payload.pastMedicalHistory,
        attendant: payload.attendant,
        paymentType: payload.paymentType,
        insuranceDetails: payload.insuranceDetails,
        sponsorType: normalizeAdmissionSponsorType(payload.coverage?.payerCategory || payload.sponsorType || 'self'),
        sponsorName: payload.sponsorName || undefined,
        advanceAmount: 0,
        advanceReceivedAmount: 0,
        admissionNotes: payload.admissionNotes,
        status: 'Admitted',
        createdBy: req.user?._id,
        updatedBy: req.user?._id,
        pharmacyClearanceStatus: 'pending'
      }], { session });

      if (bed) {
        const occupied = await Bed.findOneAndUpdate(
          {
            _id: bed._id,
            hospitalId,
            status: 'Available',
            currentAdmissionId: { $in: [null, undefined] }
          },
          {
            $set: {
              status: 'Occupied',
              currentAdmissionId: admission._id
            }
          },
          { new: true, session }
        );

        if (!occupied) {
          const error = new Error('Selected bed was assigned by another user');
          error.statusCode = 409;
          throw error;
        }

        bed = occupied;
      }

      const requestedCoverage = payload.coverage || {};
      let payer = requestedCoverage.payerId
        ? await Payer2026.findOne({
          _id: requestedCoverage.payerId,
          hospitalId,
          isActive: true
        }).session(session)
        : null;

      if (!payer) {
        payer = await ensureSelfPayer2026(hospitalId, req.user?._id, session);
      }

      coverage = await createAdmissionCoverage2026({
        req,
        hospitalId,
        admissionId: admission._id,
        payload: {
          ...requestedCoverage,
          payerId: payer._id,
          payerCategory: requestedCoverage.payerCategory || payer.type,
          eligibility: requestedCoverage.eligibility || {
            status: payer.type === 'self' ? 'verified' : 'pending'
          },
          preAuthorisation: requestedCoverage.preAuthorisation || {
            required: false,
            status: 'not_required'
          },
          allowPendingRateCard: requestedCoverage.allowPendingRateCard ?? true
        },
        session
      });


      // F08: registration/admission fee amounts are hospital/master data, never browser authority.
      const hospitalChargeConfig = await HospitalCharges2026.findOne({
        hospital: hospitalId,
        is_active: { $ne: false },
        effectiveFrom: { $lte: operationNow() }
      }).sort({ effectiveFrom: -1, updatedAt: -1 }).session(session).lean();
      configuredRegistrationFee = Math.max(0, Number(hospitalChargeConfig?.ipdCharges?.registrationFee || 0));
      configuredAdmissionFee = Math.max(0, Number(hospitalChargeConfig?.ipdCharges?.admissionFee || 0));
      const requestedSelectedMode = payload.selectedMode || payload.selectedBillingMode || payload.billingMode;
      const financeAdjustments = {
        discountType: payload.discountType,
        discountValue: payload.discountValue,
        discountRate: payload.discountRate,
        discountAmount: payload.discountAmount,
        discountReason: payload.discountReason,
        taxMode: payload.taxMode,
        taxRate: payload.taxRate
      };

      if (bed) {
        const bedQuote = await quoteWithStandardFallback2026({
          hospitalId,
          admissionId: admission._id,
          coverage,
          chargeType: 'Bed',
          serviceType: 'bed',
          internalServiceModel: 'Bed',
          internalServiceId: bed._id,
          externalCode: DAILY_TARIFF_CODES.bed,
          wardEntitlement: wardEntitlementFrom(bed.bedType),
          standardAmount: dailyBedCharge,
          quantity: 1,
          serviceDate: operationNow()
        });

        const [segment] = await IPDAccommodationSegment2026.create([{
          hospitalId,
          admissionId: admission._id,
          patientId: patient._id,
          wardId,
          roomId,
          bedId: bed._id,
          bedType: bed.bedType,
          startedAt: admission.admissionDate || operationNow(),
          pricingSnapshot: bedQuote,
          dailyRate: Number(bedQuote.amounts?.contracted ?? dailyBedCharge),
          createdBy: req.user?._id
        }], { session });

        const initialBedChargeDate = admission.admissionDate || operationNow();
        const initialBedChargeKey = dateKeyInTimeZone(initialBedChargeDate);
        const bedCharge = await createInitialCharge2026({
          hospitalId,
          admission,
          chargeType: 'Bed',
          description: `Bed Charges - ${bed.bedNumber} (${bed.bedType})`,
          rate: dailyBedCharge,
          sourceModule: 'Bed',
          sourceId: bed._id,
          addedBy: req.user?._id,
          coverage,
          serviceType: 'bed',
          internalServiceModel: 'Bed',
          internalServiceId: bed._id,
          externalCode: DAILY_TARIFF_CODES.bed,
          wardEntitlement: wardEntitlementFrom(bed.bedType),
          serviceDate: initialBedChargeDate,
          chargeDateKey: initialBedChargeKey,
          idempotencyKey: `daily:${hospitalId}:${admission._id}:${initialBedChargeKey}:bed`,
          session,
          user: req.user,
          selectedMode: requestedSelectedMode,
          adjustments: financeAdjustments,
          requestedDeposit: payload.requestedDeposit,
          overrideReason: payload.billingModeOverrideReason
        });

        bedCharge.accommodationSegmentId = segment._id;
        await bedCharge.save({ session });
        charges.push(bedCharge);
      }

      if (configuredRegistrationFee > 0) {
        charges.push(await createInitialCharge2026({
          hospitalId,
          admission,
          chargeType: 'Miscellaneous',
          description: `Registration Fee - ${admission.admissionNumber}`,
          rate: configuredRegistrationFee,
          sourceModule: 'Admission',
          sourceId: admission._id,
          addedBy: req.user?._id,
          coverage,
          serviceType: 'REGISTRATION',
          externalCode: 'IPD-REG',
          idempotencyKey: `admission:${admission._id}:registration-fee`,
          session,
          user: req.user,
          selectedMode: requestedSelectedMode,
          adjustments: financeAdjustments,
          requestedDeposit: payload.requestedDeposit,
          overrideReason: payload.billingModeOverrideReason
        }));
      }

      if (configuredAdmissionFee > 0) {
        charges.push(await createInitialCharge2026({
          hospitalId,
          admission,
          chargeType: 'Miscellaneous',
          description: `Admission Fee - ${admission.admissionNumber}`,
          rate: configuredAdmissionFee,
          sourceModule: 'Admission',
          sourceId: admission._id,
          addedBy: req.user?._id,
          coverage,
          serviceType: 'ADMISSION',
          externalCode: 'IPD-ADM',
          idempotencyKey: `admission:${admission._id}:admission-fee`,
          session,
          user: req.user,
          selectedMode: requestedSelectedMode,
          adjustments: financeAdjustments,
          requestedDeposit: payload.requestedDeposit,
          overrideReason: payload.billingModeOverrideReason
        }));
      }

      // Collection/advance is posted after admission commit through canonical IPD finance.
      const advance = 0;

      const patientLiability = charges.reduce(
        (sum, charge) => sum + Number(charge.patientLiability || 0),
        0
      );

      const sponsorLiability = charges.reduce(
        (sum, charge) => sum + Number(charge.sponsorLiability || 0),
        0
      );

      const contractedTotal = charges.reduce(
        (sum, charge) => sum + Number(charge.netAmount || 0),
        0
      );

      const encounterPolicy = await resolveAdmissionFinancialPolicy2026({
        hospitalId,
        user: req.user,
        encounterType: 'IPD',
        serviceType: 'ADMISSION',
        serviceCode: 'IPD-ADM',
        payerCategory: coverage?.payerCategory || payer.type || 'SELF',
        departmentId: admission.departmentId,
        selectedMode: requestedSelectedMode,
        requestedDeposit: payload.requestedDeposit,
        patientLiability,
        sponsorLiability,
        contractedAmount: contractedTotal,
        adjustments: {}, // charge-level tax/discount already applied exactly once
        overrideReason: payload.billingModeOverrideReason
      });

      admission.selectedBillingMode = encounterPolicy.selectedMode;
      admission.financialPolicySnapshot = encounterPolicy.policySnapshot;
      admission.requiredNowAmount = Number(encounterPolicy.requiredNow || 0);
      admission.totalBillAmount = contractedTotal;
      admission.patientReceivable = Math.max(0, patientLiability);
      admission.sponsorReceivable = sponsorLiability;
      admission.paidAmount = 0;
      admission.dueAmount = admission.patientReceivable;
      admission.nonAdmissibleAmount = charges.reduce(
        (sum, charge) => sum + Number(charge.nonAdmissibleAmount || 0),
        0
      );

      await admission.save({ session });

      await Patient.updateOne(
        { _id: patient._id, hospitalId },
        {
          $set: {
            patient_type: 'ipd',
            last_pharmacy_visit: operationNow()
          },
          $addToSet: {
            active_admissions: {
              admission_id: admission._id,
              ship_number: admission.shipNumber,
              registration_number: admission.admissionNumber,
              ward_name: String(wardId || ''),
              bed_number: String(bed?._id || ''),
              doctor_name: String(payload.primaryDoctorId),
              department_name: String(payload.departmentId || ''),
              status: 'active'
            }
          }
        },
        { session }
      );
    });

    // Post the recurring accommodation-day charge set immediately after commit.
    // The idempotency keys reuse the admission-day bed charge above, so this adds
    // Nursing and RMO/Duty Doctor (and any missed back-dated days) without double billing.
    try {
      const dailyCatchup = await ensureAdmissionDailyCharges(admission._id, operationNow(), req.user);
      const createdDaily = dailyCatchup.charges.filter((charge) =>
        charge?.sourceModule === 'RecurringDaily' && !charges.some((existing) => String(existing?._id) === String(charge?._id))
      );
      charges.push(...createdDaily);

      if (createdDaily.length) {
        const activeCharges = await IPDCharge.find({
          hospitalId: admission.hospitalId,
          admissionId: admission._id,
          status: { $nin: ['VOIDED', 'CANCELLED'] }
        }).lean();
        admission.totalBillAmount = activeCharges.reduce((sum, charge) => sum + Number(charge.netAmount ?? charge.amount ?? 0), 0);
        admission.patientReceivable = Math.max(0, activeCharges.reduce((sum, charge) => sum + Number(charge.patientLiability || 0), 0) - Number(admission.paidAmount || 0));
        admission.sponsorReceivable = activeCharges.reduce((sum, charge) => sum + Number(charge.sponsorLiability || 0), 0);
        admission.dueAmount = admission.patientReceivable;
        admission.nonAdmissibleAmount = activeCharges.reduce((sum, charge) => sum + Number(charge.nonAdmissibleAmount || 0), 0);
        await admission.save();
      }
    } catch (dailyChargeError) {
      console.error('IPD recurring charge catch-up after admission failed:', dailyChargeError);
      // Admission remains valid; running-bill/discharge catch-up will retry idempotently.
    }

    // F08: canonical finance stage. The selected policy decides what is due now;
    // one payment method is accepted and payment never defines the tariff.
    let financeStage = null;
    try {
      const financials = await ipdFinancial2026.calculateAdmissionFinancials(admission._id, { user: req.user });
      const aggregatePolicy = await resolveAdmissionFinancialPolicy2026({
        hospitalId: admission.hospitalId,
        user: req.user,
        encounterType: 'IPD',
        serviceType: 'ADMISSION',
        serviceCode: 'IPD-ADM',
        payerCategory: coverage?.payerCategory || 'SELF',
        departmentId: admission.departmentId,
        selectedMode: admission.selectedBillingMode,
        requestedDeposit: req.body.requestedDeposit,
        patientLiability: financials.patientLiabilityTotal,
        sponsorLiability: financials.sponsorLiabilityTotal,
        contractedAmount: financials.totalChargeAmount,
        adjustments: {},
        overrideReason: req.body.billingModeOverrideReason
      });
      admission.requiredNowAmount = Number(aggregatePolicy.requiredNow || 0);
      admission.financialPolicySnapshot = aggregatePolicy.policySnapshot;
      await admission.save();

      const requestedCollection = Math.max(0, Number(req.body.amountPaid ?? req.body.paymentAmount ?? 0));
      const canonicalPaymentMethod = req.body.paymentMethod || 'Cash';
      let issuedInvoice = null;
      let payment = null;
      let advanceReceipt = null;

      if (aggregatePolicy.requiredNow > 0 || requestedCollection > 0) {
        const invoiceResult = await ipdFinancial2026.issueIPDInvoice(admission._id, {
          invoiceKind: 'interim',
          idempotencyKey: `admission:${admission._id}:initial-invoice`,
          notes: `Initial IPD liability for ${admission.admissionNumber}`
        }, req.user);
        issuedInvoice = invoiceResult.invoice;

        const invoiceOutstanding = Number(issuedInvoice?.balance_due || 0);
        const applyToInvoice = Math.min(requestedCollection, invoiceOutstanding);
        if (applyToInvoice > 0) {
          payment = await ipdFinancial2026.recordIPDPayment(admission._id, {
            invoiceId: issuedInvoice._id,
            amount: applyToInvoice,
            paymentMethod: canonicalPaymentMethod,
            idempotencyKey: `admission:${admission._id}:initial-payment`,
            sourceModule: 'Admission',
            sourceId: admission._id
          }, req.user);
        }
        const excess = Math.max(0, requestedCollection - applyToInvoice);
        if (excess > 0) {
          advanceReceipt = await ipdFinancial2026.recordAdvance(admission._id, {
            amount: excess,
            paymentMethod: canonicalPaymentMethod,
            idempotencyKey: `admission:${admission._id}:initial-advance`,
            notes: `Excess collection retained as IPD advance - ${admission.admissionNumber}`
          }, req.user);
        }
      }

      const refreshed = await ipdFinancial2026.calculateAdmissionFinancials(admission._id, { user: req.user });
      const paidTowardLiability = Number(refreshed.invoicePaid || 0);
      const advanceAvailable = Number(refreshed.advanceAvailable || 0);
      const satisfiedNow = paidTowardLiability + advanceAvailable;
      const clearanceState = aggregatePolicy.selectedMode === 'TPA_SPONSOR'
        ? aggregatePolicy.clearanceState
        : aggregatePolicy.selectedMode === 'POSTPAID' || aggregatePolicy.selectedMode === 'AUTHORIZED_EXCEPTION'
          ? aggregatePolicy.clearanceState
          : satisfiedNow + 0.01 >= Number(aggregatePolicy.requiredNow || 0)
            ? 'CLEARED'
            : 'PAYMENT_REQUIRED';

      financeStage = {
        policy: aggregatePolicy,
        issuedInvoice,
        payment,
        advanceReceipt,
        requestedCollection,
        satisfiedNow,
        clearanceState,
        financials: {
          patientLiability: refreshed.patientLiabilityTotal,
          sponsorLiability: refreshed.sponsorLiabilityTotal,
          paid: refreshed.invoicePaid,
          advanceAvailable: refreshed.advanceAvailable,
          outstanding: refreshed.patientReceivable
        }
      };
    } catch (financialError) {
      // Admission/bed assignment is already committed. Return a resumable finance
      // state rather than fabricating a Paid bill or recreating the admission.
      console.error('Initial IPD finance stage failed after admission commit:', financialError);
      financeStage = {
        pending: true,
        code: financialError.code || 'INITIAL_FINANCE_PENDING',
        message: financialError.message
      };
    }

    const populated = await IPDAdmission
      .findOne({ _id: admission._id, hospitalId: admission.hospitalId })
      .populate('patientId primaryDoctorId departmentId bedId wardId roomId');

    await appendDomainEvent({
      req,
      eventType: 'ipd.admission.created',
      entityType: 'IPDAdmission',
      entityId: admission._id,
      hospitalId: admission.hospitalId,
      patientId: patient._id,
      encounterId: admission._id,
      afterSummary: {
        admissionNumber: admission.admissionNumber,
        status: admission.status,
        bedId: admission.bedId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Patient admitted successfully',
      admission: populated,
      coverage,
      charges,
      financeStage,
      authoritativeFees: {
        registrationFee: configuredRegistrationFee,
        admissionFee: configuredAdmissionFee
      }
    });
  } catch (error) {
    console.error('Tenant admission creation failed:', error);
    const statusCode = error.statusCode || (error.code === 11000 ? 409 : 500);
    return res.status(statusCode).json({ error: error.message });
  } finally {
    await session.endSession();
  }
};

// Get admission by ID (enhanced with invoice data)
exports.getAdmissionById = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const { id } = req.params;

    const admission = await IPDAdmission
      .findOne({ _id: id, hospitalId })
      .populate('patientId', 'first_name last_name patientId uhid phone dob gender blood_group sponsor_type sponsor_name')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('secondaryDoctorIds', 'firstName lastName specialization')
      .populate('departmentId', 'name')
      .populate('bedId', 'bedNumber bedType dailyCharge status')
      .populate('roomId', 'room_number type')
      .populate('wardId', 'name floor type');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const canViewFinancial = checkModuleAccess(req.user, 'billing_finance', 'view');
    const [coverage, transfers, accommodationSegments, rounds, nursingNotes, vitals, charges, dischargeSummary, invoices, bills] = await Promise.all([
      activeAdmissionCoverage2026(hospitalId, admission._id),
      IPDBedTransfer2026.find({ hospitalId, admissionId: admission._id })
        .populate('from.wardId from.roomId from.bedId to.wardId to.roomId to.bedId')
        .populate('people.requestedBy people.approvedBy people.releasedBy people.receivedBy people.completedBy', 'name role')
        .sort({ createdAt: 1 }),
      IPDAccommodationSegment2026.find({ hospitalId, admissionId: admission._id })
        .populate('wardId roomId bedId')
        .sort({ startedAt: 1 }),
      IPDRound.find({ admissionId: admission._id })
        .populate('doctorId', 'firstName lastName')
        .populate('prescriptionId')
        .sort({ roundDateTime: -1 })
        .limit(10),
      NursingNote.find({ admissionId: admission._id })
        .populate('nurseId', 'first_name last_name')
        .sort({ noteDateTime: -1 })
        .limit(20),
      IPDVitals.find({ admissionId: admission._id })
        .populate('recordedBy', 'first_name last_name')
        .sort({ recordedAt: -1 })
        .limit(50),
      canViewFinancial ? IPDCharge.find({ hospitalId, admissionId: admission._id }).sort({ chargeDate: -1 }) : Promise.resolve([]),
      DischargeSummary.findOne({ admissionId: admission._id }),
      canViewFinancial ? Invoice.find({ hospital_id: hospitalId, admission_id: admission._id }).sort({ issue_date: -1 }) : Promise.resolve([]),
      canViewFinancial ? Bill.find({ hospital_id: hospitalId, admission_id: admission._id }).sort({ generated_at: -1 }) : Promise.resolve([])
    ]);

    return res.json(buildPatientFileDto2026({
      user: req.user,
      admission,
      coverage,
      transfers,
      accommodationSegments,
      rounds,
      nursingNotes,
      vitals,
      charges,
      dischargeSummary,
      invoices,
      bills
    }));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Get admission invoice by ID (for printing receipt)
exports.getAdmissionInvoice = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);

    const invoice = await Invoice
      .findOne({
        _id: req.params.invoiceId,
        admission_id: req.params.admissionId,
        hospital_id: hospitalId
      })
      .populate('patient_id', 'first_name last_name patientId phone address')
      .populate('admission_id', 'admissionNumber admissionDate bedId wardId');

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const hospital = await Hospital.findById(hospitalId);

    return res.json({
      success: true,
      invoice,
      hospital: {
        name: hospital?.hospitalName || hospital?.name,
        address: hospital?.address || '',
        phone: hospital?.contact || '',
        email: hospital?.email || '',
        logo: hospital?.logo || ''
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// Get all admissions with filters
exports.getAllAdmissions = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const {
      page = 1,
      limit = 20,
      status,
      patientId,
      doctorId,
      startDate,
      endDate,
      search,
      clinicalAssessmentCompleted,
      pharmacyClearanceStatus
    } = req.query;

    const filter = { hospitalId, is_active: { $ne: false } };

    if (status) {
      const rows = String(status).split(',').map((value) => value.trim());
      filter.status = rows.length === 1 ? rows[0] : { $in: rows };
    }

    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.primaryDoctorId = doctorId;
    if (clinicalAssessmentCompleted !== undefined) {
      filter.clinicalAssessmentCompleted = clinicalAssessmentCompleted === 'true';
    }
    if (pharmacyClearanceStatus) {
      filter.pharmacyClearanceStatus = pharmacyClearanceStatus;
    }

    if (startDate || endDate) {
      filter.admissionDate = semanticDateRange(startDate, endDate);
    }

    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const patients = await Patient.find({
        hospitalId,
        $or: [
          { first_name: regex },
          { last_name: regex },
          { patientId: regex },
          { phone: regex },
          { uhid: regex }
        ]
      }).select('_id');

      filter.$or = [
        { admissionNumber: regex },
        { shipNumber: regex },
        { patientId: { $in: patients.map((row) => row._id) } }
      ];
    }

    const [admissions, total] = await Promise.all([
      IPDAdmission.find(filter)
        .populate('patientId', 'first_name last_name patientId uhid phone dob gender')
        .populate('primaryDoctorId', 'firstName lastName specialization')
        .populate('departmentId', 'name')
        .populate('bedId', 'bedNumber bedType dailyCharge status')
        .populate('roomId', 'room_number type')
        .populate('wardId', 'name')
        .sort({ admissionDate: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit)),
      IPDAdmission.countDocuments(filter)
    ]);

    return res.json({
      admissions,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
        totalAdmissions: total,
        limit: Number(limit)
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// Update admission
exports.updateAdmission = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);

    const protectedFields = new Set([
      'hospitalId',
      'patientId',
      'coverageId',
      'patientReceivable',
      'sponsorReceivable',
      'sponsorPaidAmount',
      'dueAmount',
      'totalBillAmount',
      'paidAmount',
      'wardId',
      'roomId',
      'bedId'
    ]);

    const updates = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => !protectedFields.has(key))
    );

    const admission = await IPDAdmission.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { $set: { ...updates, updatedBy: req.user?._id } },
      { new: true, runValidators: true }
    );

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    return res.json({
      success: true,
      message: 'Admission updated successfully',
      admission
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Complete clinical assessment
exports.completeClinicalAssessment = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);

    const admission = await IPDAdmission.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (admission.clinicalAssessmentCompleted) {
      return res.status(409).json({
        error: 'Clinical assessment already completed'
      });
    }

    const fields = [
      'provisionalDiagnosis',
      'chiefComplaints',
      'historyOfPresentIllness',
      'pastMedicalHistory'
    ];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        admission[field] = req.body[field];
      }
    }

    admission.clinicalAssessmentCompleted = true;
    admission.clinicalAssessmentCompletedAt = operationNow();
    admission.clinicalAssessmentCompletedBy = req.user?._id;
    admission.updatedBy = req.user?._id;

    await admission.save();

    if (
      req.body.temperature ||
      req.body.pulse ||
      req.body.bloodPressure?.systolic ||
      req.body.respiratoryRate ||
      req.body.spo2
    ) {
      await IPDVitals.create({
        admissionId: admission._id,
        patientId: admission.patientId,
        recordedBy: req.user?._id,
        recordedAt: operationNow(),
        temperature: req.body.temperature,
        temperatureUnit: req.body.temperatureUnit || 'Celsius',
        pulse: req.body.pulse,
        bloodPressure: req.body.bloodPressure,
        respiratoryRate: req.body.respiratoryRate,
        spo2: req.body.spo2,
        bloodSugar: req.body.bloodSugar,
        weight: req.body.weight,
        height: req.body.height,
        painScore: req.body.painScore,
        remarks: req.body.remarks || 'Initial assessment vitals'
      });
    }

    await NursingNote.create({
      admissionId: admission._id,
      patientId: admission.patientId,
      nurseId: req.user?._id,
      noteType: 'Assessment',
      note: `Initial clinical assessment completed.${req.body.chiefComplaints ? ` Chief complaints: ${req.body.chiefComplaints}` : ''}`,
      priority: 'Normal',
      createdBy: req.user?._id
    });

    return res.json({
      success: true,
      message: 'Clinical assessment completed successfully',
      admission
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Get nurse dashboard data
exports.getNurseDashboardData = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);

    const base = {
      hospitalId,
      status: { $in: ['Admitted', 'Under Treatment'] }
    };

    const populate = (query) => query
      .populate('patientId', 'first_name last_name patientId uhid phone dob gender')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('bedId', 'bedNumber bedType')
      .populate('wardId', 'name')
      .sort({ admissionDate: -1 });

    const [pendingAssessments, assignedPatients] = await Promise.all([
      populate(IPDAdmission.find({
        ...base,
        clinicalAssessmentCompleted: false
      })),
      populate(IPDAdmission.find({
        ...base,
        clinicalAssessmentCompleted: true
      }))
    ]);

    return res.json({
      success: true,
      pendingAssessments,
      assignedPatients,
      counts: {
        pending: pendingAssessments.length,
        assigned: assignedPatients.length
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Update admission status
exports.updateAdmissionStatus = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const { status, reason } = req.body;

    const admission = await IPDAdmission.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (status === 'Discharged') {
      return res.status(409).json({
        error: 'Direct status transition to Discharged is disabled. Use the canonical Final Discharge action after all configured clearances are complete.',
        code: 'FINAL_DISCHARGE_ENDPOINT_REQUIRED'
      });
    }

    const transitions = {
      'Admitted': ['Under Treatment', 'Discharge Initiated'],
      'Under Treatment': ['Discharge Initiated', 'Discharge Summary Pending'],
      'Discharge Initiated': ['Discharge Summary Pending', 'Admitted'],
      'Discharge Summary Pending': ['Billing Pending', 'Under Treatment'],
      'Billing Pending': ['Payment Pending', 'Discharge Summary Pending'],
      'Payment Pending': ['Ready for Discharge', 'Billing Pending'],
      'Ready for Discharge': ['Payment Pending'],
      'Discharged': []
    };

    if (!(transitions[admission.status] || []).includes(status)) {
      return res.status(409).json({
        error: `Invalid status transition from ${admission.status} to ${status}`
      });
    }

    admission.status = status;
    admission.updatedBy = req.user?._id;

    if (status === 'Discharged') {
      admission.dischargeDate = admission.dischargeDate || operationNow();

      await IPDAccommodationSegment2026.updateMany(
        {
          hospitalId,
          admissionId: admission._id,
          status: 'active'
        },
        {
          $set: {
            status: 'closed',
            endedAt: admission.dischargeDate
          }
        }
      );

      if (admission.bedId) {
        await Bed.updateOne(
          {
            _id: admission.bedId,
            hospitalId,
            currentAdmissionId: admission._id
          },
          {
            $set: {
              status: 'Cleaning',
              currentAdmissionId: null,
              reservedTransferId: null
            }
          }
        );
      }

      await Patient.updateOne(
        { _id: admission.patientId, hospitalId },
        {
          $pull: { active_admissions: { admission_id: admission._id } },
          $set: { patient_type: 'opd' }
        }
      );
    }

    if (reason) {
      admission.dischargeReason = reason;
    }

    await admission.save();

    await appendDomainEvent({
      req,
      eventType: 'ipd.admission.status_changed',
      entityType: 'IPDAdmission',
      entityId: admission._id,
      hospitalId,
      patientId: admission.patientId,
      encounterId: admission._id,
      afterSummary: { status: admission.status, dischargeDate: admission.dischargeDate },
      reasonCode: reason || undefined
    });

    return res.json({
      success: true,
      message: `Admission status updated to ${status}`,
      admission
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Delete admission (cancellation)
exports.deleteAdmission = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);

    const admission = await IPDAdmission.findOne({
      _id: req.params.id,
      hospitalId,
      is_active: { $ne: false }
    });

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (!['Admitted', 'Under Treatment'].includes(admission.status)) {
      return res.status(409).json({
        error: 'Cannot cancel admission after discharge workflow has progressed'
      });
    }

    const reason = String(req.body?.reason || 'Admission cancelled by user').trim();
    admission.status = 'Cancelled';
    admission.is_active = false;
    admission.deleted_at = operationNow();
    admission.deleted_by = req.user?._id || null;
    admission.deletion_reason = reason;
    admission.updatedBy = req.user?._id;
    await admission.save();

    await Promise.all([
      admission.bedId
        ? Bed.updateOne(
          {
            _id: admission.bedId,
            hospitalId,
            currentAdmissionId: admission._id
          },
          {
            $set: {
              status: 'Available',
              currentAdmissionId: null,
              reservedTransferId: null
            }
          }
        )
        : null,
      IPDAccommodationSegment2026.updateMany(
        {
          hospitalId,
          admissionId: admission._id,
          status: 'active'
        },
        {
          $set: {
            status: 'voided',
            endedAt: operationNow()
          }
        }
      ),
      Patient.updateOne(
        { _id: admission.patientId, hospitalId },
        {
          $pull: { active_admissions: { admission_id: admission._id } },
          $set: { patient_type: 'opd' }
        }
      )
    ]);

    return res.json({
      success: true,
      message: 'Admission cancelled successfully'
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Get dashboard statistics
exports.getDashboardStats = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const { start: today, end: tomorrow } = hospitalDayBounds(operationDateKey());

    const [
      totalAdmitted,
      pendingClinicalAssessment,
      dischargeInitiated,
      dischargedToday,
      occupiedBeds,
      availableBeds,
      reservedBeds,
      cleaningBeds
    ] = await Promise.all([
      IPDAdmission.countDocuments({
        hospitalId,
        status: { $in: ['Admitted', 'Under Treatment'] }
      }),
      IPDAdmission.countDocuments({
        hospitalId,
        clinicalAssessmentCompleted: false,
        status: { $in: ['Admitted', 'Under Treatment'] }
      }),
      IPDAdmission.countDocuments({
        hospitalId,
        status: {
          $in: [
            'Discharge Initiated',
            'Discharge Summary Pending',
            'Billing Pending',
            'Payment Pending',
            'Ready for Discharge'
          ]
        }
      }),
      IPDAdmission.countDocuments({
        hospitalId,
        status: 'Discharged',
        dischargeDate: { $gte: today, $lt: tomorrow }
      }),
      Bed.countDocuments({ hospitalId, status: 'Occupied' }),
      Bed.countDocuments({ hospitalId, status: 'Available' }),
      Bed.countDocuments({ hospitalId, status: 'Reserved' }),
      Bed.countDocuments({ hospitalId, status: 'Cleaning' })
    ]);

    return res.json({
      success: true,
      stats: {
        totalAdmitted,
        pendingClinicalAssessment,
        dischargeInitiated,
        dischargedToday,
        occupiedBeds,
        availableBeds,
        reservedBeds,
        cleaningBeds
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};


// Dashboard analytics must be declared as concrete routes before /admissions/:id.
// These endpoints are tenant-scoped and intentionally return a small, stable DTO
// consumed by the staff IPD dashboard.
exports.getAdmissionStatsByDoctor = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const grouped = await IPDAdmission.aggregate([
      {
        $match: {
          hospitalId: new mongoose.Types.ObjectId(String(hospitalId)),
          status: activeAdmissionFilter2026()
        }
      },
      {
        $group: {
          _id: '$primaryDoctorId',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const doctorIds = grouped.map((row) => row._id).filter(Boolean);
    const doctors = doctorIds.length
      ? await Doctor.find({
        _id: { $in: doctorIds },
        hospitalId
      }).select('firstName lastName doctorId specialization').lean()
      : [];

    const doctorMap = new Map(doctors.map((doctor) => [String(doctor._id), doctor]));
    const data = grouped.map((row) => {
      const doctor = row._id ? doctorMap.get(String(row._id)) : null;
      return {
        doctorId: row._id || null,
        doctorCode: doctor?.doctorId || null,
        doctorName: doctor
          ? `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim()
          : 'Unassigned',
        specialization: doctor?.specialization || '',
        count: Number(row.count || 0)
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.getAdmissionStatsByWard = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const grouped = await IPDAdmission.aggregate([
      {
        $match: {
          hospitalId: new mongoose.Types.ObjectId(String(hospitalId)),
          status: activeAdmissionFilter2026()
        }
      },
      {
        $group: {
          _id: '$wardId',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const wardIds = grouped.map((row) => row._id).filter(Boolean);
    const wards = wardIds.length
      ? await Ward.find({
        _id: { $in: wardIds },
        hospitalId
      }).select('name code floor type').lean()
      : [];

    const wardMap = new Map(wards.map((ward) => [String(ward._id), ward]));
    const data = grouped.map((row) => {
      const ward = row._id ? wardMap.get(String(row._id)) : null;
      return {
        wardId: row._id || null,
        wardName: ward?.name || 'Unassigned',
        wardCode: ward?.code || null,
        floor: ward?.floor || '',
        wardType: ward?.type || '',
        count: Number(row.count || 0)
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.getAdmissionTodaySchedule = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const { start, end } = hospitalDayBounds(operationDateKey());

    const [activeAdmissions, dischargedAdmissions] = await Promise.all([
      IPDAdmission.find({
        hospitalId,
        status: activeAdmissionFilter2026()
      })
        .select('_id admissionNumber patientId')
        .populate('patientId', 'first_name last_name patientId uhid')
        .lean(),
      IPDAdmission.find({
        hospitalId,
        dischargeDate: { $gte: start, $lt: end },
        status: { $in: ['Discharged', 'LAMA', 'DAMA', 'Expired'] }
      })
        .select('_id admissionNumber patientId dischargeDate status')
        .populate('patientId', 'first_name last_name patientId uhid')
        .lean()
    ]);

    const admissionMap = new Map(
      [...activeAdmissions, ...dischargedAdmissions].map((admission) => [String(admission._id), admission])
    );
    const activeAdmissionIds = activeAdmissions.map((admission) => admission._id);

    const procedures = activeAdmissionIds.length
      ? await ProcedureRequest.find({
        admissionId: { $in: activeAdmissionIds },
        sourceType: 'IPD',
        scheduledDate: { $gte: start, $lt: end },
        status: { $nin: ['Cancelled', 'Completed'] }
      })
        .select('admissionId procedureName scheduledDate status priority')
        .sort({ scheduledDate: 1 })
        .lean()
      : [];

    const patientName = (admission) => {
      const patient = admission?.patientId;
      if (!patient) return 'Unknown patient';
      return `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || patient.patientId || patient.uhid || 'Unknown patient';
    };

    const procedureEvents = procedures.map((procedure) => {
      const admission = admissionMap.get(String(procedure.admissionId));
      return {
        id: procedure._id,
        type: 'Procedure',
        title: procedure.procedureName || 'Scheduled procedure',
        patientName: patientName(admission),
        admissionNumber: admission?.admissionNumber || '',
        scheduledAt: procedure.scheduledDate,
        status: procedure.status,
        priority: procedure.priority
      };
    });

    const dischargeEvents = dischargedAdmissions.map((admission) => ({
      id: admission._id,
      type: 'Discharge',
      title: `${admission.status || 'Discharge'}${admission.admissionNumber ? ` - ${admission.admissionNumber}` : ''}`,
      patientName: patientName(admission),
      admissionNumber: admission.admissionNumber || '',
      scheduledAt: admission.dischargeDate,
      status: admission.status
    }));

    const data = [...procedureEvents, ...dischargeEvents]
      .sort((left, right) => new Date(left.scheduledAt || 0) - new Date(right.scheduledAt || 0));

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// ========== PHARMACY CLEARANCE METHODS ==========

// Get admission by SHIP number (for pharmacy lookup)
exports.getAdmissionByShipNumber = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);

    const admission = await IPDAdmission
      .findOne({
        hospitalId,
        shipNumber: req.params.shipNumber
      })
      .populate('patientId primaryDoctorId departmentId wardId roomId bedId');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    return res.json({ success: true, admission });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Update pharmacy clearance status
exports.updatePharmacyClearance = async (req, res) => {
  try {
    const { id } = req.params;
    const { clearanceStatus, finalBalance, notes } = req.body;

    const admission = await IPDAdmission.findById(id);

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const validStatuses = ['pending', 'in_progress', 'cleared', 'exempted'];

    if (!validStatuses.includes(clearanceStatus)) {
      return res.status(400).json({ error: 'Invalid clearance status' });
    }

    admission.pharmacyClearanceStatus = clearanceStatus;

    if (finalBalance !== undefined) {
      admission.pharmacyFinalBalance = finalBalance;
    }

    if (clearanceStatus === 'cleared') {
      admission.pharmacyClearanceDate = operationNow();
      admission.pharmacyClearanceBy = req.user?._id;
    }

    await admission.save();

    // Update patient's pharmacy outstanding if final balance is provided
    if (finalBalance !== undefined && admission.patientId) {
      await Patient.findByIdAndUpdate(admission.patientId, {
        pharmacy_outstanding_balance: finalBalance
      });
    }

    res.json({
      success: true,
      message: `Pharmacy clearance status updated to ${clearanceStatus}`,
      admission: {
        _id: admission._id,
        pharmacyClearanceStatus: admission.pharmacyClearanceStatus,
        pharmacyFinalBalance: admission.pharmacyFinalBalance,
        pharmacyClearanceDate: admission.pharmacyClearanceDate
      }
    });
  } catch (err) {
    console.error('Error updating pharmacy clearance:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get admissions pending pharmacy clearance
exports.getPendingPharmacyClearance = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const admissions = await IPDAdmission.find({
      status: {
        $in: [
          'Discharge Initiated',
          'Discharge Summary Pending',
          'Billing Pending',
          'Payment Pending',
          'Ready for Discharge'
        ]
      },
      pharmacyClearanceStatus: { $in: ['pending', 'in_progress'] }
    })
      .populate('patientId', 'first_name last_name patientId uhid phone pharmacy_outstanding_balance pharmacy_advance_balance')
      .populate('primaryDoctorId', 'firstName lastName')
      .populate('wardId', 'name')
      .sort({ admissionDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await IPDAdmission.countDocuments({
      status: {
        $in: [
          'Discharge Initiated',
          'Discharge Summary Pending',
          'Billing Pending',
          'Payment Pending',
          'Ready for Discharge'
        ]
      },
      pharmacyClearanceStatus: { $in: ['pending', 'in_progress'] }
    });

    res.json({
      success: true,
      admissions,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Error fetching pending pharmacy clearance:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getBedOccupancyReport = async (req, res) => {
  try {
    const hospitalId = requireAdmissionHospitalId(req);
    const [data, hospital] = await Promise.all([
      bedOccupancyData({
        hospitalId,
        asOn: req.query.asOn || operationNow()
      }),
      Hospital.findById(hospitalId).select('hospitalName name address city state pinCode contact phone email logo licenseNumber registrationNumber').lean()
    ]);
    res.json({ success: true, ...data, hospital: hospital || null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

