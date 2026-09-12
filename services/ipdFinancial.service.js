const { operationNow } = require('../utils/operationTimeContext');
const { hospitalDateKey } = require('../utils/hospitalDateTime');
const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const Patient = require('../models/Patient');
const IPDCharge = require('../models/IPDCharge');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const FinancialTransaction = require('../models/FinancialTransaction');
const ApprovalRequest = require('../models/ApprovalRequest');
const ClaimCase = require('../models/ClaimCase');
const DischargeSummary = require('../models/DischargeSummary');
const Sale = require('../models/Sale');
const { money, nextFinancialNumber } = require('../utils/financeNumbers');
const { quotePricing, pricingSnapshot } = require('./pricingEngine.service');
const { resolveFinancialPolicy, loadFinancialPolicy } = require('./financialPolicy.service');
const { activatePackageEpisode, recordPackageUtilization, reversePackageUtilization } = require('./packageAdjudication.service');
const { activeCoverage } = require('./coverage.service');
const { replaceCoverageUtilization, reverseCoverageUtilization } = require('./coverageUtilization.service');
const SponsorLedgerEntry = require('../models/SponsorLedgerEntry');
const claimService = require('./claim.service');
const Hospital = require('../models/Hospital');
const { userHospitalId } = require('../utils/hospitalScope');
const { syncChargesInvoiced } = require('./sourceBillingSync.service');
const { ensureAdmissionDailyCharges } = require('./ipdRecurringCharge.service');
const { loadIPDWorkflowPolicy, stageBefore } = require('./ipdWorkflowPolicy.service');
const { _hasActionPermission } = require('../middlewares/auth');
const { assertAdmissionOpenForMutation } = require('./ipdLifecycleGuard.service');
const { policyFromAdmission, ipdOwnsPharmacyBilling } = require('./ipdPharmacyBillingPolicy.service');

const ACTIVE_CHARGE_FILTER = {
  $or: [
    { status: { $exists: false } },
    { status: 'ACTIVE' },
    { status: 'INVOICED' }
  ]
};

const UNBILLED_CHARGE_FILTER = {
  isBilled: false,
  $or: [
    { status: { $exists: false } },
    { status: 'ACTIVE' }
  ]
};

const FINANCE_PAYMENT_METHODS = [
  'Cash',
  'Card',
  'UPI',
  'Net Banking',
  'Insurance',
  'Government Scheme',
  'Bank',
  'IPDAdvance',
  'PharmacyAdvance',
  'Adjustment',
  'Split'
];

const EXTERNAL_PAYMENT_METHODS = new Set([
  'Cash',
  'Card',
  'UPI',
  'Net Banking',
  'Insurance',
  'Government Scheme',
  'Bank'
]);

function assertAmount(value, label = 'Amount') {
  const amount = money(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error(`${label} must be greater than zero`);
    error.statusCode = 400;
    throw error;
  }

  return amount;
}




async function assertSettlementDiscountPolicy({ hospitalId, user, baseAmount, discountAmount, reason }) {
  const amount = money(discountAmount || 0);
  if (amount <= 0) return;
  const policy = await loadFinancialPolicy(hospitalId);
  const discount = policy.discount || {};
  const override = _hasActionPermission(user, 'discount_override');
  if (discount.enabled === false) {
    const error = new Error('Discounts are disabled by hospital financial policy'); error.statusCode = 409; throw error;
  }
  if (!_hasActionPermission(user, 'billing_apply_discount') && !override) {
    const error = new Error('Final settlement discount requires billing_apply_discount permission'); error.statusCode = 403; throw error;
  }
  const role = String(user?.role || '').toLowerCase();
  const hospitalMax = Math.max(0, Math.min(100, Number(discount.maxPercentage ?? 0)));
  const roleMax = ['accountant', 'finance', 'finance_staff', 'insurance_desk'].includes(role)
    ? Math.max(0, Math.min(hospitalMax, Number(discount.financeMaxPercentage ?? hospitalMax)))
    : Math.max(0, Math.min(hospitalMax, Number(discount.registrarMaxPercentage ?? hospitalMax)));
  const percent = Number(baseAmount || 0) > 0 ? money(amount / Number(baseAmount) * 100) : 100;
  if (!override && percent > roleMax + 0.0001) {
    const error = new Error(`Final settlement discount exceeds the permitted ${roleMax}% ceiling`); error.statusCode = 409; error.code = 'DISCOUNT_ABOVE_ALLOWED_RANGE'; throw error;
  }
  const maxFixed = Number(discount.maxFixedAmount || 0);
  if (!override && maxFixed > 0 && amount > maxFixed + 0.01) {
    const error = new Error(`Final settlement discount exceeds the configured ₹${money(maxFixed)} fixed ceiling`); error.statusCode = 409; error.code = 'DISCOUNT_ABOVE_ALLOWED_RANGE'; throw error;
  }
  if (!String(reason || '').trim()) {
    const error = new Error('Final settlement discount reason is required'); error.statusCode = 400; throw error;
  }
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function idempotencyQuery(key) {
  const escaped = escapeRegex(key);
  return { $regex: new RegExp(`^${escaped}(?::|$)`) };
}

function optionalMoney(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? money(parsed) : money(fallback);
}

function externalReceiptAmount(transaction = {}) {
  if (String(transaction.transactionType || '').toUpperCase() !== 'RECEIPT') return 0;
  if (transaction.externalMoneyMovement === false) return 0;
  const settled = money(transaction.amount || 0);
  const advanceApplied = money(transaction.advanceApplied || 0);
  // Legacy mixed receipts stored amountReceived as the full settled amount.
  if (advanceApplied > 0) return money(Math.max(0, settled - advanceApplied));
  const recorded = money(transaction.amountReceived || 0);
  return recorded > 0 ? money(Math.min(recorded, settled || recorded)) : settled;
}

function normalizePaymentBreakdown(payload = {}, amount = 0) {
  const rows = Array.isArray(payload.paymentBreakdown)
    ? payload.paymentBreakdown
    : Array.isArray(payload.payments)
      ? payload.payments
      : [];
  const cleaned = rows
    .map((row) => ({
      method: row?.method || row?.paymentMethod,
      amount: optionalMoney(row?.amount),
      reference: row?.reference || row?.paymentReference || ''
    }))
    .filter((row) => row.method && row.amount > 0);
  if (cleaned.length) {
    const total = money(cleaned.reduce((sum, row) => sum + row.amount, 0));
    if (amount > 0 && Math.abs(total - amount) > 0.01) {
      const error = new Error('Split payment total must equal the payment amount');
      error.statusCode = 400;
      throw error;
    }
    return cleaned;
  }
  return amount > 0 ? [{ method: payload.paymentMethod || 'Cash', amount, reference: payload.reference || '' }] : [];
}


const ADVANCE_SETTLEMENT_METHODS = new Set(['IPDAdvance', 'PharmacyAdvance', 'OPDAdvance']);
const NON_CASH_SETTLEMENT_METHODS = new Set([...ADVANCE_SETTLEMENT_METHODS, 'Adjustment']);

function paymentBreakdownTotal(rows = []) {
  return money((rows || []).reduce((sum, row) => sum + optionalMoney(row?.amount), 0));
}

function externalBreakdownTotal(rows = []) {
  return money((rows || []).reduce((sum, row) => (
    NON_CASH_SETTLEMENT_METHODS.has(String(row?.method || '')) ? sum : sum + optionalMoney(row?.amount)
  ), 0));
}

function allocateBreakdownAcrossPlan(breakdown = [], plan = []) {
  const remaining = (breakdown || []).map((row) => ({ ...row, amount: optionalMoney(row.amount) }));
  return plan.map((entry) => {
    let needed = money(entry.amount);
    const rows = [];
    for (const source of remaining) {
      if (needed <= 0) break;
      if (source.amount <= 0) continue;
      const applied = money(Math.min(needed, source.amount));
      if (applied <= 0) continue;
      rows.push({ method: source.method, amount: applied, reference: source.reference || '' });
      source.amount = money(source.amount - applied);
      needed = money(needed - applied);
    }
    if (needed > 0.01) {
      const error = new Error('Unable to allocate payment methods across selected invoices');
      error.statusCode = 409;
      throw error;
    }
    return { ...entry, breakdown: rows };
  });
}

function activeAuthorisedCredit(invoice = {}) {
  if (String(invoice.credit_status || '').toUpperCase() !== 'AUTHORIZED') return 0;
  return money(Math.min(Number(invoice.balance_due || 0), Number(invoice.credit_authorised_amount || 0)));
}

function requestedDeferredCredit(payload = {}) {
  return optionalMoney(
    payload.deferredCreditAmount ?? payload.creditAmount ?? payload.deferredAmount ?? 0
  );
}

function patientInvoiceLine(charge) {
  const patientNet = money(charge.patientLiability ?? charge.netAmount ?? 0);
  const chargeNet = money(charge.netAmount ?? patientNet);
  const ratio = chargeNet > 0 ? Math.max(0, Math.min(1, patientNet / chargeNet)) : 1;
  const discount = money(Number(charge.discountAmount ?? charge.discount ?? 0) * ratio);
  const tax = money(Number(charge.taxAmount ?? charge.tax ?? 0) * ratio);
  const taxable = money(Number(charge.taxableAmount ?? Math.max(0, Number(charge.grossAmount || charge.amount || 0) - Number(charge.discountAmount || charge.discount || 0))) * ratio);
  const gross = money(taxable + discount);
  return {
    chargeId: charge._id,
    description: charge.description,
    chargeType: charge.chargeType,
    chargeHead: charge.chargeType,
    chargeDate: charge.chargeDate,
    quantity: Number(charge.quantity || 1),
    gross,
    discount,
    taxable,
    tax,
    net: patientNet,
    discountType: charge.discountType || charge.discountDetails?.type || 'fixed',
    discountRate: Number(charge.discountRate ?? charge.discountDetails?.rate ?? 0),
    discountReason: charge.discountReason || charge.discountDetails?.reason,
    taxMode: charge.taxMode || charge.taxDetails?.mode || 'exclusive',
    taxName: charge.taxName || charge.taxDetails?.name,
    taxCode: charge.taxCode || charge.taxDetails?.code,
    taxRate: Number(charge.taxRate ?? charge.taxDetails?.rate ?? 0),
    sourceSnapshot: {
      sourceModule: charge.sourceModule,
      sourceId: charge.sourceId,
      sourceReference: charge.sourceReference,
      pricingSnapshot: charge.pricingSnapshot
    }
  };
}

function allocationPlan(invoices, amount, payload = {}) {
  let remaining = money(amount);
  const requestedInvoiceId = payload.invoiceId ? String(payload.invoiceId) : null;
  const eligible = invoices.filter((invoice) => {
    if (requestedInvoiceId && String(invoice._id) !== requestedInvoiceId) return false;
    return Number(invoice.balance_due || 0) > 0;
  });
  const outstanding = money(eligible.reduce((sum, invoice) => sum + Number(invoice.balance_due || 0), 0));
  if (remaining > outstanding + 0.01) {
    const error = new Error('Payment amount cannot exceed the selected invoice outstanding');
    error.statusCode = 400;
    throw error;
  }
  const plan = [];
  for (const invoice of eligible) {
    if (remaining <= 0) break;
    const applied = money(Math.min(remaining, Number(invoice.balance_due || 0)));
    if (applied > 0) plan.push({ invoice, amount: applied });
    remaining = money(remaining - applied);
  }
  if (remaining > 0.01) {
    const error = new Error('Unable to allocate the complete payment amount');
    error.statusCode = 409;
    throw error;
  }
  return plan;
}

async function financialPrintSnapshots(admission, session) {
  const [patient, hospital] = await Promise.all([
    mongoose.model('Patient').findById(admission.patientId, null, sessionOptions(session)).lean(),
    Hospital.findById(admission.hospitalId, null, sessionOptions(session)).lean()
  ]);
  const patientName = [patient?.salutation, patient?.first_name, patient?.middle_name, patient?.last_name].filter(Boolean).join(' ');
  return {
    patientSnapshot: patient ? {
      id: patient._id,
      uhid: patient.uhid || patient.patientId,
      name: patientName,
      firstName: patient.first_name,
      middleName: patient.middle_name,
      lastName: patient.last_name,
      dob: patient.dob,
      dobPrecision: patient.dobPrecision,
      ageEntrySource: patient.ageEntrySource,
      enteredAgeYears: patient.enteredAgeYears,
      enteredAgeMonths: patient.enteredAgeMonths,
      enteredAgeDays: patient.enteredAgeDays,
      ageAsOf: patient.ageAsOf,
      age: patient.age,
      gender: patient.gender,
      phone: patient.phone,
      address: patient.address,
      city: patient.city,
      state: patient.state,
      zipCode: patient.zipCode,
      village: patient.village,
      district: patient.district,
      tehsil: patient.tehsil,
      emergency_contact: patient.emergency_contact,
      emergency_phone: patient.emergency_phone,
      emergency_relationship: patient.emergency_relationship
    } : { id: admission.patientId },
    admissionSnapshot: {
      id: admission._id,
      admissionNumber: admission.admissionNumber,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate,
      admissionType: admission.admissionType,
      dischargeType: admission.dischargeType,
      primaryDoctorId: admission.primaryDoctorId,
      wardId: admission.wardId,
      roomId: admission.roomId,
      bedId: admission.bedId
    },
    hospitalSnapshot: hospital ? {
      id: hospital._id,
      name: hospital.hospitalName || hospital.name,
      address: hospital.address,
      city: hospital.city,
      state: hospital.state,
      pinCode: hospital.pinCode,
      contact: hospital.contact,
      email: hospital.email,
      logo: hospital.logo,
      registryNo: hospital.registryNo
    } : { id: admission.hospitalId }
  };
}

function dateKey(value = operationNow()) {
  return hospitalDateKey(value);
}

async function syncLinkedBillFromInvoice(invoice, paymentMethod, session) {
  if (!invoice?.bill_id) return null;

  const linkedBill = await Bill.findById(invoice.bill_id, null, sessionOptions(session));
  if (!linkedBill) return null;

  // The invoice is the authoritative settlement document. Mirror its financial
  // state to the linked bill so bill cards and invoice cards cannot disagree.
  linkedBill.paid_amount = money(invoice.amount_paid || 0);
  linkedBill.advance_applied = money(invoice.advance_applied || 0);
  linkedBill.settlement_discount_amount = money(invoice.settlement_discount_amount || 0);
  linkedBill.credit_note_amount = money(invoice.credit_note_total || 0);
  linkedBill.refund_amount = money(invoice.refunded_amount || 0);
  linkedBill.credit_authorised_amount = money(invoice.credit_authorised_amount || 0);
  linkedBill.credit_status = invoice.credit_status || linkedBill.credit_status || 'NONE';
  linkedBill.credit_due_date = invoice.credit_due_date || linkedBill.credit_due_date;
  linkedBill.credit_reason = invoice.credit_reason || linkedBill.credit_reason;
  linkedBill.credit_reference = invoice.credit_reference || linkedBill.credit_reference;
  linkedBill.balance_due = money(invoice.balance_due || 0);
  linkedBill.payment_method = paymentMethod || linkedBill.payment_method || 'Pending';
  await linkedBill.save(sessionOptions(session));

  return linkedBill;
}

function serviceTypeForCharge(chargeType) {
  if (chargeType === 'Consultation' || chargeType === 'Doctor Visit') {
    return 'Consultation';
  }

  if (chargeType === 'Procedure' || chargeType === 'Surgery') {
    return 'Procedure';
  }

  if (chargeType === 'Lab Test') {
    return 'Lab Test';
  }

  if (chargeType === 'Radiology') {
    return 'Radiology';
  }

  return 'Other';
}

function chargeItemType(chargeType) {
  if (chargeType === 'Lab Test') return 'Lab Test';
  if (chargeType === 'Radiology') return 'Radiology';
  if (chargeType === 'Procedure' || chargeType === 'Surgery') return 'Procedure';
  if (chargeType === 'Pharmacy') return 'Pharmacy';
  if (chargeType === 'Consultation' || chargeType === 'Doctor Visit') return 'Consultation';
  return 'Other';
}

function hospitalIdFor(admission, user) {
  return admission?.hospitalId || user?.hospital_id || undefined;
}

const PHARMACY_CONTROLLED_INVOICE_TYPES = ['Pharmacy', 'Medicine Return', 'Pharmacy Advance Credit'];

function invoiceFilterForAdmission(admissionId) {
  // All issued patient-facing documents linked to the admission. This is used
  // for display/audit only; IPD settlement uses ipdCollectibleInvoiceFilterForAdmission
  // so Pharmacy documents can never be collected twice by Billing.
  return {
    admission_id: admissionId,
    is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Refunded'] },
    invoice_type: { $nin: ['Purchase', 'Credit Note'] },
    document_stage: { $ne: 'VOID' }
  };
}

function ipdCollectibleInvoiceFilterForAdmission(admissionId) {
  return {
    admission_id: admissionId,
    is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Refunded'] },
    invoice_type: { $nin: ['Purchase', 'Credit Note', ...PHARMACY_CONTROLLED_INVOICE_TYPES] },
    is_pharmacy_sale: { $ne: true },
    document_stage: { $ne: 'VOID' }
  };
}

function isPharmacyControlledInvoice(invoice) {
  if (!invoice) return false;
  return Boolean(
    invoice.is_pharmacy_sale === true ||
    PHARMACY_CONTROLLED_INVOICE_TYPES.includes(String(invoice.invoice_type || ''))
  );
}

async function runFinancialTransaction(work) {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      result = await work(session);
    });

    return result;
  } finally {
    await session.endSession();
  }
}

function sessionOptions(session) {
  return session ? { session } : {};
}

async function findAdmission(admissionId, session, user) {
  if (!mongoose.isValidObjectId(admissionId)) {
    const error = new Error('admissionId must be a valid ObjectId');
    error.statusCode = 400;
    error.code = 'INVALID_OBJECT_ID';
    throw error;
  }

  const filter = { _id: admissionId };
  const hospitalId = userHospitalId(user);

  if (hospitalId) {
    filter.hospitalId = hospitalId;
  }

  const admission = await IPDAdmission.findOne(filter, null, sessionOptions(session));

  if (!admission) {
    const error = new Error('Admission not found in this hospital');
    error.statusCode = 404;
    throw error;
  }

  return admission;
}

function sumCharges(charges) {
  return money(charges.reduce((sum, item) => sum + (Number(item.netAmount) || 0), 0));
}

function groupChargeSummary(charges) {
  const labels = {
    Bed: 'bedCharges',
    'Doctor Visit': 'doctorVisitCharges',
    Nursing: 'nursingCharges',
    'Lab Test': 'labCharges',
    Pharmacy: 'pharmacyCharges',
    Procedure: 'procedureCharges',
    Surgery: 'surgeryCharges',
    Equipment: 'equipmentCharges',
    Consultation: 'consultationCharges',
    Miscellaneous: 'miscellaneousCharges',
    Discount: 'discounts',
    Tax: 'taxes'
  };

  const result = { total: 0 };

  for (const charge of charges) {
    const key = labels[charge.chargeType] || 'miscellaneousCharges';
    result[key] = money((result[key] || 0) + (Number(charge.netAmount) || 0));
    result.total = money(result.total + (Number(charge.netAmount) || 0));
  }

  return result;
}

