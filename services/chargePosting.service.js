const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const OTRequest = require('../models/OTRequest');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const Prescription = require('../models/Prescription');
const { quotePricing, pricingSnapshot } = require('./pricingEngine.service');
const { activatePackageEpisode, recordPackageUtilization, reversePackageUtilization } = require('./packageAdjudication.service');
const { activeCoverage, activeAppointmentCoverage } = require('./coverage.service');
const { replaceCoverageUtilization, reverseCoverageUtilization } = require('./coverageUtilization.service');
const { syncChargePosted } = require('./sourceBillingSync.service');
const { BILLING_INTENTS, BILLING_STATES } = require('../utils/billingLifecycle');
const { resolveFinancialPolicy } = require('./financialPolicy.service');
const patientFinancial = require('./patientFinancial.service');
const ipdFinancial = require('./ipdFinancial.service');
const { appendBillingLink } = require('./sourceBillingSync.service');
const { hasFeatureAccess } = require('../middlewares/auth');

const SOURCE_CONFIG = {
  LabRequest: {
    Model: LabRequest,
    masterField: 'labTestId',
    codeField: 'testCode',
    nameField: 'testName',
    chargeType: 'Lab Test',
    serviceType: 'laboratory',
    internalServiceModel: 'LabTest',
    Master: LabTest
  },
  RadiologyRequest: {
    Model: RadiologyRequest,
    masterField: 'imagingTestId',
    codeField: 'testCode',
    nameField: 'testName',
    chargeType: 'Radiology',
    serviceType: 'radiology',
    internalServiceModel: 'ImagingTest',
    Master: ImagingTest
  },
  ProcedureRequest: {
    Model: ProcedureRequest,
    masterField: 'procedureId',
    codeField: 'procedureCode',
    nameField: 'procedureName',
    chargeType: 'Procedure',
    serviceType: 'procedure',
    internalServiceModel: 'Procedure',
    Master: Procedure
  },
  OTRequest: {
    Model: OTRequest,
    masterField: 'procedureId',
    codeField: 'procedureCode',
    nameField: 'procedureName',
    chargeType: 'Surgery',
    serviceType: 'operation_theatre',
    internalServiceModel: 'Procedure',
    Master: Procedure
  }
};

function isIPDSourceRequest(request, sourceModule) {
  if (!request?.admissionId) return false;
  return request.sourceType === 'IPD' || sourceModule === 'OTRequest' || String(request.encounterType || '').toUpperCase() === 'IPD';
}

async function resolveOPDAppointmentIdFromRequest(request, hospitalId, session) {
  if (!request || isIPDSourceRequest(request)) return null;
  if (request.appointmentId) return request.appointmentId;
  if (!request.prescriptionId) return null;

  const prescription = await Prescription.findOne({
    _id: request.prescriptionId,
    hospitalId,
    patient_id: request.patientId,
    appointment_id: { $ne: null }
  }, 'appointment_id', opts(session)).lean();
  if (!prescription?.appointment_id) return null;

  // Older OPD clinical requests could be created from a prescription without
  // copying prescription.appointment_id. Repair that encounter linkage once so
  // Lab/Radiology/Procedure finance and the selected-appointment workspace agree.
  request.appointmentId = prescription.appointment_id;
  if (typeof request.save === 'function') await request.save(opts(session));
  return prescription.appointment_id;
}

function canSelectFinancialMode(user) {
  return hasFeatureAccess(user, 'billing_finance', 'manage')
    || hasFeatureAccess(user, 'registration_opd', 'manage')
    || hasFeatureAccess(user, 'ipd', 'manage');
}

function money(v) {
  return Number(Number(v || 0).toFixed(2));
}

function opts(session) {
  return session ? { session } : {};
}

function ensureSourceMasterOrOverride({ request, config, user, overrideReason, preview = false }) {
  if (request?.[config.masterField]) return;
  const { _hasActionPermission } = require('../middlewares/auth');
  if (!_hasActionPermission(user, 'pricing_override')) {
    const error = new Error('This legacy clinical request is not mapped to the hospital service master. Map the service before billing; browser/request cost cannot be used as tariff truth.');
    error.statusCode = 409;
    error.code = 'SOURCE_SERVICE_MASTER_REQUIRED';
    throw error;
  }
  if (!preview && !String(overrideReason || '').trim()) {
    const error = new Error('Pricing override reason is required for an unmapped legacy clinical request');
    error.statusCode = 400;
    error.code = 'PRICING_OVERRIDE_REASON_REQUIRED';
    throw error;
  }
}

