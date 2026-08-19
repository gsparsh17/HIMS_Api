const crypto = require('crypto');
const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
const RepricingBatch = require('../models/RepricingBatch');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const IPDAdmission = require('../models/IPDAdmission');
const Appointment = require('../models/Appointment');
const IPDCharge = require('../models/IPDCharge');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const RateCardItem = require('../models/RateCardItem');
const SponsorLedgerEntry = require('../models/SponsorLedgerEntry');
const { quotePricing, pricingSnapshot, serviceTypeFromCharge } = require('./pricingEngine.service');
const coverageService = require('./coverage.service');
const { componentMatches, activatePackageEpisode, recordPackageUtilization, reversePackageUtilization } = require('./packageAdjudication.service');
const { createCreditNote } = require('./ipdFinancial.service');
const { nextFinancialNumber, money } = require('../utils/financeNumbers');
const { appendDomainEvent } = require('./auditEvent.service');
const { replaceCoverageUtilization } = require('./coverageUtilization.service');
const { canUseInsuranceSelfApprovalOverride, buildInsuranceAdminOverride } = require('../utils/insuranceWorkflowAuthority');

function httpError(message, statusCode = 400, code, details) {
  const error = new Error(message); error.statusCode = statusCode; error.code = code; error.details = details; return error;
}
function sessionOptions(session) { return session ? { session } : {}; }
function unique(values) { return [...new Set((values || []).filter(Boolean))]; }
function delta(after = 0, before = 0) { return money(Number(after || 0) - Number(before || 0)); }
function allocationFromQuote(quote) {
  return {
    standardAmount: money(quote.amounts.hospitalStandard),
    contractedAmount: money(quote.amounts.contracted),
    eligibleAmount: money(quote.amounts.eligible),
    patientLiability: money(quote.amounts.patientLiability),
    sponsorLiability: money(quote.amounts.sponsorLiability),
    nonAdmissibleAmount: money(quote.amounts.nonAdmissible),
    contractualAdjustment: money(quote.amounts.hospitalAdjustment),
    hospitalConcession: money(quote.amounts.hospitalConcession),
    packageAbsorbed: money(quote.amounts.packageAbsorbed),
    pricingSnapshot: pricingSnapshot(quote)
  };
}
function beforeFromCharge(charge) {
  return {
    standardAmount: money(charge.standardAmount ?? charge.pricingSnapshot?.amounts?.hospitalStandard ?? charge.grossAmount ?? charge.amount),
    contractedAmount: money(charge.contractedAmount ?? charge.pricingSnapshot?.amounts?.contracted ?? charge.netAmount),
    eligibleAmount: money(charge.eligibleAmount ?? charge.pricingSnapshot?.amounts?.eligible ?? charge.netAmount),
    patientLiability: money(charge.patientLiability ?? charge.pricingSnapshot?.amounts?.patientLiability ?? charge.netAmount),
    sponsorLiability: money(charge.sponsorLiability ?? charge.pricingSnapshot?.amounts?.sponsorLiability),
    nonAdmissibleAmount: money(charge.nonAdmissibleAmount ?? charge.pricingSnapshot?.amounts?.nonAdmissible),
    contractualAdjustment: money(charge.contractualAdjustmentAmount ?? charge.pricingSnapshot?.amounts?.hospitalAdjustment),
    hospitalConcession: money(charge.hospitalConcessionAmount ?? charge.pricingSnapshot?.amounts?.hospitalConcession),
    packageAbsorbed: money(charge.packageAbsorbedAmount ?? charge.pricingSnapshot?.amounts?.packageAbsorbed),
    pricingSnapshot: charge.pricingSnapshot?.toObject?.() || charge.pricingSnapshot || {}
  };
}
function beforeFromBillItem(item) {
  return {
    standardAmount: money(item.standard_amount ?? item.pricing_snapshot?.amounts?.hospitalStandard ?? item.gross_amount ?? item.amount),
    contractedAmount: money(item.contracted_amount ?? item.pricing_snapshot?.amounts?.contracted ?? item.net_amount ?? item.amount),
    eligibleAmount: money(item.eligible_amount ?? item.pricing_snapshot?.amounts?.eligible ?? item.amount),
    patientLiability: money(item.patient_liability ?? item.pricing_snapshot?.amounts?.patientLiability ?? item.amount),
    sponsorLiability: money(item.sponsor_liability ?? item.pricing_snapshot?.amounts?.sponsorLiability),
    nonAdmissibleAmount: money(item.non_admissible_amount ?? item.pricing_snapshot?.amounts?.nonAdmissible),
    contractualAdjustment: money(item.contractual_adjustment ?? item.pricing_snapshot?.amounts?.hospitalAdjustment),
    hospitalConcession: money(item.hospital_concession ?? item.pricing_snapshot?.amounts?.hospitalConcession),
    packageAbsorbed: money(item.package_absorbed ?? item.pricing_snapshot?.amounts?.packageAbsorbed),
    pricingSnapshot: item.pricing_snapshot?.toObject?.() || item.pricing_snapshot || {}
  };
}
function lineDelta(before, after) {
  return {
    standardAmount: delta(after.standardAmount, before.standardAmount),
    contractedAmount: delta(after.contractedAmount, before.contractedAmount),
    sponsorLiability: delta(after.sponsorLiability, before.sponsorLiability),
    patientLiability: delta(after.patientLiability, before.patientLiability),
    nonAdmissibleAmount: delta(after.nonAdmissibleAmount, before.nonAdmissibleAmount),
    hospitalAdjustment: delta(after.contractualAdjustment, before.contractualAdjustment)
  };
}
function lineInputFromCharge(charge, hospitalId, coverage) {
  const quantity = Math.max(1, Number(charge.quantity || 1));
  const standardTotal = Number(charge.standardAmount ?? charge.pricingSnapshot?.amounts?.hospitalStandard ?? charge.grossAmount ?? charge.amount ?? charge.netAmount ?? 0);
  return {
    hospitalId, admissionId: charge.admissionId, coverage,
    internalServiceModel: charge.pricingSnapshot?.internalServiceModel,
    internalServiceId: charge.pricingSnapshot?.internalServiceId,
    internalCode: charge.pricingSnapshot?.serviceCode || charge.sourceReference?.lineKey,
    serviceType: serviceTypeFromCharge(charge.chargeType), chargeType: charge.chargeType,
    description: charge.description, quantity, standardAmount: standardTotal / quantity,
    serviceDate: charge.chargeDate, wardEntitlement: coverage.beneficiary?.wardEntitlement
  };
}
function lineInputFromBillItem(item, bill, hospitalId, coverage) {
  const quantity = Math.max(1, Number(item.quantity || 1));
  const standardTotal = Number(item.standard_amount ?? item.pricing_snapshot?.amounts?.hospitalStandard ?? item.gross_amount ?? item.amount ?? item.total_price ?? 0);
  let internalServiceModel = item.pricing_snapshot?.internalServiceModel;
  let internalServiceId = item.pricing_snapshot?.internalServiceId;
  if (!internalServiceId && item.procedure_id) { internalServiceModel = 'Procedure'; internalServiceId = item.procedure_id; }
  if (!internalServiceId && item.lab_test_id) { internalServiceModel = 'LabTest'; internalServiceId = item.lab_test_id; }
  if (!internalServiceId && item.radiology_test_id) { internalServiceModel = 'ImagingTest'; internalServiceId = item.radiology_test_id; }
  if (!internalServiceId && item.medicine_id) { internalServiceModel = 'Medicine'; internalServiceId = item.medicine_id; }
  const serviceType = item.item_type === 'Lab Test' ? 'laboratory' : item.item_type === 'Radiology' ? 'radiology' : item.item_type === 'Procedure' ? 'procedure' : ['Medicine', 'Pharmacy'].includes(item.item_type) ? 'pharmacy' : serviceTypeFromCharge(item.charge_type || item.item_type);
  return { hospitalId, appointmentId: bill.appointment_id, admissionId: bill.admission_id, coverage, internalServiceModel, internalServiceId, internalCode: item.procedure_code || item.lab_test_code || item.radiology_test_code || item.pricing_snapshot?.serviceCode, serviceType, chargeType: item.item_type, description: item.description || item.medicine_name, quantity, standardAmount: standardTotal / quantity, serviceDate: item.charge_date || bill.generated_at };
}