async function calculateAdmissionFinancials(admissionId, { session, persist = true, user } = {}) {
  const admission = await findAdmission(admissionId, session, user);
  const hospitalId = admission.hospitalId;

  const charges = await IPDCharge.find(
    { hospitalId, admissionId, ...ACTIVE_CHARGE_FILTER },
    null,
    sessionOptions(session)
  ).sort({ chargeDate: 1, createdAt: 1 });

  const unbilledCharges = charges.filter(
    (charge) => !charge.isBilled && (!charge.status || charge.status === 'ACTIVE')
  );

  const invoiceFilter = {
    ...invoiceFilterForAdmission(admissionId),
    hospital_id: hospitalId
  };

  const invoices = await Invoice.find(invoiceFilter, null, sessionOptions(session))
    .sort({ issue_date: 1, created_at: 1 });
  const pharmacyInvoices = invoices.filter(isPharmacyControlledInvoice);
  const ipdInvoices = invoices.filter((invoice) => !isPharmacyControlledInvoice(invoice));
  const pharmacyBillingPolicy = policyFromAdmission(admission);
  const includePharmacyInIpd = ipdOwnsPharmacyBilling(pharmacyBillingPolicy);
  const nonPharmacyCharges = charges.filter((charge) => String(charge.sourceModule || '') !== 'Pharmacy');
  const pharmacyMirrorCharges = charges.filter((charge) => String(charge.sourceModule || '') === 'Pharmacy');
  const nonPharmacyUnbilledCharges = unbilledCharges.filter((charge) => String(charge.sourceModule || '') !== 'Pharmacy');
  // When IPD owns Pharmacy billing, Pharmacy mirrors are no longer display-only:
  // they are patient-liability rows collected by the consolidated IPD invoice.
  const ipdCharges = includePharmacyInIpd ? charges : nonPharmacyCharges;
  const ipdUnbilledCharges = includePharmacyInIpd ? unbilledCharges : nonPharmacyUnbilledCharges;

  const [sponsorLedger, patientAdvanceLedger] = await Promise.all([
    SponsorLedgerEntry.find(
      { hospitalId, admissionId },
      null,
      sessionOptions(session)
    ).sort({ occurredAt: 1 }),
    PatientAdvanceLedger.find(
      { hospitalId, admissionId, walletType: 'IPD_SHARED', status: 'POSTED' },
      null,
      sessionOptions(session)
    ).sort({ postedAt: 1, createdAt: 1 })
  ]);

  // The append-only advance ledger is the authoritative patient-credit source.
  // Admission advance* fields are projections only and can become stale after
  // pharmacy settlement/refund workflows, so always rebuild them from the IPD
  // shared wallet before exposing or persisting a financial snapshot.
  const advanceStats = patientAdvanceLedger.reduce((totals, row) => {
    const type = String(row.transactionType || '').toUpperCase();
    const amount = money(row.amount || 0);
    if (row.direction === 'CREDIT' && ['ADVANCE_DEPOSIT', 'OPENING_BALANCE'].includes(type)) totals.received += amount;
    if (row.direction === 'DEBIT' && ['IPD_INVOICE_DEBIT', 'OUTSTANDING_SETTLEMENT_DEBIT'].includes(type)) totals.utilized += amount;
    if (row.direction === 'DEBIT' && ['REFUND_PAID', 'ADVANCE_REFUND', 'PHARMACY_ADVANCE_REFUND'].includes(type)) totals.refunded += amount;
    return totals;
  }, { received: 0, utilized: 0, refunded: 0 });
  const advanceAvailable = money(patientAdvanceLedger.length ? patientAdvanceLedger[patientAdvanceLedger.length - 1].balanceAfter : 0);
  const advanceReceived = money(advanceStats.received);
  const advanceUtilized = money(advanceStats.utilized);
  const advanceRefunded = money(advanceStats.refunded);

  const totalChargeAmount = sumCharges(charges);
  const totalStandardAmount = money(
    charges.reduce((sum, charge) => sum + Number(charge.pricingSnapshot?.amounts?.hospitalStandard ?? charge.amount ?? 0), 0)
  );
  const ipdChargeAmount = sumCharges(ipdCharges);

  const patientLiabilityTotal = money(
    charges.reduce((sum, charge) => sum + Number(charge.patientLiability ?? charge.pricingSnapshot?.amounts?.patientLiability ?? charge.netAmount ?? 0), 0)
  );

  const sponsorLiabilityTotal = money(
    charges.reduce((sum, charge) => sum + Number(charge.sponsorLiability ?? charge.pricingSnapshot?.amounts?.sponsorLiability ?? 0), 0)
  );
  const ipdPatientLiabilityTotal = money(
    ipdCharges.reduce((sum, charge) => sum + Number(charge.patientLiability ?? charge.pricingSnapshot?.amounts?.patientLiability ?? charge.netAmount ?? 0), 0)
  );
  const ipdSponsorLiabilityTotal = money(
    ipdCharges.reduce((sum, charge) => sum + Number(charge.sponsorLiability ?? charge.pricingSnapshot?.amounts?.sponsorLiability ?? 0), 0)
  );

  const nonAdmissibleAmount = money(
    charges.reduce((sum, charge) => sum + Number(charge.nonAdmissibleAmount ?? charge.pricingSnapshot?.amounts?.nonAdmissible ?? 0), 0)
  );

  const allUnbilledTotal = sumCharges(unbilledCharges);
  const unbilledTotal = sumCharges(ipdUnbilledCharges);
  const unbilledPatientLiability = money(
    ipdUnbilledCharges.reduce((sum, charge) => sum + Number(charge.patientLiability ?? charge.netAmount ?? 0), 0)
  );

  const unbilledSponsorLiability = money(
    ipdUnbilledCharges.reduce((sum, charge) => sum + Number(charge.sponsorLiability ?? 0), 0)
  );

  const invoicedGross = money(
    ipdInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0)
  );

  const creditNotes = money(
    ipdInvoices.reduce((sum, invoice) => sum + Number(invoice.credit_note_total || 0), 0)
  );

  const invoicePaid = money(
    ipdInvoices.reduce((sum, invoice) => sum + Number(invoice.amount_paid || 0), 0)
  );

  const invoiceOutstanding = money(
    ipdInvoices.reduce((sum, invoice) => sum + Number(invoice.balance_due || 0), 0)
  );
  // Authorised patient credit is still a receivable, but it is an explicit
  // permission to carry that portion beyond the current collection step. Keep
  // it separate from amount_paid so reports continue to show the true due.
  const authorisedCreditOutstanding = money(
    ipdInvoices.reduce((sum, invoice) => sum + activeAuthorisedCredit(invoice), 0)
  );
  const uncoveredInvoiceOutstanding = money(Math.max(0, invoiceOutstanding - authorisedCreditOutstanding));
  const pharmacySubledgerOutstanding = money(
    pharmacyInvoices.reduce((sum, invoice) => sum + Number(invoice.balance_due || 0), 0)
  );
  const pharmacySubledgerPaid = money(
    pharmacyInvoices.reduce((sum, invoice) => sum + Number(invoice.amount_paid || 0), 0)
  );
  // Pharmacy invoices remain useful inventory/tax/subledger documents in both
  // modes, but are collectible from the patient only when Pharmacy owns billing.
  const pharmacyInvoiceOutstanding = includePharmacyInIpd ? 0 : pharmacySubledgerOutstanding;
  const pharmacyInvoicePaid = includePharmacyInIpd ? 0 : pharmacySubledgerPaid;

  const ledgerDebits = money(
    sponsorLedger.reduce((sum, row) => sum + Number(row.debit || 0), 0)
  );

  const ledgerCredits = money(
    sponsorLedger.reduce((sum, row) => sum + Number(row.credit || 0), 0)
  );

  const sponsorPaid = money(
    sponsorLedger
      .filter((row) => row.entryType === 'settlement')
      .reduce((sum, row) => sum + Number(row.credit || 0), 0)
  );

  const sponsorReceivable = money(
    Math.max(0, Math.max(ipdSponsorLiabilityTotal, ledgerDebits) - ledgerCredits)
  );

  // Collectible patient due is the current invoice balance (which already
  // reflects settlement discounts/credit notes) plus patient-liability charges
  // that have not yet been invoiced. Gross liability minus cash payments would
  // incorrectly resurrect approved non-cash settlement discounts as due.
  const patientReceivable = money(
    Math.max(0, invoiceOutstanding + unbilledPatientLiability)
  );
  // Immediate collection excludes only the explicitly authorised credit on
  // issued invoices. Unbilled charges cannot become deferred credit until they
  // are first converted into an invoice.
  const immediatePatientReceivable = money(
    Math.max(0, uncoveredInvoiceOutstanding + unbilledPatientLiability)
  );
  // Advance remains a separate wallet until it is actually applied to an
  // issued invoice. Expose the projected net payable so billing screens can
  // show what the patient will owe after available IPD advance is consumed.
  const advanceAppliedActual = money(advanceUtilized);
  const advancePendingAdjustment = money(Math.min(patientReceivable, advanceAvailable));
  const advanceAdjusted = money(advanceAppliedActual + advancePendingAdjustment);
  const advanceWalletBalance = money(advanceAvailable);
  const availableAdvanceAfterAdjustment = money(Math.max(0, advanceAvailable - advancePendingAdjustment));
  // `balancePayable` is the actual patient receivable. Available advance is
  // *not* a payment until the operator allocates it. Projection fields remain
  // available for the recommended-use preview without changing accounting.
  const balancePayable = money(patientReceivable);
  const projectedAdvanceAdjustment = advancePendingAdjustment;
  const projectedAvailableAdvance = availableAdvanceAfterAdjustment;
  const balancePayableAfterAdvance = money(Math.max(0, patientReceivable - advancePendingAdjustment));
  const netPatientPayableAfterAdvance = balancePayableAfterAdvance;

  const overallDue = patientReceivable;
  const totalEncounterPaid = money(invoicePaid + pharmacyInvoicePaid);
  const totalEncounterOutstanding = money(patientReceivable + pharmacyInvoiceOutstanding);

  if (persist) {
    admission.totalBillAmount = totalChargeAmount;
    admission.invoicedAmount = money(invoicedGross - creditNotes);
    admission.paidAmount = invoicePaid;
    admission.patientReceivable = patientReceivable;
    admission.sponsorReceivable = sponsorReceivable;
    admission.sponsorPaidAmount = sponsorPaid;
    admission.nonAdmissibleAmount = nonAdmissibleAmount;
    admission.dueAmount = patientReceivable; // patient liability only; sponsor receivable is separate
    admission.advanceAmount = advanceAvailable;
    admission.advanceReceivedAmount = advanceReceived;
    admission.advanceUtilizedAmount = advanceUtilized;
    admission.advanceRefundedAmount = advanceRefunded;
    await admission.save(sessionOptions(session));
  }

  return {
    admission,
    charges,
    ipdCharges,
    pharmacyMirrorCharges,
    unbilledCharges,
    ipdUnbilledCharges,
    invoices,
    ipdInvoices,
    pharmacyInvoices,
    pharmacyBillingPolicy,
    includePharmacyInIpd,
    sponsorLedger,
    patientAdvanceLedger,
    totalChargeAmount,
    ipdChargeAmount,
    totalStandardAmount,
    patientLiabilityTotal,
    ipdPatientLiabilityTotal,
    sponsorLiabilityTotal,
    ipdSponsorLiabilityTotal,
    nonAdmissibleAmount,
    unbilledTotal,
    allUnbilledTotal,
    unbilledPatientLiability,
    unbilledSponsorLiability,
    invoicedGross,
    creditNotes,
    invoicePaid,
    invoiceOutstanding,
    authorisedCreditOutstanding,
    uncoveredInvoiceOutstanding,
    immediatePatientReceivable,
    pharmacyInvoicePaid,
    pharmacyInvoiceOutstanding,
    pharmacySubledgerPaid,
    pharmacySubledgerOutstanding,
    totalEncounterPaid,
    totalEncounterOutstanding,
    patientReceivable,
    advanceAppliedActual,
    advancePendingAdjustment,
    advanceAdjusted,
    advanceWalletBalance,
    availableAdvanceAfterAdjustment,
    balancePayable,
    projectedAdvanceAdjustment,
    projectedAvailableAdvance,
    balancePayableAfterAdvance,
    netPatientPayableAfterAdvance,
    sponsorReceivable,
    sponsorPaid,
    overallDue,
    advanceAvailable,
    advanceReceived,
    advanceUtilized,
    advanceRefunded
  };
}