async function postIPDSourceCharge({
  sourceModule,
  sourceId,
  billingIntent,
  selectedMode,
  requestedDeposit,
  adjustments = {},
  overrideReason,
  idempotencyKey,
  user,
  session
}) {
  const config = SOURCE_CONFIG[sourceModule];

  if (!config) {
    const e = new Error('Unsupported charge source');
    e.statusCode = 400;
    throw e;
  }

  const request = await config.Model.findOne(
    { _id: sourceId, hospitalId: user.hospital_id },
    null,
    opts(session)
  );

  if (!request) {
    const e = new Error('Source request not found');
    e.statusCode = 404;
    throw e;
  }

  if (!isIPDSourceRequest(request, sourceModule)) {
    const e = new Error('Source request is not linked to an IPD admission');
    e.statusCode = 409;
    throw e;
  }

  const admission = await IPDAdmission.findOne(
    { _id: request.admissionId, hospitalId: user.hospital_id },
    null,
    opts(session)
  );

  if (!admission) {
    const e = new Error('IPD admission not found');
    e.statusCode = 404;
    throw e;
  }

  const master = request[config.masterField]
    ? await config.Master.findOne({ _id: request[config.masterField], hospitalId: admission.hospitalId, is_active: { $ne: false } }, null, opts(session)).lean()
    : null;
  if (request[config.masterField] && !master) {
    const e = new Error('Source service master was not found for this hospital');
    e.statusCode = 409;
    e.code = 'SOURCE_SERVICE_MASTER_INVALID';
    throw e;
  }
  ensureSourceMasterOrOverride({ request, config, user, overrideReason });

  const key = idempotencyKey || `${sourceModule}:${sourceId}:charge`;
  const existing = await IPDCharge.findOne(
    { hospitalId: admission.hospitalId, idempotencyKey: key },
    null,
    opts(session)
  );

  if (existing) {
    const Invoice = require('../models/Invoice');
    const invoice = existing.invoiceId ? await Invoice.findOne({ _id: existing.invoiceId, hospital_id: admission.hospitalId }, null, opts(session)) : null;
    return {
      charge: existing,
      invoice,
      request,
      financialPolicy: {
        selectedMode: existing.selectedBillingMode,
        requiredNow: Number(existing.requiredNowAmount || 0),
        clearanceState: existing.clearanceState,
        policySnapshot: existing.financialPolicySnapshot || {}
      },
      alreadyExists: true
    };
  }

  const standardAmount = Number(
    request.amount ??
    request.cost ??
    request.price ??
    request.totalAmount ??
    0
  );

  const quote = await quotePricing({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
    serviceDate: request.requestedDate || operationNow(),
    chargeType: config.chargeType,
    serviceType: config.serviceType,
    internalServiceModel: config.internalServiceModel,
    internalServiceId: request[config.masterField],
    internalCode: request[config.codeField],
    standardAmount: request[config.masterField] ? undefined : standardAmount,
    quantity: 1
  });

  const coverage = await activeCoverage(admission.hospitalId, admission._id, session);
  const effectiveRequestedMode = canSelectFinancialMode(user) ? selectedMode : undefined;
  const policy = await resolveFinancialPolicy({
    hospitalId: admission.hospitalId, user, encounterType: 'IPD', serviceType: config.serviceType,
    serviceCategory: master?.category, serviceCode: request[config.codeField], payerCategory: coverage?.payerCategory || (coverage ? 'SPONSORED' : 'SELF'),
    departmentId: admission.departmentId, urgency: request.priority || request.urgency, effectiveAt: request.requestedDate || operationNow(),
    selectedMode: effectiveRequestedMode, inheritedMode: admission.selectedBillingMode, requestedDeposit,
    patientLiability: quote.amounts.patientLiability, sponsorLiability: quote.amounts.sponsorLiability,
    contractedAmount: quote.amounts.contracted, adjustments, overrideReason
  });
  const adjusted = policy.amounts;
  quote.amounts = { ...quote.amounts, patientLiability: adjusted.patientLiability, sponsorLiability: adjusted.sponsorLiability,
    hospitalConcession: money(Number(quote.amounts.hospitalConcession || 0) + Number(adjusted.discountAmount || 0)) };

  const charge = new IPDCharge({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
    patientId: request.patientId,
    chargeType: config.chargeType,
    description: request[config.nameField],
    quantity: 1,
    rate: money(adjusted.grossAmount || quote.amounts.contracted),
    discountType: adjusted.discountType,
    discountRate: adjusted.discountRate,
    discountAmount: adjusted.discountAmount,
    discountReason: adjusted.discountReason || undefined,
    taxMode: adjusted.taxMode, taxName: adjusted.taxName, taxCode: adjusted.taxCode,
    taxRate: adjusted.taxRate, taxAmount: adjusted.taxAmount, taxExemptionReason: adjusted.taxExemptionReason || undefined,
    sourceModule,
    sourceId: request._id,
    sourceReference: {
      module: sourceModule,
      documentId: request._id,
      lineKey: 'default'
    },
    idempotencyKey: key,
    addedBy: user._id,
    patientLiability: quote.amounts.patientLiability,
    sponsorLiability: quote.amounts.sponsorLiability,
    nonAdmissibleAmount: quote.amounts.nonAdmissible,
    pricingSnapshot: pricingSnapshot(quote, {
      internalServiceModel: config.internalServiceModel,
      internalServiceId: request[config.masterField]
    }),
    financialPolicySnapshot: policy.policySnapshot,
    selectedBillingMode: policy.selectedMode,
    requiredNowAmount: policy.requiredNow,
    clearanceState: policy.clearanceState
  });

  await charge.save(opts(session));

  await replaceCoverageUtilization({
    coverage,
    quote,
    hospitalId: admission.hospitalId,
    encounterType: 'IPD',
    admissionId: admission._id,
    patientId: request.patientId,
    sourceType: 'IPDCharge',
    sourceId: charge._id,
    internalServiceModel: config.internalServiceModel,
    internalServiceId: request[config.masterField],
    userId: user._id,
    session
  });

  let packageEpisode = null;
  if (coverage && quote.rateCardItemId && quote.packageCode) {
    packageEpisode = await activatePackageEpisode({
      quote, coverage, hospitalId: admission.hospitalId, encounterType: 'IPD', encounterId: admission._id,
      patientId: request.patientId, sourceType: 'IPDCharge', sourceId: charge._id, userId: user._id, session
    });
  }
  if (quote.packageAdjudication) {
    await recordPackageUtilization({
      decision: quote.packageAdjudication,
      input: { serviceType: config.serviceType, internalServiceModel: config.internalServiceModel, internalServiceId: request[config.masterField], internalCode: request[config.codeField], description: request[config.nameField], quantity: 1 },
      quote, sourceType: 'IPDCharge', sourceId: charge._id, session
    });
  }

  // Billing intent is derived from the validated selected mode, not trusted from
  // a browser checkbox. Full/partial IPD prepayment issues an interim invoice
  // for exactly this source charge; postpaid/TPA remain on the running ledger.
  request.billingIntent = policy.billingIntent || request.billingIntent || BILLING_INTENTS.DEFER_TO_ENCOUNTER;

  await syncChargePosted(charge, user._id, session);

  let invoice = null;
  if (policy.billingIntent === BILLING_INTENTS.BILL_NOW) {
    const issued = await ipdFinancial.issueIPDInvoice(admission._id, {
      invoiceKind: 'interim',
      chargeIds: [charge._id],
      idempotencyKey: `${key}:invoice`,
      notes: `${sourceModule} ${sourceId} policy-driven invoice`
    }, user);
    invoice = issued.invoice;
  }

  return { charge, request, invoice, packageEpisode, financialPolicy: policy, alreadyExists: false };
}