function simulatedPackageDecision(packages, input) {
  const serviceDate = new Date(input.serviceDate || Date.now());
  for (const episode of [...packages].reverse()) {
    if (serviceDate < episode.startsAt || serviceDate > episode.endsAt) continue;
    const definition = episode.item.packageDefinition || {};
    const exclusion = (definition.exclusions || []).find((row) => componentMatches(row, input));
    if (exclusion) return { decision: 'excluded', episode, component: exclusion, reason: 'Matched package exclusion during repricing preview' };
    const inclusion = (definition.inclusions || []).find((row) => componentMatches(row, input));
    if (inclusion) return { decision: 'included', episode, component: inclusion, reason: 'Matched package inclusion during repricing preview' };
    const type = String(input.serviceType || '').toLowerCase();
    if (
      (type === 'pharmacy' && definition.includesMedicines) ||
      (['consumable', 'consumables', 'inventory', 'implant'].includes(type) && definition.includesConsumables) ||
      (['laboratory', 'radiology'].includes(type) && definition.includesInvestigations) ||
      (type === 'bed' && definition.includesRoom) ||
      (['consultation', 'procedure'].includes(type) && definition.includesProfessionalFees)
    ) return { decision: 'included', episode, reason: 'Included by package category flag during repricing preview' };
    if (definition.defaultUnlistedComponentTreatment === 'included') return { decision: 'included', episode, reason: 'Package default includes unlisted component' };
    if (definition.defaultUnlistedComponentTreatment === 'excluded') return { decision: 'excluded', episode, reason: 'Package default excludes unlisted component' };
    if (definition.defaultUnlistedComponentTreatment === 'cash_fallback') return { decision: 'cash_fallback', episode, reason: 'Package default sends unlisted component to cash billing' };
    if (definition.defaultUnlistedComponentTreatment === 'payer_rate') return { decision: 'payer_rate', episode, reason: 'Package default sends unlisted component to payer tariff' };
  }
  return null;
}
function includedQuote(input, coverage, packageDecision) {
  const total = money(Number(input.standardAmount || 0) * Number(input.quantity || 1));
  return {
    resultType: 'package_included', serviceCode: input.internalCode, rateCard: { id: coverage.rateCardId?._id || coverage.rateCardId, version: coverage.rateCardVersion }, packageCode: packageDecision.episode.item.externalCode, packageDecision: 'included', packageTriggerRateCardItemId: packageDecision.episode.item._id,
    inputs: { payer: coverage.payerId?.code || String(coverage.payerId), coverageId: coverage._id, serviceDate: new Date(input.serviceDate || Date.now()), quantity: input.quantity },
    amounts: { hospitalStandard: total, contracted: 0, eligible: 0, sponsorLiability: 0, patientLiability: 0, nonAdmissible: 0, hospitalAdjustment: 0, hospitalConcession: 0, packageAbsorbed: total },
    explanation: [packageDecision.reason], ruleTrace: [{ rule: 'simulated_package_inclusion' }]
  };
}
async function quoteWithSimulatedPackages(input, coverage, packages) {
  const decision = simulatedPackageDecision(packages, input);
  let quote;
  if (decision?.decision === 'included') quote = includedQuote(input, coverage, decision);
  else if (decision?.decision === 'cash_fallback') {
    const total = money(Number(input.standardAmount || 0) * Number(input.quantity || 1));
    quote = {
      resultType: 'cash_fallback',
      fallbackReason: decision.reason,
      serviceCode: input.internalCode,
      rateCard: coverage.rateCardId ? { id: coverage.rateCardId?._id || coverage.rateCardId, version: coverage.rateCardVersion } : null,
      inputs: { payer: coverage.payerId?.code || String(coverage.payerId), coverageId: coverage._id, serviceDate: input.serviceDate, quantity: input.quantity },
      amounts: { hospitalStandard: total, contracted: total, eligible: total, sponsorLiability: 0, patientLiability: total, nonAdmissible: 0, hospitalAdjustment: 0, hospitalConcession: 0, packageAbsorbed: 0, coPay: 0, deductible: 0, fixedPatientShare: 0, uncovered: 0 },
      explanation: [decision.reason],
      ruleTrace: [{ rule: 'package_cash_fallback' }]
    };
  } else quote = await quotePricing({ ...input, coverage, skipPackageAdjudication: true });
  if (quote.rateCardItemId && quote.packageCode && quote.resultType !== 'package_included') {
    const item = await RateCardItem.findById(quote.rateCardItemId);
    if (item?.packageDefinition?.isPackage) {
      const startsAt = new Date(input.serviceDate || Date.now());
      const days = Math.max(1, Number(item.packagePeriodDays || 1));
      packages.push({ item, startsAt, endsAt: new Date(startsAt.getTime() + days * 86400000 - 1) });
    }
  }
  return quote;
}