async function listBillingAdmissions(user, query = {}) {
  const hospitalId = userHospitalId(user);
  if (!hospitalId) {
    const error = new Error('Authenticated user is not assigned to a hospital');
    error.statusCode = 403;
    throw error;
  }

  const filter = { hospitalId };
  const requestedStatus = String(query.status || '').trim();
  if (requestedStatus) filter.status = requestedStatus;
  else filter.status = { $nin: ['Cancelled'] };
  if (String(query.openOnly || '').toLowerCase() === 'true') {
    filter.financialClearanceStatus = { $ne: 'cleared' };
  }

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);
  const skip = (page - 1) * limit;
  const search = String(query.search || '').trim();
  let ids = [];
  let total = 0;

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    const hospitalObjectId = new mongoose.Types.ObjectId(String(hospitalId));
    const pipeline = [
      { $match: { ...filter, hospitalId: hospitalObjectId } },
      {
        $lookup: {
          from: Patient.collection.name,
          localField: 'patientId',
          foreignField: '_id',
          pipeline: [{ $project: { first_name: 1, last_name: 1, patientId: 1 } }],
          as: '_patient'
        }
      },
      { $set: { _patient: { $arrayElemAt: ['$_patient', 0] } } },
      {
        $match: {
          $or: [
            { admissionNumber: regex },
            { shipNumber: regex },
            { '_patient.first_name': regex },
            { '_patient.last_name': regex },
            { '_patient.patientId': regex }
          ]
        }
      },
      { $sort: { admissionDate: -1, _id: -1 } },
      { $facet: {
        ids: [{ $skip: skip }, { $limit: limit }, { $project: { _id: 1 } }],
        count: [{ $count: 'value' }]
      } }
    ];
    const [result = {}] = await IPDAdmission.aggregate(pipeline).allowDiskUse(true);
    ids = (result.ids || []).map((row) => row._id);
    total = result.count?.[0]?.value || 0;
  } else {
    const [idRows, count] = await Promise.all([
      IPDAdmission.find(filter).select('_id').sort({ admissionDate: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      IPDAdmission.countDocuments(filter)
    ]);
    ids = idRows.map((row) => row._id);
    total = count;
  }

  if (!ids.length) {
    return { success: true, admissions: [], pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  const admissions = await IPDAdmission.find({ hospitalId, _id: { $in: ids } })
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone dob dobPrecision ageEntrySource enteredAgeYears enteredAgeMonths enteredAgeDays ageAsOf age gender address city state zipCode village district tehsil emergency_contact emergency_phone emergency_relationship')
    .populate('primaryDoctorId', 'firstName lastName specialization')
    .populate('departmentId', 'name')
    .populate('wardId', 'name wardName')
    .populate('roomId', 'roomNumber name')
    .populate('bedId', 'bedNumber bed_number')
    .lean();
  const byId = new Map(admissions.map((row) => [String(row._id), row]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean);

  return {
    success: true,
    admissions: ordered,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  };
}

async function getRunningBill(admissionId, user, options = {}) {
  if (!options.snapshot && !options.skipEnsure) {
    await ensureAdmissionDailyCharges(admissionId, operationNow(), user);
  }
  const snapshot = options.snapshot || await calculateAdmissionFinancials(admissionId, { user });

  const admission = await IPDAdmission.findOne({
    _id: admissionId,
    hospitalId: snapshot.admission.hospitalId
  })
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone dob dobPrecision ageEntrySource enteredAgeYears enteredAgeMonths enteredAgeDays ageAsOf age gender address city state zipCode village district tehsil emergency_contact emergency_phone emergency_relationship')
    .populate('primaryDoctorId', 'firstName lastName specialization')
    .populate('departmentId', 'name')
    .populate('wardId', 'name wardName')
    .populate('roomId', 'roomNumber name')
    .populate('bedId', 'bedNumber bed_number');

  const receipts = options.transactions
    ? [...options.transactions].sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)).slice(0, 100)
    : await FinancialTransaction.find({
        hospitalId: admission.hospitalId,
        admissionId,
        status: 'POSTED'
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

  const advanceLedger = options.advanceLedger
    ? [...options.advanceLedger].sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)).slice(0, 100)
    : await PatientAdvanceLedger.find({
        hospitalId: admission.hospitalId,
        admissionId,
        status: 'POSTED'
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

  const ipdInvoiceIdsForReceipts = new Set((snapshot.ipdInvoices || []).map((row) => String(row._id)));
  const isIpdControlledTransaction = (transaction = {}) => {
    const source = String(transaction.sourceModule || '').toUpperCase();
    if (source === 'PHARMACY') return false;
    const invoiceId = transaction.invoiceId?._id || transaction.invoiceId;
    if (invoiceId && ipdInvoiceIdsForReceipts.size && !ipdInvoiceIdsForReceipts.has(String(invoiceId))) return false;
    return true;
  };
  const ipdExternalPaidAmount = money(receipts.reduce((sum, transaction) => (
    isIpdControlledTransaction(transaction) ? sum + externalReceiptAmount(transaction) : sum
  ), 0));
  const ipdPaymentRefunds = money(receipts.reduce((sum, transaction) => {
    if (!isIpdControlledTransaction(transaction)) return sum;
    return String(transaction.transactionType || '').toUpperCase() === 'REFUND'
      ? sum + money(transaction.amount || 0)
      : sum;
  }, 0));
  // Actual money collected is external invoice receipts plus advance deposits.
  // Advance utilisation is NOT new money and must never be counted again.
  const ipdTotalCollectedAmount = money(ipdExternalPaidAmount + snapshot.advanceReceived);
  const ipdNetCollectedAmount = money(Math.max(
    0,
    ipdTotalCollectedAmount - ipdPaymentRefunds - snapshot.advanceRefunded
  ));

  const pendingDiscountApprovals = await ApprovalRequest.find({
    hospitalId: admission.hospitalId,
    admissionId,
    requestType: 'DISCOUNT_APPROVAL',
    status: 'Pending'
  }).select('_id details requestedBy createdAt').lean();

  const unbilledChargesByDate = snapshot.ipdUnbilledCharges.reduce((result, charge) => {
    const key = dateKey(charge.chargeDate);
    (result[key] ||= []).push(charge);
    return result;
  }, {});

  const reversedBilledCharges = await IPDCharge.find({
    hospitalId: admission.hospitalId,
    admissionId,
    isBilled: true,
    status: 'REVERSED',
    ...(snapshot.includePharmacyInIpd ? {} : { sourceModule: { $ne: 'Pharmacy' } })
  }).sort({ chargeDate: 1, createdAt: 1 }).lean();
  const billedCharges = [
    ...snapshot.ipdCharges.filter((charge) => charge.isBilled),
    ...reversedBilledCharges
  ].sort((a, b) => new Date(a.chargeDate || a.createdAt || 0) - new Date(b.chargeDate || b.createdAt || 0));
  const pharmacyMirrorCharges = snapshot.pharmacyMirrorCharges;

  return {
    success: true,
    admission: {
      _id: admission._id,
      admissionNumber: admission.admissionNumber,
      shipNumber: admission.shipNumber,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate,
      dischargeType: admission.dischargeType,
      admissionType: admission.admissionType,
      status: admission.status,
      financialClearanceStatus: admission.financialClearanceStatus,
      chargeFreeze: admission.chargeFreeze || { status: 'open' },
      financeInitialization: admission.financeInitialization || { status: 'ready' },
      pharmacyBillingPolicySnapshot: admission.pharmacyBillingPolicySnapshot,
      pharmacyBillingPolicy: snapshot.pharmacyBillingPolicy,
      totalBillAmount: snapshot.totalChargeAmount,
      standardAmount: snapshot.totalStandardAmount,
      patientLiability: snapshot.ipdPatientLiabilityTotal,
      sponsorLiability: snapshot.ipdSponsorLiabilityTotal,
      totalPatientLiabilityIncludingPharmacy: snapshot.patientLiabilityTotal,
      totalSponsorLiabilityIncludingPharmacy: snapshot.sponsorLiabilityTotal,
      patientReceivable: snapshot.patientReceivable,
      authorisedCreditOutstanding: snapshot.authorisedCreditOutstanding,
      immediatePatientReceivable: snapshot.immediatePatientReceivable,
      uncoveredInvoiceOutstanding: snapshot.uncoveredInvoiceOutstanding,
      advanceAppliedActual: snapshot.advanceAppliedActual,
      advancePendingAdjustment: snapshot.advancePendingAdjustment,
      advanceAdjusted: snapshot.advanceAdjusted,
      advanceWalletBalance: snapshot.advanceWalletBalance,
      availableAdvanceAfterAdjustment: snapshot.availableAdvanceAfterAdjustment,
      balancePayable: snapshot.balancePayable,
      projectedAdvanceAdjustment: snapshot.projectedAdvanceAdjustment,
      projectedAvailableAdvance: snapshot.projectedAvailableAdvance,
      balancePayableAfterAdvance: snapshot.balancePayableAfterAdvance,
      netPayableAfterAdvance: snapshot.netPatientPayableAfterAdvance,
      sponsorReceivable: snapshot.sponsorReceivable,
      paidAmount: snapshot.invoicePaid,
      totalSettledAmount: snapshot.invoicePaid,
      externalPaidAmount: ipdExternalPaidAmount,
      totalCollectedAmount: ipdTotalCollectedAmount,
      netCollectedAmount: ipdNetCollectedAmount,
      paymentRefundAmount: ipdPaymentRefunds,
      dueAmount: snapshot.patientReceivable,
      invoicedAmount: snapshot.invoicedGross,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      authorisedCreditOutstanding: snapshot.authorisedCreditOutstanding,
      immediatePatientReceivable: snapshot.immediatePatientReceivable,
      uncoveredInvoiceOutstanding: snapshot.uncoveredInvoiceOutstanding,
      unbilledTotal: snapshot.unbilledTotal,
      unbilledPatientLiability: snapshot.unbilledPatientLiability,
      unbilledSponsorLiability: snapshot.unbilledSponsorLiability,
      advanceAmount: snapshot.advanceAvailable,
      advanceReceivedAmount: snapshot.advanceReceived,
      advanceUtilizedAmount: snapshot.advanceUtilized,
      advanceRefundedAmount: snapshot.advanceRefunded,
      patientId: admission.patientId,
      primaryDoctorId: admission.primaryDoctorId,
      departmentId: admission.departmentId,
      wardId: admission.wardId,
      roomId: admission.roomId,
      bedId: admission.bedId
    },
    patient: admission.patientId,
    unbilledCharges: snapshot.ipdUnbilledCharges,
    unbilledChargesByDate,
    unbilledSummary: groupChargeSummary(snapshot.ipdUnbilledCharges),
    billedCharges,
    pharmacyMirrorCharges,
    pharmacyMirrorSummary: groupChargeSummary(pharmacyMirrorCharges),
    billedSummary: {
      total: sumCharges(billedCharges.filter((charge) => charge.status !== 'REVERSED')),
      count: billedCharges.filter((charge) => charge.status !== 'REVERSED').length,
      reversedCount: billedCharges.filter((charge) => charge.status === 'REVERSED').length
    },
    invoices: snapshot.ipdInvoices,
    pharmacyInvoices: snapshot.pharmacyInvoices,
    allInvoices: snapshot.invoices,
    receipts,
    advanceLedger,
    pendingDiscountApprovals,
    sponsorLedger: snapshot.sponsorLedger,
    financialSummary: {
      // Billing workspace totals follow the frozen per-admission Pharmacy
      // collection owner. In consolidated mode Pharmacy mirrors are included;
      // in the default Pharmacy-owned mode they remain display-only here.
      pharmacyBillingOwner: snapshot.pharmacyBillingPolicy?.billingOwner || 'PHARMACY',
      pharmacyBillingPolicy: snapshot.pharmacyBillingPolicy,
      totalChargeAmount: snapshot.ipdChargeAmount,
      totalEncounterChargeAmount: snapshot.totalChargeAmount,
      pharmacyMirrorChargeAmount: sumCharges(snapshot.pharmacyMirrorCharges),
      standardAmount: snapshot.totalStandardAmount,
      patientLiability: snapshot.ipdPatientLiabilityTotal,
      sponsorLiability: snapshot.ipdSponsorLiabilityTotal,
      totalPatientLiabilityIncludingPharmacy: snapshot.patientLiabilityTotal,
      totalSponsorLiabilityIncludingPharmacy: snapshot.sponsorLiabilityTotal,
      nonAdmissibleAmount: snapshot.nonAdmissibleAmount,
      patientReceivable: snapshot.patientReceivable,
      authorisedCreditOutstanding: snapshot.authorisedCreditOutstanding,
      immediatePatientReceivable: snapshot.immediatePatientReceivable,
      uncoveredInvoiceOutstanding: snapshot.uncoveredInvoiceOutstanding,
      advanceAppliedActual: snapshot.advanceAppliedActual,
      advancePendingAdjustment: snapshot.advancePendingAdjustment,
      advanceAdjusted: snapshot.advanceAdjusted,
      advanceWalletBalance: snapshot.advanceWalletBalance,
      availableAdvanceAfterAdjustment: snapshot.availableAdvanceAfterAdjustment,
      balancePayable: snapshot.balancePayable,
      projectedAdvanceAdjustment: snapshot.projectedAdvanceAdjustment,
      projectedAvailableAdvance: snapshot.projectedAvailableAdvance,
      balancePayableAfterAdvance: snapshot.balancePayableAfterAdvance,
      netPayableAfterAdvance: snapshot.netPatientPayableAfterAdvance,
      // Backward-compatible alias used by older IPD screens. Both fields are
      // intentionally the same canonical IPD patient receivable and exclude
      // the separately-settled pharmacy ledger.
      overallDue: snapshot.patientReceivable,
      sponsorReceivable: snapshot.sponsorReceivable,
      sponsorPaidAmount: snapshot.sponsorPaid,
      // paidAmount is retained as total invoice settlement for compatibility.
      // External collections and advance utilisation are exposed separately.
      paidAmount: snapshot.invoicePaid,
      totalSettledAmount: snapshot.invoicePaid,
      externalPaidAmount: ipdExternalPaidAmount,
      paymentsApplied: ipdExternalPaidAmount,
      totalCollectedAmount: ipdTotalCollectedAmount,
      netCollectedAmount: ipdNetCollectedAmount,
      paymentRefundAmount: ipdPaymentRefunds,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      authorisedCreditOutstanding: snapshot.authorisedCreditOutstanding,
      immediatePatientReceivable: snapshot.immediatePatientReceivable,
      uncoveredInvoiceOutstanding: snapshot.uncoveredInvoiceOutstanding,
      unbilledTotal: snapshot.unbilledTotal,
      pharmacyInvoicePaid: snapshot.pharmacyInvoicePaid,
      pharmacyInvoiceOutstanding: snapshot.pharmacyInvoiceOutstanding,
      pharmacySubledgerPaid: snapshot.pharmacySubledgerPaid,
      pharmacySubledgerOutstanding: snapshot.pharmacySubledgerOutstanding,
      // Complete-bill/packet totals span both the IPD-controlled invoice ledger
      // and the separately-owned Pharmacy invoice ledger. These fields are for
      // display/reconciliation only; collection permissions remain separated.
      totalPaidAmountIncludingPharmacy: snapshot.totalEncounterPaid,
      totalOutstandingIncludingPharmacy: snapshot.totalEncounterOutstanding,
      advanceReceived: snapshot.advanceReceived,
      advanceApplied: snapshot.advanceUtilized,
      advanceRefunded: snapshot.advanceRefunded,
      advanceAvailable: snapshot.advanceAvailable
    }
  };
}

async function addManualCharge(payload, user) {
  const admission = await findAdmission(payload.admissionId, null, user);
  assertAdmissionOpenForMutation(admission, { action: 'Manual IPD charge creation' });
  const quantity = Number(payload.quantity || 1);
  const standardRate = assertAmount(payload.rate, 'Rate');

  if (!Number.isFinite(quantity) || quantity <= 0) {
    const error = new Error('Quantity must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const chargeDate = payload.chargeDate || operationNow();

  if (payload.chargeType === 'Bed' && quantity !== 1) {
    const error = new Error('Bed accommodation is billed once per hospital calendar day. Use daily-charge catch-up instead of a multi-day manual quantity.');
    error.statusCode = 409;
    error.code = 'BED_MULTI_DAY_MANUAL_CHARGE_BLOCKED';
    throw error;
  }

  if (payload.chargeType === 'Bed') {
    const existing = await IPDCharge.findOne({
      hospitalId: admission.hospitalId,
      admissionId: admission._id,
      chargeType: 'Bed',
      chargeDateKey: dateKey(chargeDate),
      $or: [
        { status: { $exists: false } },
        { status: { $in: ['ACTIVE', 'INVOICED'] } }
      ]
    });

    if (existing) {
      const error = new Error('Bed charge already exists for this admission and date');
      error.statusCode = 409;
      throw error;
    }
  }

  let quote;

  try {
    quote = await quotePricing({
      hospitalId: admission.hospitalId,
      admissionId: admission._id,
      serviceDate: chargeDate,
      chargeType: payload.chargeType,
      serviceType: payload.serviceType,
      internalServiceModel: payload.internalServiceModel,
      internalServiceId: payload.internalServiceId,
      payerServiceCode: payload.externalCode,
      internalCode: payload.serviceCode,
      standardAmount: payload.internalServiceId ? undefined : standardRate,
      quantity,
      sameOtSessionIndex: payload.sameOtSessionIndex,
      bilateralSecond: payload.bilateralSecond,
      withinPackagePeriod: payload.withinPackagePeriod,
      nonAdmissibleAmount: payload.nonAdmissibleAmount
    });
  } catch (pricingError) {
    if (payload.allowStandardFallback !== true) throw pricingError;

    const amount = money(standardRate * quantity);
    quote = {
      amounts: {
        hospitalStandard: amount,
        contracted: amount,
        eligible: amount,
        patientLiability: amount,
        sponsorLiability: 0,
        nonAdmissible: 0,
        hospitalAdjustment: 0,
        hospitalConcession: 0,
        packageAbsorbed: 0
      },
      inputs: { fallbackReason: pricingError.message },
      explanation: ['Standard hospital rate used by authorised fallback'],
      ruleTrace: []
    };
  }

  const contracted = money(quote.amounts.contracted);
  const coverageForPolicy = await activeCoverage(admission.hospitalId, admission._id);
  const policy = await resolveFinancialPolicy({
    hospitalId: admission.hospitalId,
    user,
    encounterType: 'IPD',
    serviceType: payload.serviceType || payload.chargeType,
    serviceCategory: payload.serviceCategory,
    serviceCode: payload.serviceCode || payload.externalCode,
    payerCategory: coverageForPolicy?.payerCategory || (coverageForPolicy ? 'SPONSORED' : 'SELF'),
    departmentId: admission.departmentId,
    selectedMode: payload.selectedMode || admission.financialPolicySnapshot?.selectedMode,
    requestedDeposit: payload.requestedDeposit,
    patientLiability: quote.amounts.patientLiability,
    sponsorLiability: quote.amounts.sponsorLiability,
    contractedAmount: contracted,
    adjustments: {
      discountType: payload.discountType,
      discountRate: payload.discountRate,
      discountAmount: payload.discountAmount ?? payload.discount,
      discountValue: payload.discountValue,
      discountReason: payload.discountReason,
      taxMode: payload.taxMode,
      taxRate: payload.taxRate,
      taxReason: payload.taxReason || payload.taxExemptionReason
    },
    overrideReason: payload.overrideReason
  });
  const adjusted = policy.amounts;
  quote.amounts = {
    ...quote.amounts,
    patientLiability: adjusted.patientLiability,
    sponsorLiability: adjusted.sponsorLiability,
    hospitalConcession: money(Number(quote.amounts.hospitalConcession || 0) + adjusted.discountAmount)
  };

  const charge = await IPDCharge.create({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
    patientId: admission.patientId,
    chargeType: payload.chargeType || 'Miscellaneous',
    description: payload.description,
    quantity,
    rate: money(contracted / quantity),
    discountType: adjusted.discountType,
    discountRate: adjusted.discountRate,
    discountAmount: adjusted.discountAmount,
    discountReason: adjusted.discountReason,
    discountApprovedBy: (adjusted.discountAmount > 0 && !adjusted.requiresDiscountApproval) ? user?._id : undefined,
    discountApprovedAt: (adjusted.discountAmount > 0 && !adjusted.requiresDiscountApproval) ? operationNow() : undefined,
    discount: adjusted.discountAmount,
    taxMode: adjusted.taxMode,
    taxName: adjusted.taxName,
    taxCode: adjusted.taxCode,
    taxRate: adjusted.taxRate,
    taxAmount: adjusted.taxAmount,
    taxExemptionReason: adjusted.taxExemptionReason,
    tax: adjusted.taxAmount,
    sourceModule: payload.sourceModule || 'Manual',
    sourceId: payload.sourceId,
    sourceReference: payload.sourceReference,
    chargeDate,
    chargeDateKey: dateKey(chargeDate),
    idempotencyKey: payload.idempotencyKey,
    notes: payload.notes,
    addedBy: user?._id,
    pricingSnapshot: pricingSnapshot(quote, {
      internalServiceModel: payload.internalServiceModel,
      internalServiceId: payload.internalServiceId
    }),
    patientLiability: adjusted.patientLiability,
    sponsorLiability: adjusted.sponsorLiability,
    nonAdmissibleAmount: quote.amounts.nonAdmissible,
    financialPolicySnapshot: policy.policySnapshot,
    selectedBillingMode: policy.selectedMode,
    requiredNowAmount: policy.requiredNow,
    clearanceState: policy.clearanceState
  });

  if (adjusted.requiresDiscountApproval) {
    try {
      const ApprovalRequest = require('../models/ApprovalRequest');
      await ApprovalRequest.create({
        hospitalId: admission.hospitalId,
        requestType: 'DISCOUNT_APPROVAL',
        patientId: admission.patientId,
        admissionId: admission._id,
        details: {
          chargeId: charge._id,
          description: charge.description,
          totalBillAmount: contracted,
          discountAmount: adjusted.discountAmount,
          requestedDiscountPercentage: adjusted.discountRate,
          reason: adjusted.discountReason || 'Staff discount request',
          encounterType: 'IPD'
        },
        requestedBy: user?._id,
        status: 'Pending'
      });
    } catch (apprErr) {
      console.warn('Could not create ApprovalRequest for IPD charge:', apprErr.message);
    }
  }

  // Any new manual clinical/financial charge invalidates a previously recorded
  // final financial clearance until the current ledger is settled again.
  await IPDAdmission.updateOne(
    { _id: admission._id, hospitalId: admission.hospitalId },
    {
      $set: { financialClearanceStatus: 'in_progress' },
      $unset: { financialClearedAt: 1, financialClearedBy: 1, finalSettlementReceiptNumber: 1 }
    }
  );

  const coverage = coverageForPolicy;
  await replaceCoverageUtilization({
    coverage,
    quote,
    hospitalId: admission.hospitalId,
    encounterType: 'IPD',
    admissionId: admission._id,
    patientId: admission.patientId,
    sourceType: 'IPDCharge',
    sourceId: charge._id,
    internalServiceModel: payload.internalServiceModel,
    internalServiceId: payload.internalServiceId,
    userId: user?._id
  });
  if (coverage && quote.rateCardItemId && quote.packageCode) {
    await activatePackageEpisode({
      quote, coverage, hospitalId: admission.hospitalId, encounterType: 'IPD', encounterId: admission._id,
      patientId: admission.patientId, sourceType: 'IPDCharge', sourceId: charge._id, userId: user?._id
    });
  }
  if (quote.packageAdjudication) {
    await recordPackageUtilization({
      decision: quote.packageAdjudication,
      input: { serviceType: payload.serviceType || undefined, internalServiceModel: payload.internalServiceModel, internalServiceId: payload.internalServiceId, internalCode: payload.serviceCode, description: payload.description, quantity },
      quote, sourceType: 'IPDCharge', sourceId: charge._id
    });
  }
  await calculateAdmissionFinancials(admission._id, { user });

  return charge;
}

async function adjustExistingUnbilledCharge(chargeId, payload = {}, user) {
  const charge = await IPDCharge.findById(chargeId);
  if (!charge) {
    const error = new Error('IPD charge not found');
    error.statusCode = 404;
    throw error;
  }
  const admission = await findAdmission(charge.admissionId, null, user);
  assertAdmissionOpenForMutation(admission, { action: 'IPD charge adjustment' });
  if (String(charge.hospitalId) !== String(admission.hospitalId)) {
    const error = new Error('IPD charge does not belong to this hospital');
    error.statusCode = 403;
    throw error;
  }
  if (charge.isBilled || charge.status === 'INVOICED' || charge.invoiceId || charge.billId) {
    const error = new Error('Billed IPD charges cannot be edited; use credit/refund controls instead');
    error.statusCode = 409;
    error.code = 'IPD_CHARGE_ALREADY_BILLED';
    throw error;
  }

  // pricingSnapshot is the tariff/payer allocation before discretionary
  // clerk discount/tax policy. Re-resolve from that authoritative base so a
  // Desk retry never compounds an already-applied discount.
  const snapshot = charge.pricingSnapshot || {};
  const snapshotAmounts = snapshot.amounts || {};
  let contractedAmount = money(
    snapshotAmounts.contracted ?? charge.contractedAmount ?? charge.grossAmount ?? (Number(charge.rate || 0) * Number(charge.quantity || 1))
  );
  let basePatientLiability = money(snapshotAmounts.patientLiability ?? charge.patientLiability ?? contractedAmount);
  let baseSponsorLiability = money(snapshotAmounts.sponsorLiability ?? charge.sponsorLiability ?? 0);

  // Finance users may override the unit rate of any ACTIVE/unbilled IPD charge,
  // including Lab/Radiology/Procedure lines. The original tariff snapshot and
  // every override are retained; invoiced rows remain immutable.
  const hasManualRate = payload.manualRate !== undefined && payload.manualRate !== null && payload.manualRate !== '';
  let manualRate;
  let manualRateReason;
  let previousContractedAmount;
  if (hasManualRate) {
    if (String(snapshot.resultType || '').toLowerCase() === 'package_included' || snapshot.packageEpisodeId) {
      const error = new Error('Package-included charges cannot be manually repriced; use the package/coverage repricing workflow');
      error.statusCode = 409;
      error.code = 'IPD_PACKAGE_CHARGE_RATE_LOCKED';
      throw error;
    }
    if (!_hasActionPermission(user, 'pricing_override')) {
      const error = new Error('Manual IPD charge rate override requires pricing_override permission');
      error.statusCode = 403;
      throw error;
    }
    manualRate = assertAmount(payload.manualRate, 'Rate');
    manualRateReason = String(payload.overrideReason || payload.reason || '').trim();
    if (!manualRateReason) {
      const error = new Error('Rate override reason is required');
      error.statusCode = 400;
      error.code = 'IPD_RATE_OVERRIDE_REASON_REQUIRED';
      throw error;
    }

    previousContractedAmount = contractedAmount;
    const newContractedAmount = money(manualRate * Number(charge.quantity || 1));
    const allocationBase = money(basePatientLiability + baseSponsorLiability);
    const sponsorRatio = allocationBase > 0 ? Number(baseSponsorLiability || 0) / allocationBase : 0;
    baseSponsorLiability = money(newContractedAmount * sponsorRatio);
    basePatientLiability = money(newContractedAmount - baseSponsorLiability);
    contractedAmount = newContractedAmount;
  }

  const coverage = await activeCoverage(admission.hospitalId, admission._id);
  const policy = await resolveFinancialPolicy({
    hospitalId: admission.hospitalId,
    user,
    encounterType: 'IPD',
    serviceType: payload.serviceType || charge.chargeType,
    serviceCategory: payload.serviceCategory,
    serviceCode: payload.serviceCode || snapshot.serviceCode,
    payerCategory: coverage?.payerCategory || (coverage ? 'SPONSORED' : 'SELF'),
    departmentId: admission.departmentId,
    selectedMode: payload.selectedMode || charge.selectedBillingMode || admission.financialPolicySnapshot?.selectedMode,
    requestedDeposit: payload.requestedDeposit,
    patientLiability: basePatientLiability,
    sponsorLiability: baseSponsorLiability,
    contractedAmount,
    adjustments: {
      // A pure rate override must preserve an already-approved discount/tax
      // configuration instead of silently resetting it.
      discountType: payload.discountType ?? (hasManualRate ? charge.discountType : undefined),
      discountRate: payload.discountRate ?? (hasManualRate ? charge.discountRate : undefined),
      discountAmount: payload.discountAmount ?? payload.discount ?? (hasManualRate && charge.discountType !== 'percentage' ? charge.discountAmount : undefined),
      discountValue: payload.discountValue,
      discountReason: payload.discountReason ?? (hasManualRate ? charge.discountReason : undefined),
      taxMode: payload.taxMode ?? (hasManualRate ? charge.taxMode : undefined),
      taxRate: payload.taxRate ?? (hasManualRate ? charge.taxRate : undefined),
      taxReason: payload.taxReason ?? (hasManualRate ? charge.taxExemptionReason : undefined)
    },
    overrideReason: payload.overrideReason
  });
  const adjusted = policy.amounts;

  if (hasManualRate) {
    const now = operationNow();
    const originalRate = money(charge.rate || 0);
    charge.rateOverrideHistory = Array.isArray(charge.rateOverrideHistory) ? charge.rateOverrideHistory : [];
    charge.rateOverrideHistory.push({
      previousRate: originalRate,
      newRate: manualRate,
      quantity: Number(charge.quantity || 1),
      previousContractedAmount: money(previousContractedAmount || 0),
      newContractedAmount: contractedAmount,
      reason: manualRateReason,
      overriddenBy: user?._id,
      overriddenAt: now
    });
    charge.rate = manualRate;
  }

  charge.discountType = adjusted.discountType;
  charge.discountRate = adjusted.discountRate;
  charge.discountAmount = adjusted.discountAmount;
  charge.discount = adjusted.discountAmount;
  charge.discountReason = adjusted.discountReason || undefined;
  charge.discountApprovedBy = adjusted.discountAmount > 0 && !adjusted.requiresDiscountApproval ? user?._id : undefined;
  charge.discountApprovedAt = adjusted.discountAmount > 0 && !adjusted.requiresDiscountApproval ? operationNow() : undefined;
  charge.taxMode = adjusted.taxMode;
  charge.taxName = adjusted.taxName || undefined;
  charge.taxCode = adjusted.taxCode || undefined;
  charge.taxRate = adjusted.taxRate;
  charge.taxAmount = adjusted.taxAmount;
  charge.tax = adjusted.taxAmount;
  charge.taxExemptionReason = adjusted.taxExemptionReason || undefined;
  charge.patientLiability = adjusted.patientLiability;
  charge.sponsorLiability = adjusted.sponsorLiability;
  charge.hospitalConcessionAmount = money(Number(snapshotAmounts.hospitalConcession || 0) + Number(adjusted.discountAmount || 0));
  // Persist the adjusted patient allocation in the canonical pricing snapshot.
  // Sponsored charges are intentionally not overwritten from netAmount by the
  // model hook, so updating only the top-level aliases would lose the Desk
  // discount on save and make approval/collection totals inconsistent.
  const existingSnapshot = snapshot?.toObject?.() || snapshot || {};
  const existingSnapshotAmounts = snapshotAmounts?.toObject?.() || snapshotAmounts || {};
  const standardAmount = money(existingSnapshotAmounts.hospitalStandard ?? charge.standardAmount ?? previousContractedAmount ?? contractedAmount);
  charge.pricingSnapshot = {
    ...existingSnapshot,
    ...(hasManualRate ? {
      resultType: 'manual_override',
      fallbackReason: undefined,
      inputs: {
        ...(existingSnapshot.inputs || {}),
        manualOverride: {
          rate: manualRate,
          reason: manualRateReason,
          overriddenBy: user?._id,
          overriddenAt: operationNow()
        }
      },
      explanation: [
        ...(Array.isArray(existingSnapshot.explanation) ? existingSnapshot.explanation : []),
        `Manual rate override from ₹${money(charge.rateOverrideHistory?.[charge.rateOverrideHistory.length - 1]?.previousRate || 0)} to ₹${manualRate}: ${manualRateReason}`
      ]
    } : {}),
    amounts: {
      ...existingSnapshotAmounts,
      ...(hasManualRate ? {
        contracted: contractedAmount,
        eligible: contractedAmount,
        hospitalAdjustment: money(standardAmount - contractedAmount)
      } : {}),
      patientLiability: adjusted.patientLiability,
      sponsorLiability: adjusted.sponsorLiability,
      hospitalConcession: charge.hospitalConcessionAmount
    }
  };
  charge.markModified('pricingSnapshot');
  charge.financialPolicySnapshot = policy.policySnapshot;
  charge.selectedBillingMode = policy.selectedMode;
  charge.requiredNowAmount = policy.requiredNow;
  charge.clearanceState = policy.clearanceState;
  if (payload.notes) charge.notes = payload.notes;
  await charge.save();

  const ApprovalRequest = require('../models/ApprovalRequest');
  const pendingApproval = await ApprovalRequest.findOne({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
    requestType: 'DISCOUNT_APPROVAL',
    status: 'Pending',
    'details.chargeId': charge._id
  });
  if (adjusted.requiresDiscountApproval) {
    const details = {
      chargeId: charge._id,
      description: charge.description,
      totalBillAmount: contractedAmount,
      discountAmount: adjusted.discountAmount,
      requestedDiscountPercentage: adjusted.discountRate,
      reason: adjusted.discountReason || 'Staff discount request',
      encounterType: 'IPD'
    };
    if (pendingApproval) {
      pendingApproval.details = details;
      pendingApproval.requestedBy = user?._id || pendingApproval.requestedBy;
      await pendingApproval.save();
    } else {
      await ApprovalRequest.create({
        hospitalId: admission.hospitalId,
        requestType: 'DISCOUNT_APPROVAL',
        patientId: admission.patientId,
        admissionId: admission._id,
        details,
        requestedBy: user?._id,
        status: 'Pending'
      });
    }
  } else if (pendingApproval) {
    // A registrar may edit an unbilled charge back inside their permitted
    // discount ceiling (or remove the discount entirely). The old request is
    // then superseded and must not continue blocking invoice/payment actions.
    await ApprovalRequest.deleteOne({ _id: pendingApproval._id, status: 'Pending' });
  }

  // Keep coverage utilisation aligned with the canonical charge. Discount is a
  // patient concession; sponsor allocation remains the pricing-engine amount.
  if (coverage) {
    const quote = {
      serviceCode: snapshot.serviceCode || payload.serviceCode,
      rateCard: snapshot.rateCardId ? { id: snapshot.rateCardId, version: snapshot.rateCardVersion } : undefined,
      rateCardItemId: snapshot.rateCardItemId,
      inputs: snapshot.inputs || {},
      amounts: {
        ...snapshotAmounts,
        contracted: contractedAmount,
        patientLiability: adjusted.patientLiability,
        sponsorLiability: adjusted.sponsorLiability,
        hospitalConcession: charge.hospitalConcessionAmount
      },
      explanation: snapshot.explanation || [],
      ruleTrace: snapshot.ruleTrace || [],
      pricedAt: snapshot.pricedAt || operationNow()
    };
    await replaceCoverageUtilization({
      coverage,
      quote,
      hospitalId: admission.hospitalId,
      encounterType: 'IPD',
      admissionId: admission._id,
      patientId: admission.patientId,
      sourceType: 'IPDCharge',
      sourceId: charge._id,
      internalServiceModel: snapshot.internalServiceModel,
      internalServiceId: snapshot.internalServiceId,
      userId: user?._id
    });
  }

  await calculateAdmissionFinancials(admission._id, { user });
  return charge;
}

async function overrideUnbilledChargeRate(admissionId, chargeId, payload = {}, user) {
  const scopedCharge = await IPDCharge.findOne({ _id: chargeId, admissionId }).select('_id admissionId');
  if (!scopedCharge) {
    const error = new Error('IPD charge not found for this admission');
    error.statusCode = 404;
    throw error;
  }

  return adjustExistingUnbilledCharge(chargeId, {
    manualRate: payload.rate ?? payload.manualRate,
    overrideReason: payload.reason ?? payload.overrideReason,
    notes: payload.notes
  }, user);
}

async function reverseInvoicedCharge(admissionId, chargeId, payload = {}, user) {
  const reason = String(payload.reason || '').trim();
  if (!reason) {
    const error = new Error('Reversal reason is required');
    error.statusCode = 400;
    throw error;
  }

  const result = await runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session, user);
    const charge = await IPDCharge.findOne({
      _id: chargeId,
      hospitalId: admission.hospitalId,
      admissionId
    }, null, sessionOptions(session));

    if (!charge) {
      const error = new Error('Charge not found');
      error.statusCode = 404;
      throw error;
    }

    if (charge.status === 'REVERSED' || charge.reversalCreditNoteId) {
      const creditNote = charge.reversalCreditNoteId
        ? await Invoice.findById(charge.reversalCreditNoteId, null, sessionOptions(session))
        : null;
      const invoice = charge.invoiceId
        ? await Invoice.findById(charge.invoiceId, null, sessionOptions(session))
        : null;
      return { charge, invoice, creditNote, alreadyExists: true, draftClaimIds: [] };
    }

    if (!charge.isBilled || charge.status !== 'INVOICED' || !charge.invoiceId) {
      const error = new Error('Only an invoiced charge can be reversed. Void an unbilled charge instead.');
      error.statusCode = 409;
      error.code = 'CHARGE_NOT_INVOICED';
      throw error;
    }

    const invoice = await Invoice.findOne({
      _id: charge.invoiceId,
      hospital_id: admission.hospitalId,
      admission_id: admission._id
    }, null, sessionOptions(session));
    if (!invoice || invoice.document_stage === 'VOID') {
      const error = new Error('The issued invoice for this charge is not available for reversal');
      error.statusCode = 409;
      error.code = 'INVOICE_NOT_REVERSIBLE';
      throw error;
    }

    const invoiceLine = (invoice.service_items || []).find((line) =>
      String(line.charge_id || '') === String(charge._id)
    );
    if (!invoiceLine) {
      const error = new Error('This charge could not be matched to its issued invoice line');
      error.statusCode = 409;
      error.code = 'INVOICE_LINE_NOT_FOUND';
      throw error;
    }

    const patientAmount = money(
      invoiceLine.net_amount ?? invoiceLine.total_price ?? charge.patientLiability ?? charge.netAmount ?? 0
    );
    const sponsorAmount = money(charge.sponsorLiability ?? charge.pricingSnapshot?.amounts?.sponsorLiability ?? 0);

    const claimRows = sponsorAmount > 0
      ? await ClaimCase.find({
          hospitalId: admission.hospitalId,
          admissionId: admission._id,
          'lines.chargeId': charge._id,
          status: { $nin: ['cancelled', 'closed'] }
        }, null, sessionOptions(session)).select('_id status')
      : [];
    const lockedClaim = claimRows.find((claim) => !['draft', 'documents_pending', 'ready'].includes(String(claim.status || '')));
    if (lockedClaim) {
      const error = new Error('This sponsored charge is already part of a submitted/adjudicated claim. Correct or reopen the claim before reversing the charge.');
      error.statusCode = 409;
      error.code = 'CHARGE_IN_SUBMITTED_CLAIM';
      error.details = { claimId: lockedClaim._id, status: lockedClaim.status };
      throw error;
    }

    let creditResult = null;
    if (patientAmount > 0) {
      creditResult = await createCreditNoteInSession(invoice, {
        amount: patientAmount,
        reason: `Charge reversal — ${charge.description}: ${reason}`,
        idempotencyKey: payload.idempotencyKey
          ? `${payload.idempotencyKey}:credit-note`
          : `ipd-charge-reversal:${charge._id}:credit-note`
      }, user, session);
    }

    let sponsorCreditPosted = 0;
    if (sponsorAmount > 0) {
      const coverage = await activeCoverage(admission.hospitalId, admission._id, session);
      const payerId = coverage?.payerId?._id || coverage?.payerId;
      if (!coverage || !payerId) {
        const error = new Error('Active sponsor coverage is required to reverse the sponsor liability for this charge');
        error.statusCode = 409;
        error.code = 'REVERSAL_COVERAGE_REQUIRED';
        throw error;
      }

      // Some payer policies recognise receivable only at claim submission. Do
      // not create an orphan credit before any receivable exists. If invoice
      // issue already recognised the sponsor balance, reverse only the
      // remaining recognised amount for this invoice/coverage.
      const sponsorRows = await SponsorLedgerEntry.find({
        hospitalId: admission.hospitalId,
        admissionId: admission._id,
        coverageId: coverage._id,
        invoiceId: invoice._id
      }, null, sessionOptions(session)).select('debit credit');
      const recognisedOutstanding = money(Math.max(0, sponsorRows.reduce(
        (sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0),
        0
      )));
      sponsorCreditPosted = money(Math.min(sponsorAmount, recognisedOutstanding));

      if (sponsorCreditPosted > 0) {
        await claimService.appendLedger({
          hospitalId: admission.hospitalId,
          payerId,
          encounterType: 'IPD',
          admissionId: admission._id,
          patientId: admission.patientId,
          coverageId: coverage._id,
          invoiceId: invoice._id,
          chargeId: charge._id,
          entryType: 'credit_adjustment',
          credit: sponsorCreditPosted,
          reference: invoice.invoice_number,
          reason: `Invoiced charge reversal: ${reason}`,
          sourceType: 'reversal',
          sourceId: charge._id,
          idempotencyKey: payload.idempotencyKey
            ? `${payload.idempotencyKey}:sponsor-credit`
            : `ipd-charge-reversal:${charge._id}:sponsor-credit`,
          createdBy: user?._id,
          session
        });
      }
    }

    await reverseCoverageUtilization({
      hospitalId: admission.hospitalId,
      sourceType: 'IPDCharge',
      sourceId: charge._id,
      userId: user?._id,
      reason,
      session
    });
    await reversePackageUtilization({
      hospitalId: admission.hospitalId,
      sourceType: 'IPDCharge',
      sourceId: charge._id,
      userId: user?._id,
      reason,
      session
    });

    charge.status = 'REVERSED';
    charge.reversedAt = operationNow();
    charge.reversedBy = user?._id;
    charge.reversalReason = reason;
    charge.reversalCreditNoteId = creditResult?.creditNote?._id;
    charge.reversalAmount = patientAmount;
    charge.reversalSponsorAmount = sponsorAmount;
    await charge.save(sessionOptions(session));

    if (!['Discharged', 'Cancelled'].includes(String(admission.status || '')) &&
        ['cleared', 'exception_approved'].includes(String(admission.financialClearanceStatus || ''))) {
      admission.financialClearanceStatus = 'in_progress';
      admission.financialClearedAt = undefined;
      admission.financialClearedBy = undefined;
      await admission.save(sessionOptions(session));
    }

    return {
      charge,
      invoice,
      creditNote: creditResult?.creditNote || null,
      sponsorCreditPosted,
      alreadyExists: false,
      draftClaimIds: claimRows.map((claim) => claim._id)
    };
  });

  const claimRefreshFailures = [];
  for (const claimId of result.draftClaimIds || []) {
    try {
      await claimService.refreshClaim({
        hospitalId: result.charge.hospitalId,
        claimId,
        user
      });
    } catch (error) {
      claimRefreshFailures.push({ claimId, message: error.message });
    }
  }

  const snapshot = await calculateAdmissionFinancials(admissionId, { user });
  const originalInvoice = await Invoice.findById(result.invoice?._id || result.charge.invoiceId);
  const patientBase = originalInvoice?.payer_allocation?.coverage_id
    ? money(originalInvoice?.payer_allocation?.patient_liability || 0)
    : money(originalInvoice?.total || 0);
  const effectiveLiability = money(Math.max(
    0,
    patientBase -
      Number(originalInvoice?.settlement_discount_amount || 0) -
      Number(originalInvoice?.credit_note_total || 0)
  ));
  const effectiveCollected = money(Math.max(
    0,
    Number(originalInvoice?.amount_paid || 0) - Number(originalInvoice?.refunded_amount || 0) - Number(originalInvoice?.advance_transferred_amount || 0)
  ));
  const overpaymentAmount = money(Math.max(0, effectiveCollected - effectiveLiability));

  return {
    charge: result.charge,
    invoice: originalInvoice || result.invoice,
    creditNote: result.creditNote,
    sponsorCreditPosted: result.sponsorCreditPosted || 0,
    alreadyExists: result.alreadyExists,
    overpaymentAmount,
    refundRecommended: overpaymentAmount > 0,
    claimRefreshFailures,
    summary: {
      patientReceivable: snapshot.patientReceivable,
      sponsorReceivable: snapshot.sponsorReceivable,
      unbilledTotal: snapshot.unbilledTotal
    }
  };
}

async function generateBedCharge(admissionId, payload, user) {
  const admission = await findAdmission(admissionId, null, user);
  assertAdmissionOpenForMutation(admission, { action: 'Manual bed charge generation' });
  await admission.populate('bedId');

  if (!admission.bedId) {
    const error = new Error('No bed is allocated for this admission');
    error.statusCode = 400;
    throw error;
  }

  const chargeDate = new Date(payload.date || operationNow());
  chargeDate.setHours(0, 0, 0, 0);

  const admissionDate = new Date(admission.admissionDate);
  admissionDate.setHours(0, 0, 0, 0);

  if (chargeDate < admissionDate) {
    const error = new Error('Bed charge cannot be generated before admission date');
    error.statusCode = 400;
    throw error;
  }

  if (admission.dischargeDate && chargeDate > new Date(admission.dischargeDate)) {
    const error = new Error('Bed charge cannot be generated after discharge date');
    error.statusCode = 400;
    throw error;
  }

  const key = dateKey(chargeDate);

  const existing = await IPDCharge.findOne({
    hospitalId: admission.hospitalId,
    admissionId,
    chargeType: 'Bed',
    chargeDateKey: key,
    $or: [
      { status: { $exists: false } },
      { status: { $in: ['ACTIVE', 'INVOICED'] } }
    ]
  });

  if (existing) {
    return { charge: existing, alreadyExists: true };
  }

  const quote = await quotePricing({
    hospitalId: admission.hospitalId,
    admissionId,
    serviceDate: chargeDate,
    chargeType: 'Bed',
    serviceType: 'bed',
    internalServiceModel: 'Bed',
    internalServiceId: admission.bedId._id,
    internalCode: admission.bedId.bedCode,
    standardAmount: Number(payload.rate ?? admission.bedId.dailyCharge ?? 0),
    quantity: 1
  });

  const charge = await IPDCharge.create({
    hospitalId: admission.hospitalId,
    admissionId,
    patientId: admission.patientId,
    chargeType: 'Bed',
    description: payload.description || `Bed charge ${admission.bedId.bedNumber} for ${key}`,
    quantity: 1,
    rate: quote.amounts.contracted,
    sourceModule: 'Bed',
    sourceId: admission.bedId._id,
    sourceReference: {
      module: 'Bed',
      documentId: admission.bedId._id,
      lineKey: key
    },
    chargeDate,
    chargeDateKey: key,
    isAutoGenerated: true,
    idempotencyKey: payload.idempotencyKey || `bed:${admission.hospitalId}:${admissionId}:${key}`,
    addedBy: user?._id,
    pricingSnapshot: pricingSnapshot(quote, {
      internalServiceModel: 'Bed',
      internalServiceId: admission.bedId._id
    }),
    patientLiability: quote.amounts.patientLiability,
    sponsorLiability: quote.amounts.sponsorLiability,
    nonAdmissibleAmount: quote.amounts.nonAdmissible
  });

  const coverage = await activeCoverage(admission.hospitalId, admission._id);
  await replaceCoverageUtilization({
    coverage,
    quote,
    hospitalId: admission.hospitalId,
    encounterType: 'IPD',
    admissionId: admission._id,
    patientId: admission.patientId,
    sourceType: 'IPDCharge',
    sourceId: charge._id,
    internalServiceModel: 'Bed',
    internalServiceId: admission.bedId._id,
    userId: user?._id
  });
  if (quote.packageAdjudication) {
    await recordPackageUtilization({
      decision: quote.packageAdjudication,
      input: { serviceType: 'bed', internalServiceModel: 'Bed', internalServiceId: admission.bedId._id, internalCode: admission.bedId.bedCode, description: charge.description, quantity: 1 },
      quote, sourceType: 'IPDCharge', sourceId: charge._id
    });
  }
  await calculateAdmissionFinancials(admissionId, { user });

  return { charge, alreadyExists: false };
}

async function applyDiscount(admissionId, payload, user) {
  const admission = await findAdmission(admissionId, null, user);
  const discountAmount = assertAmount(payload.discountAmount, 'Discount amount');

  const activeCharges = await IPDCharge.find({
    hospitalId: admission.hospitalId,
    admissionId,
    ...ACTIVE_CHARGE_FILTER
  });

  const chargeable = money(
    activeCharges
      .filter((charge) => charge.adjustmentType !== 'DISCOUNT' && charge.chargeType !== 'Discount')
      .reduce((sum, charge) => sum + Math.max(0, Number(charge.netAmount) || 0), 0)
  );

  const existingDiscount = money(
    activeCharges
      .filter((charge) => charge.adjustmentType === 'DISCOUNT' || charge.chargeType === 'Discount')
      .reduce((sum, charge) => sum + Math.abs(Number(charge.netAmount) || 0), 0)
  );

  if (discountAmount > money(chargeable - existingDiscount)) {
    const error = new Error('Discount cannot exceed the available chargeable amount');
    error.statusCode = 400;
    throw error;
  }

  await assertSettlementDiscountPolicy({
    hospitalId: admission.hospitalId,
    user,
    baseAmount: money(chargeable - existingDiscount),
    discountAmount,
    reason: payload.discountReason
  });

  const discountCharge = await IPDCharge.create({
    hospitalId: hospitalIdFor(admission, user),
    admissionId,
    patientId: admission.patientId,
    chargeType: 'Discount',
    adjustmentType: 'DISCOUNT',
    description: `Authorised discount — ${payload.discountReason.trim()}`,
    quantity: 1,
    rate: 0,
    discountType: payload.discountType === 'percentage' ? 'percentage' : 'fixed',
    discountRate: optionalMoney(payload.discountRate),
    discountAmount,
    discountReason: payload.discountReason.trim(),
    discountApprovedBy: payload.approvedBy || user?._id,
    discountApprovedAt: operationNow(),
    discount: discountAmount,
    taxAmount: 0,
    tax: 0,
    sourceModule: 'Billing',
    sourceReference: { module: 'Billing' },
    chargeDate: operationNow(),
    notes: payload.notes || payload.discountReason.trim(),
    discountDetails: {
      type: payload.discountType === 'percentage' ? 'percentage' : 'fixed',
      reason: payload.discountReason.trim(),
      approvedBy: payload.approvedBy || user?._id,
      approvedAt: operationNow()
    },
    addedBy: user?._id
  });

  admission.discountAmount = money((admission.discountAmount || 0) + discountAmount);
  admission.discountReason = payload.discountReason.trim();
  await admission.save();

  await calculateAdmissionFinancials(admissionId, { user });

  return discountCharge;
}

async function voidCharge(admissionId, chargeId, payload, user) {
  const admission = await findAdmission(admissionId, null, user);
  assertAdmissionOpenForMutation(admission, { action: 'IPD charge void' });

  const charge = await IPDCharge.findOne({
    _id: chargeId,
    hospitalId: admission.hospitalId,
    admissionId
  });

  if (!charge) {
    const error = new Error('Charge not found');
    error.statusCode = 404;
    throw error;
  }

  if (charge.isBilled || charge.status === 'INVOICED') {
    const error = new Error('An invoiced charge cannot be voided. Create a credit note instead.');
    error.statusCode = 409;
    throw error;
  }

  if (!payload.reason?.trim()) {
    const error = new Error('Void reason is required');
    error.statusCode = 400;
    throw error;
  }

  charge.status = 'VOIDED';
  charge.voidReason = payload.reason.trim();
  charge.voidedBy = user?._id;
  charge.voidedAt = operationNow();
  await charge.save();

  await reverseCoverageUtilization({
    hospitalId: admission.hospitalId,
    sourceType: 'IPDCharge',
    sourceId: charge._id,
    userId: user?._id,
    reason: payload.reason.trim()
  });
  await reversePackageUtilization({
    hospitalId: admission.hospitalId,
    sourceType: 'IPDCharge',
    sourceId: charge._id,
    userId: user?._id,
    reason: payload.reason.trim()
  });

  await calculateAdmissionFinancials(admissionId, { user });

  return charge;
}

async function previewIPDInvoice(admissionId, payload = {}, user) {
  await ensureAdmissionDailyCharges(admissionId, payload.throughDate || operationNow(), user);
  const admission = await findAdmission(admissionId, null, user);
  const requested = Array.isArray(payload.chargeIds) ? [...new Set(payload.chargeIds.map(String))] : [];
  const pharmacyBillingPolicy = policyFromAdmission(admission);
  const filter = { hospitalId: admission.hospitalId, admissionId, ...UNBILLED_CHARGE_FILTER };
  if (!ipdOwnsPharmacyBilling(pharmacyBillingPolicy)) filter.sourceModule = { $ne: 'Pharmacy' };
  if (requested.length) filter._id = { $in: requested };
  const charges = await IPDCharge.find(filter).sort({ chargeDate: 1, createdAt: 1 }).lean();
  if (requested.length && charges.length !== requested.length) {
    const error = new Error('One or more selected charges are no longer eligible'); error.statusCode = 409; error.code = 'INVALID_SELECTED_CHARGES'; throw error;
  }
  const gross = money(charges.reduce((a,c)=>a+Number(c.grossAmount||c.amount||0),0));
  const discount = money(charges.reduce((a,c)=>a+Number(c.discountAmount||c.discount||0),0));
  const tax = money(charges.reduce((a,c)=>a+Number(c.taxAmount||c.tax||0),0));
  const net = money(charges.reduce((a,c)=>a+Number(c.patientLiability ?? c.netAmount ?? 0),0));
  return { admissionId, invoiceKind: payload.invoiceKind === 'final' ? 'final' : 'interim', billingMode: requested.length ? 'IMMEDIATE_SELECTED' : 'ALL_UNBILLED', pharmacyBillingPolicy, chargeCount: charges.length, chargeIds: charges.map(c=>c._id), charges, totals: { gross, discount, tax, net } };
}

async function issueIPDInvoice(admissionId, payload = {}, user) {
  await ensureAdmissionDailyCharges(admissionId, payload.throughDate || operationNow(), user);
  const requestedInvoiceKind = payload.invoiceKind === 'final' ? 'IPD Final' : 'IPD Interim';

  return runFinancialTransaction(async (session) => {
    // Keep transaction retries deterministic; supplementary handling may change
    // the document kind for this attempt but must not mutate outer state.
    let invoiceKind = requestedInvoiceKind;
    const admission = await findAdmission(admissionId, session, user);

    if (payload.idempotencyKey) {
      const existing = await Invoice.findOne({ hospital_id: admission.hospitalId, idempotency_key: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) {
        return { invoice: existing, bill: await Bill.findById(existing.bill_id, null, sessionOptions(session)), alreadyExists: true };
      }
    }

    const requestedChargeIds = Array.isArray(payload.chargeIds) ? payload.chargeIds.filter(Boolean) : [];
    let existingFinal = null;
    if (invoiceKind === 'IPD Final') {
      if (admission.chargeFreeze?.status !== 'frozen' || !admission.chargeFreeze?.frozenAt) {
        const error = new Error('Final IPD invoice is blocked until the admission charge freeze is completed');
        error.statusCode = 409;
        error.code = 'IPD_CHARGE_FREEZE_REQUIRED';
        throw error;
      }
      const workflowPolicy = await loadIPDWorkflowPolicy(admission.hospitalId);
      if (
        workflowPolicy.requirePharmacyClearance &&
        stageBefore(workflowPolicy, 'PHARMACY_CLEARANCE', 'IPD_FINAL_INVOICE') &&
        !['cleared', 'exempted'].includes(String(admission.pharmacyClearanceStatus || 'pending'))
      ) {
        const error = new Error('Final IPD invoice is blocked until Pharmacy Final Clearance is completed or explicitly exempted by policy');
        error.statusCode = 409;
        error.code = 'PHARMACY_CLEARANCE_REQUIRED_BEFORE_FINAL_INVOICE';
        throw error;
      }

      // A document labelled "Final" must be issued only after the doctor has
      // finalized and staff has completed the discharge summary. This creates a
      // clinical charge-freeze point instead of allowing normal care to continue
      // after a final invoice has already been printed.
      const dischargeSummary = await DischargeSummary.findOne(
        { admissionId: admission._id, hospitalId: admission.hospitalId },
        null,
        sessionOptions(session)
      ).select('status');
      if (!dischargeSummary || dischargeSummary.status !== 'StaffCompleted') {
        const error = new Error('Final IPD invoice is available only after the discharge summary is finalized by the doctor and completed by staff');
        error.statusCode = 409;
        error.code = 'DISCHARGE_SUMMARY_NOT_COMPLETED';
        throw error;
      }

      existingFinal = await Invoice.findOne({ hospital_id: admission.hospitalId, admission_id: admission._id, $or: [{ invoice_type: 'IPD Final' }, { is_final_ipd_invoice: true }], document_stage: { $ne: 'VOID' } }, null, sessionOptions(session)).sort({ issue_date: -1, created_at: -1 });
    }
    if (requestedInvoiceKind === 'IPD Final' && requestedChargeIds.length) {
      const error = new Error('Final invoice cannot be limited to selected charges'); error.statusCode = 400; throw error;
    }
    const pharmacyBillingPolicy = policyFromAdmission(admission);
    const chargeFilter = { hospitalId: admission.hospitalId, admissionId, ...UNBILLED_CHARGE_FILTER };
    if (!ipdOwnsPharmacyBilling(pharmacyBillingPolicy)) chargeFilter.sourceModule = { $ne: 'Pharmacy' };
    if (requestedChargeIds.length) chargeFilter._id = { $in: requestedChargeIds };
    const charges = await IPDCharge.find(chargeFilter, null, sessionOptions(session)).sort({ chargeDate: 1, createdAt: 1 });
    if (requestedChargeIds.length && charges.length !== [...new Set(requestedChargeIds.map(String))].length) {
      const error = new Error('One or more selected charges are invalid, already invoiced, voided, or belong to another admission');
      error.statusCode = 409; error.code = 'INVALID_SELECTED_CHARGES'; throw error;
    }

    // A retry with no new charges returns the existing final invoice. If new
    // charges arrived after finalization (for example a late recurring charge),
    // issue a supplementary IPD Interim invoice instead of silently returning a
    // stale final invoice and leaving the new charge permanently unbilled.
    if (existingFinal && !charges.length) {
      return { invoice: existingFinal, bill: await Bill.findById(existingFinal.bill_id, null, sessionOptions(session)), alreadyExists: true };
    }
    const supplementaryToFinal = existingFinal && charges.length ? existingFinal : null;
    if (supplementaryToFinal) invoiceKind = 'IPD Interim';

    if (!charges.length && invoiceKind !== 'IPD Final') {
      const error = new Error('There are no unbilled active charges eligible for IPD collection for this admission');
      error.statusCode = 409;
      throw error;
    }

    if (charges.length) {
      const pendingApprovals = await ApprovalRequest.find({
        hospitalId: admission.hospitalId,
        admissionId: admission._id,
        requestType: 'DISCOUNT_APPROVAL',
        status: 'Pending',
        'details.chargeId': { $in: charges.map((row) => row._id) }
      }, null, sessionOptions(session)).lean();
      if (pendingApprovals.length) {
        const error = new Error('One or more IPD charges are waiting for discount approval. Complete the approval decision before issuing an invoice for those charges.');
        error.statusCode = 409;
        error.code = 'DISCOUNT_APPROVAL_PENDING';
        error.details = { chargeIds: pendingApprovals.map((row) => row.details?.chargeId).filter(Boolean) };
        throw error;
      }
    }

    const standardAmount = money(charges.reduce((sum, row) => sum + Number(row.pricingSnapshot?.amounts?.hospitalStandard ?? row.grossAmount ?? row.amount ?? 0), 0));
    const contractedAmount = money(charges.reduce((sum, row) => sum + Number(row.netAmount || 0), 0));
    const patientLiability = money(charges.reduce((sum, row) => sum + Number(row.patientLiability ?? row.netAmount ?? 0), 0));
    const sponsorLiability = money(charges.reduce((sum, row) => sum + Number(row.sponsorLiability || 0), 0));
    const nonAdmissible = money(charges.reduce((sum, row) => sum + Number(row.nonAdmissibleAmount || 0), 0));

    const adjustmentRows = charges.filter((row) => ['DISCOUNT', 'WAIVER', 'TAX'].includes(row.adjustmentType) || ['Discount', 'Tax'].includes(row.chargeType));
    const regularRows = charges.filter((row) => !adjustmentRows.includes(row));
    const lines = regularRows.map(patientInvoiceLine);
    const lineDiscountTotal = money(lines.reduce((sum, line) => sum + line.discount, 0));
    const billDiscountTotal = money(adjustmentRows
      .filter((row) => ['DISCOUNT', 'WAIVER'].includes(row.adjustmentType) || row.chargeType === 'Discount')
      .reduce((sum, row) => sum + Math.abs(Number(row.patientLiability ?? row.netAmount ?? row.discountAmount ?? row.discount ?? 0)), 0));
    const taxAdjustmentTotal = money(adjustmentRows
      .filter((row) => row.adjustmentType === 'TAX' || row.chargeType === 'Tax')
      .reduce((sum, row) => sum + Math.abs(Number(row.patientLiability ?? row.netAmount ?? row.taxAmount ?? row.tax ?? 0)), 0));
    const subtotal = money(lines.reduce((sum, line) => sum + line.gross, 0));
    const taxableAmount = money(lines.reduce((sum, line) => sum + line.taxable, 0));
    const taxTotal = money(lines.reduce((sum, line) => sum + line.tax, 0) + taxAdjustmentTotal);
    const totalDiscount = money(lineDiscountTotal + billDiscountTotal);
    const roundingAdjustment = money(patientLiability - (subtotal - totalDiscount + taxTotal));
    const patientInvoiceTotal = money(Math.max(0, patientLiability));
    const hospitalId = admission.hospitalId;
    const snapshots = await financialPrintSnapshots(admission, session);

    const billNumber = await nextFinancialNumber({ documentType: 'BILL', hospitalId, session });
    const bill = new Bill({
      hospital_id: hospitalId,
      bill_number: billNumber,
      document_stage: 'GENERATED',
      patient_id: admission.patientId,
      admission_id: admission._id,
      total_amount: patientInvoiceTotal,
      gross_amount: subtotal,
      subtotal,
      line_discount_total: lineDiscountTotal,
      bill_discount_total: billDiscountTotal,
      taxable_amount: taxableAmount,
      tax_amount: taxTotal,
      discount: totalDiscount,
      rounding_adjustment: roundingAdjustment,
      discount_type: 'fixed',
      discount_reason: billDiscountTotal > 0 ? 'Authorised IPD charge/final bill discount' : undefined,
      payment_method: 'Pending',
      status: patientInvoiceTotal === 0 ? 'Paid' : 'Generated',
      items: lines.map((line) => ({
        charge_id: line.chargeId,
        description: line.description,
        charge_type: line.chargeType,
        charge_head: line.chargeHead,
        charge_date: line.chargeDate,
        gross_amount: line.gross,
        amount: line.net,
        quantity: line.quantity,
        unit_price: money(line.gross / Math.max(1, line.quantity)),
        discount_type: line.discountType,
        discount_rate: line.discountRate,
        discount_amount: line.discount,
        discount_reason: line.discountReason,
        taxable_amount: line.taxable,
        tax_mode: line.taxMode,
        tax_name: line.taxName,
        tax_code: line.taxCode,
        tax_rate: line.taxRate,
        tax_amount: line.tax,
        net_amount: line.net,
        source_snapshot: line.sourceSnapshot,
        item_type: chargeItemType(line.chargeType),
        admission_id: admission._id
      })),
      notes: payload.notes || (supplementaryToFinal ? `Supplementary IPD bill after final invoice ${supplementaryToFinal.invoice_number}` : `${invoiceKind} patient-liability bill for ${admission.admissionNumber}`),
      created_by: user?._id,
      patient_snapshot: snapshots.patientSnapshot,
      admission_snapshot: snapshots.admissionSnapshot,
      hospital_snapshot: snapshots.hospitalSnapshot,
      print_snapshot: { templateVersion: 'reference-billing-2026-08', generatedAt: new Date() }
    });
    await bill.save(sessionOptions(session));

    const invoiceNumber = await nextFinancialNumber({ documentType: 'INVOICE', hospitalId, session });
    const coverage = admission.coverageId
      ? await require('../models/AdmissionCoverage')
        .findOne({ _id: admission.coverageId, hospitalId })
        .populate('payerId', 'code name type pricingPolicy')
        .session(session)
      : null;

    const invoice = new Invoice({
      hospital_id: hospitalId,
      invoice_number: invoiceNumber,
      patient_id: admission.patientId,
      admission_id: admission._id,
      bill_id: bill._id,
      invoice_type: invoiceKind,
      document_stage: 'ISSUED',
      is_final_ipd_invoice: invoiceKind === 'IPD Final',
      issue_date: operationNow(),
      due_date: payload.dueDate ? new Date(payload.dueDate) : new Date(),
      issued_at: operationNow(),
      subtotal,
      gross_amount: subtotal,
      line_discount_total: lineDiscountTotal,
      bill_discount_total: billDiscountTotal,
      taxable_amount: taxableAmount,
      discount: totalDiscount,
      tax: taxTotal,
      rounding_adjustment: roundingAdjustment,
      total: patientInvoiceTotal,
      amount_paid: 0,
      balance_due: patientInvoiceTotal,
      status: patientInvoiceTotal === 0 ? 'Paid' : 'Issued',
      idempotency_key: payload.idempotencyKey,
      discount_details: billDiscountTotal > 0 ? { type: 'fixed', reason: 'Authorised IPD charge/final bill discount', approved_by: user?._id, approved_at: operationNow() } : undefined,
      payer_allocation: {
        coverage_id: coverage?._id,
        payer_id: coverage?.payerId,
        standard_amount: standardAmount,
        contracted_amount: contractedAmount,
        patient_liability: patientLiability,
        sponsor_liability: sponsorLiability,
        non_admissible_amount: nonAdmissible,
        sponsor_paid_amount: 0
      },
      service_items: lines.map((line) => ({
        charge_id: line.chargeId,
        description: line.description,
        charge_type: line.chargeType,
        charge_head: line.chargeHead,
        charge_date: line.chargeDate,
        quantity: line.quantity,
        unit_price: money(line.gross / Math.max(1, line.quantity)),
        gross_amount: line.gross,
        discount_type: line.discountType,
        discount_rate: line.discountRate,
        discount_amount: line.discount,
        discount_reason: line.discountReason,
        taxable_amount: line.taxable,
        tax_mode: line.taxMode,
        tax_name: line.taxName,
        tax_code: line.taxCode,
        tax_rate: line.taxRate,
        tax_amount: line.tax,
        total_price: line.net,
        net_amount: line.net,
        source_snapshot: line.sourceSnapshot,
        service_type: serviceTypeForCharge(line.chargeType),
        bill_id: bill._id
      })),
      notes: payload.notes || (supplementaryToFinal ? `Supplementary IPD invoice after final invoice ${supplementaryToFinal.invoice_number}; sponsor liability is handled through claim and sponsor ledger` : `${invoiceKind} patient statement; sponsor liability is handled through claim and sponsor ledger`),
      created_by: user?._id,
      patient_snapshot: snapshots.patientSnapshot,
      admission_snapshot: snapshots.admissionSnapshot,
      hospital_snapshot: snapshots.hospitalSnapshot,
      print_snapshot: { templateVersion: 'reference-billing-2026-08', generatedAt: new Date(), chargeIds: charges.map((row) => row._id), supplementaryToFinalInvoiceId: supplementaryToFinal?._id, supplementaryToFinalInvoiceNumber: supplementaryToFinal?.invoice_number }
    });
    await invoice.save(sessionOptions(session));

    bill.invoice_id = invoice._id;
    bill.invoice_ids = [invoice._id];
    bill.document_stage = 'INVOICED';
    bill.invoiced_at = operationNow();
    await bill.save(sessionOptions(session));

    const ids = charges.map((row) => row._id);
    const update = await IPDCharge.updateMany(
      { _id: { $in: ids }, hospitalId, admissionId, ...UNBILLED_CHARGE_FILTER },
      { $set: { isBilled: true, status: 'INVOICED', billId: bill._id, invoiceId: invoice._id, billedAt: operationNow(), sourceReference: { module: 'IPD', documentId: bill._id, invoiceNumber: invoice.invoice_number, billNumber } } },
      sessionOptions(session)
    );
    if (update.modifiedCount !== charges.length) {
      const error = new Error('Invoice issuance stopped because one or more charges changed during processing');
      error.statusCode = 409;
      throw error;
    }

    await syncChargesInvoiced(charges, bill, invoice, user?._id, session);

    if (
      sponsorLiability > 0 &&
      coverage?.payerId &&
      (coverage.payerId.pricingPolicy?.receivableRecognition || 'invoice_issue') === 'invoice_issue'
    ) {
      await claimService.appendLedger({
        hospitalId,
        payerId: coverage.payerId._id || coverage.payerId,
        encounterType: 'IPD',
        admissionId: admission._id,
        patientId: admission.patientId,
        coverageId: coverage._id,
        invoiceId: invoice._id,
        entryType: 'receivable',
        debit: sponsorLiability,
        reference: invoiceNumber,
        reason: 'Sponsor receivable recognized at invoice issue',
        sourceType: 'invoice',
        sourceId: invoice._id,
        idempotencyKey: `invoice:${invoice._id}:sponsor-receivable`,
        createdBy: user?._id,
        session
      });
    }

    if (invoiceKind === 'IPD Final') {
      admission.finalInvoiceId = invoice._id;
      if (admission.status === 'Billing Pending') admission.status = 'Payment Pending';
    }
    admission.financialClearanceStatus = 'in_progress';
    await admission.save(sessionOptions(session));
    return { invoice, bill, payerAllocation: invoice.payer_allocation, alreadyExists: false };
  }).then(async (result) => {
    await calculateAdmissionFinancials(admissionId, { user });
    return result;
  });
}

async function syncIPDClinicalFinancialClearance(admissionId, user) {
  // Operational Lab/Radiology/Procedure worklists persist a clearance snapshot.
  // Recompute it after settlement so a fully paid request cannot remain blocked
  // as PAYMENT_REQUIRED until somebody manually reopens the billing screen.
  try {
    const admission = await IPDAdmission.findById(admissionId).select('hospitalId').lean();
    if (!admission?.hospitalId) return;
    const sourceRows = await IPDCharge.find({
      hospitalId: admission.hospitalId,
      admissionId,
      sourceModule: { $in: ['LabRequest', 'RadiologyRequest', 'ProcedureRequest', 'OTRequest'] },
      sourceId: { $ne: null },
      status: { $nin: ['VOIDED', 'CANCELLED', 'REVERSED'] }
    }).select('sourceModule sourceId').lean();
    if (!sourceRows.length) return;
    const { getSourceFinancialStatus } = require('./chargePosting.service');
    const scopedUser = { ...(user || {}), hospital_id: admission.hospitalId, hospitalId: admission.hospitalId };
    const seen = new Set();
    for (const row of sourceRows) {
      const key = `${row.sourceModule}:${row.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await getSourceFinancialStatus({ sourceModule: row.sourceModule, sourceId: row.sourceId, user: scopedUser });
      } catch (error) {
        console.warn(`[IPD payment] Unable to refresh ${key} clearance:`, error.message);
      }
    }
  } catch (error) {
    console.warn('[IPD payment] Clinical clearance synchronization failed:', error.message);
  }
}

async function recordIPDPayment(admissionId, payload = {}, user) {
  const suppliedAmount = optionalMoney(payload.amount ?? payload.paymentAmount);
  let breakdown = normalizePaymentBreakdown(payload, suppliedAmount);
  const breakdownAmount = paymentBreakdownTotal(breakdown);
  const requestedAmount = suppliedAmount > 0 ? suppliedAmount : breakdownAmount;
  if (!breakdown.length && requestedAmount > 0) {
    breakdown = normalizePaymentBreakdown(payload, requestedAmount);
  }
  const settlementDiscountAmount = optionalMoney(payload.settlementDiscountAmount ?? payload.finalDiscountAmount);
  const taxAdjustmentAmount = optionalMoney(payload.taxAdjustmentAmount);
  if (taxAdjustmentAmount !== 0 && !_hasActionPermission(user, 'tax_override')) {
    const error = new Error('Manual tax adjustment requires tax_override permission');
    error.statusCode = 403;
    error.code = 'TAX_OVERRIDE_PERMISSION_REQUIRED';
    throw error;
  }
  const explicitDeferredCredit = requestedDeferredCredit(payload);
  const deferRemaining = payload.deferRemaining === true || payload.authorizeRemainingCredit === true;

  if (requestedAmount <= 0 && settlementDiscountAmount <= 0 && taxAdjustmentAmount === 0 && explicitDeferredCredit <= 0 && !deferRemaining) {
    const error = new Error('Enter a payment, advance allocation, deferred credit, settlement discount or tax adjustment');
    error.statusCode = 400;
    throw error;
  }

  const paymentMethod = breakdown.length > 1 ? 'Split' : (breakdown[0]?.method || payload.paymentMethod || 'Cash');
  if (requestedAmount > 0 && (!FINANCE_PAYMENT_METHODS.includes(paymentMethod) || breakdown.some((row) => !FINANCE_PAYMENT_METHODS.includes(row.method)))) {
    const error = new Error('Unsupported payment method');
    error.statusCode = 400;
    throw error;
  }
  if (breakdown.some((row) => row.method === 'PharmacyAdvance')) {
    const error = new Error('Pharmacy Advance cannot be applied by IPD Billing. Use the Pharmacy settlement workflow for that wallet.');
    error.statusCode = 409;
    throw error;
  }
  if (settlementDiscountAmount > 0 && !String(payload.settlementDiscountReason || payload.adjustmentReason || '').trim()) {
    const error = new Error('Settlement discount reason is required');
    error.statusCode = 400;
    error.code = 'DISCOUNT_REASON_REQUIRED';
    throw error;
  }
  if (taxAdjustmentAmount !== 0 && !String(payload.taxAdjustmentReason || payload.adjustmentReason || '').trim()) {
    const error = new Error('Tax adjustment reason is required');
    error.statusCode = 400;
    error.code = 'TAX_OVERRIDE_REASON_REQUIRED';
    throw error;
  }
  if (taxAdjustmentAmount !== 0) {
    const error = new Error('Tax on an issued IPD invoice is immutable. Finalise tax on source charges before invoice issuance or use a dedicated debit/credit adjustment workflow.');
    error.statusCode = 409;
    error.code = 'ISSUED_INVOICE_TAX_IMMUTABLE';
    throw error;
  }
  if ((explicitDeferredCredit > 0 || deferRemaining) && !String(payload.deferredCreditReason || payload.creditReason || payload.deferralReason || '').trim()) {
    const error = new Error('Reason is required when authorising Credit / Pay Later');
    error.statusCode = 400;
    throw error;
  }

  return runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session, user);
    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.find(
        { idempotencyKey: idempotencyQuery(payload.idempotencyKey) },
        null,
        sessionOptions(session)
      ).sort({ createdAt: 1 });
      if (existing.length) {
        const creditTxn = existing.find((row) => row.transactionType === 'DEFERRED_CREDIT');
        const receiptTxn = existing.find((row) => row.transactionType !== 'DEFERRED_CREDIT');
        return {
          receiptNumber: receiptTxn?.transactionNumber || null,
          creditAuthorizationNumber: creditTxn?.transactionNumber || null,
          transactions: existing,
          alreadyExists: true
        };
      }
    }

    if (payload.invoiceId) {
      const requestedInvoice = await Invoice.findOne({
        ...invoiceFilterForAdmission(admissionId),
        hospital_id: admission.hospitalId,
        _id: payload.invoiceId
      }, null, sessionOptions(session));
      if (requestedInvoice && isPharmacyControlledInvoice(requestedInvoice)) {
        const error = new Error('Pharmacy invoices are controlled by the Pharmacy settlement/clearance workflow and cannot be collected by IPD Billing');
        error.statusCode = 409;
        error.code = 'PHARMACY_INVOICE_REQUIRES_PHARMACY_SETTLEMENT';
        throw error;
      }
    }

    let invoices = await Invoice.find({ ...ipdCollectibleInvoiceFilterForAdmission(admissionId), hospital_id: admission.hospitalId }, null, sessionOptions(session))
      .sort({ issue_date: 1, created_at: 1 });
    let selected = payload.invoiceId ? invoices.filter((invoice) => String(invoice._id) === String(payload.invoiceId)) : invoices;
    if (!selected.length) {
      const error = new Error('No eligible invoice found for settlement');
      error.statusCode = 404;
      throw error;
    }

    const amountBeforeSettlement = money(selected.reduce((sum, invoice) => sum + Number(invoice.balance_due || 0), 0));
    const hospitalId = hospitalIdFor(admission, user);
    await assertSettlementDiscountPolicy({
      hospitalId,
      user,
      baseAmount: amountBeforeSettlement,
      discountAmount: settlementDiscountAmount,
      reason: payload.settlementDiscountReason || payload.adjustmentReason
    });

    const needsReceiptNumber = requestedAmount > 0 || settlementDiscountAmount > 0 || taxAdjustmentAmount !== 0;
    const receiptNumber = needsReceiptNumber
      ? await nextFinancialNumber({ documentType: 'RECEIPT', hospitalId, session })
      : null;
    const transactions = [];

    // Issued-invoice tax is immutable; payment-time tax mutation intentionally removed.

    const discountAllocationByInvoice = new Map();
    if (settlementDiscountAmount > 0) {
      // Reload because a tax adjustment can change balance_due through the model hook.
      invoices = await Invoice.find({ ...ipdCollectibleInvoiceFilterForAdmission(admissionId), hospital_id: admission.hospitalId }, null, sessionOptions(session))
        .sort({ issue_date: 1, created_at: 1 });
      selected = payload.invoiceId ? invoices.filter((invoice) => String(invoice._id) === String(payload.invoiceId)) : invoices;
      let remainingDiscount = settlementDiscountAmount;
      const currentOutstanding = money(selected.reduce((sum, invoice) => sum + Number(invoice.balance_due || 0), 0));
      if (remainingDiscount > currentOutstanding + 0.01) {
        const error = new Error('Settlement discount cannot exceed invoice outstanding');
        error.statusCode = 400;
        throw error;
      }
      for (const invoice of selected) {
        if (remainingDiscount <= 0) break;
        const applied = money(Math.min(remainingDiscount, Number(invoice.balance_due || 0)));
        if (applied <= 0) continue;
        invoice.settlement_discount_amount = money(Number(invoice.settlement_discount_amount || 0) + applied);
        invoice.discount_details = {
          type: 'fixed',
          reason: payload.settlementDiscountReason,
          approved_by: payload.discountApprovedBy || user?._id,
          approved_at: operationNow()
        };
        discountAllocationByInvoice.set(String(invoice._id), applied);
        await invoice.save(sessionOptions(session));
        await syncLinkedBillFromInvoice(invoice, 'Adjustment', session);
        remainingDiscount = money(remainingDiscount - applied);
      }
      const discountTransaction = new FinancialTransaction({
        hospitalId,
        patientId: admission.patientId,
        admissionId: admission._id,
        invoiceId: payload.invoiceId || selected[0]?._id,
        transactionNumber: receiptNumber,
        transactionType: 'SETTLEMENT',
        direction: 'CREDIT',
        amount: settlementDiscountAmount,
        paymentMethod: 'Adjustment',
        receiptType: payload.receiptType === 'Final Settlement' ? 'Final Settlement' : 'Adjustment',
        amountBeforeSettlement,
        settlementDiscountAmount,
        settlementDiscountReason: payload.settlementDiscountReason,
        settlementDiscountApprovedBy: payload.discountApprovedBy || user?._id,
        externalMoneyMovement: false,
        cashFlowClass: 'NON_CASH_ADJUSTMENT',
        sourceModule: payload.sourceModule || 'Discharge',
        sourceId: admission._id,
        status: 'POSTED',
        remarks: payload.settlementDiscountReason,
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:discount` : undefined,
        documentAllocations: Array.from(discountAllocationByInvoice.entries()).map(([documentId, allocatedAmount]) => ({
          documentType: 'Invoice', documentId, amount: allocatedAmount
        }))
      });
      await discountTransaction.save(sessionOptions(session));
      transactions.push(discountTransaction);
    }

    invoices = await Invoice.find({ ...ipdCollectibleInvoiceFilterForAdmission(admissionId), hospital_id: admission.hospitalId }, null, sessionOptions(session))
      .sort({ issue_date: 1, created_at: 1 });

    const plan = requestedAmount > 0 ? allocationPlan(invoices, requestedAmount, payload) : [];
    const allocatedPlan = allocateBreakdownAcrossPlan(breakdown, plan);
    const advanceApplied = money(breakdown.filter((row) => row.method === 'IPDAdvance').reduce((sum, row) => sum + row.amount, 0));
    let updatedAdvance = null;
    if (advanceApplied > 0) {
      updatedAdvance = await IPDAdmission.findOneAndUpdate(
        { _id: admission._id, hospitalId: admission.hospitalId, advanceAmount: { $gte: advanceApplied } },
        { $inc: { advanceAmount: -advanceApplied, advanceUtilizedAmount: advanceApplied } },
        { new: true, ...sessionOptions(session) }
      );
      if (!updatedAdvance) {
        const error = new Error('Insufficient available IPD advance');
        error.statusCode = 409;
        throw error;
      }
      await PatientAdvanceLedger.create([{
        hospitalId,
        patientId: admission.patientId,
        admissionId: admission._id,
        walletType: 'IPD_SHARED',
        transactionType: 'IPD_INVOICE_DEBIT',
        direction: 'DEBIT',
        amount: advanceApplied,
        openingBalance: money(updatedAdvance.advanceAmount + advanceApplied),
        paymentMethod: 'IPDAdvance',
        referenceNumber: receiptNumber,
        documentType: 'Invoice',
        sourceModule: 'IPD',
        sourceId: admission._id,
        balanceAfter: money(updatedAdvance.advanceAmount),
        notes: payload.notes || 'IPD advance utilised against invoice(s)',
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:advance` : undefined
      }], sessionOptions(session));
    }

    const receiptType = payload.receiptType === 'Final Settlement' ? 'Final Settlement' : 'Payment';
    for (const entry of allocatedPlan) {
      const invoice = entry.invoice;
      const invoiceBreakdown = entry.breakdown || [];
      const invoiceAdvanceApplied = paymentBreakdownTotal(invoiceBreakdown.filter((row) => row.method === 'IPDAdvance'));
      const externalReceived = externalBreakdownTotal(invoiceBreakdown);
      const invoicePaymentMethod = invoiceBreakdown.length > 1 ? 'Split' : (invoiceBreakdown[0]?.method || paymentMethod);
      const invoiceSettlementDiscount = money(discountAllocationByInvoice.get(String(invoice._id)) || 0);
      const projectedBalance = Math.max(0, money(Number(invoice.balance_due || 0) - entry.amount));

      invoice.amount_paid = money(Number(invoice.amount_paid || 0) + entry.amount);
      invoice.payment_history.push({
        date: operationNow(),
        amount: entry.amount,
        method: invoicePaymentMethod,
        reference: payload.reference || invoiceBreakdown.find((row) => row.reference)?.reference,
        status: 'Completed',
        collected_by: user?._id,
        transaction_id: receiptNumber,
        receipt_number: receiptNumber,
        receipt_type: receiptType,
        amount_before_settlement: amountBeforeSettlement,
        settlement_discount_amount: invoiceSettlementDiscount,
        settlement_discount_reason: payload.settlementDiscountReason,
        settlement_discount_approved_by: invoiceSettlementDiscount > 0 ? (payload.discountApprovedBy || user?._id) : undefined,
        advance_applied: invoiceAdvanceApplied,
        balance_after: projectedBalance,
        payment_breakdown: invoiceBreakdown
      });
      invoice.advance_applied = money(Number(invoice.advance_applied || 0) + invoiceAdvanceApplied);
      invoice.receipt_numbers = Array.from(new Set([...(invoice.receipt_numbers || []), receiptNumber].filter(Boolean)));
      await invoice.save(sessionOptions(session));
      await syncLinkedBillFromInvoice(invoice, invoicePaymentMethod, session);

      const isPureAdvanceUtilisation = invoiceAdvanceApplied > 0 && externalReceived <= 0.001;
      const transaction = new FinancialTransaction({
        hospitalId,
        patientId: admission.patientId,
        admissionId: admission._id,
        billId: invoice.bill_id,
        invoiceId: invoice._id,
        transactionNumber: receiptNumber,
        transactionType: isPureAdvanceUtilisation ? 'ADVANCE_UTILISATION' : 'RECEIPT',
        direction: 'CREDIT',
        amount: entry.amount,
        paymentMethod: invoicePaymentMethod,
        paymentReference: payload.reference,
        receiptType,
        amountBeforeSettlement,
        settlementDiscountAmount: invoiceSettlementDiscount,
        settlementDiscountReason: invoiceSettlementDiscount > 0 ? payload.settlementDiscountReason : undefined,
        settlementDiscountApprovedBy: invoiceSettlementDiscount > 0 ? (payload.discountApprovedBy || user?._id) : undefined,
        advanceApplied: invoiceAdvanceApplied,
        amountReceived: externalReceived,
        amountTendered: externalReceived,
        amountApplied: entry.amount,
        externalMoneyMovement: externalReceived > 0,
        cashFlowClass: externalReceived > 0 ? 'EXTERNAL_COLLECTION' : 'WALLET_UTILISATION',
        balanceAfter: projectedBalance,
        paymentBreakdown: invoiceBreakdown,
        documentAllocations: [{ documentType: 'Invoice', documentId: invoice._id, amount: entry.amount }],
        sourceModule: payload.sourceModule || 'IPD',
        sourceId: admission._id,
        status: 'POSTED',
        remarks: payload.notes,
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:${invoice._id}` : undefined,
        metadata: {
          allocatedInvoiceNumber: invoice.invoice_number,
          externalReceived,
          advanceApplied: invoiceAdvanceApplied
        }
      });
      await transaction.save(sessionOptions(session));
      transactions.push(transaction);
    }

    // Credit / Pay Later is not a payment and therefore does not reduce
    // amount_paid or balance_due. It records an authorised receivable that can
    // be collected later using this same endpoint with any normal tender.
    invoices = await Invoice.find({ ...ipdCollectibleInvoiceFilterForAdmission(admissionId), hospital_id: admission.hospitalId }, null, sessionOptions(session))
      .sort({ issue_date: 1, created_at: 1 });
    selected = payload.invoiceId ? invoices.filter((invoice) => String(invoice._id) === String(payload.invoiceId)) : invoices;
    const newCreditCapacity = money(selected.reduce((sum, invoice) => (
      sum + Math.max(0, Number(invoice.balance_due || 0) - activeAuthorisedCredit(invoice))
    ), 0));
    const deferredCreditAmount = deferRemaining ? newCreditCapacity : explicitDeferredCredit;
    if (deferredCreditAmount > newCreditCapacity + 0.01) {
      const error = new Error('Credit / Pay Later amount cannot exceed the remaining uncovered invoice balance');
      error.statusCode = 400;
      throw error;
    }

    let creditAuthorizationNumber = null;
    if (deferredCreditAmount > 0) {
      creditAuthorizationNumber = await nextFinancialNumber({ documentType: 'CREDIT_AUTHORIZATION', hospitalId, session });
      let remainingCredit = deferredCreditAmount;
      for (const invoice of selected) {
        if (remainingCredit <= 0) break;
        const existingCredit = activeAuthorisedCredit(invoice);
        const capacity = money(Math.max(0, Number(invoice.balance_due || 0) - existingCredit));
        const applied = money(Math.min(remainingCredit, capacity));
        if (applied <= 0) continue;
        invoice.credit_authorised_amount = money(Number(invoice.credit_authorised_amount || 0) + applied);
        invoice.credit_status = 'AUTHORIZED';
        invoice.credit_due_date = payload.deferredCreditDueDate || payload.creditDueDate || invoice.due_date;
        invoice.credit_reason = String(payload.deferredCreditReason || payload.creditReason || payload.deferralReason || '').trim();
        invoice.credit_reference = String(payload.deferredCreditReference || payload.creditReference || payload.reference || '').trim();
        invoice.credit_authorised_at = operationNow();
        invoice.credit_authorised_by = user?._id;
        invoice.credit_history = invoice.credit_history || [];
        invoice.credit_history.push({
          action: existingCredit > 0 ? 'UPDATE' : 'AUTHORIZE',
          amount: applied,
          dueDate: invoice.credit_due_date,
          reason: invoice.credit_reason,
          reference: invoice.credit_reference,
          at: operationNow(),
          by: user?._id
        });
        await invoice.save(sessionOptions(session));
        await syncLinkedBillFromInvoice(invoice, undefined, session);

        const creditTransaction = new FinancialTransaction({
          hospitalId,
          patientId: admission.patientId,
          admissionId: admission._id,
          billId: invoice.bill_id,
          invoiceId: invoice._id,
          transactionNumber: creditAuthorizationNumber,
          transactionType: 'DEFERRED_CREDIT',
          direction: 'CREDIT',
          amount: applied,
          paymentMethod: 'Adjustment',
          paymentReference: invoice.credit_reference,
          receiptType: 'Adjustment',
          amountBeforeSettlement,
          amountReceived: 0,
          amountTendered: 0,
          amountApplied: 0,
          externalMoneyMovement: false,
          cashFlowClass: 'NON_CASH_ADJUSTMENT',
          balanceAfter: money(invoice.balance_due || 0),
          sourceModule: payload.sourceModule || 'IPD',
          sourceId: admission._id,
          status: 'POSTED',
          remarks: `Credit / Pay Later authorised: ${invoice.credit_reason}`,
          createdBy: user?._id,
          idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:credit:${invoice._id}` : undefined,
          metadata: {
            creditAuthorization: true,
            authorisedCreditAmount: applied,
            dueDate: invoice.credit_due_date,
            creditReference: invoice.credit_reference
          }
        });
        await creditTransaction.save(sessionOptions(session));
        transactions.push(creditTransaction);
        remainingCredit = money(remainingCredit - applied);
      }
    }

    return {
      receiptNumber,
      creditAuthorizationNumber,
      transactions,
      updatedAdvance,
      settlementDiscountAmount,
      taxAdjustmentAmount,
      paymentAmount: requestedAmount,
      externalReceived: externalBreakdownTotal(breakdown),
      advanceApplied,
      deferredCreditAmount,
      alreadyExists: false
    };
  }).then(async (result) => {
    const snapshot = await calculateAdmissionFinancials(admissionId, { user });
    await syncIPDClinicalFinancialClearance(admissionId, user);
    return {
      ...result,
      settlementSummary: {
        paymentAmount: money(result.paymentAmount || 0),
        externalReceived: money(result.externalReceived || 0),
        advanceApplied: money(result.advanceApplied || 0),
        deferredCreditAmount: money(result.deferredCreditAmount || 0),
        invoiceOutstanding: money(snapshot.invoiceOutstanding || 0),
        authorisedCreditOutstanding: money(snapshot.authorisedCreditOutstanding || 0),
        immediateDueAmount: money(snapshot.immediatePatientReceivable || 0),
        advanceAvailable: money(snapshot.advanceAvailable || 0)
      }
    };
  });
}
async function applyAvailableIPDAdvance(admissionId, options = {}, user) {
  const snapshot = await calculateAdmissionFinancials(admissionId, { user });
  const requestedInvoiceId = options.invoiceId ? String(options.invoiceId) : '';
  const targetInvoice = requestedInvoiceId
    ? snapshot.ipdInvoices.find((invoice) => String(invoice._id) === requestedInvoiceId)
    : null;
  const due = money(targetInvoice ? Number(targetInvoice.balance_due || 0) : snapshot.invoiceOutstanding);
  const available = money(snapshot.advanceAvailable || 0);
  const amount = money(Math.min(due, available));

  if (amount <= 0) {
    return {
      appliedAmount: 0,
      invoiceOutstandingBefore: due,
      advanceAvailableBefore: available,
      skipped: true,
      reason: due <= 0 ? 'NO_INVOICE_DUE' : 'NO_AVAILABLE_ADVANCE'
    };
  }

  const settlement = await recordIPDPayment(admissionId, {
    amount,
    invoiceId: targetInvoice?._id,
    paymentMethod: 'IPDAdvance',
    payments: [{ method: 'IPDAdvance', amount }],
    sourceModule: options.sourceModule || 'IPD',
    receiptType: options.receiptType === 'Final Settlement' ? 'Final Settlement' : 'Payment',
    reference: options.reference,
    notes: options.notes || 'Available IPD advance applied automatically against issued invoice(s)',
    idempotencyKey: options.idempotencyKey
  }, user);

  const after = await calculateAdmissionFinancials(admissionId, { user });
  const refreshedTarget = targetInvoice
    ? after.ipdInvoices.find((invoice) => String(invoice._id) === requestedInvoiceId)
    : null;

  return {
    ...settlement,
    appliedAmount: amount,
    invoiceOutstandingBefore: due,
    advanceAvailableBefore: available,
    invoiceOutstandingAfter: refreshedTarget
      ? money(refreshedTarget.balance_due || 0)
      : money(after.invoiceOutstanding),
    advanceAvailableAfter: money(after.advanceAvailable || 0),
    invoice: refreshedTarget || null,
    skipped: false
  };
}

async function getAuthoritativeIpdAdvanceBalance({ hospitalId, admissionId, session, fallbackBalance = 0 }) {
  const latest = await PatientAdvanceLedger.findOne(
    { hospitalId, admissionId, walletType: 'IPD_SHARED', status: 'POSTED' },
    null,
    sessionOptions(session)
  )
    .sort({ postedAt: -1, createdAt: -1, _id: -1 })
    .select('balanceAfter')
    .lean();

  // Existing installations can contain legacy admissions whose projection was
  // populated before the append-only IPD_SHARED ledger existed. Preserve that
  // value only when no authoritative ledger row exists; the first new deposit
  // or refund then bootstraps the ledger from the legacy opening balance.
  return latest ? money(latest.balanceAfter) : money(fallbackBalance);
}


async function recordAdvance(admissionId, payload, user) {
  const amount = assertAmount(payload.amount, 'Advance amount');
  const paymentMethod = payload.paymentMethod || 'Cash';

  if (!EXTERNAL_PAYMENT_METHODS.has(paymentMethod)) {
    const error = new Error('Advance deposits must use an external payment method such as Cash, Card, UPI or Bank');
    error.statusCode = 400;
    throw error;
  }

  return runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session, user);

    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne(
        { idempotencyKey: payload.idempotencyKey },
        null,
        sessionOptions(session)
      );

      if (existing) {
        const hospitalId = hospitalIdFor(admission, user);
        return {
          receiptNumber: existing.transactionNumber,
          advanceBalance: await getAuthoritativeIpdAdvanceBalance({
            hospitalId,
            admissionId: admission._id,
            session,
            fallbackBalance: admission.advanceAmount
          }),
          transaction: existing,
          alreadyExists: true
        };
      }
    }

    const hospitalId = hospitalIdFor(admission, user);
    const openingBalance = await getAuthoritativeIpdAdvanceBalance({
      hospitalId,
      admissionId: admission._id,
      session,
      fallbackBalance: admission.advanceAmount
    });
    const balanceAfter = money(openingBalance + amount);

    const receiptNumber = await nextFinancialNumber({
      documentType: 'ADVANCE_RECEIPT',
      hospitalId,
      session
    });

    // The append-only PatientAdvanceLedger is the source of truth.  The
    // admission.advanceAmount field is only a projection and can be stale after
    // legacy/imported flows.  Set it from the authoritative opening balance
    // instead of incrementing a potentially stale projection.  MongoDB
    // transaction write-conflict retries keep concurrent deposits serialised.
    const updated = await IPDAdmission.findOneAndUpdate(
      { _id: admissionId, hospitalId: admission.hospitalId },
      {
        $inc: { advanceReceivedAmount: amount },
        $set: {
          advanceAmount: balanceAfter,
          financialClearanceStatus: 'in_progress'
        }
      },
      { new: true, ...sessionOptions(session) }
    );

    if (!updated) {
      const error = new Error('IPD admission was not available while receiving advance');
      error.statusCode = 409;
      throw error;
    }

    await PatientAdvanceLedger.create(
      [{
        hospitalId,
        patientId: updated.patientId,
        admissionId: updated._id,
        walletType: 'IPD_SHARED',
        transactionType: 'ADVANCE_DEPOSIT',
        direction: 'CREDIT',
        amount,
        openingBalance,
        paymentMethod,
        referenceNumber: receiptNumber,
        documentType: 'Receipt',
        sourceModule: 'IPD',
        sourceId: updated._id,
        balanceAfter,
        notes: payload.notes || 'IPD advance received',
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:ledger` : undefined
      }],
      sessionOptions(session)
    );

    const transaction = new FinancialTransaction({
      hospitalId,
      patientId: updated.patientId,
      admissionId: updated._id,
      transactionNumber: receiptNumber,
      transactionType: 'ADVANCE_DEPOSIT',
      direction: 'CREDIT',
      amount,
      paymentMethod,
      paymentReference: payload.reference,
      receiptType: 'Advance',
      amountReceived: amount,
      amountTendered: amount,
      amountApplied: 0,
      externalMoneyMovement: true,
      cashFlowClass: 'ADVANCE_RECEIPT',
      balanceAfter,
      sourceModule: 'IPD',
      sourceId: updated._id,
      remarks: payload.notes || 'IPD advance received',
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey,
      metadata: {
        walletType: 'IPD_SHARED',
        walletOpeningBalance: openingBalance,
        walletBalanceAfter: balanceAfter
      }
    });

    await transaction.save(sessionOptions(session));

    return {
      receiptNumber,
      advanceBalance: balanceAfter,
      transaction,
      alreadyExists: false
    };
  });
}

async function refundAdvance(admissionId, payload, user) {
  const amount = assertAmount(payload.amount, 'Advance refund amount');
  const paymentMethod = payload.paymentMethod || 'Cash';

  if (!EXTERNAL_PAYMENT_METHODS.has(paymentMethod)) {
    const error = new Error('Advance refunds must use an external refund method such as Cash, Card, UPI or Bank');
    error.statusCode = 400;
    throw error;
  }

  if (!payload.reason?.trim()) {
    const error = new Error('Refund reason is required');
    error.statusCode = 400;
    throw error;
  }

  return runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session, user);
    const hospitalId = hospitalIdFor(admission, user);

    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne(
        { idempotencyKey: payload.idempotencyKey },
        null,
        sessionOptions(session)
      );
      if (existing) {
        return {
          refundNumber: existing.transactionNumber,
          advanceBalance: money(existing.balanceAfter),
          transaction: existing,
          alreadyExists: true
        };
      }
    }

    const openingBalance = await getAuthoritativeIpdAdvanceBalance({
      hospitalId,
      admissionId: admission._id,
      session,
      fallbackBalance: admission.advanceAmount
    });
    if (amount > openingBalance + 0.01) {
      const error = new Error('Refund amount exceeds the available IPD advance balance');
      error.statusCode = 409;
      throw error;
    }
    const balanceAfter = money(openingBalance - amount);

    const refundNumber = await nextFinancialNumber({
      documentType: 'REFUND',
      hospitalId,
      session
    });

    const updated = await IPDAdmission.findOneAndUpdate(
      { _id: admission._id, hospitalId: admission.hospitalId },
      {
        $inc: { advanceRefundedAmount: amount },
        $set: { advanceAmount: balanceAfter }
      },
      { new: true, ...sessionOptions(session) }
    );

    if (!updated) {
      const error = new Error('IPD admission was not available while refunding advance');
      error.statusCode = 409;
      throw error;
    }

    await PatientAdvanceLedger.create(
      [{
        hospitalId,
        patientId: updated.patientId,
        admissionId: updated._id,
        walletType: 'IPD_SHARED',
        transactionType: 'REFUND_PAID',
        direction: 'DEBIT',
        amount,
        openingBalance,
        paymentMethod,
        referenceNumber: refundNumber,
        documentType: 'Refund',
        sourceModule: 'Discharge',
        sourceId: updated._id,
        balanceAfter,
        notes: payload.reason.trim(),
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:ledger` : undefined
      }],
      sessionOptions(session)
    );

    const transaction = new FinancialTransaction({
      hospitalId,
      patientId: updated.patientId,
      admissionId: updated._id,
      transactionNumber: refundNumber,
      transactionType: 'ADVANCE_REFUND',
      direction: 'DEBIT',
      amount,
      paymentMethod,
      paymentReference: payload.reference,
      receiptType: 'Refund',
      amountReceived: 0,
      amountTendered: 0,
      amountApplied: 0,
      externalMoneyMovement: true,
      cashFlowClass: 'REFUND',
      balanceAfter,
      sourceModule: 'Discharge',
      sourceId: updated._id,
      remarks: payload.reason.trim(),
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey,
      metadata: {
        walletType: 'IPD_SHARED',
        walletOpeningBalance: openingBalance,
        walletBalanceAfter: balanceAfter
      }
    });

    await transaction.save(sessionOptions(session));

    return { refundNumber, advanceBalance: balanceAfter, transaction, alreadyExists: false };
  });
}


async function allocateInvoiceAdjustmentAcrossBills(invoice, adjustmentAmount, field, session) {
  const linkedBillIds = Array.from(new Set([
    ...(invoice?.bill_ids || []),
    ...(invoice?.bill_id ? [invoice.bill_id] : [])
  ].map((value) => String(value)).filter(Boolean)));
  if (!linkedBillIds.length || adjustmentAmount <= 0) return [];

  const linkedBills = await Bill.find(
    { _id: { $in: linkedBillIds }, hospital_id: invoice.hospital_id, is_deleted: { $ne: true } },
    null,
    sessionOptions(session)
  ).sort({ generated_at: 1, createdAt: 1 });

  let remaining = money(adjustmentAmount);
  const allocations = [];
  for (const linkedBill of linkedBills) {
    if (remaining <= 0.001) break;
    let capacity = 0;
    if (field === 'credit_note_amount') {
      capacity = money(Math.max(0, Number(linkedBill.total_amount || 0) - Number(linkedBill.credit_note_amount || 0)));
    } else if (field === 'refund_amount') {
      capacity = money(Math.max(0, Number(linkedBill.paid_amount || 0) - Number(linkedBill.refund_amount || 0)));
    } else {
      throw new Error(`Unsupported Bill adjustment projection field: ${field}`);
    }
    const applied = money(Math.min(capacity, remaining));
    if (applied <= 0) continue;
    linkedBill[field] = money(Number(linkedBill[field] || 0) + applied);
    await linkedBill.save(sessionOptions(session));
    allocations.push({ documentType: 'Bill', documentId: linkedBill._id, amount: applied });
    remaining = money(remaining - applied);
  }
  return allocations;
}

async function ensureAdjustmentInvoiceBillReverseLinks(adjustmentInvoice, originalInvoice, session) {
  const linkedBillIds = Array.from(new Set([
    ...(adjustmentInvoice?.bill_ids || []),
    ...(adjustmentInvoice?.bill_id ? [adjustmentInvoice.bill_id] : [])
  ].map((value) => String(value)).filter(Boolean)));
  if (!linkedBillIds.length) return;

  const updateResult = await Bill.updateMany({
    _id: { $in: linkedBillIds },
    hospital_id: originalInvoice.hospital_id,
    patient_id: originalInvoice.patient_id,
    is_deleted: { $ne: true }
  }, {
    $addToSet: { invoice_ids: adjustmentInvoice._id }
  }, sessionOptions(session));

  const matchedCount = Number(updateResult?.matchedCount ?? updateResult?.n ?? 0);
  if (matchedCount !== linkedBillIds.length) {
    const error = new Error('Credit-note Bill linkage could not be established for every referenced Bill');
    error.statusCode = 409;
    error.code = 'CREDIT_NOTE_BILL_LINK_CONFLICT';
    throw error;
  }
}

async function createCreditNoteInSession(invoice, payload, user, session) {
  const amount = assertAmount(payload.amount, 'Credit note amount');
  if (!payload.reason?.trim()) {
    const error = new Error('Credit note reason is required');
    error.statusCode = 400;
    throw error;
  }

  const scopedHospitalId = userHospitalId(user);
  if (scopedHospitalId && String(invoice.hospital_id) !== String(scopedHospitalId)) {
    const error = new Error('Invoice not found in this hospital');
    error.statusCode = 404;
    throw error;
  }

  if (payload.idempotencyKey) {
    const existingTransaction = await FinancialTransaction.findOne({
      hospitalId: invoice.hospital_id,
      idempotencyKey: payload.idempotencyKey,
      transactionType: 'CREDIT_NOTE'
    }, null, sessionOptions(session));
    if (existingTransaction) {
      const existingCreditNoteId = existingTransaction.metadata?.creditNoteInvoiceId;
      const existingCreditNote = existingCreditNoteId
        ? await Invoice.findById(existingCreditNoteId, null, sessionOptions(session))
        : null;
      if (existingCreditNote) {
        await ensureAdjustmentInvoiceBillReverseLinks(existingCreditNote, invoice, session);
      }
      return {
        creditNote: existingCreditNote,
        originalInvoice: invoice,
        transaction: existingTransaction,
        alreadyExists: true
      };
    }
  }

  if (!['Appointment', 'Procedure', 'Lab Test', 'Radiology', 'IPD Interim', 'IPD Final', 'Pharmacy', 'Mixed', 'Other'].includes(invoice.invoice_type) ||
      invoice.document_stage === 'VOID') {
    const error = new Error('This invoice cannot receive a credit note');
    error.statusCode = 409;
    throw error;
  }

  // Settlement discounts and credit notes both reduce the patient's recognised
  // liability. Never allow a later credit note to exceed what remains after
  // settlement concessions have already been posted.
  const eligible = money(Math.max(
    0,
    Number(invoice.total || 0) -
      Number(invoice.settlement_discount_amount || 0) -
      Number(invoice.credit_note_total || 0)
  ));
  if (amount > eligible + 0.01) {
    const error = new Error('Credit note amount exceeds the eligible invoice value');
    error.statusCode = 400;
    throw error;
  }

  const admission = invoice.admission_id
    ? await findAdmission(invoice.admission_id, session, user)
    : null;
  const hospitalId = invoice.hospital_id || hospitalIdFor(admission, user);
  const noteNumber = await nextFinancialNumber({ documentType: 'CREDIT_NOTE', hospitalId, session });

  const creditNote = new Invoice({
    hospital_id: hospitalId,
    invoice_number: noteNumber,
    patient_id: invoice.patient_id,
    admission_id: invoice.admission_id,
    appointment_id: invoice.appointment_id,
    bill_id: invoice.bill_id,
    bill_ids: invoice.bill_ids || (invoice.bill_id ? [invoice.bill_id] : []),
    invoice_type: 'Credit Note',
    document_stage: 'CREDIT_NOTE',
    linked_invoice_id: invoice._id,
    issue_date: operationNow(),
    due_date: operationNow(),
    subtotal: amount,
    gross_amount: amount,
    discount: 0,
    tax: 0,
    total: amount,
    amount_paid: amount,
    balance_due: 0,
    status: 'Paid',
    notes: payload.reason.trim(),
    created_by: user?._id,
    patient_snapshot: invoice.patient_snapshot,
    hospital_snapshot: invoice.hospital_snapshot,
    service_items: [{
      description: `Credit note against ${invoice.invoice_number}: ${payload.reason.trim()}`,
      quantity: 1,
      unit_price: amount,
      gross_amount: amount,
      taxable_amount: amount,
      net_amount: amount,
      total_price: amount,
      service_type: 'Other',
      charge_type: 'Credit Note',
      source_snapshot: {
        sourceModule: 'Billing',
        sourceId: invoice._id,
        sourceLineKey: `credit-note:${invoice._id}:${noteNumber}`
      }
    }]
  });
  await creditNote.save(sessionOptions(session));

  // Credit Notes are Invoice documents that intentionally retain the original
  // Bill references for auditability. Keep that relationship bidirectional
  // without replacing Bill.invoice_id, which remains the issued payment-authority
  // Invoice. The adjustment document is appended only to Bill.invoice_ids.
  await ensureAdjustmentInvoiceBillReverseLinks(creditNote, invoice, session);

  invoice.credit_note_total = money(Number(invoice.credit_note_total || 0) + amount);
  await invoice.save(sessionOptions(session));

  const billCreditAllocations = await allocateInvoiceAdjustmentAcrossBills(
    invoice,
    amount,
    'credit_note_amount',
    session
  );

  const transaction = new FinancialTransaction({
    hospitalId,
    patientId: invoice.patient_id,
    admissionId: invoice.admission_id,
    billId: invoice.bill_id,
    invoiceId: invoice._id,
    transactionNumber: noteNumber,
    transactionType: 'CREDIT_NOTE',
    direction: 'CREDIT',
    amount,
    paymentMethod: 'Adjustment',
    receiptType: 'Adjustment',
    amountReceived: 0,
    amountTendered: 0,
    amountApplied: 0,
    externalMoneyMovement: false,
    cashFlowClass: 'NON_CASH_ADJUSTMENT',
    documentAllocations: billCreditAllocations.length
      ? billCreditAllocations
      : [{ documentType: 'Invoice', documentId: invoice._id, amount }],
    sourceModule: 'Billing',
    sourceId: creditNote._id,
    remarks: payload.reason.trim(),
    createdBy: user?._id,
    idempotencyKey: payload.idempotencyKey,
    metadata: { creditNoteInvoiceId: creditNote._id }
  });
  await transaction.save(sessionOptions(session));

  return { creditNote, originalInvoice: invoice, transaction, alreadyExists: false };
}

async function createCreditNote(invoiceId, payload, user) {
  const result = await runFinancialTransaction(async (session) => {
    const invoice = await Invoice.findById(invoiceId, null, sessionOptions(session));
    if (!invoice) {
      const error = new Error('Invoice not found');
      error.statusCode = 404;
      throw error;
    }
    return createCreditNoteInSession(invoice, payload, user, session);
  });

  if (result.originalInvoice?.admission_id) {
    await calculateAdmissionFinancials(result.originalInvoice.admission_id, { user });
  }
  return result;
}

async function refundInvoice(invoiceId, payload, user) {
  const refundAmount = assertAmount(payload.amount, 'Refund amount');
  const refundMethod = payload.paymentMethod || 'Cash';
  if (!EXTERNAL_PAYMENT_METHODS.has(refundMethod)) {
    const error = new Error('Invoice refunds must use an external refund method such as Cash, Card, UPI or Bank');
    error.statusCode = 400;
    throw error;
  }
  if (!payload.reason?.trim()) {
    const error = new Error('Refund reason is required');
    error.statusCode = 400;
    throw error;
  }

  const result = await runFinancialTransaction(async (session) => {
    const invoice = await Invoice.findById(invoiceId, null, sessionOptions(session));
    if (!invoice) {
      const error = new Error('Invoice not found');
      error.statusCode = 404;
      throw error;
    }

    const scopedHospitalId = userHospitalId(user);
    if (scopedHospitalId && String(invoice.hospital_id) !== String(scopedHospitalId)) {
      const error = new Error('Invoice not found in this hospital');
      error.statusCode = 404;
      throw error;
    }

    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne({
        hospitalId: invoice.hospital_id,
        idempotencyKey: payload.idempotencyKey,
        transactionType: 'REFUND'
      }, null, sessionOptions(session));
      if (existing) {
        const creditNoteId = existing.metadata?.creditNoteId;
        return {
          refundNumber: existing.transactionNumber,
          transaction: existing,
          creditNote: creditNoteId ? await Invoice.findById(creditNoteId, null, sessionOptions(session)) : null,
          originalInvoice: invoice,
          alreadyExists: true
        };
      }
    }

    const refundable = money(Math.max(0, Number(invoice.amount_paid || 0) - Number(invoice.refunded_amount || 0) - Number(invoice.advance_transferred_amount || 0)));
    if (refundAmount > refundable + 0.01) {
      const error = new Error(`Refund amount exceeds the collected refundable amount of ₹${refundable.toFixed(2)}`);
      error.statusCode = 400;
      throw error;
    }

    // A refund always carries an equal credit note so the patient's liability and
    // the external cash reversal remain separate, auditable events. They are
    // committed in the SAME MongoDB transaction: never persist a credit without
    // its refund (or vice versa) because a network/database failure occurred.
    const creditKey = payload.idempotencyKey ? `${payload.idempotencyKey}:credit` : undefined;
    const credit = await createCreditNoteInSession(invoice, {
      amount: refundAmount,
      reason: payload.reason,
      idempotencyKey: creditKey
    }, user, session);

    const hospitalId = invoice.hospital_id;
    const refundNumber = await nextFinancialNumber({ documentType: 'REFUND', hospitalId, session });

    invoice.refunded_amount = money(Number(invoice.refunded_amount || 0) + refundAmount);
    await invoice.save(sessionOptions(session));

    const billRefundAllocations = await allocateInvoiceAdjustmentAcrossBills(
      invoice,
      refundAmount,
      'refund_amount',
      session
    );

    const transaction = new FinancialTransaction({
      hospitalId,
      patientId: invoice.patient_id,
      admissionId: invoice.admission_id,
      billId: invoice.bill_id,
      invoiceId: invoice._id,
      transactionNumber: refundNumber,
      transactionType: 'REFUND',
      direction: 'DEBIT',
      amount: refundAmount,
      paymentMethod: refundMethod,
      paymentReference: payload.reference,
      receiptType: 'Refund',
      amountReceived: 0,
      amountTendered: 0,
      amountApplied: 0,
      externalMoneyMovement: true,
      cashFlowClass: 'REFUND',
      sourceModule: 'Billing',
      sourceId: credit.creditNote?._id,
      remarks: payload.reason.trim(),
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey,
      documentAllocations: billRefundAllocations.length
        ? billRefundAllocations
        : [{ documentType: 'Invoice', documentId: invoice._id, amount: refundAmount }],
      metadata: {
        creditNoteNumber: credit.creditNote?.invoice_number,
        creditNoteId: credit.creditNote?._id,
        creditTransactionId: credit.transaction?._id
      }
    });
    await transaction.save(sessionOptions(session));

    return {
      creditNote: credit.creditNote,
      originalInvoice: invoice,
      refundNumber,
      transaction,
      alreadyExists: false
    };
  });

  if (result.originalInvoice?.admission_id) {
    await calculateAdmissionFinancials(result.originalInvoice.admission_id, { user });
  }
  return result;
}


/**
 * Resolve the collected portion of an OPD invoice while cancelling the
 * appointment, without forcing front-desk staff to leave the Desk screen.
 *
 * REFUND  -> money leaves the hospital through the selected external method.
 * ADVANCE -> money remains with the hospital and is moved to the patient's
 *            OPD shared advance wallet as a non-cash reclassification.
 *
 * Only the liability that corresponds to the collected amount is credited
 * here. Any still-unpaid remainder is deliberately left for a separate credit
 * note so the controller can enforce the stronger pricing_override permission
 * for writing off unpaid liability.
 */
async function resolveOPDInvoiceCollectionForCancellation(invoiceId, payload = {}, user) {
  const disposition = String(payload.disposition || '').trim().toUpperCase();
  if (!['REFUND', 'ADVANCE'].includes(disposition)) {
    const error = new Error('Cancellation collection disposition must be REFUND or ADVANCE');
    error.statusCode = 400;
    error.code = 'INVALID_CANCELLATION_FINANCIAL_DISPOSITION';
    throw error;
  }
  const reason = String(payload.reason || '').trim();
  if (!reason) {
    const error = new Error('Financial adjustment reason is required');
    error.statusCode = 400;
    throw error;
  }

  const result = await runFinancialTransaction(async (session) => {
    const invoice = await Invoice.findById(invoiceId, null, sessionOptions(session));
    if (!invoice) {
      const error = new Error('Invoice not found');
      error.statusCode = 404;
      throw error;
    }

    const scopedHospitalId = userHospitalId(user);
    if (scopedHospitalId && String(invoice.hospital_id) !== String(scopedHospitalId)) {
      const error = new Error('Invoice not found in this hospital');
      error.statusCode = 404;
      throw error;
    }
    if (invoice.admission_id) {
      const error = new Error('IPD invoice collection cannot be moved through OPD appointment cancellation');
      error.statusCode = 409;
      error.code = 'OPD_CANCELLATION_IPD_INVOICE_BLOCKED';
      throw error;
    }
    if (payload.appointmentId && invoice.appointment_id && String(invoice.appointment_id) !== String(payload.appointmentId)) {
      const error = new Error('Invoice does not belong to the appointment being cancelled');
      error.statusCode = 409;
      error.code = 'OPD_ENCOUNTER_MISMATCH';
      throw error;
    }

    const rootKey = String(payload.idempotencyKey || `appointment-cancel:${payload.appointmentId || 'unknown'}:invoice:${invoice._id}:${disposition.toLowerCase()}`);
    const moneyKey = `${rootKey}:money`;
    const existingMoney = await FinancialTransaction.findOne({
      hospitalId: invoice.hospital_id,
      idempotencyKey: moneyKey,
      status: 'POSTED'
    }, null, sessionOptions(session));
    if (existingMoney) {
      const existingCreditId = existingMoney.metadata?.creditNoteId;
      return {
        originalInvoice: invoice,
        creditNote: existingCreditId ? await Invoice.findById(existingCreditId, null, sessionOptions(session)) : null,
        transaction: existingMoney,
        amountResolved: money(existingMoney.amount || 0),
        disposition,
        alreadyExists: true
      };
    }

    const collectedAvailable = money(Math.max(
      0,
      Number(invoice.amount_paid || 0) -
      Number(invoice.refunded_amount || 0) -
      Number(invoice.advance_transferred_amount || 0)
    ));
    if (collectedAvailable <= 0) {
      return {
        originalInvoice: invoice,
        creditNote: null,
        transaction: null,
        amountResolved: 0,
        disposition,
        alreadyExists: false
      };
    }

    const remainingLiability = money(Math.max(
      0,
      Number(invoice.total || 0) -
      Number(invoice.settlement_discount_amount || 0) -
      Number(invoice.credit_note_total || 0)
    ));
    const creditForCollected = money(Math.min(collectedAvailable, remainingLiability));
    const credit = creditForCollected > 0
      ? await createCreditNoteInSession(invoice, {
          amount: creditForCollected,
          reason,
          idempotencyKey: `${rootKey}:credit`
        }, user, session)
      : null;

    if (disposition === 'REFUND') {
      const refundMethod = payload.paymentMethod || 'Cash';
      if (!EXTERNAL_PAYMENT_METHODS.has(refundMethod)) {
        const error = new Error('Appointment cancellation refunds must use an external refund method such as Cash, Card, UPI or Bank');
        error.statusCode = 400;
        throw error;
      }

      const refundNumber = await nextFinancialNumber({ documentType: 'REFUND', hospitalId: invoice.hospital_id, session });
      invoice.refunded_amount = money(Number(invoice.refunded_amount || 0) + collectedAvailable);
      await invoice.save(sessionOptions(session));

      const billRefundAllocations = await allocateInvoiceAdjustmentAcrossBills(
        invoice,
        collectedAvailable,
        'refund_amount',
        session
      );

      const transaction = new FinancialTransaction({
        hospitalId: invoice.hospital_id,
        patientId: invoice.patient_id,
        billId: invoice.bill_id,
        invoiceId: invoice._id,
        transactionNumber: refundNumber,
        transactionType: 'REFUND',
        direction: 'DEBIT',
        amount: collectedAvailable,
        paymentMethod: refundMethod,
        paymentReference: payload.reference,
        receiptType: 'Refund',
        amountReceived: 0,
        amountTendered: 0,
        amountApplied: 0,
        externalMoneyMovement: true,
        cashFlowClass: 'REFUND',
        sourceModule: 'OPD',
        sourceId: invoice.appointment_id || invoice._id,
        remarks: reason,
        createdBy: user?._id,
        idempotencyKey: moneyKey,
        documentAllocations: billRefundAllocations.length
          ? billRefundAllocations
          : [{ documentType: 'Invoice', documentId: invoice._id, amount: collectedAvailable }],
        metadata: {
          appointmentCancellation: true,
          disposition: 'REFUND',
          creditNoteId: credit?.creditNote?._id,
          creditNoteNumber: credit?.creditNote?.invoice_number,
          creditAmountCreated: creditForCollected
        }
      });
      await transaction.save(sessionOptions(session));

      return {
        originalInvoice: invoice,
        creditNote: credit?.creditNote || null,
        transaction,
        refundNumber,
        amountResolved: collectedAvailable,
        disposition,
        alreadyExists: false
      };
    }

    const advanceNumber = await nextFinancialNumber({ documentType: 'ADVANCE_RECEIPT', hospitalId: invoice.hospital_id, session });
    const latestAdvance = await PatientAdvanceLedger.findOne({
      hospitalId: invoice.hospital_id,
      patientId: invoice.patient_id,
      walletType: 'OPD_SHARED',
      status: 'POSTED'
    }, null, sessionOptions(session)).sort({ postedAt: -1, createdAt: -1 });
    const openingBalance = money(latestAdvance?.balanceAfter || 0);
    const balanceAfter = money(openingBalance + collectedAvailable);

    await PatientAdvanceLedger.create([{
      hospitalId: invoice.hospital_id,
      patientId: invoice.patient_id,
      walletType: 'OPD_SHARED',
      transactionType: 'MANUAL_ADJUSTMENT',
      direction: 'CREDIT',
      amount: collectedAvailable,
      openingBalance,
      paymentMethod: 'Adjustment',
      referenceNumber: advanceNumber,
      documentType: 'Adjustment',
      documentId: invoice._id,
      sourceModule: 'OPD',
      sourceId: invoice.appointment_id || invoice._id,
      balanceAfter,
      notes: reason,
      createdBy: user?._id,
      idempotencyKey: `${rootKey}:advance-ledger`,
      transactionGroupId: rootKey,
      presentationType: 'APPOINTMENT_CANCELLATION_TO_ADVANCE'
    }], sessionOptions(session));

    invoice.advance_transferred_amount = money(Number(invoice.advance_transferred_amount || 0) + collectedAvailable);
    await invoice.save(sessionOptions(session));

    const transaction = new FinancialTransaction({
      hospitalId: invoice.hospital_id,
      patientId: invoice.patient_id,
      billId: invoice.bill_id,
      invoiceId: invoice._id,
      transactionNumber: advanceNumber,
      transactionType: 'ADJUSTMENT',
      direction: 'CREDIT',
      amount: collectedAvailable,
      paymentMethod: 'Adjustment',
      paymentReference: payload.reference,
      receiptType: 'Adjustment',
      amountReceived: 0,
      amountTendered: 0,
      amountApplied: 0,
      advanceCreated: collectedAvailable,
      externalMoneyMovement: false,
      cashFlowClass: 'NON_CASH_ADJUSTMENT',
      balanceAfter,
      sourceModule: 'OPD',
      sourceId: invoice.appointment_id || invoice._id,
      remarks: reason,
      createdBy: user?._id,
      idempotencyKey: moneyKey,
      documentAllocations: [{ documentType: 'Invoice', documentId: invoice._id, amount: collectedAvailable }],
      metadata: {
        appointmentCancellation: true,
        disposition: 'ADVANCE',
        walletType: 'OPD_SHARED',
        walletOpeningBalance: openingBalance,
        walletBalanceAfter: balanceAfter,
        creditNoteId: credit?.creditNote?._id,
        creditNoteNumber: credit?.creditNote?.invoice_number,
        creditAmountCreated: creditForCollected
      }
    });
    await transaction.save(sessionOptions(session));

    return {
      originalInvoice: invoice,
      creditNote: credit?.creditNote || null,
      transaction,
      advanceNumber,
      advanceBalance: balanceAfter,
      amountResolved: collectedAvailable,
      disposition,
      alreadyExists: false
    };
  });

  return result;
}

async function getFinancialLedger(admissionId, user, options = {}) {
  const snapshot = options.snapshot || await calculateAdmissionFinancials(admissionId, { user });

  const [transactions, advanceLedger] = await Promise.all([
    options.transactions
      ? Promise.resolve(options.transactions)
      : FinancialTransaction.find({
          hospitalId: snapshot.admission.hospitalId,
          admissionId,
          status: 'POSTED'
        }).sort({ createdAt: 1 }).lean(),
    options.advanceLedger
      ? Promise.resolve(options.advanceLedger)
      : PatientAdvanceLedger.find({
          hospitalId: snapshot.admission.hospitalId,
          admissionId,
          status: 'POSTED'
        }).sort({ postedAt: 1, createdAt: 1 }).lean()
  ]);

  const ipdInvoiceIds = new Set((snapshot.ipdInvoices || []).map((row) => String(row._id)));
  const isIpdControlledTransaction = (transaction = {}) => {
    if (String(transaction.sourceModule || '').toUpperCase() === 'PHARMACY') return false;
    const invoiceId = transaction.invoiceId?._id || transaction.invoiceId;
    return !invoiceId || !ipdInvoiceIds.size || ipdInvoiceIds.has(String(invoiceId));
  };
  const ipdTransactions = transactions.filter(isIpdControlledTransaction);
  const externalPaidAmount = money(ipdTransactions.reduce((sum, row) => sum + externalReceiptAmount(row), 0));
  const paymentRefundAmount = money(ipdTransactions
    .filter((row) => String(row.transactionType || '').toUpperCase() === 'REFUND')
    .reduce((sum, row) => sum + money(row.amount || 0), 0));
  const totalCollectedAmount = money(externalPaidAmount + snapshot.advanceReceived);
  const netCollectedAmount = money(Math.max(0, totalCollectedAmount - paymentRefundAmount - snapshot.advanceRefunded));

  // A patient-advance event may be mirrored by FinancialTransaction. The current
  // production path/fixture stores the wallet reference as paymentReference for the
  // deposit and as transactionNumber for utilisation. Match both identities before
  // exposing wallet-only rows, otherwise the same advance appears twice in Ledger.
  const financialEventReferences = new Set();
  transactions.forEach((transaction) => {
    [transaction.transactionNumber, transaction.paymentReference]
      .filter(Boolean)
      .forEach((reference) => financialEventReferences.add(String(reference)));
  });
  const unmatchedAdvanceLedger = advanceLedger.filter((entry) =>
    !entry.referenceNumber || !financialEventReferences.has(String(entry.referenceNumber))
  );

  const advanceByReference = new Map();
  advanceLedger.forEach((entry) => {
    if (entry.referenceNumber) advanceByReference.set(String(entry.referenceNumber), entry);
  });

  const invoiceEntries = [...(snapshot.ipdInvoices || []), ...(snapshot.pharmacyInvoices || [])]
    .filter((invoice) => invoice.document_stage !== 'VOID' && invoice.status !== 'Cancelled')
    .map((invoice) => ({
      date: invoice.issue_date || invoice.created_at || invoice.createdAt,
      kind: 'INVOICE',
      number: invoice.invoice_number,
      patientDebit: money(invoice.total),
      patientCredit: 0,
      walletCredit: 0,
      walletDebit: 0,
      walletBalance: null,
      description: `${invoice.invoice_type || 'Patient'} — ${invoice.status || 'Issued'}`,
      invoiceId: invoice._id
    }));

  const transactionEntry = (transaction) => {
    const type = String(transaction.transactionType || '').toUpperCase();
    const amount = money(transaction.amount || 0);
    const advanceApplied = money(transaction.advanceApplied || 0);
    let patientDebit = 0;
    let patientCredit = 0;
    let walletCredit = 0;
    let walletDebit = 0;

    if (type === 'ADVANCE_DEPOSIT') {
      walletCredit = amount;
    } else if (type === 'ADVANCE_UTILISATION') {
      patientCredit = money(transaction.amountApplied || amount);
      walletDebit = money(transaction.advanceApplied || amount);
    } else if (type === 'ADVANCE_REFUND') {
      walletDebit = amount;
    } else if (type === 'REFUND') {
      patientDebit = amount;
    } else if (type === 'DEFERRED_CREDIT') {
      // Credit / Pay Later is an authorisation state, not a payment and not a
      // reduction in the patient's legal receivable. Keep it visible in the
      // ledger without altering the running debit/credit balance.
      patientDebit = 0;
      patientCredit = 0;
    } else if (['RECEIPT', 'SETTLEMENT', 'CREDIT_NOTE'].includes(type)) {
      // A legacy mixed settlement may embed advanceApplied in the receipt amount.
      // The whole settlement reduces patient liability once; only the advance part
      // moves the wallet. New records normally have a separate ADVANCE_UTILISATION.
      patientCredit = amount;
      if (advanceApplied > 0) walletDebit = advanceApplied;
    } else if (String(transaction.direction || '').toUpperCase() === 'DEBIT') {
      patientDebit = amount;
    } else {
      patientCredit = amount;
    }

    const referenceCandidates = [transaction.transactionNumber, transaction.paymentReference].filter(Boolean).map(String);
    const matchingAdvance = referenceCandidates.map((ref) => advanceByReference.get(ref)).find(Boolean);
    return {
      date: transaction.postedAt || transaction.createdAt,
      kind: type || transaction.transactionType || 'TRANSACTION',
      number: transaction.transactionNumber || transaction.paymentReference,
      patientDebit: money(patientDebit),
      patientCredit: money(patientCredit),
      walletCredit: money(walletCredit),
      walletDebit: money(walletDebit),
      walletBalance: matchingAdvance ? money(matchingAdvance.balanceAfter) : null,
      walletType: matchingAdvance?.walletType || transaction.metadata?.walletType || (walletCredit || walletDebit ? 'IPD_SHARED' : undefined),
      paymentMethod: transaction.paymentMethod,
      description: transaction.remarks || transaction.transactionType,
      invoiceId: transaction.invoiceId,
      transactionId: transaction._id
    };
  };

  const unmatchedWalletEntries = unmatchedAdvanceLedger.map((entry) => {
    const type = String(entry.transactionType || '').toUpperCase();
    const amount = money(entry.amount || 0);
    const isCredit = String(entry.direction || '').toUpperCase() === 'CREDIT';
    const isUtilisation = ['IPD_INVOICE_DEBIT', 'OUTSTANDING_SETTLEMENT_DEBIT'].includes(type);
    return {
      date: entry.postedAt || entry.createdAt,
      kind: `WALLET_${type}`,
      number: entry.referenceNumber,
      patientDebit: 0,
      // For legacy wallet-only utilisation, reflect the settlement once in the
      // patient-liability columns as well as the wallet movement.
      patientCredit: isUtilisation ? amount : 0,
      walletCredit: isCredit ? amount : 0,
      walletDebit: !isCredit ? amount : 0,
      walletBalance: money(entry.balanceAfter),
      walletType: entry.walletType,
      paymentMethod: entry.paymentMethod,
      description: entry.notes || entry.transactionType,
      advanceEntryId: entry._id
    };
  });

  let patientBalance = 0;
  const entries = [
    ...invoiceEntries,
    ...transactions.map(transactionEntry),
    ...unmatchedWalletEntries
  ]
    .sort((left, right) => new Date(left.date || 0) - new Date(right.date || 0))
    .map((entry) => {
      patientBalance = money(patientBalance + money(entry.patientDebit) - money(entry.patientCredit));
      return {
        ...entry,
        patientBalance,
        // Backward-compatible aliases used by the financial print mapper.
        debit: money(entry.patientDebit),
        credit: money(entry.patientCredit),
        balance: patientBalance
      };
    });

  const encounterInvoiced = money(
    [...(snapshot.ipdInvoices || []), ...(snapshot.pharmacyInvoices || [])]
      .filter((invoice) => invoice.document_stage !== 'VOID' && invoice.status !== 'Cancelled')
      .reduce((sum, invoice) => sum + Number(invoice.total || 0), 0)
  );
  const encounterSettled = money(
    [...(snapshot.ipdInvoices || []), ...(snapshot.pharmacyInvoices || [])]
      .filter((invoice) => invoice.document_stage !== 'VOID' && invoice.status !== 'Cancelled')
      .reduce((sum, invoice) => sum + Number(invoice.amount_paid || 0), 0)
  );

  return {
    success: true,
    admission: snapshot.admission,
    totals: {
      totalCharged: snapshot.ipdChargeAmount,
      totalEncounterCharged: snapshot.totalChargeAmount,
      pharmacyMirrorCharged: sumCharges(snapshot.pharmacyMirrorCharges),
      invoiced: snapshot.invoicedGross,
      encounterInvoiced,
      // `paid` remains IPD-controlled invoice settlement for compatibility.
      paid: snapshot.invoicePaid,
      totalSettledAmount: snapshot.invoicePaid,
      encounterSettledAmount: encounterSettled,
      externalPaidAmount,
      totalCollectedAmount,
      netCollectedAmount,
      paymentRefundAmount,
      due: snapshot.overallDue,
      advanceReceived: snapshot.advanceReceived,
      advanceApplied: snapshot.advanceUtilized,
      advanceRefunded: snapshot.advanceRefunded,
      advanceAvailable: snapshot.advanceAvailable
    },
    invoices: snapshot.ipdInvoices,
    pharmacyInvoices: snapshot.pharmacyInvoices,
    transactions,
    advanceLedger,
    entries
  };
}

async function getFinancialClearance(admissionId, user, options = {}) {
  if (!options.snapshot && !options.skipEnsure) {
    await ensureAdmissionDailyCharges(admissionId, operationNow(), user);
  }
  const snapshot = options.snapshot || await calculateAdmissionFinancials(admissionId, { user });
  const admission = snapshot.admission;
  const workflowPolicy = await loadIPDWorkflowPolicy(admission.hospitalId);
  const pharmacyBillingPolicy = snapshot.pharmacyBillingPolicy || policyFromAdmission(admission);
  const consolidatedPharmacyBilling = ipdOwnsPharmacyBilling(pharmacyBillingPolicy);

  const eligibleUnbilledFilter = {
    hospitalId: admission.hospitalId,
    admissionId,
    ...UNBILLED_CHARGE_FILTER
  };
  if (!consolidatedPharmacyBilling) eligibleUnbilledFilter.sourceModule = { $ne: 'Pharmacy' };

  const [pendingPharmacySales, hasPharmacyTransactions, pharmacyAdvanceRow, eligibleUnbilled] = await Promise.all([
    Sale.find({
      hospitalId: admission.hospitalId,
      admission_id: admissionId,
      billing_owner: { $ne: 'IPD' },
      balance_due: { $gt: 0 },
      status: { $in: ['Pending', 'Partially Paid', 'PartiallyReturned'] },
      include_in_discharge_clearance: { $ne: false }
    }).select('sale_number balance_due total_amount payment_deferred include_in_discharge_clearance sale_date billing_owner collection_mode').lean(),
    Sale.exists({ hospitalId: admission.hospitalId, admission_id: admissionId, status: { $ne: 'Cancelled' } }),
    PatientAdvanceLedger.findOne({ hospitalId: admission.hospitalId, admissionId, walletType: 'PHARMACY_IPD', status: 'POSTED' }).sort({ createdAt: -1 }).select('balanceAfter').lean(),
    IPDCharge.find(eligibleUnbilledFilter).select('netAmount sourceModule').lean()
  ]);

  // In IPD-consolidated mode Pharmacy Sale/Invoice rows remain authoritative
  // subledger documents, but they are deliberately not patient-collectible.
  const pharmacyDue = consolidatedPharmacyBilling
    ? 0
    : money(pendingPharmacySales.reduce((sum, sale) => sum + (Number(sale.balance_due) || 0), 0));
  const pharmacyAdvanceAvailable = money(pharmacyAdvanceRow?.balanceAfter || 0);
  const explicitPharmacyClearance = ['cleared', 'exempted'].includes(admission.pharmacyClearanceStatus);
  const noPharmacyActivity = !hasPharmacyTransactions && pharmacyAdvanceAvailable === 0;
  const pharmacyAutoExemptEligible = workflowPolicy.autoExemptPharmacyWhenNoTransactions && noPharmacyActivity;
  const pharmacyCleared = !workflowPolicy.requirePharmacyClearance || explicitPharmacyClearance || pharmacyAutoExemptEligible;
  const finalInvoice = snapshot.ipdInvoices.find((invoice) => invoice.invoice_type === 'IPD Final' || invoice.is_final_ipd_invoice === true) || null;
  const eligibleUnbilledTotal = money(eligibleUnbilled.reduce((sum, row) => sum + Number(row.netAmount || 0), 0));

  const advanceAvailable = money(snapshot.advanceAvailable);
  const disposition = admission.advanceClearanceDisposition || 'pending';
  const advanceReconciled = !workflowPolicy.requireAdvanceReconciliation || advanceAvailable === 0 ||
    workflowPolicy.unusedIpdAdvanceDisposition === 'ALLOW_RETAIN' ||
    (workflowPolicy.unusedIpdAdvanceDisposition === 'REQUIRE_DECISION' && ['retain', 'carry_forward', 'refunded', 'none'].includes(disposition));

  const pharmacyMustPrecedeFinance = workflowPolicy.requirePharmacyClearance && stageBefore(workflowPolicy, 'PHARMACY_CLEARANCE', 'IPD_FINANCIAL_CLEARANCE');
  const checks = {
    chargeFreezeActive: admission.chargeFreeze?.status === 'frozen' && Boolean(admission.chargeFreeze?.frozenAt),
    unbilledChargesResolved: eligibleUnbilledTotal === 0,
    // Explicitly authorised pay-later credit may cover an issued receivable
    // for discharge clearance without pretending it was paid. The invoice
    // balance remains outstanding for later collection/reporting.
    issuedInvoicesSettled: snapshot.uncoveredInvoiceOutstanding === 0,
    issuedInvoicesPaidInFull: snapshot.invoiceOutstanding === 0,
    issuedInvoicesCoveredByAuthorisedCredit: snapshot.invoiceOutstanding > 0 && snapshot.uncoveredInvoiceOutstanding === 0,
    // In consolidated mode this is an operational Pharmacy reconciliation
    // gate. Patient money is never collected by Pharmacy.
    pharmacyClearance: pharmacyCleared && pharmacyDue === 0,
    advanceReconciled,
    finalInvoiceAvailable: !workflowPolicy.requireFinalIPDInvoice || Boolean(finalInvoice),
    financialExceptionApproved: admission.financialClearanceStatus === 'exception_approved'
  };

  const prerequisitesReady = checks.chargeFreezeActive &&
    checks.unbilledChargesResolved &&
    checks.issuedInvoicesSettled &&
    checks.advanceReconciled &&
    checks.finalInvoiceAvailable &&
    (!pharmacyMustPrecedeFinance || checks.pharmacyClearance);
  const ready = prerequisitesReady || checks.financialExceptionApproved;
  const cleared = ['cleared', 'exception_approved'].includes(admission.financialClearanceStatus);

  return {
    success: true,
    ready,
    cleared,
    explicitClearanceStatus: admission.financialClearanceStatus,
    checks,
    workflowPolicy,
    pharmacyBillingPolicy,
    pharmacyMustPrecedeFinance,
    pharmacyAutoExemptEligible,
    summary: {
      pharmacyBillingOwner: pharmacyBillingPolicy.billingOwner,
      totalCharges: snapshot.ipdChargeAmount,
      totalEncounterCharges: snapshot.totalChargeAmount,
      pharmacyMirrorCharges: sumCharges(snapshot.pharmacyMirrorCharges),
      unbilledCharges: eligibleUnbilledTotal,
      allUnbilledIncludingPharmacy: snapshot.allUnbilledTotal,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      authorisedCreditOutstanding: snapshot.authorisedCreditOutstanding,
      uncoveredInvoiceOutstanding: snapshot.uncoveredInvoiceOutstanding,
      dueAmount: snapshot.overallDue,
      immediateDueAmount: money(snapshot.uncoveredInvoiceOutstanding + eligibleUnbilledTotal),
      patientReceivable: snapshot.patientReceivable,
      advanceAppliedActual: snapshot.advanceAppliedActual,
      advancePendingAdjustment: snapshot.advancePendingAdjustment,
      advanceAdjusted: snapshot.advanceAdjusted,
      advanceWalletBalance: snapshot.advanceWalletBalance,
      availableAdvanceAfterAdjustment: snapshot.availableAdvanceAfterAdjustment,
      balancePayable: snapshot.balancePayable,
      projectedAdvanceAdjustment: snapshot.projectedAdvanceAdjustment,
      projectedAvailableAdvance: snapshot.projectedAvailableAdvance,
      balancePayableAfterAdvance: snapshot.balancePayableAfterAdvance,
      advanceReceived: snapshot.advanceReceived,
      advanceApplied: snapshot.advanceUtilized,
      advanceAvailable,
      advanceDisposition: disposition,
      pharmacyDue,
      pharmacySubledgerOutstanding: snapshot.pharmacySubledgerOutstanding,
      pharmacyAdvanceAvailable,
      finalInvoiceNumber: finalInvoice?.invoice_number || null
    },
    pendingPharmacySales,
    invoices: snapshot.ipdInvoices,
    pharmacyInvoices: snapshot.pharmacyInvoices
  };
}
async function getFinanceWorkspace(admissionId, user) {
  // Load the canonical IPD financial snapshot once. The previous UI called
  // running-bill, ledger and clearance independently, causing the same costly
  // admission calculation to run three times for every workspace open/refresh.
  await ensureAdmissionDailyCharges(admissionId, operationNow(), user);
  const snapshot = await calculateAdmissionFinancials(admissionId, { user });
  const hospitalId = snapshot.admission.hospitalId;

  const [transactions, advanceLedger] = await Promise.all([
    FinancialTransaction.find({ hospitalId, admissionId, status: 'POSTED' }).sort({ createdAt: 1 }).lean(),
    PatientAdvanceLedger.find({ hospitalId, admissionId, status: 'POSTED' }).sort({ createdAt: 1 }).lean()
  ]);

  const [runningBill, ledger, clearance] = await Promise.all([
    getRunningBill(admissionId, user, { snapshot, transactions, advanceLedger, skipEnsure: true }),
    getFinancialLedger(admissionId, user, { snapshot, transactions, advanceLedger }),
    getFinancialClearance(admissionId, user, { snapshot, skipEnsure: true })
  ]);

  return { success: true, runningBill, ledger, clearance };
}

async function finaliseFinancialClearance(admissionId, payload = {}, user) {
  let admissionForPolicy = await findAdmission(admissionId, null, user);
  if (admissionForPolicy.chargeFreeze?.status !== 'frozen' || !admissionForPolicy.chargeFreeze?.frozenAt) {
    const error = new Error('Freeze clinical charging before final financial clearance');
    error.statusCode = 409;
    error.code = 'IPD_CHARGE_FREEZE_REQUIRED';
    throw error;
  }

  const workflowPolicy = await loadIPDWorkflowPolicy(admissionForPolicy.hospitalId);
  if (workflowPolicy.autoExemptPharmacyWhenNoTransactions && admissionForPolicy.pharmacyClearanceStatus === 'pending') {
    const [hasSale, pharmacyAdvance] = await Promise.all([
      Sale.exists({ hospitalId: admissionForPolicy.hospitalId, admission_id: admissionId, status: { $ne: 'Cancelled' } }),
      PatientAdvanceLedger.findOne({ hospitalId: admissionForPolicy.hospitalId, admissionId, walletType: 'PHARMACY_IPD', status: 'POSTED' })
        .sort({ createdAt: -1 }).select('balanceAfter').lean()
    ]);
    if (!hasSale && money(pharmacyAdvance?.balanceAfter || 0) === 0) {
      admissionForPolicy.pharmacyClearanceStatus = 'exempted';
      admissionForPolicy.pharmacyClearanceDate = operationNow();
      admissionForPolicy.pharmacyFinalBalance = 0;
      await admissionForPolicy.save();
    }
  }

  let clearance = await getFinancialClearance(admissionId, user);
  let issuedInvoice = null;
  let advanceSettlement = null;
  let settlement = null;
  let advanceRefund = null;

  if (
    workflowPolicy.requireFinalIPDInvoice &&
    !clearance.checks.finalInvoiceAvailable &&
    workflowPolicy.requirePharmacyClearance &&
    stageBefore(workflowPolicy, 'PHARMACY_CLEARANCE', 'IPD_FINAL_INVOICE') &&
    !clearance.checks.pharmacyClearance
  ) {
    const error = new Error('Complete Pharmacy Final Clearance before issuing the Final IPD invoice');
    error.statusCode = 409;
    error.code = 'PHARMACY_CLEARANCE_REQUIRED_BEFORE_FINAL_INVOICE';
    error.details = clearance;
    throw error;
  }

  if (workflowPolicy.requireFinalIPDInvoice && !clearance.checks.finalInvoiceAvailable) {
    const issued = await issueIPDInvoice(admissionId, {
      invoiceKind: 'final',
      notes: payload.notes || 'Final consolidated IPD invoice/statement',
      idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:invoice` : undefined
    }, user);
    issuedInvoice = issued.invoice;
    clearance = await getFinancialClearance(admissionId, user);
  } else if (clearance.summary.unbilledCharges > 0) {
    const issued = await issueIPDInvoice(admissionId, {
      invoiceKind: 'final',
      notes: payload.notes,
      idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:invoice` : undefined
    }, user);
    issuedInvoice = issued.invoice;
    clearance = await getFinancialClearance(admissionId, user);
  }

  // Final clearance uses the same modular settlement engine as an interim
  // invoice. Advance is only consumed when the caller actually allocates an
  // IPDAdvance payment (or explicitly opts into autoApplyAdvance). External
  // tenders are real cash flow; Credit / Pay Later remains an outstanding
  // receivable covered by an authorisation, not a payment.
  const requestedPaymentAmount = optionalMoney(payload.paymentAmount ?? payload.amount);
  const paymentRows = Array.isArray(payload.payments)
    ? payload.payments
    : (Array.isArray(payload.paymentBreakdown) ? payload.paymentBreakdown : []);
  const hasPaymentRows = paymentRows.some((row) => optionalMoney(row?.amount) > 0);
  const settlementDiscount = optionalMoney(payload.settlementDiscountAmount ?? payload.finalDiscountAmount);
  const taxAdjustment = optionalMoney(payload.taxAdjustmentAmount);
  const explicitDeferredCredit = requestedDeferredCredit(payload);
  const wantsDeferredCredit = payload.deferRemaining === true || payload.authorizeRemainingCredit === true || explicitDeferredCredit > 0;
  const hasSettlementAction = requestedPaymentAmount > 0 || hasPaymentRows || settlementDiscount > 0 || taxAdjustment !== 0 || wantsDeferredCredit;

  if (hasSettlementAction) {
    settlement = await recordIPDPayment(admissionId, {
      ...payload,
      sourceModule: 'Discharge',
      receiptType: 'Final Settlement',
      idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:settlement` : undefined
    }, user);
    clearance = await getFinancialClearance(admissionId, user);
  }

  // Automatic wallet use is opt-in only. This retains backwards-compatible
  // support for hospitals that explicitly request it without making advance
  // utilisation an unavoidable consequence of generating/finalising a bill.
  if (payload.autoApplyAdvance === true && clearance.summary?.uncoveredInvoiceOutstanding > 0 && clearance.summary?.advanceAvailable > 0) {
    advanceSettlement = await applyAvailableIPDAdvance(admissionId, {
      sourceModule: 'Discharge',
      receiptType: 'Final Settlement',
      notes: 'Available IPD advance applied by explicit final-clearance instruction',
      idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:advance-auto` : undefined
    }, user);
    clearance = await getFinancialClearance(admissionId, user);
  }

  // Decide what to do with *actual remaining* advance only after all selected
  // payment allocations have posted. Refund means real money leaves the wallet;
  // retain/carry_forward only records the operator's clearance decision.
  admissionForPolicy = await findAdmission(admissionId, null, user);
  const advanceDisposition = String(payload.unusedAdvanceDisposition || '').toLowerCase();
  const currentAdvance = money(admissionForPolicy.advanceAmount || 0);

  if (advanceDisposition === 'refund' && currentAdvance > 0) {
    const requestedRefund = optionalMoney(payload.advanceRefundAmount);
    const refundAmount = requestedRefund > 0 ? Math.min(requestedRefund, currentAdvance) : currentAdvance;
    advanceRefund = await refundAdvance(admissionId, {
      amount: refundAmount,
      paymentMethod: payload.advanceRefundMethod || payload.refundPaymentMethod || 'Cash',
      reference: payload.advanceRefundReference || payload.refundReference,
      reason: String(payload.advanceRefundReason || payload.advanceDispositionNote || payload.notes || 'Unused IPD advance refunded during final financial clearance').trim(),
      idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:advance-refund` : undefined
    }, user);
    admissionForPolicy = await findAdmission(admissionId, null, user);
    admissionForPolicy.advanceClearanceDisposition = 'refunded';
    admissionForPolicy.advanceClearanceDispositionAt = operationNow();
    admissionForPolicy.advanceClearanceDispositionBy = user?._id;
    admissionForPolicy.advanceClearanceDispositionNote = String(payload.advanceDispositionNote || payload.notes || 'Unused IPD advance refunded').trim();
    await admissionForPolicy.save();
  } else if (['retain', 'carry_forward'].includes(advanceDisposition) && currentAdvance > 0) {
    admissionForPolicy.advanceClearanceDisposition = advanceDisposition;
    admissionForPolicy.advanceClearanceDispositionAt = operationNow();
    admissionForPolicy.advanceClearanceDispositionBy = user?._id;
    admissionForPolicy.advanceClearanceDispositionNote = String(payload.advanceDispositionNote || payload.notes || '').trim();
    await admissionForPolicy.save();
  } else if (money(admissionForPolicy.advanceAmount || 0) === 0 && admissionForPolicy.advanceClearanceDisposition === 'pending') {
    admissionForPolicy.advanceClearanceDisposition = 'none';
    admissionForPolicy.advanceClearanceDispositionAt = operationNow();
    admissionForPolicy.advanceClearanceDispositionBy = user?._id;
    await admissionForPolicy.save();
  }

  clearance = await getFinancialClearance(admissionId, user);
  const admission = await findAdmission(admissionId, null, user);
  const exceptionAllowed = Boolean(payload.allowException && user && ['admin', 'accountant', 'mediqliq_super_admin'].includes(user.role));
  if (!clearance.ready && !exceptionAllowed) {
    const error = new Error('Financial clearance prerequisites are incomplete. Resolve unbilled charges, invoice payment/authorised credit, remaining advance disposition and any configured pharmacy prerequisite');
    error.statusCode = 409;
    error.details = clearance;
    throw error;
  }

  admission.financialClearanceStatus = clearance.ready ? 'cleared' : 'exception_approved';
  admission.financialClearedAt = operationNow();
  admission.financialClearedBy = user?._id;
  if (!clearance.ready) {
    admission.financialClearanceException = {
      reason: payload.exceptionReason || 'Authorised financial discharge exception',
      approvedBy: user?._id,
      approvedAt: operationNow(),
      outstandingAccepted: money((clearance.summary.invoiceOutstanding || 0) + (clearance.summary.pharmacyDue || 0))
    };
  }
  if (issuedInvoice && (issuedInvoice.invoice_type === 'IPD Final' || issuedInvoice.is_final_ipd_invoice === true)) admission.finalInvoiceId = issuedInvoice._id;
  if (clearance.ready && ['Billing Pending', 'Payment Pending'].includes(admission.status)) admission.status = 'Ready for Discharge';
  await admission.save();

  return {
    clearance: await getFinancialClearance(admissionId, user),
    issuedInvoice,
    advanceSettlement,
    settlement,
    advanceRefund,
    admission
  };
}

module.exports = {
  calculateAdmissionFinancials,
  listBillingAdmissions,
  getRunningBill,
  getFinanceWorkspace,
  addManualCharge,
  adjustExistingUnbilledCharge,
  overrideUnbilledChargeRate,
  generateBedCharge,
  applyDiscount,
  voidCharge,
  reverseInvoicedCharge,
  previewIPDInvoice,
  issueIPDInvoice,
  recordIPDPayment,
  applyAvailableIPDAdvance,
  recordAdvance,
  refundAdvance,
  createCreditNote,
  refundInvoice,
  resolveOPDInvoiceCollectionForCancellation,
  getFinancialLedger,
  getFinancialClearance,
  finaliseFinancialClearance
};
