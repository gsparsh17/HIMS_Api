const crypto = require('crypto');
const mongoose = require('mongoose');
const ClaimCase = require('../models/ClaimCase');
const SponsorLedgerEntry = require('../models/SponsorLedgerEntry');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const Appointment = require('../models/Appointment');
const Bill = require('../models/Bill');
const Payer = require('../models/Payer');
const claimReadiness = require('./claimReadiness.service');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function badRequest(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function objectId(value) {
  if (!value) return undefined;
  return value instanceof mongoose.Types.ObjectId
    ? value
    : mongoose.Types.ObjectId.createFromHexString(String(value));
}

async function nextClaimNumber(hospitalId) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const prefix = `CLM-${date}-`;
  const latest = await ClaimCase.findOne({ hospitalId, claimNumber: new RegExp(`^${prefix}`) })
    .sort({ claimNumber: -1 })
    .select('claimNumber')
    .lean();
  const last = Number(String(latest?.claimNumber || '').split('-').at(-1) || 0);
  return `${prefix}${String(last + 1).padStart(5, '0')}`;
}

function nextLedgerNumber() {
  return `SLE-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function payerLedgerBalance(hospitalId, payerId, session) {
  const [row] = await SponsorLedgerEntry.aggregate([
    { $match: { hospitalId: objectId(hospitalId), payerId: objectId(payerId) } },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } }
  ]).session(session || null);
  return money(Number(row?.debit || 0) - Number(row?.credit || 0));
}

async function appendLedger({
  hospitalId,
  payerId,
  encounterType,
  admissionId,
  appointmentId,
  patientId,
  coverageId,
  claimId,
  invoiceId,
  chargeId,
  entryType,
  debit = 0,
  credit = 0,
  reference,
  reason,
  sourceType,
  sourceId,
  reversalOf,
  idempotencyKey,
  createdBy,
  session
}) {
  if (idempotencyKey) {
    const existing = await SponsorLedgerEntry.findOne({ hospitalId, idempotencyKey }).session(session || null);
    if (existing) return existing;
  }
  const prior = await payerLedgerBalance(hospitalId, payerId, session);
  const balanceAfter = money(Math.max(0, prior + Number(debit || 0) - Number(credit || 0)));
  const [entry] = await SponsorLedgerEntry.create([{
    hospitalId,
    payerId,
    encounterType,
    admissionId,
    appointmentId,
    patientId,
    coverageId,
    claimId,
    invoiceId,
    chargeId,
    entryNumber: nextLedgerNumber(),
    entryType,
    debit: money(debit),
    credit: money(credit),
    balanceAfter,
    reference,
    reason,
    sourceType,
    sourceId,
    reversalOf,
    idempotencyKey,
    createdBy
  }], { session });
  return entry;
}

function allocationFromCharge(charge) {
  return {
    lineNumber: 0,
    chargeId: charge._id,
    packageEpisodeId: charge.pricingSnapshot?.packageEpisodeId,
    serviceDate: charge.chargeDate || charge.createdAt,
    serviceType: charge.chargeType,
    description: charge.description,
    internalServiceModel: charge.pricingSnapshot?.internalServiceModel,
    internalServiceId: charge.pricingSnapshot?.internalServiceId,
    internalCode: charge.pricingSnapshot?.inputs?.internalCode || charge.sourceReference?.lineKey,
    payerCode: charge.pricingSnapshot?.serviceCode,
    quantity: Number(charge.quantity || 1),
    standardAmount: money(charge.standardAmount ?? charge.grossAmount),
    contractedAmount: money(charge.contractedAmount ?? charge.netAmount),
    eligibleAmount: money(charge.eligibleAmount ?? charge.contractedAmount ?? charge.netAmount),
    sponsorLiability: money(charge.sponsorLiability),
    patientLiability: money(charge.patientLiability),
    nonAdmissibleAmount: money(charge.nonAdmissibleAmount),
    contractualAdjustment: money(charge.contractualAdjustmentAmount),
    hospitalConcession: money(charge.hospitalConcessionAmount),
    submittedAmount: money(charge.sponsorLiability),
    pricingSnapshot: charge.pricingSnapshot
  };
}

function allocationFromBillItem(bill, item) {
  return {
    lineNumber: 0,
    billId: bill._id,
    billItemId: item._id,
    packageEpisodeId: item.pricing_snapshot?.packageEpisodeId,
    serviceDate: item.charge_date || bill.generated_at || bill.createdAt,
    serviceType: item.item_type,
    description: item.description,
    internalServiceModel: item.pricing_snapshot?.internalServiceModel,
    internalServiceId: item.pricing_snapshot?.internalServiceId,
    internalCode: item.procedure_code || item.lab_test_code || item.radiology_test_code,
    payerCode: item.pricing_snapshot?.serviceCode,
    quantity: Number(item.quantity || 1),
    standardAmount: money(item.standard_amount ?? item.gross_amount ?? item.amount),
    contractedAmount: money(item.contracted_amount ?? item.net_amount ?? item.amount),
    eligibleAmount: money(item.eligible_amount ?? item.contracted_amount ?? item.amount),
    sponsorLiability: money(item.sponsor_liability),
    patientLiability: money(item.patient_liability ?? item.amount),
    nonAdmissibleAmount: money(item.non_admissible_amount),
    contractualAdjustment: money(item.contractual_adjustment),
    hospitalConcession: money(item.hospital_concession),
    submittedAmount: money(item.sponsor_liability),
    pricingSnapshot: item.pricing_snapshot
  };
}

function deriveClaimSchemeData(coverage = {}) {
  const schemeType = String(coverage.payerCategory || coverage.payerId?.type || 'generic').toLowerCase();
  if (schemeType !== 'pmjay') return { schemeType, schemeData: {} };
  const source = coverage.schemeData?.pmjay || {};
  return {
    schemeType,
    schemeData: {
      pmjay: {
        pmjayCaseId: source.pmjayCaseId,
        abhaId: source.abhaId,
        beneficiaryId: source.beneficiaryId || coverage.beneficiary?.beneficiaryId || coverage.beneficiary?.schemeCardNumber,
        packageCode: source.packageCode || coverage.preAuthorisation?.requestedPackageCode,
        packageName: source.packageName,
        packageType: source.packageType,
        packageRate: source.packageRate,
        specialty: source.specialty || coverage.rateContext?.specialty,
        caseType: source.caseType,
        provisionalDiagnosis: source.provisionalDiagnosis,
        finalDiagnosis: source.finalDiagnosis,
        icd10Codes: source.icd10Codes || [],
        procedureCodes: source.procedureCodes || [],
        portability: Boolean(source.portability),
        homeState: source.homeState,
        treatingState: source.treatingState
      }
    }
  };
}

function summarizeLines(lines) {
  const sums = lines.reduce((acc, line) => {
    acc.standardAmount += Number(line.standardAmount || 0);
    acc.contractedAmount += Number(line.contractedAmount || 0);
    acc.eligibleAmount += Number(line.eligibleAmount || 0);
    acc.sponsorLiability += Number(line.sponsorLiability || 0);
    acc.patientLiability += Number(line.patientLiability || 0);
    acc.nonAdmissibleAmount += Number(line.nonAdmissibleAmount || 0);
    acc.contractualAdjustment += Number(line.contractualAdjustment || 0);
    acc.hospitalConcession += Number(line.hospitalConcession || 0);
    acc.claimSubmittedAmount += Number(line.submittedAmount || 0);
    acc.approvedSponsorAmount += Number(line.approvedAmount || 0);
    acc.deductedAmount += Number(line.deductedAmount || 0);
    acc.sponsorPaidAmount += Number(line.paidAmount || 0);
    return acc;
  }, {
    standardAmount: 0,
    contractedAmount: 0,
    eligibleAmount: 0,
    sponsorLiability: 0,
    patientLiability: 0,
    nonAdmissibleAmount: 0,
    contractualAdjustment: 0,
    hospitalConcession: 0,
    claimSubmittedAmount: 0,
    approvedSponsorAmount: 0,
    deductedAmount: 0,
    sponsorPaidAmount: 0
  });
  Object.keys(sums).forEach((key) => { sums[key] = money(sums[key]); });
  sums.outstandingSponsorAmount = money(Math.max(
    0,
    (sums.approvedSponsorAmount || sums.claimSubmittedAmount || sums.sponsorLiability) - sums.sponsorPaidAmount
  ));
  return sums;
}

async function resolveEncounter({ hospitalId, encounterType, admissionId, appointmentId, coverageId }) {
  const type = String(encounterType || (admissionId ? 'IPD' : 'OPD')).toUpperCase();
  let encounter;
  if (type === 'IPD') {
    encounter = await IPDAdmission.findOne({ _id: admissionId, hospitalId }).lean();
  } else {
    encounter = await Appointment.findOne({ _id: appointmentId, hospital_id: hospitalId }).lean();
  }
  if (!encounter) throw badRequest(`${type} encounter not found`, 404);

  const activeCoverageId = coverageId || encounter.coverageId;
  const coverageFilter = {
    hospitalId,
    encounterType: type,
    active: true,
    ...(activeCoverageId ? { _id: activeCoverageId } : {}),
    ...(type === 'IPD' ? { admissionId: encounter._id } : { appointmentId: encounter._id })
  };
  const coverage = await AdmissionCoverage.findOne(coverageFilter).populate('payerId').lean();
  if (!coverage || coverage.payerId?.type === 'self') {
    throw badRequest('Active non-cash coverage is required to create a claim', 409);
  }
  return {
    encounterType: type,
    encounter,
    coverage,
    patientId: type === 'IPD' ? encounter.patientId : encounter.patient_id
  };
}

async function loadEncounterLines({ hospitalId, encounterType, admissionId, appointmentId }) {
  let lines = [];
  if (encounterType === 'IPD') {
    const charges = await IPDCharge.find({
      hospitalId,
      admissionId,
      status: { $in: ['ACTIVE', 'INVOICED'] },
      sponsorLiability: { $gt: 0 }
    }).sort({ chargeDate: 1, createdAt: 1 }).lean();
    lines = charges.map(allocationFromCharge);
  } else {
    const bills = await Bill.find({
      hospital_id: hospitalId,
      appointment_id: appointmentId,
      status: { $nin: ['Cancelled', 'Refunded'] },
      'payer_allocation.sponsor_liability': { $gt: 0 }
    }).sort({ generated_at: 1 }).lean();
    for (const bill of bills) {
      for (const item of bill.items || []) {
        if (Number(item.sponsor_liability || 0) > 0) lines.push(allocationFromBillItem(bill, item));
      }
    }
  }
  return lines.map((line, index) => ({ ...line, lineNumber: index + 1 }));
}

async function createClaim({ hospitalId, body, user }) {
  const resolved = await resolveEncounter({ hospitalId, ...body });
  if (body.allowAdditionalClaim !== true) {
    const existing = await ClaimCase.findOne({
      hospitalId,
      coverageId: resolved.coverage._id,
      status: { $nin: ['cancelled', 'closed'] }
    }).select('_id claimNumber status').lean();
    if (existing) {
      throw badRequest(`An active claim (${existing.claimNumber}) already exists for this coverage`, 409);
    }
  }
  const lines = await loadEncounterLines({
    hospitalId,
    encounterType: resolved.encounterType,
    admissionId: resolved.encounterType === 'IPD' ? resolved.encounter._id : undefined,
    appointmentId: resolved.encounterType === 'OPD' ? resolved.encounter._id : undefined
  });
  if (!lines.length) throw badRequest('No sponsor-liable lines are available for this encounter', 409);
  const totals = summarizeLines(lines);
  const serviceDates = lines.map((line) => new Date(line.serviceDate || Date.now()).getTime()).filter(Number.isFinite);

  const scheme = deriveClaimSchemeData(resolved.coverage);
  return ClaimCase.create({
    hospitalId,
    claimNumber: await nextClaimNumber(hospitalId),
    encounterType: resolved.encounterType,
    admissionId: resolved.encounterType === 'IPD' ? resolved.encounter._id : undefined,
    appointmentId: resolved.encounterType === 'OPD' ? resolved.encounter._id : undefined,
    patientId: resolved.patientId,
    coverageId: resolved.coverage._id,
    payerId: resolved.coverage.payerId._id,
    type: body.type || 'cashless',
    schemeType: scheme.schemeType,
    schemeData: { ...scheme.schemeData, ...(body.schemeData || {}) },
    status: body.status || 'draft',
    servicePeriod: {
      from: new Date(Math.min(...serviceDates)),
      to: new Date(Math.max(...serviceDates))
    },
    preAuth: {
      requestNumber: resolved.coverage.preAuthorisation?.requestNumber,
      approvedAmount: resolved.coverage.preAuthorisation?.approvedAmount,
      status: resolved.coverage.preAuthorisation?.status
    },
    amounts: totals,
    lines,
    documents: body.documents || [],
    createdBy: user._id,
    updatedBy: user._id
  });
}

async function refreshClaim({ hospitalId, claimId, user }) {
  const claim = await ClaimCase.findOne({ _id: claimId, hospitalId });
  if (!claim) throw badRequest('Claim not found', 404);
  if (!['draft', 'documents_pending', 'ready'].includes(claim.status)) {
    throw badRequest('Only an unsubmitted claim can be rebuilt', 409);
  }
  const oldBySource = new Map((claim.lines || []).map((line) => [
    String(line.chargeId || `${line.billId}:${line.billItemId}`),
    line
  ]));
  const fresh = await loadEncounterLines({
    hospitalId,
    encounterType: claim.encounterType,
    admissionId: claim.admissionId,
    appointmentId: claim.appointmentId
  });
  claim.lines = fresh.map((line) => {
    const previous = oldBySource.get(String(line.chargeId || `${line.billId}:${line.billItemId}`));
    return previous ? { ...line, admissibilityStatus: previous.admissibilityStatus, deductionReason: previous.deductionReason } : line;
  });
  claim.amounts = summarizeLines(claim.lines);
  claim.updatedBy = user._id;
  claim.revision += 1;
  await claim.save();
  return claim;
}

async function ensureReceivableAtSubmission({ claim, payer, user, session }) {
  const amount = money(claim.amounts.claimSubmittedAmount || claim.amounts.sponsorLiability);
  if (amount <= 0) return null;

  // Principal already recognised from issued documents or an earlier claim action.
  // Settlement and deduction credits are deliberately excluded: they reconcile the
  // receivable after recognition and must not cause it to be recognised a second time.
  const [principal] = await SponsorLedgerEntry.aggregate([
    {
      $match: {
        hospitalId: objectId(claim.hospitalId),
        coverageId: objectId(claim.coverageId),
        $or: [
          { entryType: 'receivable' },
          { entryType: { $in: ['debit_adjustment', 'credit_adjustment', 'reversal'] }, sourceType: { $in: ['invoice', 'repricing', 'claim', 'reversal'] } }
        ]
      }
    },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } }
  ]).session(session || null);
  const recognised = money(Number(principal?.debit || 0) - Number(principal?.credit || 0));
  const delta = money(amount - recognised);
  if (delta <= 0) return null;

  const policy = payer?.pricingPolicy?.receivableRecognition || 'invoice_issue';
  return appendLedger({
    hospitalId: claim.hospitalId,
    payerId: claim.payerId,
    encounterType: claim.encounterType,
    admissionId: claim.admissionId,
    appointmentId: claim.appointmentId,
    patientId: claim.patientId,
    coverageId: claim.coverageId,
    claimId: claim._id,
    entryType: 'receivable',
    debit: delta,
    reference: claim.claimNumber,
    reason: policy === 'claim_submission'
      ? 'Sponsor receivable recognized at claim submission'
      : 'Sponsor receivable reconciliation for unrecognized claim principal',
    sourceType: 'claim',
    sourceId: claim._id,
    idempotencyKey: `claim:${claim._id}:receivable`,
    createdBy: user._id,
    session
  });
}

async function submitClaim({ hospitalId, claimId, amount, user }) {
  const readiness = await claimReadiness.evaluateAndPersist({ hospitalId, claimId, user });
  const claimBeforeSubmit = await ClaimCase.findOne({ _id: claimId, hospitalId }).select('readiness').lean();
  const overrideActive = Boolean(claimBeforeSubmit?.readiness?.override?.active);
  if (readiness.status === 'blocked' && !overrideActive) {
    const error = badRequest('Claim readiness is blocked. Resolve critical issues or record an authorized readiness override before submission.', 422);
    error.readiness = readiness;
    throw error;
  }
  const session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const claim = await ClaimCase.findOne({ _id: claimId, hospitalId }).session(session);
      if (!claim) throw badRequest('Claim not found', 404);
      if (!['draft', 'documents_pending', 'ready', 'query'].includes(claim.status)) {
        throw badRequest('Claim cannot be submitted in its current status', 409);
      }
      const payer = await Payer.findOne({ _id: claim.payerId, hospitalId }).session(session);
      const submittedAmount = money(amount ?? claim.amounts.sponsorLiability);
      const lineSponsor = money((claim.lines || []).reduce((sum, line) => sum + Number(line.sponsorLiability || 0), 0));
      if (submittedAmount < 0 || submittedAmount > lineSponsor) {
        throw badRequest(`Submitted amount must be between 0 and ${lineSponsor}`);
      }
      claim.status = 'submitted';
      claim.submittedAt = new Date();
      claim.submittedBy = user._id;
      claim.amounts.claimSubmittedAmount = submittedAmount;
      claim.amounts.outstandingSponsorAmount = submittedAmount;
      claim.updatedBy = user._id;
      claim.revision += 1;
      await claim.save({ session });
      await ensureReceivableAtSubmission({ claim, payer, user, session });
      if (claim.encounterType === 'IPD') {
        await IPDAdmission.updateOne(
          { _id: claim.admissionId, hospitalId },
          { $set: { claimSubmittedAmount: submittedAmount } },
          { session }
        );
      }
      saved = claim;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

async function adjudicateClaim({ hospitalId, claimId, body, user }) {
  const session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const claim = await ClaimCase.findOne({ _id: claimId, hospitalId }).session(session);
      if (!claim) throw badRequest('Claim not found', 404);
      if (!['submitted', 'query', 'partially_approved', 'approved', 'settlement_pending', 'partially_settled'].includes(claim.status)) {
        throw badRequest('Claim is not in an adjudicable state', 409);
      }
      const previousDeduction = money(claim.amounts.deductedAmount);
      const changes = new Map((body.lines || []).map((line) => [String(line.lineId || line._id), line]));
      for (const line of claim.lines) {
        const patch = changes.get(String(line._id));
        if (!patch) continue;
        const submitted = money(line.submittedAmount || line.sponsorLiability);
        const approved = money(patch.approvedAmount ?? line.approvedAmount);
        const deducted = money(patch.deductedAmount ?? Math.max(0, submitted - approved));
        if (approved < 0 || deducted < 0 || approved + deducted > submitted + 0.01) {
          throw badRequest(`Invalid adjudication for line ${line.lineNumber}`);
        }
        line.approvedAmount = approved;
        line.deductedAmount = deducted;
        line.admissibilityStatus = patch.admissibilityStatus || (
          approved === 0 ? 'non_admissible' : approved < submitted ? 'partially_admissible' : 'admissible'
        );
        line.deductionReason = patch.deductionReason;
      }
      const totals = summarizeLines(claim.lines);
      claim.amounts.approvedSponsorAmount = money(body.approvedSponsorAmount ?? totals.approvedSponsorAmount);
      claim.amounts.deductedAmount = money(body.deductedAmount ?? totals.deductedAmount);
      claim.amounts.outstandingSponsorAmount = money(Math.max(0, claim.amounts.approvedSponsorAmount - claim.amounts.sponsorPaidAmount));
      claim.adjudicationStatus = claim.amounts.approvedSponsorAmount <= 0
        ? 'rejected'
        : claim.amounts.approvedSponsorAmount < claim.amounts.claimSubmittedAmount
          ? 'partially_approved'
          : 'approved';
      claim.status = claim.amounts.approvedSponsorAmount > 0 ? 'settlement_pending' : 'rejected';
      claim.updatedBy = user._id;
      claim.revision += 1;
      await claim.save({ session });

      const deductionDelta = money(claim.amounts.deductedAmount - previousDeduction);
      if (deductionDelta !== 0) {
        await appendLedger({
          hospitalId,
          payerId: claim.payerId,
          encounterType: claim.encounterType,
          admissionId: claim.admissionId,
          appointmentId: claim.appointmentId,
          patientId: claim.patientId,
          coverageId: claim.coverageId,
          claimId: claim._id,
          entryType: deductionDelta > 0 ? 'deduction' : 'debit_adjustment',
          debit: deductionDelta < 0 ? Math.abs(deductionDelta) : 0,
          credit: deductionDelta > 0 ? deductionDelta : 0,
          reference: claim.claimNumber,
          reason: body.note || (deductionDelta > 0 ? 'Payer deduction/adjudication' : 'Payer deduction revised downward'),
          sourceType: 'claim',
          sourceId: claim._id,
          idempotencyKey: `claim:${claim._id}:deduction:r${claim.revision}`,
          createdBy: user._id,
          session
        });
      }
      saved = claim;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

async function recordSettlement({ hospitalId, claimId, body, user }) {
  const amount = money(body.amount);
  if (amount <= 0) throw badRequest('Settlement amount must be greater than zero');
  const session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const claim = await ClaimCase.findOne({ _id: claimId, hospitalId }).session(session);
      if (!claim) throw badRequest('Claim not found', 404);
      if (!['approved', 'partially_approved', 'settlement_pending', 'partially_settled'].includes(claim.status)) {
        throw badRequest('Claim is not awaiting settlement', 409);
      }
      const approved = money(body.approvedSponsorAmount ?? claim.amounts.approvedSponsorAmount ?? claim.amounts.claimSubmittedAmount);
      const previousPaid = money(claim.amounts.sponsorPaidAmount);
      if (previousPaid + amount > approved + 0.01) throw badRequest('Settlement exceeds approved sponsor amount');
      claim.settlements.push({
        amount,
        receivedAt: body.receivedAt || new Date(),
        reference: body.reference,
        method: body.method,
        recordedBy: user._id
      });
      claim.amounts.approvedSponsorAmount = approved;
      claim.amounts.sponsorPaidAmount = money(previousPaid + amount);
      claim.amounts.outstandingSponsorAmount = money(Math.max(0, approved - claim.amounts.sponsorPaidAmount));
      const approvedLines = (claim.lines || []).filter((line) => Number(line.approvedAmount || 0) > 0);
      let remainingSettlement = amount;
      approvedLines.forEach((line, index) => {
        const outstanding = money(Math.max(0, Number(line.approvedAmount || 0) - Number(line.paidAmount || 0)));
        const share = index === approvedLines.length - 1
          ? money(Math.min(outstanding, remainingSettlement))
          : money(Math.min(outstanding, amount * Number(line.approvedAmount || 0) / Math.max(approved, 0.01)));
        line.paidAmount = money(Number(line.paidAmount || 0) + share);
        remainingSettlement = money(Math.max(0, remainingSettlement - share));
      });
      claim.status = claim.amounts.outstandingSponsorAmount === 0 ? 'settled' : 'partially_settled';
      if (claim.status === 'settled') {
        claim.closedAt = new Date();
        claim.closedBy = user._id;
      }
      claim.updatedBy = user._id;
      claim.revision += 1;
      await claim.save({ session });

      await appendLedger({
        hospitalId,
        payerId: claim.payerId,
        encounterType: claim.encounterType,
        admissionId: claim.admissionId,
        appointmentId: claim.appointmentId,
        patientId: claim.patientId,
        coverageId: claim.coverageId,
        claimId: claim._id,
        entryType: 'settlement',
        credit: amount,
        reference: body.reference || claim.claimNumber,
        reason: body.note || 'Sponsor settlement',
        sourceType: 'settlement',
        sourceId: claim._id,
        idempotencyKey: body.idempotencyKey || `claim:${claim._id}:settlement:${body.reference || claim.revision}`,
        createdBy: user._id,
        session
      });

      if (claim.encounterType === 'IPD') {
        await IPDAdmission.updateOne(
          { _id: claim.admissionId, hospitalId },
          { $set: {
            approvedSponsorAmount: approved,
            sponsorPaidAmount: claim.amounts.sponsorPaidAmount,
            sponsorReceivable: claim.amounts.outstandingSponsorAmount
          } },
          { session }
        );
      }
      saved = claim;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

async function cancelClaim({ hospitalId, claimId, reason, user }) {
  const session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const claim = await ClaimCase.findOne({ _id: claimId, hospitalId }).session(session);
      if (!claim) throw badRequest('Claim not found', 404);
      if (claim.status === 'cancelled') { saved = claim; return; }
      if (Number(claim.amounts.sponsorPaidAmount || 0) > 0) {
        throw badRequest('Settled claim cannot be cancelled; record a settlement reversal first', 409);
      }

      // Only reverse ledger entries created by this claim. Invoice-origin receivables
      // remain valid because cancelling a claim does not cancel the underlying invoice.
      const entries = await SponsorLedgerEntry.find({
        hospitalId,
        claimId: claim._id,
        sourceType: 'claim',
        entryType: { $ne: 'reversal' }
      }).session(session);
      for (const entry of entries) {
        await appendLedger({
          hospitalId,
          payerId: claim.payerId,
          encounterType: claim.encounterType,
          admissionId: claim.admissionId,
          appointmentId: claim.appointmentId,
          patientId: claim.patientId,
          coverageId: claim.coverageId,
          claimId: claim._id,
          entryType: 'reversal',
          debit: money(entry.credit),
          credit: money(entry.debit),
          reference: claim.claimNumber,
          reason: reason || `Reversal of claim ledger entry ${entry.entryNumber}`,
          sourceType: 'reversal',
          sourceId: claim._id,
          reversalOf: entry._id,
          idempotencyKey: `claim:${claim._id}:cancel:reverse:${entry._id}`,
          createdBy: user._id,
          session
        });
        await SponsorLedgerEntry.updateOne({ _id: entry._id }, { $set: { reconciliationStatus: 'reconciled' } }, { session });
      }

      claim.status = 'cancelled';
      claim.cancelledAt = new Date();
      claim.cancelledBy = user._id;
      claim.cancellationReason = reason;
      claim.closedAt = new Date();
      claim.closedBy = user._id;
      claim.updatedBy = user._id;
      claim.amounts.outstandingSponsorAmount = 0;
      claim.revision += 1;
      await claim.save({ session });
      saved = claim;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

function dateFilter(query, field = 'createdAt') {
  const range = {};
  if (query.from) range.$gte = new Date(query.from);
  if (query.to) {
    const to = new Date(query.to);
    if (String(query.to).length <= 10) to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }
  return Object.keys(range).length ? { [field]: range } : {};
}

function claimFilter(hospitalId, query = {}) {
  return {
    hospitalId,
    ...dateFilter(query, query.dateField === 'service' ? 'servicePeriod.from' : 'createdAt'),
    ...(query.status ? { status: { $in: String(query.status).split(',') } } : {}),
    ...(query.payerId ? { payerId: query.payerId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.encounterType ? { encounterType: String(query.encounterType).toUpperCase() } : {})
  };
}

async function report({ hospitalId, query }) {
  const filter = claimFilter(hospitalId, query);
  const claims = await ClaimCase.find(filter)
    .populate('payerId', 'code name type')
    .populate('patientId', 'first_name last_name patientId uhid')
    .populate('admissionId', 'admissionNumber admissionDate dischargeDate')
    .populate('appointmentId', 'token appointment_date')
    .sort({ createdAt: -1 })
    .lean();

  const rows = [];
  for (const claim of claims) {
    for (const line of claim.lines || []) {
      rows.push({
        claimNumber: claim.claimNumber,
        claimStatus: claim.status,
        encounterType: claim.encounterType,
        encounterNumber: claim.admissionId?.admissionNumber || claim.appointmentId?.token || '',
        patientId: claim.patientId?.patientId || claim.patientId?.uhid || '',
        patientName: [claim.patientId?.first_name, claim.patientId?.last_name].filter(Boolean).join(' '),
        payerCode: claim.payerId?.code || '',
        payerName: claim.payerId?.name || '',
        serviceDate: line.serviceDate,
        serviceType: line.serviceType,
        description: line.description,
        internalCode: line.internalCode,
        payerCodeLine: line.payerCode,
        standardAmount: money(line.standardAmount),
        contractedAmount: money(line.contractedAmount),
        eligibleAmount: money(line.eligibleAmount),
        sponsorLiability: money(line.sponsorLiability),
        patientLiability: money(line.patientLiability),
        nonAdmissibleAmount: money(line.nonAdmissibleAmount),
        contractualAdjustment: money(line.contractualAdjustment),
        hospitalConcession: money(line.hospitalConcession),
        submittedAmount: money(line.submittedAmount),
        approvedAmount: money(line.approvedAmount),
        deductedAmount: money(line.deductedAmount),
        paidAmount: money(line.paidAmount)
      });
    }
  }

  const summaryByPayer = new Map();
  for (const claim of claims) {
    const key = String(claim.payerId?._id || claim.payerId || 'unknown');
    const current = summaryByPayer.get(key) || {
      payerId: key,
      payerCode: claim.payerId?.code || '',
      payerName: claim.payerId?.name || '',
      claims: 0,
      submitted: 0,
      approved: 0,
      paid: 0,
      outstanding: 0,
      deductions: 0,
      patientLiability: 0
    };
    current.claims += 1;
    current.submitted += Number(claim.amounts?.claimSubmittedAmount || 0);
    current.approved += Number(claim.amounts?.approvedSponsorAmount || 0);
    current.paid += Number(claim.amounts?.sponsorPaidAmount || 0);
    current.outstanding += Number(claim.amounts?.outstandingSponsorAmount || 0);
    current.deductions += Number(claim.amounts?.deductedAmount || 0);
    current.patientLiability += Number(claim.amounts?.patientLiability || 0);
    summaryByPayer.set(key, current);
  }
  const summary = Array.from(summaryByPayer.values()).map((row) => {
    Object.keys(row).forEach((key) => {
      if (typeof row[key] === 'number' && key !== 'claims') row[key] = money(row[key]);
    });
    return row;
  });
  return { claims, rows, summary };
}

async function ledgerReport({ hospitalId, query }) {
  const filter = {
    hospitalId,
    ...dateFilter(query, 'occurredAt'),
    ...(query.payerId ? { payerId: query.payerId } : {}),
    ...(query.claimId ? { claimId: query.claimId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.admissionId ? { admissionId: query.admissionId } : {}),
    ...(query.appointmentId ? { appointmentId: query.appointmentId } : {})
  };
  return SponsorLedgerEntry.find(filter)
    .populate('payerId', 'code name')
    .populate('patientId', 'first_name last_name patientId uhid')
    .populate('claimId', 'claimNumber status')
    .populate('admissionId', 'admissionNumber')
    .populate('appointmentId', 'token')
    .sort({ occurredAt: 1, createdAt: 1 })
    .lean();
}

module.exports = {
  money,
  badRequest,
  summarizeLines,
  createClaim,
  refreshClaim,
  submitClaim,
  adjudicateClaim,
  recordSettlement,
  cancelClaim,
  claimFilter,
  deriveClaimSchemeData,
  report,
  ledgerReport,
  appendLedger
};