async function postSourceCharge({ sourceModule, sourceId, billingIntent, selectedMode, requestedDeposit, adjustments = {}, overrideReason, idempotencyKey, user, session }) {
  const config = SOURCE_CONFIG[sourceModule];
  if (!config) { const e = new Error('Unsupported charge source'); e.statusCode = 400; throw e; }
  const request = await config.Model.findOne({ _id: sourceId, hospitalId: user.hospital_id }, null, opts(session));
  if (!request) { const e = new Error('Source request not found'); e.statusCode = 404; throw e; }

  const resolvedAppointmentId = isIPDSourceRequest(request, sourceModule)
    ? null
    : await resolveOPDAppointmentIdFromRequest(request, user.hospital_id, session);

  // Desk checkout can create the clinical request after the canonical bill/invoice
  // has already been posted, and links those document ids back onto the request.
  // Re-entering the Lab/Radiology/Procedure worklist must therefore reuse those
  // documents instead of trying to create a second charge with a different key.
  if ((request.billIds || []).length || (request.invoiceIds || []).length || request.invoiceId) {
    const existingStatus = await getSourceFinancialStatus({ sourceModule, sourceId, user, session });
    if (existingStatus.bill || existingStatus.invoices.length || existingStatus.charge) {
      let invoice = existingStatus.invoices[existingStatus.invoices.length - 1] || null;
      if (!invoice && existingStatus.bill && !isIPDSourceRequest(request, sourceModule)) {
        const issued = await patientFinancial.issueOPDInvoice(request.patientId, {
          billIds: [existingStatus.bill._id],
          idempotencyKey: `${sourceModule}:${sourceId}:linked-invoice`,
          notes: `${sourceModule} ${sourceId} linked source invoice`
        }, user);
        invoice = issued.invoice;
        await appendBillingLink({
          sourceModule,
          sourceId,
          hospitalId: user.hospital_id,
          billId: existingStatus.bill._id,
          invoiceId: invoice?._id,
          state: invoice ? 'INVOICED' : 'CHARGE_POSTED',
          action: invoice ? 'INVOICE_ISSUED' : 'CHARGE_POSTED',
          actorId: user._id,
          session
        });
      }
      return {
        charge: existingStatus.charge || null,
        bill: existingStatus.bill || null,
        invoice,
        request,
        sourceModule,
        financialPolicy: {
          selectedMode: existingStatus.selectedMode,
          requiredNow: existingStatus.requiredNow,
          clearanceState: existingStatus.clearanceState,
          policySnapshot: existingStatus.policySnapshot || {}
        },
        alreadyExists: true,
        reusedLinkedFinancials: true
      };
    }
  }

  if (isIPDSourceRequest(request, sourceModule)) {
    return postIPDSourceCharge({ sourceModule, sourceId, billingIntent, selectedMode, requestedDeposit, adjustments, overrideReason, idempotencyKey, user, session });
  }
  const normalizedSourceType = String(request.sourceType || '').toUpperCase();
  if (normalizedSourceType === 'OPD' && !resolvedAppointmentId) {
    const e = new Error('This OPD clinical request is missing its appointment link. Open/re-save the source request or use a prescription that belongs to an appointment.');
    e.statusCode = 409;
    e.code = 'SOURCE_APPOINTMENT_REQUIRED';
    throw e;
  }
  const master = request[config.masterField]
    ? await config.Master.findOne({ _id: request[config.masterField], hospitalId: user.hospital_id, is_active: { $ne: false } }, null, opts(session)).lean()
    : null;
  if (request[config.masterField] && !master) {
    const e = new Error('Source service master was not found for this hospital');
    e.statusCode = 409;
    e.code = 'SOURCE_SERVICE_MASTER_INVALID';
    throw e;
  }
  ensureSourceMasterOrOverride({ request, config, user, overrideReason });
  const key = idempotencyKey || `${sourceModule}:${sourceId}:opd-charge`;
  const Appointment = require('../models/Appointment');
  const sourceAppointment = resolvedAppointmentId
    ? await Appointment.findOne({ _id: resolvedAppointmentId, hospital_id: user.hospital_id }, 'selectedBillingMode', opts(session)).lean()
    : null;
  if (resolvedAppointmentId && !sourceAppointment) { const e = new Error('OPD appointment not found'); e.statusCode = 404; throw e; }
  const effectiveRequestedMode = canSelectFinancialMode(user) ? selectedMode : undefined;
  const result = await patientFinancial.addOPDCharge(request.patientId, {
    appointmentId: resolvedAppointmentId || undefined,
    idempotencyKey: key,
    chargeType: config.chargeType,
    serviceType: config.serviceType,
    serviceCategory: master?.category,
    description: request[config.nameField],
    internalServiceModel: config.internalServiceModel,
    internalServiceId: request[config.masterField],
    serviceCode: request[config.codeField],
    quantity: 1,
    rate: request[config.masterField] ? 0 : Number(request.amount ?? request.cost ?? request.price ?? 0),
    selectedMode: effectiveRequestedMode,
    inheritedMode: sourceAppointment?.selectedBillingMode,
    urgency: request.priority || request.urgency,
    effectiveAt: request.requestedDate || operationNow(),
    requestedDeposit,
    discountType: adjustments.discountType,
    discountRate: adjustments.discountRate,
    discountAmount: adjustments.discountAmount,
    discountValue: adjustments.discountValue,
    discountReason: adjustments.discountReason,
    taxMode: adjustments.taxMode,
    taxRate: adjustments.taxRate,
    taxReason: adjustments.taxReason,
    overrideReason,
    sourceModule,
    sourceId: request._id,
    sourceLineKey: `${sourceModule}:${request._id}:default`,
    createdFrom: `${sourceModule}:source-charge`
  }, user);
  const policy = result.financialPolicy;
  let invoice = null;
  // OPD source requests get a canonical pending invoice so full/partial prepay
  // can be collected without recreating the service or tariff in Finance.
  if (result.bill?._id) {
    const issued = await patientFinancial.issueOPDInvoice(request.patientId, {
      billIds: [result.bill._id],
      idempotencyKey: `${key}:invoice`,
      notes: `${sourceModule} ${sourceId} source invoice`
    }, user);
    invoice = issued.invoice;
  }
  await appendBillingLink({
    sourceModule,
    sourceId,
    hospitalId: user.hospital_id,
    billId: result.bill?._id,
    invoiceId: invoice?._id,
    state: invoice ? 'INVOICED' : 'CHARGE_POSTED',
    action: invoice ? 'INVOICE_ISSUED' : 'CHARGE_POSTED',
    actorId: user._id,
    billingIntent: policy?.billingIntent,
    selectedBillingMode: policy?.selectedMode,
    requiredNowAmount: policy?.requiredNow,
    financialClearanceState: policy?.clearanceState,
    financialPolicySnapshot: policy?.policySnapshot,
    pricingSnapshot: result.bill?.items?.[0]?.pricing_snapshot || result.bill?.items?.[0]?.source_snapshot?.pricingSnapshot || {},
    session
  });
  return { ...result, invoice, request, sourceModule, financialPolicy: policy, alreadyExists: result.alreadyExists };
}



