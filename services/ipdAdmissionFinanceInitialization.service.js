'use strict';

const IPDAdmission = require('../models/IPDAdmission');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const { operationNow } = require('../utils/operationTimeContext');
const { hospitalIdFromUser } = require('./tenantScope.service');
const { ensureAdmissionDailyCharges } = require('./ipdRecurringCharge.service');
const { resolveFinancialPolicy } = require('./financialPolicy.service');
const ipdFinancial = require('./ipdFinancial.service');

function normalizeAmount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

async function scopedAdmission(admissionId, user) {
  const hospitalId = hospitalIdFromUser(user);
  const query = { _id: admissionId };
  if (hospitalId) query.hospitalId = hospitalId;
  const admission = await IPDAdmission.findOne(query);
  if (!admission) {
    const error = new Error('Admission not found');
    error.statusCode = 404;
    throw error;
  }
  return admission;
}

async function markPending(admission, user, inputs, { isRetry = false } = {}) {
  const prior = admission.financeInitialization?.toObject?.() || admission.financeInitialization || {};
  admission.financeInitialization = {
    ...prior,
    status: 'pending',
    requestedCollection: normalizeAmount(inputs.requestedCollection ?? prior.requestedCollection),
    requestedDeposit: normalizeAmount(inputs.requestedDeposit ?? prior.requestedDeposit),
    paymentMethod: inputs.paymentMethod || prior.paymentMethod || 'Cash',
    selectedMode: inputs.selectedMode || prior.selectedMode || admission.selectedBillingMode || undefined,
    payerCategory: inputs.payerCategory || prior.payerCategory || undefined,
    billingModeOverrideReason: inputs.billingModeOverrideReason ?? prior.billingModeOverrideReason,
    retryCount: Number(prior.retryCount || 0) + (isRetry ? 1 : 0),
    lastAttemptAt: operationNow(),
    completedAt: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    lastAttemptBy: user?._id
  };
  await admission.save({ validateBeforeSave: false });
}