async function encounterRecord({ hospitalId, encounterType, encounterId }) {
  if (encounterType === 'OPD') {
    const row = await Appointment.findOne({ _id: encounterId, hospital_id: hospitalId });
    if (!row) throw httpError('Appointment not found', 404); return { row, patientId: row.patient_id };
  }
  const row = await IPDAdmission.findOne({ _id: encounterId, hospitalId });
  if (!row) throw httpError('Admission not found', 404); return { row, patientId: row.patientId };
}
async function preparedCoverage({ req, hospitalId, encounterType, encounterId, payload }) {
  if (payload.toCoverageId) {
    const coverage = await AdmissionCoverage.findOne({ _id: payload.toCoverageId, hospitalId, encounterType });
    if (!coverage) throw httpError('Target coverage not found', 404); return coverage.populate('payerId rateCardId');
  }
  if (!payload.targetCoverage?.payerId) throw httpError('toCoverageId or targetCoverage.payerId is required', 422);
  const coverage = await coverageService.createEncounterCoverage({ req, hospitalId, encounterType, encounterId, payload: { ...payload.targetCoverage, conversionReason: payload.reason }, activateImmediately: false });
  return coverage.populate('payerId rateCardId');
}
async function nextBatchNumber(hospitalId) {
  const count = await RepricingBatch.countDocuments({ hospitalId });
  return `RPR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(count + 1).padStart(5, '0')}`;
}