async function previewSourceFinancialPolicy({ sourceModule, sourceId, selectedMode, requestedDeposit, adjustments = {}, overrideReason, user, session }) {
  const config = SOURCE_CONFIG[sourceModule];
  if (!config) { const e = new Error('Unsupported charge source'); e.statusCode = 400; throw e; }
  const request = await config.Model.findOne({ _id: sourceId, hospitalId: user.hospital_id }, null, opts(session));
  if (!request) { const e = new Error('Source request not found'); e.statusCode = 404; throw e; }
  const master = request[config.masterField]
    ? await config.Master.findOne({ _id: request[config.masterField], hospitalId: user.hospital_id, is_active: { $ne: false } }, null, opts(session)).lean()
    : null;
  if (request[config.masterField] && !master) { const e = new Error('Source service master was not found for this hospital'); e.statusCode = 409; e.code = 'SOURCE_SERVICE_MASTER_INVALID'; throw e; }
  ensureSourceMasterOrOverride({ request, config, user, overrideReason, preview: true });

  const isIPD = isIPDSourceRequest(request, sourceModule);
  let encounter = null;
  let coverage = null;
  if (isIPD) {
    encounter = await IPDAdmission.findOne({ _id: request.admissionId, hospitalId: user.hospital_id }, null, opts(session));
    if (!encounter) { const e = new Error('IPD admission not found'); e.statusCode = 404; throw e; }
    coverage = await activeCoverage(user.hospital_id, encounter._id, session);
  } else {
    if (!request.appointmentId) { const e = new Error('OPD source request must be linked to an appointment'); e.statusCode = 409; throw e; }
    const Appointment = require('../models/Appointment');
    encounter = await Appointment.findOne({ _id: request.appointmentId, hospital_id: user.hospital_id }, null, opts(session));
    if (!encounter) { const e = new Error('OPD appointment not found'); e.statusCode = 404; throw e; }
    coverage = await activeAppointmentCoverage(user.hospital_id, encounter._id, session);
  }

  const standardAmount = Number(request.amount ?? request.cost ?? request.price ?? request.totalAmount ?? 0);
  const quote = await quotePricing({
    hospitalId: user.hospital_id,
    ...(isIPD ? { admissionId: encounter._id } : { appointmentId: encounter._id }),
    serviceDate: request.requestedDate || operationNow(),
    chargeType: config.chargeType, serviceType: config.serviceType,
    internalServiceModel: config.internalServiceModel, internalServiceId: request[config.masterField],
    internalCode: request[config.codeField], standardAmount: request[config.masterField] ? undefined : standardAmount, quantity: 1
  });
  const inheritedMode = encounter.selectedBillingMode;
  const permittedExplicitMode = canSelectFinancialMode(user) ? selectedMode : undefined;
  // An encounter selection is inherited, not an explicit override. A narrower
  // service rule may legitimately replace it with the service default.
  const policy = await resolveFinancialPolicy({
    hospitalId: user.hospital_id, user, encounterType: isIPD ? 'IPD' : 'OPD', serviceType: config.serviceType,
    serviceCategory: master?.category, serviceCode: request[config.codeField],
    payerCategory: coverage?.payerCategory || (coverage ? 'SPONSORED' : 'SELF'),
    departmentId: encounter.departmentId || encounter.department_id,
    urgency: request.priority || request.urgency, effectiveAt: request.requestedDate || operationNow(),
    selectedMode: permittedExplicitMode, inheritedMode, requestedDeposit,
    patientLiability: quote.amounts.patientLiability, sponsorLiability: quote.amounts.sponsorLiability,
    contractedAmount: quote.amounts.contracted, adjustments, overrideReason
  });
  return { sourceModule, sourceId: request._id, request, master, quote, financialPolicy: policy };
}


