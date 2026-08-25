const { operationNow } = require('../utils/operationTimeContext');
const { hospitalDateKey } = require('../utils/hospitalDateTime');
const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const FinancialTransaction = require('../models/FinancialTransaction');
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
      age: patient.age,
      gender: patient.gender,
      phone: patient.phone,
      address: patient.address,
      city: patient.city,
      state: patient.state,
      guardianName: patient.guardianName || patient.father_name || patient.husband_name
    } : { id: admission.patientId },
    admissionSnapshot: {
      id: admission._id,
      admissionNumber: admission.admissionNumber,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate,
      admissionType: admission.admissionType,
      dischargeType: admission.dischargeType || admission.status,
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
  const ipdCharges = charges.filter((charge) => String(charge.sourceModule || '') !== 'Pharmacy');
  const pharmacyMirrorCharges = charges.filter((charge) => String(charge.sourceModule || '') === 'Pharmacy');
  const ipdUnbilledCharges = unbilledCharges.filter((charge) => String(charge.sourceModule || '') !== 'Pharmacy');

  const sponsorLedger = await SponsorLedgerEntry.find(
    { hospitalId, admissionId },
    null,
    sessionOptions(session)
  ).sort({ occurredAt: 1 });

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
  const pharmacyInvoiceOutstanding = money(
    pharmacyInvoices.reduce((sum, invoice) => sum + Number(invoice.balance_due || 0), 0)
  );

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

  const patientReceivable = money(
    Math.max(0, ipdPatientLiabilityTotal - invoicePaid)
  );

  const overallDue = patientReceivable;

  if (persist) {
    admission.totalBillAmount = totalChargeAmount;
    admission.invoicedAmount = money(invoicedGross - creditNotes);
    admission.paidAmount = invoicePaid;
    admission.patientReceivable = patientReceivable;
    admission.sponsorReceivable = sponsorReceivable;
    admission.sponsorPaidAmount = sponsorPaid;
    admission.nonAdmissibleAmount = nonAdmissibleAmount;
    admission.dueAmount = patientReceivable; // patient liability only; sponsor receivable is separate
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
    sponsorLedger,
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
    pharmacyInvoiceOutstanding,
    patientReceivable,
    sponsorReceivable,
    sponsorPaid,
    overallDue,
    advanceAvailable: money(admission.advanceAmount || 0),
    advanceReceived: money(admission.advanceReceivedAmount || 0),
    advanceUtilized: money(admission.advanceUtilizedAmount || 0),
    advanceRefunded: money(admission.advanceRefundedAmount || 0)
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

  const limit = Math.min(Math.max(Number(query.limit) || 150, 1), 300);
  const admissions = await IPDAdmission.find(filter)
    .populate('patientId', 'first_name last_name patientId phone age gender')
    .populate('primaryDoctorId', 'firstName lastName specialization')
    .populate('departmentId', 'name')
    .populate('wardId', 'name wardName')
    .populate('roomId', 'roomNumber name')
    .populate('bedId', 'bedNumber bed_number')
    .sort({ admissionDate: -1 })
    .limit(limit)
    .lean();

  const search = String(query.search || '').trim().toLowerCase();
  const filtered = search
    ? admissions.filter((admission) => {
        const patient = admission.patientId || {};
        const haystack = [
          patient.first_name,
          patient.last_name,
          patient.patientId,
          admission.admissionNumber,
          admission.shipNumber
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(search);
      })
    : admissions;

  return { success: true, admissions: filtered };
}

async function getRunningBill(admissionId, user) {
  await ensureAdmissionDailyCharges(admissionId, operationNow(), user);
  const snapshot = await calculateAdmissionFinancials(admissionId, { user });

  const admission = await IPDAdmission.findOne({
    _id: admissionId,
    hospitalId: snapshot.admission.hospitalId
  })
    .populate('patientId', 'first_name last_name patientId phone age gender')
    .populate('primaryDoctorId', 'firstName lastName specialization')
    .populate('departmentId', 'name')
    .populate('wardId', 'name wardName')
    .populate('roomId', 'roomNumber name')
    .populate('bedId', 'bedNumber bed_number');

  const receipts = await FinancialTransaction.find({
    hospitalId: admission.hospitalId,
    admissionId,
    status: 'POSTED'
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const advanceLedger = await PatientAdvanceLedger.find({
    hospitalId: admission.hospitalId,
    admissionId,
    status: 'POSTED'
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const unbilledChargesByDate = snapshot.ipdUnbilledCharges.reduce((result, charge) => {
    const key = dateKey(charge.chargeDate);
    (result[key] ||= []).push(charge);
    return result;
  }, {});

  const billedCharges = snapshot.ipdCharges.filter((charge) => charge.isBilled);
  const pharmacyMirrorCharges = snapshot.pharmacyMirrorCharges;

  return {
    success: true,
    admission: {
      _id: admission._id,
      admissionNumber: admission.admissionNumber,
      shipNumber: admission.shipNumber,
      admissionDate: admission.admissionDate,
      status: admission.status,
      financialClearanceStatus: admission.financialClearanceStatus,
      totalBillAmount: snapshot.totalChargeAmount,
      standardAmount: snapshot.totalStandardAmount,
      patientLiability: snapshot.ipdPatientLiabilityTotal,
      sponsorLiability: snapshot.ipdSponsorLiabilityTotal,
      totalPatientLiabilityIncludingPharmacy: snapshot.patientLiabilityTotal,
      totalSponsorLiabilityIncludingPharmacy: snapshot.sponsorLiabilityTotal,
      patientReceivable: snapshot.patientReceivable,
      sponsorReceivable: snapshot.sponsorReceivable,
      paidAmount: snapshot.invoicePaid,
      dueAmount: snapshot.patientReceivable,
      invoicedAmount: snapshot.invoicedGross,
      invoiceOutstanding: snapshot.invoiceOutstanding,
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
      total: sumCharges(billedCharges),
      count: billedCharges.length
    },
    invoices: snapshot.ipdInvoices,
    pharmacyInvoices: snapshot.pharmacyInvoices,
    allInvoices: snapshot.invoices,
    receipts,
    advanceLedger,
    sponsorLedger: snapshot.sponsorLedger,
    financialSummary: {
      // Billing workspace totals are IPD-controlled only. Pharmacy remains a
      // separate collectible ledger and is exposed alongside for audit/display.
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
      sponsorReceivable: snapshot.sponsorReceivable,
      sponsorPaidAmount: snapshot.sponsorPaid,
      paidAmount: snapshot.invoicePaid,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      unbilledTotal: snapshot.unbilledTotal,
      pharmacyInvoiceOutstanding: snapshot.pharmacyInvoiceOutstanding,
      advanceAvailable: snapshot.advanceAvailable
    }
  };
}

async function addManualCharge(payload, user) {
  const admission = await findAdmission(payload.admissionId, null, user);
  const quantity = Number(payload.quantity || 1);
  const standardRate = assertAmount(payload.rate, 'Rate');

  if (!Number.isFinite(quantity) || quantity <= 0) {
    const error = new Error('Quantity must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const chargeDate = payload.chargeDate || operationNow();

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
      taxRate: payload.taxRate
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
    discountApprovedBy: adjusted.discountAmount > 0 ? user?._id : undefined,
    discountApprovedAt: adjusted.discountAmount > 0 ? operationNow() : undefined,
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

async function generateBedCharge(admissionId, payload, user) {
  const admission = await findAdmission(admissionId, null, user);
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
  const filter = { hospitalId: admission.hospitalId, admissionId, sourceModule: { $ne: 'Pharmacy' }, ...UNBILLED_CHARGE_FILTER };
  if (requested.length) filter._id = { $in: requested };
  const charges = await IPDCharge.find(filter).sort({ chargeDate: 1, createdAt: 1 }).lean();
  if (requested.length && charges.length !== requested.length) {
    const error = new Error('One or more selected charges are no longer eligible'); error.statusCode = 409; error.code = 'INVALID_SELECTED_CHARGES'; throw error;
  }
  const gross = money(charges.reduce((a,c)=>a+Number(c.grossAmount||c.amount||0),0));
  const discount = money(charges.reduce((a,c)=>a+Number(c.discountAmount||c.discount||0),0));
  const tax = money(charges.reduce((a,c)=>a+Number(c.taxAmount||c.tax||0),0));
  const net = money(charges.reduce((a,c)=>a+Number(c.patientLiability ?? c.netAmount ?? 0),0));
  return { admissionId, invoiceKind: payload.invoiceKind === 'final' ? 'final' : 'interim', billingMode: requested.length ? 'IMMEDIATE_SELECTED' : 'ALL_UNBILLED', chargeCount: charges.length, chargeIds: charges.map(c=>c._id), charges, totals: { gross, discount, tax, net } };
}

async function issueIPDInvoice(admissionId, payload = {}, user) {
  await ensureAdmissionDailyCharges(admissionId, payload.throughDate || operationNow(), user);
  const invoiceKind = payload.invoiceKind === 'final' ? 'IPD Final' : 'IPD Interim';

  return runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session, user);

    if (payload.idempotencyKey) {
      const existing = await Invoice.findOne({ hospital_id: admission.hospitalId, idempotency_key: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) {
        return { invoice: existing, bill: await Bill.findById(existing.bill_id, null, sessionOptions(session)), alreadyExists: true };
      }
    }

    const requestedChargeIds = Array.isArray(payload.chargeIds) ? payload.chargeIds.filter(Boolean) : [];
    if (invoiceKind === 'IPD Final') {
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
      const existingFinal = await Invoice.findOne({ hospital_id: admission.hospitalId, admission_id: admission._id, $or: [{ invoice_type: 'IPD Final' }, { is_final_ipd_invoice: true }], document_stage: { $ne: 'VOID' } }, null, sessionOptions(session)).sort({ issue_date: -1, created_at: -1 });
      if (existingFinal) return { invoice: existingFinal, bill: await Bill.findById(existingFinal.bill_id, null, sessionOptions(session)), alreadyExists: true };
    }
    if (payload.invoiceKind === 'final' && requestedChargeIds.length) {
      const error = new Error('Final invoice cannot be limited to selected charges'); error.statusCode = 400; throw error;
    }
    const chargeFilter = { hospitalId: admission.hospitalId, admissionId, sourceModule: { $ne: 'Pharmacy' }, ...UNBILLED_CHARGE_FILTER };
    if (requestedChargeIds.length) chargeFilter._id = { $in: requestedChargeIds };
    const charges = await IPDCharge.find(chargeFilter, null, sessionOptions(session)).sort({ chargeDate: 1, createdAt: 1 });
    if (requestedChargeIds.length && charges.length !== [...new Set(requestedChargeIds.map(String))].length) {
      const error = new Error('One or more selected charges are invalid, already invoiced, voided, or belong to another admission');
      error.statusCode = 409; error.code = 'INVALID_SELECTED_CHARGES'; throw error;
    }
    if (!charges.length && invoiceKind !== 'IPD Final') {
      const error = new Error('There are no unbilled active non-pharmacy charges for this admission');
      error.statusCode = 409;
      throw error;
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
      notes: payload.notes || `${invoiceKind} patient-liability bill for ${admission.admissionNumber}`,
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
      notes: payload.notes || `${invoiceKind} patient statement; sponsor liability is handled through claim and sponsor ledger`,
      created_by: user?._id,
      patient_snapshot: snapshots.patientSnapshot,
      admission_snapshot: snapshots.admissionSnapshot,
      hospital_snapshot: snapshots.hospitalSnapshot,
      print_snapshot: { templateVersion: 'reference-billing-2026-08', generatedAt: new Date(), chargeIds: charges.map((row) => row._id) }
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

async function recordIPDPayment(admissionId, payload = {}, user) {
  const requestedAmount = optionalMoney(payload.amount ?? payload.paymentAmount);
  const settlementDiscountAmount = optionalMoney(payload.settlementDiscountAmount ?? payload.finalDiscountAmount);
  const taxAdjustmentAmount = optionalMoney(payload.taxAdjustmentAmount);
  if (requestedAmount <= 0 && settlementDiscountAmount <= 0 && taxAdjustmentAmount === 0) {
    const error = new Error('Enter a payment, settlement discount or tax adjustment');
    error.statusCode = 400;
    throw error;
  }
  const breakdown = normalizePaymentBreakdown(payload, requestedAmount);
  const paymentMethod = breakdown.length > 1 ? 'Split' : (breakdown[0]?.method || payload.paymentMethod || 'Cash');
  if (!FINANCE_PAYMENT_METHODS.includes(paymentMethod) || breakdown.some((row) => !FINANCE_PAYMENT_METHODS.includes(row.method))) {
    const error = new Error('Unsupported payment method');
    error.statusCode = 400;
    throw error;
  }
  if ((settlementDiscountAmount > 0 || taxAdjustmentAmount !== 0) && !String(payload.settlementDiscountReason || payload.adjustmentReason || '').trim()) {
    const error = new Error('Reason is required for settlement discount or tax adjustment');
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
      if (existing.length) return { receiptNumber: existing[0].transactionNumber, transactions: existing, alreadyExists: true };
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
    const selected = payload.invoiceId ? invoices.filter((invoice) => String(invoice._id) === String(payload.invoiceId)) : invoices;
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
    const receiptNumber = await nextFinancialNumber({ documentType: 'RECEIPT', hospitalId, session });
    const transactions = [];

    if (taxAdjustmentAmount !== 0) {
      const invoice = selected[0];
      const nextTotal = money(Number(invoice.total || 0) + taxAdjustmentAmount);
      if (nextTotal < 0 || Number(invoice.amount_paid || 0) > nextTotal) {
        const error = new Error('Tax adjustment would make the invoice total invalid');
        error.statusCode = 400;
        throw error;
      }
      invoice.tax = money(Number(invoice.tax || 0) + taxAdjustmentAmount);
      invoice.total = nextTotal;
      const linkedBill = invoice.bill_id ? await Bill.findById(invoice.bill_id, null, sessionOptions(session)) : null;
      if (linkedBill) {
        linkedBill.tax_amount = money(Number(linkedBill.tax_amount || 0) + taxAdjustmentAmount);
        linkedBill.total_amount = money(Number(linkedBill.total_amount || 0) + taxAdjustmentAmount);
        await linkedBill.save(sessionOptions(session));
      }
      await invoice.save(sessionOptions(session));
      const taxTransaction = new FinancialTransaction({
        hospitalId,
        patientId: admission.patientId,
        admissionId: admission._id,
        billId: invoice.bill_id,
        invoiceId: invoice._id,
        transactionNumber: receiptNumber,
        transactionType: 'ADJUSTMENT',
        direction: taxAdjustmentAmount > 0 ? 'DEBIT' : 'CREDIT',
        amount: Math.abs(taxAdjustmentAmount),
        paymentMethod: 'Adjustment',
        receiptType: payload.receiptType || 'Adjustment',
        taxAdjustmentAmount,
        sourceModule: payload.sourceModule || 'Discharge',
        sourceId: admission._id,
        status: 'POSTED',
        remarks: payload.adjustmentReason || payload.settlementDiscountReason,
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:tax` : undefined
      });
      await taxTransaction.save(sessionOptions(session));
      transactions.push(taxTransaction);
    }

    const discountAllocationByInvoice = new Map();
    if (settlementDiscountAmount > 0) {
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
        const linkedBill = invoice.bill_id ? await Bill.findById(invoice.bill_id, null, sessionOptions(session)) : null;
        if (linkedBill) {
          linkedBill.settlement_discount_amount = money(Number(linkedBill.settlement_discount_amount || 0) + applied);
          linkedBill.discount_reason = payload.settlementDiscountReason;
          await linkedBill.save(sessionOptions(session));
        }
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
        receiptType: payload.receiptType || 'Final Settlement',
        amountBeforeSettlement,
        settlementDiscountAmount,
        settlementDiscountReason: payload.settlementDiscountReason,
        settlementDiscountApprovedBy: payload.discountApprovedBy || user?._id,
        sourceModule: payload.sourceModule || 'Discharge',
        sourceId: admission._id,
        status: 'POSTED',
        remarks: payload.settlementDiscountReason,
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:discount` : undefined
      });
      await discountTransaction.save(sessionOptions(session));
      transactions.push(discountTransaction);
    }

    invoices = await Invoice.find({ ...ipdCollectibleInvoiceFilterForAdmission(admissionId), hospital_id: admission.hospitalId }, null, sessionOptions(session))
      .sort({ issue_date: 1, created_at: 1 });
    const plan = allocationPlan(invoices, requestedAmount, payload);
    const advanceApplied = money(breakdown.filter((row) => row.method === 'IPDAdvance').reduce((sum, row) => sum + row.amount, 0));
    let updatedAdvance = null;
    if (advanceApplied > 0) {
      updatedAdvance = await IPDAdmission.findOneAndUpdate(
        { _id: admission._id, advanceAmount: { $gte: advanceApplied } },
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

    let remainingAdvanceForAllocation = advanceApplied;
    for (const entry of plan) {
      const invoice = entry.invoice;
      const invoiceAdvanceApplied = money(Math.min(remainingAdvanceForAllocation, entry.amount));
      remainingAdvanceForAllocation = money(remainingAdvanceForAllocation - invoiceAdvanceApplied);
      const invoiceSettlementDiscount = money(discountAllocationByInvoice.get(String(invoice._id)) || 0);
      invoice.amount_paid = money(Number(invoice.amount_paid || 0) + entry.amount);
      const projectedBalance = Math.max(0, money(Number(invoice.balance_due || 0) - entry.amount));
      invoice.payment_history.push({
        date: operationNow(),
        amount: entry.amount,
        method: paymentMethod,
        reference: payload.reference,
        status: 'Completed',
        collected_by: user?._id,
        transaction_id: receiptNumber,
        receipt_number: receiptNumber,
        receipt_type: payload.receiptType || (payload.sourceModule === 'Discharge' ? 'Final Settlement' : 'Payment'),
        amount_before_settlement: amountBeforeSettlement,
        settlement_discount_amount: invoiceSettlementDiscount,
        settlement_discount_reason: payload.settlementDiscountReason,
        settlement_discount_approved_by: invoiceSettlementDiscount > 0 ? (payload.discountApprovedBy || user?._id) : undefined,
        advance_applied: invoiceAdvanceApplied,
        balance_after: projectedBalance,
        payment_breakdown: breakdown
      });
      invoice.advance_applied = money(Number(invoice.advance_applied || 0) + invoiceAdvanceApplied);
      invoice.receipt_numbers = Array.from(new Set([...(invoice.receipt_numbers || []), receiptNumber]));
      await invoice.save(sessionOptions(session));
      await syncLinkedBillFromInvoice(invoice, paymentMethod, session);

      const transaction = new FinancialTransaction({
        hospitalId,
        patientId: admission.patientId,
        admissionId: admission._id,
        billId: invoice.bill_id,
        invoiceId: invoice._id,
        transactionNumber: receiptNumber,
        transactionType: advanceApplied > 0 && requestedAmount === advanceApplied ? 'ADVANCE_UTILISATION' : 'RECEIPT',
        direction: 'CREDIT',
        amount: entry.amount,
        paymentMethod,
        paymentReference: payload.reference,
        receiptType: payload.receiptType || (payload.sourceModule === 'Discharge' ? 'Final Settlement' : 'Payment'),
        amountBeforeSettlement,
        settlementDiscountAmount: invoiceSettlementDiscount,
        settlementDiscountReason: invoiceSettlementDiscount > 0 ? payload.settlementDiscountReason : undefined,
        settlementDiscountApprovedBy: invoiceSettlementDiscount > 0 ? (payload.discountApprovedBy || user?._id) : undefined,
        advanceApplied: invoiceAdvanceApplied,
        amountReceived: entry.amount,
        balanceAfter: projectedBalance,
        paymentBreakdown: breakdown,
        sourceModule: payload.sourceModule || 'IPD',
        sourceId: admission._id,
        status: 'POSTED',
        remarks: payload.notes,
        createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:${invoice._id}` : undefined,
        metadata: { allocatedInvoiceNumber: invoice.invoice_number }
      });
      await transaction.save(sessionOptions(session));
      transactions.push(transaction);
    }

    return { receiptNumber, transactions, updatedAdvance, settlementDiscountAmount, taxAdjustmentAmount, alreadyExists: false };
  }).then(async (result) => {
    await calculateAdmissionFinancials(admissionId, { user });
    return result;
  });
}

async function recordAdvance(admissionId, payload, user) {
  const amount = assertAmount(payload.amount, 'Advance amount');
  const paymentMethod = payload.paymentMethod || 'Cash';

  if (!FINANCE_PAYMENT_METHODS.includes(paymentMethod) || paymentMethod === 'IPDAdvance') {
    const error = new Error('Unsupported advance payment method');
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
        return {
          receiptNumber: existing.transactionNumber,
          advanceBalance: admission.advanceAmount,
          alreadyExists: true
        };
      }
    }

    const hospitalId = hospitalIdFor(admission, user);
    const receiptNumber = await nextFinancialNumber({
      documentType: 'ADVANCE_RECEIPT',
      hospitalId,
      session
    });

    const updated = await IPDAdmission.findOneAndUpdate(
      { _id: admissionId, hospitalId: admission.hospitalId },
      {
        $inc: {
          advanceAmount: amount,
          advanceReceivedAmount: amount
        },
        $set: { financialClearanceStatus: 'in_progress' }
      },
      { new: true, ...sessionOptions(session) }
    );

    const openingBalance = money(updated.advanceAmount - amount);

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
        balanceAfter: money(updated.advanceAmount),
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
      sourceModule: 'IPD',
      sourceId: updated._id,
      remarks: payload.notes || 'IPD advance received',
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey,
      metadata: { walletType: 'IPD_SHARED' }
    });

    await transaction.save(sessionOptions(session));

    return {
      receiptNumber,
      advanceBalance: money(updated.advanceAmount),
      transaction,
      alreadyExists: false
    };
  });
}

async function refundAdvance(admissionId, payload, user) {
  const amount = assertAmount(payload.amount, 'Advance refund amount');
  const paymentMethod = payload.paymentMethod || 'Cash';

  if (!payload.reason?.trim()) {
    const error = new Error('Refund reason is required');
    error.statusCode = 400;
    throw error;
  }

  return runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session, user);
    const hospitalId = hospitalIdFor(admission, user);
    const refundNumber = await nextFinancialNumber({
      documentType: 'ADVANCE_REFUND',
      hospitalId,
      session
    });

    const updated = await IPDAdmission.findOneAndUpdate(
      { _id: admission._id, advanceAmount: { $gte: amount } },
      {
        $inc: {
          advanceAmount: -amount,
          advanceRefundedAmount: amount
        }
      },
      { new: true, ...sessionOptions(session) }
    );

    if (!updated) {
      const error = new Error('Refund amount exceeds the available IPD advance balance');
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
        openingBalance: money(updated.advanceAmount + amount),
        paymentMethod,
        referenceNumber: refundNumber,
        documentType: 'Refund',
        sourceModule: 'Discharge',
        sourceId: updated._id,
        balanceAfter: money(updated.advanceAmount),
        notes: payload.reason.trim(),
        createdBy: user?._id
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
      sourceModule: 'Discharge',
      sourceId: updated._id,
      remarks: payload.reason.trim(),
      createdBy: user?._id
    });

    await transaction.save(sessionOptions(session));

    return { refundNumber, advanceBalance: money(updated.advanceAmount), transaction };
  });
}

async function createCreditNote(invoiceId, payload, user) {
  const amount = assertAmount(payload.amount, 'Credit note amount');

  if (!payload.reason?.trim()) {
    const error = new Error('Credit note reason is required');
    error.statusCode = 400;
    throw error;
  }

  return runFinancialTransaction(async (session) => {
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

    if (!['Appointment', 'Procedure', 'Lab Test', 'Radiology', 'IPD Interim', 'IPD Final', 'Pharmacy', 'Mixed', 'Other'].includes(invoice.invoice_type) ||
        invoice.document_stage === 'VOID') {
      const error = new Error('This invoice cannot receive a credit note');
      error.statusCode = 409;
      throw error;
    }

    const eligible = money(invoice.total - (invoice.credit_note_total || 0));

    if (amount > eligible) {
      const error = new Error('Credit note amount exceeds the eligible invoice value');
      error.statusCode = 400;
      throw error;
    }

    const admission = invoice.admission_id
      ? await findAdmission(invoice.admission_id, session, user)
      : null;

    const hospitalId = invoice.hospital_id || hospitalIdFor(admission, user);
    const noteNumber = await nextFinancialNumber({
      documentType: 'CREDIT_NOTE',
      hospitalId,
      session
    });

    const creditNote = new Invoice({
      hospital_id: hospitalId,
      invoice_number: noteNumber,
      patient_id: invoice.patient_id,
      admission_id: invoice.admission_id,
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
      service_items: [{
        description: `Credit note against ${invoice.invoice_number}: ${payload.reason.trim()}`,
        quantity: 1,
        unit_price: amount,
        total_price: amount,
        service_type: 'Other'
      }]
    });

    await creditNote.save(sessionOptions(session));

    invoice.credit_note_total = money((invoice.credit_note_total || 0) + amount);
    await invoice.save(sessionOptions(session));

    // Keep every linked bill in sync with the invoice credit note. OPD can have
    // one consolidated invoice linked to several bills, and patient-level due
    // summaries are bill-backed; updating only the invoice would leave the OPD
    // workspace and complete ledger with an incorrect outstanding amount.
    const linkedBillIds = Array.from(new Set([
      ...(invoice.bill_ids || []),
      ...(invoice.bill_id ? [invoice.bill_id] : [])
    ].map((value) => String(value)).filter(Boolean)));
    let remainingBillCredit = amount;
    if (linkedBillIds.length) {
      const linkedBills = await Bill.find({ _id: { $in: linkedBillIds } }, null, sessionOptions(session)).sort({ generated_at: 1, createdAt: 1 });
      for (const linkedBill of linkedBills) {
        if (remainingBillCredit <= 0) break;
        const eligibleBillCredit = money(Math.max(0, Number(linkedBill.total_amount || 0) - Number(linkedBill.credit_note_amount || 0)));
        const applied = money(Math.min(eligibleBillCredit, remainingBillCredit));
        if (applied <= 0) continue;
        linkedBill.credit_note_amount = money(Number(linkedBill.credit_note_amount || 0) + applied);
        await linkedBill.save(sessionOptions(session));
        remainingBillCredit = money(remainingBillCredit - applied);
      }
    }

    const transaction = new FinancialTransaction({
      hospitalId,
      patientId: invoice.patient_id,
      admissionId: invoice.admission_id,
      billId: invoice.bill_id,
      invoiceId: invoice._id,
      transactionNumber: noteNumber,
      transactionType: 'CREDIT_NOTE',
      direction: 'DEBIT',
      amount,
      paymentMethod: 'Adjustment',
      sourceModule: 'Billing',
      sourceId: creditNote._id,
      remarks: payload.reason.trim(),
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey,
      metadata: { creditNoteInvoiceId: creditNote._id }
    });

    await transaction.save(sessionOptions(session));

    return { creditNote, originalInvoice: invoice, transaction };
  }).then(async (result) => {
    if (result.originalInvoice.admission_id) {
      await calculateAdmissionFinancials(result.originalInvoice.admission_id, { user });
    }
    return result;
  });
}

async function refundInvoice(invoiceId, payload, user) {
  const amount = assertAmount(payload.amount, 'Refund amount');

  if (!payload.reason?.trim()) {
    const error = new Error('Refund reason is required');
    error.statusCode = 400;
    throw error;
  }

  if (payload.idempotencyKey) {
    const existing = await FinancialTransaction.findOne({ idempotencyKey: payload.idempotencyKey }).lean();
    if (existing) return { refundNumber: existing.transactionNumber, transaction: existing, alreadyExists: true };
  }

  const invoicePreview = await Invoice.findById(invoiceId).lean();
  if (!invoicePreview) {
    const error = new Error('Invoice not found');
    error.statusCode = 404;
    throw error;
  }
  const scopedHospitalId = userHospitalId(user);
  if (scopedHospitalId && String(invoicePreview.hospital_id) !== String(scopedHospitalId)) {
    const error = new Error('Invoice not found in this hospital');
    error.statusCode = 404;
    throw error;
  }
  const refundable = money(Math.max(0, Number(invoicePreview.amount_paid || 0) - Number(invoicePreview.refunded_amount || 0)));
  if (amount > refundable + 0.01) {
    const error = new Error(`Refund amount exceeds the collected refundable amount of ₹${refundable.toFixed(2)}`);
    error.statusCode = 400;
    throw error;
  }

  const creditKey = payload.idempotencyKey ? `${payload.idempotencyKey}:credit` : undefined;
  let credit;
  if (creditKey) {
    const existingCreditTransaction = await FinancialTransaction.findOne({ idempotencyKey: creditKey }).lean();
    if (existingCreditTransaction?.metadata?.creditNoteInvoiceId) {
      const [creditNote, originalInvoice] = await Promise.all([
        Invoice.findById(existingCreditTransaction.metadata.creditNoteInvoiceId),
        Invoice.findById(invoiceId)
      ]);
      credit = { creditNote, originalInvoice, transaction: existingCreditTransaction, alreadyExists: true };
    }
  }
  if (!credit) {
    credit = await createCreditNote(invoiceId, {
      amount,
      reason: payload.reason,
      idempotencyKey: creditKey
    }, user);
  }

  return runFinancialTransaction(async (session) => {
    const invoice = await Invoice.findById(invoiceId, null, sessionOptions(session));
    const admission = invoice.admission_id
      ? await findAdmission(invoice.admission_id, session, user)
      : null;

    const hospitalId = invoice.hospital_id || hospitalIdFor(admission, user);
    const refundNumber = await nextFinancialNumber({
      documentType: 'ADVANCE_REFUND',
      hospitalId,
      session
    });

    invoice.refunded_amount = money((invoice.refunded_amount || 0) + amount);
    await invoice.save(sessionOptions(session));

    const transaction = new FinancialTransaction({
      hospitalId,
      patientId: invoice.patient_id,
      admissionId: invoice.admission_id,
      billId: invoice.bill_id,
      invoiceId: invoice._id,
      transactionNumber: refundNumber,
      transactionType: 'REFUND',
      direction: 'DEBIT',
      amount,
      paymentMethod: payload.paymentMethod || 'Cash',
      paymentReference: payload.reference,
      sourceModule: 'Billing',
      sourceId: credit.creditNote._id,
      remarks: payload.reason.trim(),
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey,
      metadata: { creditNoteNumber: credit.creditNote.invoice_number }
    });

    await transaction.save(sessionOptions(session));

    return { creditNote: credit.creditNote, refundNumber, transaction };
  });
}

async function getFinancialLedger(admissionId, user) {
  const snapshot = await calculateAdmissionFinancials(admissionId, { user });

  const [transactions, advanceLedger] = await Promise.all([
    FinancialTransaction.find({
      hospitalId: snapshot.admission.hospitalId,
      admissionId,
      status: 'POSTED'
    })
      .sort({ createdAt: 1 })
      .lean(),
    PatientAdvanceLedger.find({
      hospitalId: snapshot.admission.hospitalId,
      admissionId,
      status: 'POSTED'
    })
      .sort({ createdAt: 1 })
      .lean()
  ]);

  const entries = [
    ...snapshot.ipdInvoices.map((invoice) => ({
      date: invoice.issue_date || invoice.created_at,
      kind: 'INVOICE',
      number: invoice.invoice_number,
      debit: money(invoice.total),
      credit: 0,
      balance: money(invoice.balance_due),
      description: `${invoice.invoice_type} — ${invoice.status}`,
      invoiceId: invoice._id
    })),
    ...transactions.map((transaction) => ({
      date: transaction.createdAt,
      kind: transaction.transactionType,
      number: transaction.transactionNumber,
      debit: transaction.direction === 'DEBIT' ? money(transaction.amount) : 0,
      credit: transaction.direction === 'CREDIT' ? money(transaction.amount) : 0,
      description: transaction.remarks || transaction.transactionType,
      invoiceId: transaction.invoiceId,
      transactionId: transaction._id
    })),
    ...advanceLedger.map((entry) => ({
      date: entry.createdAt,
      kind: `ADVANCE_${entry.transactionType}`,
      number: entry.referenceNumber,
      debit: entry.direction === 'DEBIT' ? money(entry.amount) : 0,
      credit: entry.direction === 'CREDIT' ? money(entry.amount) : 0,
      balance: money(entry.balanceAfter),
      description: entry.notes || entry.transactionType,
      advanceEntryId: entry._id
    }))
  ].sort((left, right) => new Date(left.date) - new Date(right.date));

  return {
    success: true,
    admission: snapshot.admission,
    totals: {
      totalCharged: snapshot.ipdChargeAmount,
      totalEncounterCharged: snapshot.totalChargeAmount,
      pharmacyMirrorCharged: sumCharges(snapshot.pharmacyMirrorCharges),
      invoiced: snapshot.invoicedGross,
      paid: snapshot.invoicePaid,
      due: snapshot.overallDue,
      advanceAvailable: snapshot.advanceAvailable
    },
    invoices: snapshot.ipdInvoices,
    pharmacyInvoices: snapshot.pharmacyInvoices,
    transactions,
    advanceLedger,
    entries
  };
}

async function getFinancialClearance(admissionId, user) {
  await ensureAdmissionDailyCharges(admissionId, operationNow(), user);
  const snapshot = await calculateAdmissionFinancials(admissionId, { user });
  const admission = snapshot.admission;
  const workflowPolicy = await loadIPDWorkflowPolicy(admission.hospitalId);

  const [pendingPharmacySales, hasPharmacyTransactions, pharmacyAdvanceRow, nonPharmacyUnbilled] = await Promise.all([
    Sale.find({
      hospitalId: admission.hospitalId,
      admission_id: admissionId,
      balance_due: { $gt: 0 },
      status: { $in: ['Pending', 'Partially Paid', 'PartiallyReturned'] },
      include_in_discharge_clearance: { $ne: false }
    }).select('sale_number balance_due total_amount payment_deferred include_in_discharge_clearance sale_date').lean(),
    Sale.exists({ hospitalId: admission.hospitalId, admission_id: admissionId, status: { $ne: 'Cancelled' } }),
    PatientAdvanceLedger.findOne({ hospitalId: admission.hospitalId, admissionId, walletType: 'PHARMACY_IPD', status: 'POSTED' }).sort({ createdAt: -1 }).select('balanceAfter').lean(),
    IPDCharge.find({ hospitalId: admission.hospitalId, admissionId, sourceModule: { $ne: 'Pharmacy' }, ...UNBILLED_CHARGE_FILTER }).select('netAmount').lean()
  ]);

  const pharmacyDue = money(pendingPharmacySales.reduce((sum, sale) => sum + (Number(sale.balance_due) || 0), 0));
  const pharmacyAdvanceAvailable = money(pharmacyAdvanceRow?.balanceAfter || 0);
  const explicitPharmacyClearance = ['cleared', 'exempted'].includes(admission.pharmacyClearanceStatus);
  const noPharmacyActivity = !hasPharmacyTransactions && pharmacyAdvanceAvailable === 0;
  const pharmacyAutoExemptEligible = workflowPolicy.autoExemptPharmacyWhenNoTransactions && noPharmacyActivity;
  const pharmacyCleared = !workflowPolicy.requirePharmacyClearance || explicitPharmacyClearance || pharmacyAutoExemptEligible;
  const finalInvoice = snapshot.ipdInvoices.find((invoice) => invoice.invoice_type === 'IPD Final' || invoice.is_final_ipd_invoice === true) || null;
  const nonPharmacyUnbilledTotal = money(nonPharmacyUnbilled.reduce((sum, row) => sum + Number(row.netAmount || 0), 0));

  const advanceAvailable = money(snapshot.advanceAvailable);
  const disposition = admission.advanceClearanceDisposition || 'pending';
  const advanceReconciled = !workflowPolicy.requireAdvanceReconciliation || advanceAvailable === 0 ||
    workflowPolicy.unusedIpdAdvanceDisposition === 'ALLOW_RETAIN' ||
    (workflowPolicy.unusedIpdAdvanceDisposition === 'REQUIRE_DECISION' && ['retain', 'carry_forward', 'refunded', 'none'].includes(disposition));

  const pharmacyMustPrecedeFinance = workflowPolicy.requirePharmacyClearance && stageBefore(workflowPolicy, 'PHARMACY_CLEARANCE', 'IPD_FINANCIAL_CLEARANCE');
  const checks = {
    unbilledChargesResolved: nonPharmacyUnbilledTotal === 0,
    issuedInvoicesSettled: snapshot.invoiceOutstanding === 0,
    pharmacyClearance: pharmacyCleared && pharmacyDue === 0,
    advanceReconciled,
    finalInvoiceAvailable: !workflowPolicy.requireFinalIPDInvoice || Boolean(finalInvoice),
    financialExceptionApproved: admission.financialClearanceStatus === 'exception_approved'
  };

  const prerequisitesReady = checks.unbilledChargesResolved &&
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
    pharmacyMustPrecedeFinance,
    pharmacyAutoExemptEligible,
    summary: {
      totalCharges: snapshot.ipdChargeAmount,
      totalEncounterCharges: snapshot.totalChargeAmount,
      pharmacyMirrorCharges: sumCharges(snapshot.pharmacyMirrorCharges),
      unbilledCharges: nonPharmacyUnbilledTotal,
      allUnbilledIncludingPharmacy: snapshot.allUnbilledTotal,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      dueAmount: snapshot.overallDue,
      advanceAvailable,
      advanceDisposition: disposition,
      pharmacyDue,
      pharmacyAdvanceAvailable,
      finalInvoiceNumber: finalInvoice?.invoice_number || null
    },
    pendingPharmacySales,
    invoices: snapshot.ipdInvoices,
    pharmacyInvoices: snapshot.pharmacyInvoices
  };
}
async function finaliseFinancialClearance(admissionId, payload = {}, user) {
  let admissionForPolicy = await findAdmission(admissionId, null, user);
  const workflowPolicy = await loadIPDWorkflowPolicy(admissionForPolicy.hospitalId);
  if (workflowPolicy.autoExemptPharmacyWhenNoTransactions && admissionForPolicy.pharmacyClearanceStatus === 'pending') {
    const [hasSale, pharmacyAdvance] = await Promise.all([
      Sale.exists({ hospitalId: admissionForPolicy.hospitalId, admission_id: admissionId, status: { $ne: 'Cancelled' } }),
      PatientAdvanceLedger.findOne({ hospitalId: admissionForPolicy.hospitalId, admissionId, walletType: 'PHARMACY_IPD', status: 'POSTED' }).sort({ createdAt: -1 }).select('balanceAfter').lean()
    ]);
    if (!hasSale && money(pharmacyAdvance?.balanceAfter || 0) === 0) {
      admissionForPolicy.pharmacyClearanceStatus = 'exempted';
      admissionForPolicy.pharmacyClearanceDate = operationNow();
      admissionForPolicy.pharmacyFinalBalance = 0;
      await admissionForPolicy.save();
    }
  }
  const advanceDisposition = String(payload.unusedAdvanceDisposition || '').toLowerCase();
  if (['retain', 'carry_forward'].includes(advanceDisposition)) {
    admissionForPolicy.advanceClearanceDisposition = advanceDisposition;
    admissionForPolicy.advanceClearanceDispositionAt = operationNow();
    admissionForPolicy.advanceClearanceDispositionBy = user?._id;
    admissionForPolicy.advanceClearanceDispositionNote = String(payload.advanceDispositionNote || payload.notes || '').trim();
    await admissionForPolicy.save();
  }
  if (money(admissionForPolicy.advanceAmount || 0) === 0 && admissionForPolicy.advanceClearanceDisposition === 'pending') {
    admissionForPolicy.advanceClearanceDisposition = 'none';
    admissionForPolicy.advanceClearanceDispositionAt = operationNow();
    admissionForPolicy.advanceClearanceDispositionBy = user?._id;
    await admissionForPolicy.save();
  }
  let clearance = await getFinancialClearance(admissionId, user);
  let issuedInvoice = null;
  let settlement = null;

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

  const settlementAmount = optionalMoney(payload.paymentAmount ?? payload.amount);
  const settlementDiscount = optionalMoney(payload.settlementDiscountAmount ?? payload.finalDiscountAmount);
  const taxAdjustment = optionalMoney(payload.taxAdjustmentAmount);
  if (settlementAmount > 0 || settlementDiscount > 0 || taxAdjustment !== 0) {
    // With no explicit invoice selection, allocate oldest-first across every
    // outstanding invoice. This prevents a final payment from being rejected
    // merely because an interim invoice remains due alongside the final bill.
    const targetInvoice = payload.invoiceId || undefined;
    settlement = await recordIPDPayment(admissionId, {
      ...payload,
      invoiceId: targetInvoice,
      amount: settlementAmount,
      settlementDiscountAmount: settlementDiscount,
      taxAdjustmentAmount: taxAdjustment,
      sourceModule: 'Discharge',
      receiptType: 'Final Settlement',
      idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:settlement` : undefined
    }, user);
    clearance = await getFinancialClearance(admissionId, user);
  }

  const admission = await findAdmission(admissionId, null, user);
  const exceptionAllowed = Boolean(payload.allowException && user && ['admin', 'accountant', 'mediqliq_super_admin'].includes(user.role));
  if (!clearance.ready && !exceptionAllowed) {
    const error = new Error('Financial clearance prerequisites are incomplete. Resolve the final invoice, IPD dues, advance disposition and any configured pharmacy prerequisite');
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
      outstandingAccepted: clearance.summary.dueAmount + clearance.summary.pharmacyDue
    };
  }
  if (issuedInvoice) admission.finalInvoiceId = issuedInvoice._id;
  if (clearance.ready && ['Billing Pending', 'Payment Pending'].includes(admission.status)) admission.status = 'Ready for Discharge';
  await admission.save();
  return { clearance: await getFinancialClearance(admissionId, user), issuedInvoice, settlement, admission };
}

module.exports = {
  calculateAdmissionFinancials,
  listBillingAdmissions,
  getRunningBill,
  addManualCharge,
  generateBedCharge,
  applyDiscount,
  voidCharge,
  previewIPDInvoice,
  issueIPDInvoice,
  recordIPDPayment,
  recordAdvance,
  refundAdvance,
  createCreditNote,
  refundInvoice,
  getFinancialLedger,
  getFinancialClearance,
  finaliseFinancialClearance
};