async function preview({ req, hospitalId, encounterType, encounterId, payload }) {
  const normalizedType = String(encounterType).toUpperCase();
  const encounter = await encounterRecord({ hospitalId, encounterType: normalizedType, encounterId });
  const fromCoverage = await coverageService.activeEncounterCoverage({ hospitalId, encounterType: normalizedType, encounterId });
  const toCoverage = await preparedCoverage({ req, hospitalId, encounterType: normalizedType, encounterId, payload });
  if (!toCoverage.simulationOnly && !['verified', 'emergency_override'].includes(toCoverage.eligibility?.status)) {
    throw httpError('Target coverage eligibility must be verified before repricing preview', 409, 'COVERAGE_NOT_VERIFIED');
  }
  const lines = []; const packages = [];
  if (normalizedType === 'IPD') {
    const charges = await IPDCharge.find({ hospitalId, admissionId: encounterId, status: { $in: ['ACTIVE', 'INVOICED'] } }).sort({ chargeDate: 1, createdAt: 1 });
    for (const charge of charges) {
      if (['Discount', 'Tax'].includes(charge.chargeType) || ['DISCOUNT', 'TAX', 'WAIVER'].includes(charge.adjustmentType)) continue;
      const input = lineInputFromCharge(charge, hospitalId, toCoverage);
      const quote = await quoteWithSimulatedPackages(input, toCoverage, packages);
      const before = beforeFromCharge(charge); const after = { ...allocationFromQuote(quote), pricingSnapshot: pricingSnapshot(quote, input) };
      lines.push({ sourceType: 'IPDCharge', sourceId: charge._id, description: charge.description, locked: Boolean(charge.isBilled || charge.status === 'INVOICED' || charge.invoiceId), lockReason: charge.isBilled || charge.invoiceId ? 'Charge is already invoiced' : undefined, before, after, delta: lineDelta(before, after), adjustmentStatus: charge.isBilled || charge.invoiceId ? 'pending' : 'not_required' });
    }
  } else {
    const bills = await Bill.find({ hospital_id: hospitalId, appointment_id: encounterId, is_deleted: { $ne: true }, status: { $ne: 'Cancelled' } }).sort({ generated_at: 1, createdAt: 1 });
    for (const bill of bills) {
      const locked = bill.document_stage === 'INVOICED' || (bill.invoice_ids || []).length > 0 || bill.invoice_id || Number(bill.paid_amount || 0) > 0;
      if (Number(bill.paid_amount || 0) > 0 && !(bill.invoice_id || (bill.invoice_ids || []).length)) throw httpError(`Bill ${bill.bill_number || bill._id} has payment but no issued invoice; reconcile it before conversion`, 409, 'PAID_BILL_WITHOUT_INVOICE');
      for (const item of bill.items || []) {
        const input = lineInputFromBillItem(item, bill, hospitalId, toCoverage);
        const quote = await quoteWithSimulatedPackages(input, toCoverage, packages);
        const before = beforeFromBillItem(item); const after = { ...allocationFromQuote(quote), pricingSnapshot: pricingSnapshot(quote, input) };
        lines.push({ sourceType: 'BillItem', sourceId: bill._id, sourceLineId: item._id, description: item.description || item.medicine_name, locked, lockReason: locked ? 'Bill is issued or has payment' : undefined, before, after, delta: lineDelta(before, after), adjustmentStatus: locked ? 'pending' : 'not_required' });
      }
    }
  }
  const totals = lines.reduce((sum, line) => {
    sum.beforeStandard += line.before.standardAmount; sum.beforePatient += line.before.patientLiability; sum.beforeSponsor += line.before.sponsorLiability;
    sum.afterStandard += line.after.standardAmount; sum.afterPatient += line.after.patientLiability; sum.afterSponsor += line.after.sponsorLiability;
    sum.contractualAdjustmentDelta += line.delta.hospitalAdjustment; return sum;
  }, { beforeStandard: 0, beforePatient: 0, beforeSponsor: 0, afterStandard: 0, afterPatient: 0, afterSponsor: 0, patientRefundOrCredit: 0, patientAdditionalDue: 0, sponsorReceivableDelta: 0, contractualAdjustmentDelta: 0 });
  Object.keys(totals).forEach((key) => { totals[key] = money(totals[key]); });
  totals.patientRefundOrCredit = money(Math.max(0, totals.beforePatient - totals.afterPatient));
  totals.patientAdditionalDue = money(Math.max(0, totals.afterPatient - totals.beforePatient));
  totals.sponsorReceivableDelta = money(totals.afterSponsor - totals.beforeSponsor);
  const idempotencyKey = payload.idempotencyKey || req.headers['idempotency-key'] || crypto.randomUUID();
  const batch = await RepricingBatch.findOneAndUpdate({ hospitalId, idempotencyKey }, {
    hospitalId, batchNumber: await nextBatchNumber(hospitalId), encounterType: normalizedType,
    admissionId: normalizedType === 'IPD' ? encounterId : undefined, appointmentId: normalizedType === 'OPD' ? encounterId : undefined,
    patientId: encounter.patientId, fromCoverageId: fromCoverage?._id, toCoverageId: toCoverage._id, reason: payload.reason || 'Coverage changed after service posting', status: 'pending_approval', lines, totals, idempotencyKey, createdBy: req.user._id
  }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return batch;
}

async function approve({ req, hospitalId, batchId, user }) {
  const batch = await RepricingBatch.findOne({ _id: batchId, hospitalId });
  if (!batch) throw httpError('Repricing batch not found', 404);
  if (batch.status === 'approved') return batch;
  if (batch.status !== 'pending_approval') throw httpError(`Batch cannot be approved from ${batch.status}`, 409);
  const sameAsPreparer = String(batch.createdBy) === String(user?._id);
  if (sameAsPreparer && !canUseInsuranceSelfApprovalOverride(user)) {
    throw httpError('Repricing must be approved by another authorised user', 409, 'FOUR_EYES_REQUIRED');
  }
  batch.status = 'approved';
  batch.firstApprovedBy = user._id;
  batch.firstApprovedAt = new Date();
  batch.approvalOverride = sameAsPreparer
    ? buildInsuranceAdminOverride(user, 'Small-hospital admin approved their own repricing batch')
    : { used: false };
  await batch.save();
  if (req) {
    await appendDomainEvent({
      req,
      eventType: 'coverage.repricing_approved',
      entityType: 'RepricingBatch',
      entityId: batch._id,
      hospitalId,
      patientId: batch.patientId,
      encounterId: batch.admissionId || batch.appointmentId,
      afterSummary: { batchNumber: batch.batchNumber, adminSelfApprovalOverride: Boolean(batch.approvalOverride?.used) }
    });
  }
  return batch;
}

function applyAfterToCharge(charge, after) {
  const quantity = Math.max(1, Number(charge.quantity || 1));
  charge.rate = money(Number(after.contractedAmount || 0) / quantity);
  charge.pricingSnapshot = after.pricingSnapshot;
  charge.standardAmount = after.standardAmount; charge.contractedAmount = after.contractedAmount; charge.eligibleAmount = after.eligibleAmount;
  charge.patientLiability = after.patientLiability; charge.sponsorLiability = after.sponsorLiability; charge.nonAdmissibleAmount = after.nonAdmissibleAmount;
  charge.contractualAdjustmentAmount = after.contractualAdjustment; charge.hospitalConcessionAmount = after.hospitalConcession; charge.packageAbsorbedAmount = after.packageAbsorbed;
}
function applyAfterToBillItem(item, after) {
  item.pricing_snapshot = after.pricingSnapshot; item.standard_amount = after.standardAmount; item.contracted_amount = after.contractedAmount; item.eligible_amount = after.eligibleAmount;
  item.patient_liability = after.patientLiability; item.sponsor_liability = after.sponsorLiability; item.non_admissible_amount = after.nonAdmissibleAmount;
  item.contractual_adjustment = after.contractualAdjustment; item.hospital_concession = after.hospitalConcession; item.package_absorbed = after.packageAbsorbed;
  item.amount = after.contractedAmount; item.net_amount = after.contractedAmount;
}
function recalcBillAllocation(bill, coverage) {
  const totals = (bill.items || []).reduce((sum, item) => {
    sum.standard_amount += Number(item.standard_amount || 0); sum.contracted_amount += Number(item.contracted_amount || item.amount || 0); sum.eligible_amount += Number(item.eligible_amount || 0); sum.patient_liability += Number(item.patient_liability || 0); sum.sponsor_liability += Number(item.sponsor_liability || 0); sum.non_admissible_amount += Number(item.non_admissible_amount || 0); sum.contractual_adjustment += Number(item.contractual_adjustment || 0); sum.hospital_concession += Number(item.hospital_concession || 0); sum.package_absorbed += Number(item.package_absorbed || 0); if (item.pricing_snapshot?.resultType === 'cash_fallback') sum.fallback_count += 1; return sum;
  }, { standard_amount: 0, contracted_amount: 0, eligible_amount: 0, patient_liability: 0, sponsor_liability: 0, non_admissible_amount: 0, contractual_adjustment: 0, hospital_concession: 0, package_absorbed: 0, fallback_count: 0 });
  Object.keys(totals).forEach((key) => { totals[key] = money(totals[key]); });
  bill.payer_allocation = { coverage_id: coverage._id, payer_id: coverage.payerId?._id || coverage.payerId, rate_card_id: coverage.rateCardId?._id || coverage.rateCardId, rate_card_version: coverage.rateCardVersion, ...totals };
  bill.subtotal = totals.contracted_amount; bill.total_amount = totals.contracted_amount; bill.gross_amount = totals.standard_amount;
}
async function createAdjustmentInvoice({ batch, coverage, patientAmount, sponsorAmount, reason, user, linkedInvoiceId }) {
  const total = money(Math.max(0, patientAmount) + Math.max(0, sponsorAmount));
  if (total <= 0) return null;
  const invoiceNumber = await nextFinancialNumber({ documentType: 'INVOICE', hospitalId: batch.hospitalId });
  return Invoice.create({
    hospital_id: batch.hospitalId, invoice_number: invoiceNumber, patient_id: batch.patientId,
    appointment_id: batch.appointmentId, admission_id: batch.admissionId, customer_type: sponsorAmount > 0 ? 'Insurance' : 'Patient',
    invoice_type: 'Other', document_stage: 'ISSUED', issued_at: operationNow(), issue_date: operationNow(), due_date: new Date(operationNow().getTime() + 30 * 86400000),
    linked_invoice_id: linkedInvoiceId, subtotal: total, gross_amount: total, discount: 0, tax: 0, total, amount_paid: 0,
    payer_allocation: { coverage_id: coverage._id, payer_id: coverage.payerId?._id || coverage.payerId, standard_amount: total, contracted_amount: total, eligible_amount: sponsorAmount, patient_liability: Math.max(0, patientAmount), sponsor_liability: Math.max(0, sponsorAmount) },
    service_items: [{ description: reason, quantity: 1, unit_price: total, total_price: total, service_type: 'Other', patient_liability: Math.max(0, patientAmount), sponsor_liability: Math.max(0, sponsorAmount), contracted_amount: total, eligible_amount: Math.max(0, sponsorAmount), standard_amount: total }],
    notes: `${reason}; repricing batch ${batch.batchNumber}`, created_by: user._id, idempotency_key: `${batch.idempotencyKey}:adjustment:${patientAmount}:${sponsorAmount}`
  });
}
async function lockedLineInvoiceId(line, hospitalId) {
  if (line.sourceType === 'IPDCharge') {
    const charge = await IPDCharge.findOne({ _id: line.sourceId, hospitalId }).select('invoiceId');
    if (!charge?.invoiceId) throw httpError(`Locked charge ${line.sourceId} has no invoice reference`, 409, 'INVOICE_REQUIRED');
    return String(charge.invoiceId);
  }
  const bill = await Bill.findOne({ _id: line.sourceId, hospital_id: hospitalId }).select('invoice_id invoice_ids');
  if (!bill) throw httpError(`Bill ${line.sourceId} not found`, 404);
  const ids = unique([bill.invoice_id, ...(bill.invoice_ids || [])].map((value) => value && String(value)));
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) throw httpError(`Locked bill ${line.sourceId} has no invoice reference`, 409, 'INVOICE_REQUIRED');
  throw httpError(`Bill ${line.sourceId} is linked to multiple invoices; line-level invoice allocation must be reconciled before repricing`, 409, 'AMBIGUOUS_INVOICE_ALLOCATION', { invoiceIds: ids });
}