async function reverseSourceFinancials({ sourceModule, sourceId, reason, paymentMethod = 'Cash', reference, user, session }) {
  const config = SOURCE_CONFIG[sourceModule];
  if (!config) { const e = new Error('Unsupported charge source'); e.statusCode = 400; throw e; }
  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason) { const e = new Error('Cancellation/reversal reason is required'); e.statusCode = 400; e.code = 'REVERSAL_REASON_REQUIRED'; throw e; }

  const status = await getSourceFinancialStatus({ sourceModule, sourceId, user, session });
  const request = status.request;
  if ([BILLING_STATES.VOIDED, BILLING_STATES.REFUNDED, BILLING_STATES.CREDITED].includes(request.billingState)) {
    return {
      sourceModule,
      sourceId: request._id,
      billingState: request.billingState,
      alreadyReversed: true,
      voidedCharge: null,
      creditNotes: [],
      refunds: []
    };
  }
  const baseKey = `${sourceModule}:${sourceId}:cancel`;
  const results = { voidedCharge: null, creditNotes: [], refunds: [] };

  // Once an invoice exists, cancellation becomes an accounting reversal. A
  // clinical user may cancel the request, but only Finance/refund authority may
  // create credit/refund documents. The caller can surface FINANCE_REVERSAL_REQUIRED
  // and Finance can resume idempotently through /source-finance/.../reverse.
  if (status.invoices.length) {
    const { _hasActionPermission } = require('../middlewares/auth');
    if (!_hasActionPermission(user, 'refund')) {
      const e = new Error('Clinical request cancelled; Finance refund/credit authority is required to reverse its invoice');
      e.statusCode = 409;
      e.code = 'FINANCE_REVERSAL_REQUIRED';
      e.details = { sourceModule, sourceId: String(sourceId), invoiceIds: status.invoices.map((row) => row._id) };
      throw e;
    }
  }

  // An uninvoiced IPD source charge can be safely voided at source. This also
  // reverses payer/package utilization through the canonical IPD finance path.
  if (status.charge && !status.invoices.length && !status.charge.isBilled && status.charge.status !== 'INVOICED') {
    results.voidedCharge = await ipdFinancial.voidCharge(
      request.admissionId,
      status.charge._id,
      { reason: normalizedReason },
      user
    );
  } else {
    // Source-finance creates source-specific invoices, so a cancellation can
    // reverse that exact liability without touching unrelated services.
    for (const invoice of status.invoices) {
      const remainingCredit = money(Math.max(0, Number(invoice.total || 0) - Number(invoice.credit_note_total || 0)));
      if (remainingCredit <= 0) continue;
      const refundable = money(Math.max(0, Number(invoice.amount_paid || 0) - Number(invoice.refunded_amount || 0)));
      const refundAmount = money(Math.min(refundable, remainingCredit));
      if (refundAmount > 0) {
        const refunded = await ipdFinancial.refundInvoice(invoice._id, {
          amount: refundAmount,
          reason: normalizedReason,
          paymentMethod,
          reference,
          idempotencyKey: `${baseKey}:invoice:${invoice._id}:refund`
        }, user);
        results.refunds.push(refunded);
      }
      const alreadyCredited = money(Number(invoice.credit_note_total || 0) + refundAmount);
      const remainingAfterRefundCredit = money(Math.max(0, Number(invoice.total || 0) - alreadyCredited));
      if (remainingAfterRefundCredit > 0) {
        const credited = await ipdFinancial.createCreditNote(invoice._id, {
          amount: remainingAfterRefundCredit,
          reason: normalizedReason,
          idempotencyKey: `${baseKey}:invoice:${invoice._id}:credit`
        }, user);
        results.creditNotes.push(credited);
      }
    }

    if (status.charge) {
      await IPDCharge.updateOne(
        { _id: status.charge._id, hospitalId: user.hospital_id },
        { $set: { status: 'CANCELLED', voidReason: normalizedReason, voidedBy: user._id, voidedAt: operationNow() } },
        opts(session)
      );
      await reverseCoverageUtilization({ hospitalId: user.hospital_id, sourceType: 'IPDCharge', sourceId: status.charge._id, userId: user._id, reason: normalizedReason, session });
      await reversePackageUtilization({ hospitalId: user.hospital_id, sourceType: 'IPDCharge', sourceId: status.charge._id, userId: user._id, reason: normalizedReason, session });
    }
  }

  const finalState = results.refunds.length ? BILLING_STATES.REFUNDED
    : (results.creditNotes.length ? BILLING_STATES.CREDITED : BILLING_STATES.VOIDED);
  await appendBillingLink({
    sourceModule, sourceId, hospitalId: user.hospital_id,
    state: finalState, action: 'SOURCE_CANCELLED', actorId: user._id,
    reason: normalizedReason, financialClearanceState: 'HOLD', session
  });

  return { sourceModule, sourceId, billingState: finalState, ...results };
}