async function processInitialFinance(admissionId, user, inputs = {}, { isRetry = false } = {}) {
  const admission = await scopedAdmission(admissionId, user);
  const stored = admission.financeInitialization?.toObject?.() || admission.financeInitialization || {};
  const merged = {
    requestedCollection: normalizeAmount(inputs.requestedCollection ?? stored.requestedCollection),
    requestedDeposit: normalizeAmount(inputs.requestedDeposit ?? stored.requestedDeposit),
    paymentMethod: inputs.paymentMethod || stored.paymentMethod || 'Cash',
    selectedMode: inputs.selectedMode || stored.selectedMode || admission.selectedBillingMode,
    payerCategory: inputs.payerCategory || stored.payerCategory,
    billingModeOverrideReason: inputs.billingModeOverrideReason ?? stored.billingModeOverrideReason
  };
  await markPending(admission, user, merged, { isRetry });

  try {
    // Catch-up is part of the resumable finance bootstrap. It is idempotent and
    // guarantees the policy/invoice sees the complete admission-day charge set.
    await ensureAdmissionDailyCharges(admission._id, operationNow(), user);
    const financials = await ipdFinancial.calculateAdmissionFinancials(admission._id, { user });
    const coverage = await AdmissionCoverage.findOne({
      hospitalId: admission.hospitalId,
      admissionId: admission._id,
      encounterType: 'IPD',
      active: true
    }).sort({ createdAt: -1 }).lean();

    const aggregatePolicy = await resolveFinancialPolicy({
      hospitalId: admission.hospitalId,
      user,
      encounterType: 'IPD',
      serviceType: 'ADMISSION',
      serviceCode: 'IPD-ADM',
      payerCategory: merged.payerCategory || coverage?.payerCategory || 'SELF',
      departmentId: admission.departmentId,
      selectedMode: merged.selectedMode || admission.selectedBillingMode,
      requestedDeposit: merged.requestedDeposit,
      patientLiability: financials.patientLiabilityTotal,
      sponsorLiability: financials.sponsorLiabilityTotal,
      contractedAmount: financials.totalChargeAmount,
      adjustments: {},
      overrideReason: merged.billingModeOverrideReason
    });

    admission.requiredNowAmount = Number(aggregatePolicy.requiredNow || 0);
    admission.financialPolicySnapshot = aggregatePolicy.policySnapshot;
    admission.selectedBillingMode = aggregatePolicy.selectedMode || admission.selectedBillingMode;
    await admission.save({ validateBeforeSave: false });

    let issuedInvoice = null;
    let payment = null;
    let advanceReceipt = null;
    if (Number(aggregatePolicy.requiredNow || 0) > 0 || merged.requestedCollection > 0) {
      const invoiceResult = await ipdFinancial.issueIPDInvoice(admission._id, {
        invoiceKind: 'interim',
        idempotencyKey: `admission:${admission._id}:initial-invoice`,
        notes: `Initial IPD liability for ${admission.admissionNumber}`
      }, user);
      issuedInvoice = invoiceResult.invoice;

      // Freeze the admission-time collection allocation before mutating money.
      // On retry, never infer "excess" from the invoice's *current* balance:
      // a previous initial-payment transaction may already have committed even
      // if a later stage failed. Recomputing from balance_due in that situation
      // would incorrectly turn the already-applied payment into a new advance.
      const planOwner = await IPDAdmission.findById(admission._id);
      const priorPlan = planOwner?.financeInitialization?.toObject?.() || planOwner?.financeInitialization || {};
      const sameInvoice = priorPlan.initialInvoiceId && String(priorPlan.initialInvoiceId) === String(issuedInvoice._id);
      const hasStoredPlan = sameInvoice && Number.isFinite(Number(priorPlan.plannedInvoiceCollection)) && Number.isFinite(Number(priorPlan.plannedAdvanceAmount));
      let applyToInvoice;
      let excess;
      if (hasStoredPlan) {
        applyToInvoice = normalizeAmount(priorPlan.plannedInvoiceCollection);
        excess = normalizeAmount(priorPlan.plannedAdvanceAmount);
      } else {
        const invoiceOutstandingAtPlan = normalizeAmount(issuedInvoice?.balance_due);
        applyToInvoice = Math.min(merged.requestedCollection, invoiceOutstandingAtPlan);
        excess = Math.max(0, merged.requestedCollection - applyToInvoice);
        if (!planOwner) throw new Error('Admission not found while persisting initial finance allocation');
        planOwner.financeInitialization = {
          ...priorPlan,
          initialInvoiceId: issuedInvoice._id,
          plannedInvoiceCollection: applyToInvoice,
          plannedAdvanceAmount: excess
        };
        await planOwner.save({ validateBeforeSave: false });
      }

      // Always call the original idempotent stage with the stored planned
      // amount. If it committed previously, the financial service returns the
      // existing transaction rather than charging again.
      if (applyToInvoice > 0) {
        payment = await ipdFinancial.recordIPDPayment(admission._id, {
          invoiceId: issuedInvoice._id,
          amount: applyToInvoice,
          paymentMethod: merged.paymentMethod,
          idempotencyKey: `admission:${admission._id}:initial-payment`,
          sourceModule: 'Admission',
          sourceId: admission._id
        }, user);
      }
      if (excess > 0) {
        advanceReceipt = await ipdFinancial.recordAdvance(admission._id, {
          amount: excess,
          paymentMethod: merged.paymentMethod,
          idempotencyKey: `admission:${admission._id}:initial-advance`,
          notes: `Excess collection retained as IPD advance - ${admission.admissionNumber}`
        }, user);
      }
    }

    const refreshed = await ipdFinancial.calculateAdmissionFinancials(admission._id, { user });
    const satisfiedNow = Number(refreshed.invoicePaid || 0) + Number(refreshed.advanceAvailable || 0);
    const clearanceState = aggregatePolicy.selectedMode === 'TPA_SPONSOR'
      ? aggregatePolicy.clearanceState
      : ['POSTPAID', 'AUTHORIZED_EXCEPTION'].includes(aggregatePolicy.selectedMode)
        ? aggregatePolicy.clearanceState
        : satisfiedNow + 0.01 >= Number(aggregatePolicy.requiredNow || 0) ? 'CLEARED' : 'PAYMENT_REQUIRED';

    const current = await IPDAdmission.findById(admission._id);
    current.financeInitialization = {
      ...(current.financeInitialization?.toObject?.() || current.financeInitialization || {}),
      status: 'ready',
      completedAt: operationNow(),
      errorCode: undefined,
      errorMessage: undefined,
      lastAttemptBy: user?._id
    };
    await current.save({ validateBeforeSave: false });

    return {
      pending: false,
      policy: aggregatePolicy,
      issuedInvoice,
      payment,
      advanceReceipt,
      requestedCollection: merged.requestedCollection,
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
  } catch (error) {
    const current = await IPDAdmission.findById(admission._id);
    if (current) {
      current.financeInitialization = {
        ...(current.financeInitialization?.toObject?.() || current.financeInitialization || {}),
        status: 'pending',
        errorCode: error.code || 'INITIAL_FINANCE_PENDING',
        errorMessage: String(error.message || 'Initial finance processing failed').slice(0, 1000),
        lastAttemptAt: operationNow(),
        lastAttemptBy: user?._id
      };
      await current.save({ validateBeforeSave: false });
    }
    return {
      pending: true,
      code: error.code || 'INITIAL_FINANCE_PENDING',
      message: error.message
    };
  }
}

module.exports = { processInitialFinance };