async function sponsorLedgerAdjustment({ batch, coverage, amount, user }) {
  if (Math.abs(amount) < 0.01) return null;
  const previous = await SponsorLedgerEntry.findOne({ hospitalId: batch.hospitalId, payerId: coverage.payerId?._id || coverage.payerId }).sort({ occurredAt: -1 });
  const balance = money(Number(previous?.balanceAfter || 0) + amount);
  return SponsorLedgerEntry.create({ hospitalId: batch.hospitalId, payerId: coverage.payerId?._id || coverage.payerId, encounterType: batch.encounterType, admissionId: batch.admissionId, appointmentId: batch.appointmentId, patientId: batch.patientId, coverageId: coverage._id, entryNumber: `SLE-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, entryType: amount > 0 ? 'debit_adjustment' : 'credit_adjustment', debit: amount > 0 ? amount : 0, credit: amount < 0 ? Math.abs(amount) : 0, balanceAfter: Math.max(0, balance), reference: batch.batchNumber, reason: 'Coverage repricing sponsor allocation adjustment', sourceType: 'repricing', sourceId: batch._id, idempotencyKey: `${batch.idempotencyKey}:sponsor-ledger`, createdBy: user._id });
}

function quoteFromSnapshot(snapshot = {}) {
  return {
    resultType: snapshot.resultType,
    serviceCode: snapshot.serviceCode,
    rateCard: snapshot.rateCardId ? { id: snapshot.rateCardId, version: snapshot.rateCardVersion } : null,
    rateCardItemId: snapshot.rateCardItemId,
    packageCode: snapshot.packageCode,
    packageEpisodeId: snapshot.packageEpisodeId,
    packageTriggerRateCardItemId: snapshot.packageTriggerRateCardItemId,
    packageDecision: snapshot.packageDecision,
    inputs: snapshot.inputs || {},
    amounts: snapshot.amounts || {},
    explanation: snapshot.explanation || [],
    ruleTrace: snapshot.ruleTrace || []
  };
}

async function replaceCommittedCoverageLine({ line, coverage, batch, hospitalId, userId, session }) {
  const snapshot = line.after?.pricingSnapshot || {};
  const quote = quoteFromSnapshot(snapshot);
  const sourceType = line.sourceType === 'BillItem' ? 'BillItem' : 'IPDCharge';
  await replaceCoverageUtilization({
    coverage,
    quote,
    hospitalId,
    encounterType: batch.encounterType,
    admissionId: batch.admissionId,
    appointmentId: batch.appointmentId,
    patientId: batch.patientId,
    sourceType,
    sourceId: line.sourceId,
    sourceLineId: line.sourceLineId,
    internalServiceModel: snapshot.internalServiceModel,
    internalServiceId: snapshot.internalServiceId,
    userId,
    reason: `Coverage repricing ${batch.batchNumber}`,
    session
  });
}

function packageInputFromSnapshot(snapshot = {}, line = {}) {
  return {
    ...(snapshot.inputs || {}),
    serviceType: snapshot.serviceType || snapshot.inputs?.serviceType,
    internalServiceModel: snapshot.internalServiceModel,
    internalServiceId: snapshot.internalServiceId,
    internalCode: snapshot.serviceCode,
    serviceCode: snapshot.serviceCode,
    description: line.description,
    quantity: snapshot.inputs?.quantity || 1,
    serviceDate: snapshot.inputs?.serviceDate || snapshot.pricedAt || new Date()
  };
}

async function replayCommittedPackageLine({ line, coverage, batch, hospitalId, userId, session, episodeCache }) {
  const snapshot = line.after?.pricingSnapshot || {};
  if (!snapshot.packageCode) return null;
  const sourceType = line.sourceType === 'BillItem' ? 'BillItem' : 'IPDCharge';
  const encounterType = batch.encounterType;
  const encounterId = batch.admissionId || batch.appointmentId;
  let episode = null;

  if (snapshot.rateCardItemId && snapshot.resultType !== 'package_included') {
    episode = await activatePackageEpisode({
      quote: {
        rateCard: { id: snapshot.rateCardId },
        rateCardItemId: snapshot.rateCardItemId,
        packageCode: snapshot.packageCode,
        amounts: snapshot.amounts || {},
        inputs: snapshot.inputs || {}
      },
      coverage,
      hospitalId,
      encounterType,
      encounterId,
      patientId: batch.patientId,
      sourceType,
      sourceId: line.sourceId,
      sourceLineId: line.sourceLineId,
      userId,
      session
    });
    if (episode) episodeCache.set(String(episode.rateCardItemId), episode);
  }

  const triggerItemId = snapshot.packageTriggerRateCardItemId || (snapshot.resultType === 'package_included' ? snapshot.rateCardItemId : null);
  if (!episode && triggerItemId) episode = episodeCache.get(String(triggerItemId));
  if (!episode && triggerItemId) {
    const serviceDate = new Date(snapshot.inputs?.serviceDate || snapshot.pricedAt || Date.now());
    const PackageEpisode = require('../models/PackageEpisode');
    episode = await PackageEpisode.findOne({
      hospitalId,
      coverageId: coverage._id,
      rateCardItemId: triggerItemId,
      status: 'active',
      startsAt: { $lte: serviceDate },
      endsAt: { $gte: serviceDate }
    }).sort({ startsAt: -1 }).session(session || null);
    if (episode) episodeCache.set(String(triggerItemId), episode);
  }

  if (snapshot.packageDecision && episode) {
    await recordPackageUtilization({
      decision: { episode, decision: snapshot.packageDecision },
      input: packageInputFromSnapshot(snapshot, line),
      quote: { amounts: snapshot.amounts || {} },
      sourceType,
      sourceId: line.sourceId,
      sourceLineId: line.sourceLineId,
      session
    });
  }
  return episode;
}

async function commit({ req, hospitalId, batchId }) {
  const batch = await RepricingBatch.findOne({ _id: batchId, hospitalId });
  if (!batch) throw httpError('Repricing batch not found', 404);
  if (batch.status === 'committed') return batch;
  if (batch.status !== 'approved') throw httpError('Repricing batch must be approved before commit', 409);
  const sameAsPreparer = String(batch.createdBy) === String(req.user._id);
  if (sameAsPreparer && !canUseInsuranceSelfApprovalOverride(req.user)) {
    throw httpError('The user who prepared repricing cannot commit it', 409, 'FOUR_EYES_REQUIRED');
  }
  batch.commitOverride = sameAsPreparer
    ? buildInsuranceAdminOverride(req.user, 'Small-hospital admin committed their own repricing batch')
    : { used: false };
  batch.status = 'committing'; await batch.save();
  const coverage = await AdmissionCoverage.findOne({ _id: batch.toCoverageId, hospitalId }).populate('payerId rateCardId');
  if (!coverage) throw httpError('Target coverage not found', 404);
  const generated = [];
  try {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await coverageService.activatePreparedCoverage({ req, hospitalId, coverageId: coverage._id, session });
        const episodeCache = new Map();
        for (const line of batch.lines) {
          if (line.locked) continue;
          const sourceType = line.sourceType === 'BillItem' ? 'BillItem' : 'IPDCharge';
          await reversePackageUtilization({
            hospitalId,
            sourceType,
            sourceId: line.sourceId,
            sourceLineId: line.sourceLineId,
            userId: req.user._id,
            reason: `Coverage repricing ${batch.batchNumber}`,
            session
          });
          await replaceCommittedCoverageLine({ line, coverage, batch, hospitalId, userId: req.user._id, session });
          if (line.sourceType === 'IPDCharge') {
            const charge = await IPDCharge.findOne({ _id: line.sourceId, hospitalId, isBilled: false, status: 'ACTIVE' }).session(session);
            if (!charge) throw httpError(`Charge ${line.sourceId} became locked after preview`, 409, 'REPRICING_STALE');
            applyAfterToCharge(charge, line.after); await charge.save({ session });
            await replayCommittedPackageLine({ line, coverage, batch, hospitalId, userId: req.user._id, session, episodeCache });
          } else {
            const bill = await Bill.findOne({ _id: line.sourceId, hospital_id: hospitalId, document_stage: { $ne: 'INVOICED' }, paid_amount: { $lte: 0 } }).session(session);
            if (!bill) throw httpError(`Bill ${line.sourceId} became locked after preview`, 409, 'REPRICING_STALE');
            const item = bill.items.id(line.sourceLineId); if (!item) throw httpError('Bill item no longer exists', 409, 'REPRICING_STALE');
            applyAfterToBillItem(item, line.after); recalcBillAllocation(bill, coverage); await bill.save({ session });
            await replayCommittedPackageLine({ line, coverage, batch, hospitalId, userId: req.user._id, session, episodeCache });
          }
        }
        if (batch.encounterType === 'IPD') {
          const charges = await IPDCharge.find({ hospitalId, admissionId: batch.admissionId, status: { $in: ['ACTIVE', 'INVOICED'] } }).session(session);
          const totals = charges.reduce((sum, charge) => { sum.patient += Number(charge.patientLiability || 0); sum.sponsor += Number(charge.sponsorLiability || 0); sum.nonAdmissible += Number(charge.nonAdmissibleAmount || 0); sum.contracted += Number(charge.contractedAmount || charge.netAmount || 0); return sum; }, { patient: 0, sponsor: 0, nonAdmissible: 0, contracted: 0 });
          await IPDAdmission.updateOne({ _id: batch.admissionId, hospitalId }, { $set: { coverageId: coverage._id, sponsorType: coverage.payerCategory, patientReceivable: money(totals.patient), sponsorReceivable: money(totals.sponsor), nonAdmissibleAmount: money(totals.nonAdmissible), totalBillAmount: money(totals.contracted), dueAmount: money(totals.patient) } }, { session });
        }
      });
    } finally { await session.endSession(); }

    const locked = batch.lines.filter((line) => line.locked);
    if (locked.length) {
      const groups = new Map();
      for (const line of locked) {
        const invoiceId = await lockedLineInvoiceId(line, hospitalId);
        const group = groups.get(invoiceId) || { invoiceId, patientDelta: 0, sponsorDelta: 0, lines: [] };
        group.patientDelta += Number(line.delta?.patientLiability || 0);
        group.sponsorDelta += Number(line.delta?.sponsorLiability || 0);
        group.lines.push(line);
        groups.set(invoiceId, group);
      }
      let totalSponsorDelta = 0;
      for (const group of groups.values()) {
        group.patientDelta = money(group.patientDelta);
        group.sponsorDelta = money(group.sponsorDelta);
        totalSponsorDelta += group.sponsorDelta;
        const groupDocuments = [];
        if (group.patientDelta < -0.009) {
          const credit = await createCreditNote(group.invoiceId, {
            amount: Math.abs(group.patientDelta),
            reason: `Coverage repricing ${batch.batchNumber}`,
            idempotencyKey: `${batch.idempotencyKey}:patient-credit:${group.invoiceId}`
          }, req.user);
          generated.push(credit.creditNote._id); groupDocuments.push(credit.creditNote._id);
        }
        if (group.patientDelta > 0.009) {
          const invoice = await createAdjustmentInvoice({ batch, coverage, patientAmount: group.patientDelta, sponsorAmount: 0, reason: 'Patient liability increase after coverage repricing', user: req.user, linkedInvoiceId: group.invoiceId });
          if (invoice) { generated.push(invoice._id); groupDocuments.push(invoice._id); }
        }
        if (group.sponsorDelta > 0.009) {
          const invoice = await createAdjustmentInvoice({ batch, coverage, patientAmount: 0, sponsorAmount: group.sponsorDelta, reason: 'Sponsor liability created after coverage repricing', user: req.user, linkedInvoiceId: group.invoiceId });
          if (invoice) { generated.push(invoice._id); groupDocuments.push(invoice._id); }
        }
        // A negative sponsor delta is represented in the sponsor ledger; an
        // issued sponsor invoice is never silently rewritten. Coverage/package
        // utilization follows the approved economic allocation even though the
        // original issued document remains immutable.
        for (const line of group.lines) {
          const sourceType = line.sourceType === 'BillItem' ? 'BillItem' : 'IPDCharge';
          await reversePackageUtilization({
            hospitalId,
            sourceType,
            sourceId: line.sourceId,
            sourceLineId: line.sourceLineId,
            userId: req.user._id,
            reason: `Coverage repricing ${batch.batchNumber}`
          });
          await replaceCommittedCoverageLine({ line, coverage, batch, hospitalId, userId: req.user._id });
          await replayCommittedPackageLine({ line, coverage, batch, hospitalId, userId: req.user._id, episodeCache: new Map() });
          line.adjustmentStatus = 'created';
          line.generatedDocumentIds = groupDocuments;
        }
      }
      await sponsorLedgerAdjustment({ batch, coverage, amount: money(totalSponsorDelta), user: req.user });
    }
    batch.status = 'committed'; batch.committedBy = req.user._id; batch.committedAt = new Date(); await batch.save();
    await appendDomainEvent({
      req,
      eventType: 'coverage.repricing_committed',
      entityType: 'RepricingBatch',
      entityId: batch._id,
      hospitalId,
      patientId: batch.patientId,
      encounterId: batch.admissionId || batch.appointmentId,
      afterSummary: {
        batchNumber: batch.batchNumber,
        totals: batch.totals,
        generatedDocuments: generated,
        adminSelfApprovalOverride: Boolean(batch.commitOverride?.used)
      }
    });
    return batch;
  } catch (error) {
    batch.status = 'failed'; batch.error = error.message; batch.lines.forEach((line) => { if (line.locked && line.adjustmentStatus === 'pending') { line.adjustmentStatus = 'failed'; line.error = error.message; } }); await batch.save().catch(() => {}); throw error;
  }
}

module.exports = { preview, approve, commit, allocationFromQuote, beforeFromCharge, beforeFromBillItem, lineDelta, simulatedPackageDecision, packageInputFromSnapshot, quoteFromSnapshot, replaceCommittedCoverageLine };