async function getSourceFinancialStatus({ sourceModule, sourceId, user, session }) {
  const config = SOURCE_CONFIG[sourceModule];
  if (!config) { const e = new Error('Unsupported charge source'); e.statusCode = 400; throw e; }
  const request = await config.Model.findOne({ _id: sourceId, hospitalId: user.hospital_id }, null, opts(session)).lean();
  if (!request) { const e = new Error('Source request not found'); e.statusCode = 404; throw e; }

  const Invoice = require('../models/Invoice');
  const Bill = require('../models/Bill');
  const AdmissionCoverage = require('../models/AdmissionCoverage');
  let selectedMode = null;
  let requiredNow = 0;
  let policySnapshot = {};
  let charge = null;
  let bill = null;

  if (isIPDSourceRequest(request, sourceModule)) {
    charge = await IPDCharge.findOne({ hospitalId: user.hospital_id, sourceModule, sourceId: request._id, status: { $nin: ['VOIDED', 'CANCELLED'] } }, null, opts(session)).sort({ createdAt: -1 }).lean();
    selectedMode = charge?.selectedBillingMode || null;
    requiredNow = money(charge?.requiredNowAmount || 0);
    policySnapshot = charge?.financialPolicySnapshot || {};
  } else {
    const billIds = (request.billIds || []).filter(Boolean);
    if (billIds.length) {
      bill = await Bill.findOne({ _id: { $in: billIds }, hospital_id: user.hospital_id }, null, opts(session)).sort({ created_at: -1 }).lean();
      const line = bill?.items?.find((item) => String(item?.source_snapshot?.sourceId || item?.source_snapshot?.requestId || '') === String(request._id)) || bill?.items?.[0];
      policySnapshot = line?.source_snapshot?.financialPolicy || line?.source_snapshot?.financialPolicySnapshot || {};
      selectedMode = policySnapshot.selectedMode || line?.selectedBillingMode || null;
      requiredNow = money(policySnapshot.requiredNow ?? line?.requiredNowAmount ?? 0);
    }
  }

  const invoiceIds = [...new Set([...(request.invoiceIds || []), request.invoiceId].filter(Boolean).map(String))];
  const invoices = invoiceIds.length
    ? await Invoice.find({ _id: { $in: invoiceIds }, hospital_id: user.hospital_id, document_stage: { $ne: 'VOID' } }, null, opts(session)).lean()
    : [];
  const paidNow = money(invoices.reduce((sum, inv) => sum + Number(inv.amount_paid || 0), 0));
  const totalInvoiced = money(invoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0));

  let clearanceState = charge?.clearanceState || policySnapshot.clearanceState || 'PAYMENT_REQUIRED';
  if (selectedMode === 'POSTPAID') {
    clearanceState = 'POSTPAID_ALLOWED';
  } else if (selectedMode === 'AUTHORIZED_EXCEPTION') {
    clearanceState = 'EXCEPTION_APPROVED';
  } else if (selectedMode === 'TPA_SPONSOR') {
    const coverage = await AdmissionCoverage.findOne({
      hospitalId: user.hospital_id,
      ...(request.admissionId ? { admissionId: request.admissionId, encounterType: 'IPD' } : { appointmentId: request.appointmentId, encounterType: 'OPD' }),
      isActive: { $ne: false }
    }, null, opts(session)).sort({ createdAt: -1 }).lean();
    const eligible = ['verified', 'emergency_override'].includes(String(coverage?.eligibility?.status || ''));
    const preauthRequired = Boolean(coverage?.preAuthorisation?.required);
    const preauthOk = !preauthRequired || ['approved', 'partially_approved', 'not_required'].includes(String(coverage?.preAuthorisation?.status || ''));
    clearanceState = eligible && preauthOk ? 'CLEARED' : (eligible ? 'TPA_PENDING' : 'AUTHORIZATION_REQUIRED');
  } else if (requiredNow <= 0 || paidNow + 0.009 >= requiredNow) {
    clearanceState = 'CLEARED';
  } else {
    clearanceState = 'PAYMENT_REQUIRED';
  }

  // Persist the current server-computed clearance so operational lists can show the
  // correct readiness state without equating INVOICED/is_billed with PAID/CLEARED.
  if (request.financialClearanceState !== clearanceState || request.selectedBillingMode !== selectedMode || Number(request.requiredNowAmount || 0) !== requiredNow) {
    await config.Model.updateOne(
      { _id: request._id, hospitalId: user.hospital_id },
      { $set: { financialClearanceState: clearanceState, selectedBillingMode: selectedMode || undefined, requiredNowAmount: requiredNow } },
      opts(session)
    );
    request.financialClearanceState = clearanceState;
    request.selectedBillingMode = selectedMode || request.selectedBillingMode;
    request.requiredNowAmount = requiredNow;
  }

  return { sourceModule, sourceId: request._id, request, charge, bill, invoices, selectedMode, requiredNow, paidNow, totalInvoiced,
    outstandingRequiredNow: money(Math.max(0, requiredNow - paidNow)), clearanceState, policySnapshot };
}

module.exports = {
  postIPDSourceCharge,
  postSourceCharge,
  getSourceFinancialStatus,
  previewSourceFinancialPolicy,
  reverseSourceFinancials,
  SOURCE_CONFIG
};