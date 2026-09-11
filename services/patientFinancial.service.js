const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const Hospital = require('../models/Hospital');
const FinancialTransaction = require('../models/FinancialTransaction');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const ApprovalRequest = require('../models/ApprovalRequest');
const billingPatientService = require('./billingPatient.service');
const { money, nextFinancialNumber } = require('../utils/financeNumbers');
const { assertUserHospital } = require('../utils/hospitalScope');
const { quotePricing, pricingSnapshot, serviceTypeFromCharge } = require('./pricingEngine.service');
const { activeAppointmentCoverage } = require('./coverage.service');
const { activatePackageEpisode, recordPackageUtilization } = require('./packageAdjudication.service');
const { replaceCoverageUtilization } = require('./coverageUtilization.service');
const { resolveFinancialPolicy } = require('./financialPolicy.service');
const { _hasActionPermission } = require('../middlewares/auth');
const { calculateChargeAmounts } = require('./financeInvariant.service');

const PAYMENT_METHODS = [
  'Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme',
  'Bank', 'OPDAdvance', 'Adjustment'
];

const EXTERNAL_PAYMENT_METHODS = new Set([
  'Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'Bank'
]);

const sessionOptions = (session) => (session ? { session } : {});
const id = (value) => String(value?._id || value || '');
const amount = (value) => money(Number(value || 0));
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');



function clinicalFlagsFromServiceItems(serviceItems = []) {
  const types = new Set((serviceItems || []).map((item) => String(
    item.service_type || item.charge_type || item.charge_head || item.item_type || ''
  ).trim().toLowerCase()));
  const has = (...needles) => needles.some((needle) => types.has(String(needle).toLowerCase()));
  return {
    has_procedures: has('Procedure'),
    procedures_status: has('Procedure') ? 'Pending' : 'None',
    has_lab_tests: has('Lab Test', 'LAB', 'Laboratory'),
    lab_tests_status: has('Lab Test', 'LAB', 'Laboratory') ? 'Pending' : 'None',
    has_radiology: has('Radiology', 'Imaging'),
    radiology_status: has('Radiology', 'Imaging') ? 'Pending' : 'None'
  };
}

async function resolveRequestedBillToInvoice({ billId, hospitalId, patientId, appointmentId, session = null }) {
  if (!billId) return { bill: null, invoice: null };
  const bill = await Bill.findOne({
    _id: billId,
    hospital_id: hospitalId,
    patient_id: patientId,
    is_deleted: { $ne: true }
  }, null, sessionOptions(session)).lean();
  if (!bill) throw financialError('Selected bill was not found for this patient.', 404, 'OPD_BILL_NOT_FOUND');

  if (appointmentId && appointmentIdFromBillSource(bill) !== id(appointmentId)) {
    throw financialError('The selected bill does not belong to this appointment.', 409, 'OPD_ENCOUNTER_MISMATCH');
  }
  if (bill.status === 'Discount Pending Approval' || bill.discount_approval?.status === 'PENDING') {
    throw financialError('This bill is waiting for discount approval. Collect the final payment after the approval decision is posted.', 409, 'DISCOUNT_APPROVAL_PENDING');
  }

  const linkedInvoiceIds = [bill.invoice_id, ...(bill.invoice_ids || [])].map(id).filter(Boolean);
  if (!linkedInvoiceIds.length) return { bill, invoice: null };

  let query = Invoice.findOne({
    _id: { $in: linkedInvoiceIds },
    hospital_id: hospitalId,
    patient_id: patientId,
    is_deleted: { $ne: true },
    document_stage: { $ne: 'VOID' },
    status: { $nin: ['Cancelled', 'Refunded', 'Discount Pending Approval'] },
    balance_due: { $gt: 0 },
    $or: [{ admission_id: { $exists: false } }, { admission_id: null }]
  }).sort({ issue_date: 1, created_at: 1 });
  if (session) query = query.session(session);
  const invoice = await query.lean();
  if (!invoice) return { bill, invoice: null };
  if (appointmentId && !(await invoiceBelongsToAppointment(invoice, appointmentId, { hospitalId, patientId, session }))) {
    throw financialError('The selected bill resolves to an invoice outside this appointment.', 409, 'OPD_ENCOUNTER_MISMATCH');
  }
  if (await invoiceHasPendingDiscount({ hospitalId, patientId, invoiceId: invoice._id, session })) {
    throw financialError('This invoice contains a bill waiting for discount approval. Collect the final payment after the approval decision is posted.', 409, 'DISCOUNT_APPROVAL_PENDING');
  }
  return { bill, invoice };
}

function appointmentIdFromBillSource(bill) {
  if (!bill) return '';
  if (bill.appointment_id) return id(bill.appointment_id);
  const candidates = new Set();
  for (const item of bill.items || []) {
    const snapshot = item?.source_snapshot || {};
    const origin = String(snapshot.originModule || snapshot.sourceModule || '').toLowerCase();
    if (origin === 'appointment' && snapshot.sourceId) candidates.add(id(snapshot.sourceId));
    const match = String(snapshot.sourceLineKey || '').match(/^appointment:([^:]+):/i);
    if (match?.[1]) candidates.add(String(match[1]));
  }
  return candidates.size === 1 ? [...candidates][0] : '';
}

function scopeBillFilterToAppointment(filter, appointmentId) {
  if (!appointmentId) return filter;
  filter.$and = Array.isArray(filter.$and) ? filter.$and : [];
  filter.$and.push({
    $or: [
      { appointment_id: appointmentId },
      { 'items.source_snapshot.sourceLineKey': { $regex: `^appointment:${escapeRegex(appointmentId)}:`, $options: 'i' } },
      { 'items.source_snapshot.originModule': 'Appointment', 'items.source_snapshot.sourceId': String(appointmentId) }
    ]
  });
  return filter;
}

async function scopeInvoicesToAppointment(invoices, appointmentId, options) {
  if (!appointmentId) return invoices;
  const matches = await Promise.all((invoices || []).map(async (invoice) => (
    await invoiceBelongsToAppointment(invoice, appointmentId, options) ? invoice : null
  )));
  return matches.filter(Boolean);
}

async function invoiceBelongsToAppointment(invoice, appointmentId, { hospitalId, patientId, session } = {}) {
  if (!invoice || !appointmentId) return false;
  if (id(invoice.appointment_id) === id(appointmentId)) return true;
  const linkedBillIds = [invoice.bill_id, ...(invoice.bill_ids || [])].map(id).filter(Boolean);
  if (!linkedBillIds.length) return false;
  const bills = await Bill.find({
    _id: { $in: linkedBillIds },
    ...(hospitalId ? { hospital_id: hospitalId } : {}),
    ...(patientId ? { patient_id: patientId } : {}),
    is_deleted: { $ne: true }
  }, null, sessionOptions(session)).lean();
  return bills.some((bill) => appointmentIdFromBillSource(bill) === id(appointmentId));
}

const isDiscountApprovalPendingBill = (bill) =>
  bill?.status === 'Discount Pending Approval' || bill?.discount_approval?.status === 'PENDING';

function financialError(message, statusCode = 400, code = 'FINANCIAL_VALIDATION_ERROR', details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function calculateLineAmounts(payload = {}) {
  try {
    return calculateChargeAmounts(payload);
  } catch (error) {
    throw financialError(error.message);
  }
}

function rejectOPDBillDiscount(bill) {
  if (!bill) return 0;
  const oldTotal = amount(bill.total_amount || 0);
  let restoredBaseDiscount = 0;
  let taxableTotal = 0;
  let taxTotal = 0;
  let newTotal = 0;

  for (const item of bill.items || []) {
    const oldItemDiscount = amount(item.discount_amount || 0);
    restoredBaseDiscount = amount(restoredBaseDiscount + oldItemDiscount);

    const quantity = Number(item.quantity || 1);
    const gross = amount(
      Number(item.gross_amount || 0) ||
      (Number(item.unit_price || 0) * (Number.isFinite(quantity) && quantity > 0 ? quantity : 1)) ||
      (Number(item.taxable_amount || item.amount || 0) + oldItemDiscount)
    );
    const taxMode = ['inclusive', 'exempt'].includes(item.tax_mode) ? item.tax_mode : 'exclusive';
    const taxRate = taxMode === 'exempt' ? 0 : Math.max(0, Number(item.tax_rate || 0));
    let taxable = gross;
    let tax = 0;
    let net = gross;
    if (taxMode === 'inclusive' && taxRate > 0) {
      taxable = amount(gross / (1 + taxRate / 100));
      tax = amount(gross - taxable);
    } else if (taxMode === 'exclusive' && taxRate > 0) {
      tax = amount(gross * taxRate / 100);
      net = amount(gross + tax);
    }

    const oldNet = amount(item.net_amount || item.amount || 0);
    const liabilityDelta = amount(Math.max(0, net - oldNet));
    item.discount_amount = 0;
    item.discount_rate = 0;
    item.discount_reason = undefined;
    item.taxable_amount = taxable;
    item.tax_amount = tax;
    item.net_amount = net;
    item.amount = net;
    if (item.patient_liability != null) {
      item.patient_liability = amount(Number(item.patient_liability || 0) + liabilityDelta);
    }
    if (item.hospital_concession != null) {
      item.hospital_concession = amount(Math.max(0, Number(item.hospital_concession || 0) - oldItemDiscount));
    }

    taxableTotal = amount(taxableTotal + taxable);
    taxTotal = amount(taxTotal + tax);
    newTotal = amount(newTotal + net);
  }

  // Legacy bills may not carry item-level discount metadata. Preserve the
  // approved/requested amount as the fallback restoration value in that case.
  const requestedDiscount = amount(
    bill.discount_approval?.discount_amount ||
    bill.line_discount_total ||
    bill.discount ||
    restoredBaseDiscount
  );
  if (!(bill.items || []).length) {
    newTotal = amount(oldTotal + requestedDiscount);
    taxableTotal = amount(Number(bill.taxable_amount || 0) + requestedDiscount);
    taxTotal = amount(bill.tax_amount || 0);
  }

  const totalDelta = amount(Math.max(0, newTotal - oldTotal));
  bill.line_discount_total = 0;
  bill.bill_discount_total = 0;
  bill.discount = 0;
  bill.taxable_amount = taxableTotal;
  bill.tax_amount = taxTotal;
  bill.total_amount = newTotal;

  if (bill.payer_allocation?.coverage_id) {
    bill.payer_allocation.patient_liability = amount(Number(bill.payer_allocation.patient_liability || 0) + totalDelta);
    bill.payer_allocation.hospital_concession = amount(Math.max(0, Number(bill.payer_allocation.hospital_concession || 0) - requestedDiscount));
  }

  return totalDelta;
}

async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

async function findPatient(patientId, user, session) {
  const hospitalId = assertUserHospital(user);
  const patient = await Patient.findOne({ _id: patientId, hospitalId }, null, sessionOptions(session));
  if (!patient) throw financialError('Patient not found in this hospital', 404);
  return { patient, hospitalId };
}

async function getOPDAdvanceBalance({ hospitalId, patientId, session }) {
  const latest = await PatientAdvanceLedger.findOne({
    hospitalId,
    patientId,
    walletType: 'OPD_SHARED',
    status: 'POSTED',
    $or: [{ admissionId: { $exists: false } }, { admissionId: null }]
  }, null, sessionOptions(session)).sort({ createdAt: -1 });
  return amount(latest?.balanceAfter);
}

async function getPatientWorkspace(patientId, user, options = {}) {
  const hospitalId = assertUserHospital(user);
  return billingPatientService.getPatientBillingDetails({
    hospitalId,
    patientId,
    admissionId: null,
    appointmentId: options.appointmentId || null
  });
}

async function addOPDCharge(patientId, payload, user) {
  return runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    const appointmentId = payload.appointmentId || null;
    if (payload.idempotencyKey) {
      const existing = await Bill.findOne({ hospital_id: hospitalId, idempotency_key: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) {
        // Repair legacy Desk rows that retained the stable appointment source key
        // but missed the top-level appointment_id used by encounter-scoped Finance.
        if (appointmentId && !existing.appointment_id) {
          existing.appointment_id = appointmentId;
          await existing.save(sessionOptions(session));
        }
        const snapshot = existing.items?.[0]?.source_snapshot || {};
        return {
          bill: existing,
          financialPolicy: {
            selectedMode: snapshot.selectedMode,
            requiredNow: Number(snapshot.requiredNow || 0),
            clearanceState: snapshot.clearanceState,
            policySnapshot: snapshot.financialPolicy || {}
          },
          alreadyExists: true
        };
      }
    }
    if (appointmentId && payload.sourceModule === 'Appointment' && payload.sourceLineKey) {
      const existingSourceBill = await Bill.findOne({
        hospital_id: hospitalId,
        appointment_id: appointmentId,
        is_deleted: { $ne: true },
        'items.source_snapshot.sourceLineKey': String(payload.sourceLineKey)
      }, null, sessionOptions(session));
      if (existingSourceBill) {
        const snapshot = existingSourceBill.items?.[0]?.source_snapshot || {};
        return {
          bill: existingSourceBill,
          financialPolicy: {
            selectedMode: snapshot.selectedMode,
            requiredNow: Number(snapshot.requiredNow || 0),
            clearanceState: snapshot.clearanceState,
            policySnapshot: snapshot.financialPolicy || {}
          },
          alreadyExists: true,
          duplicateSourcePrevented: true
        };
      }
    }

    const cashLine = calculateLineAmounts(payload);
    if (!String(payload.description || '').trim()) throw financialError('Charge description is required');

    const quote = await quotePricing({
      hospitalId,
      appointmentId,
      serviceDate: payload.chargeDate || operationNow(),
      chargeType: payload.chargeType,
      serviceType: payload.serviceType || serviceTypeFromCharge(payload.chargeType),
      internalServiceModel: payload.internalServiceModel,
      internalServiceId: payload.internalServiceId,
      internalCode: payload.serviceCode,
      payerServiceCode: payload.payerServiceCode,
      // Existing OPD inputs express rate per unit. The cash calculation remains
      // available for tax/discount display, while payer allocation uses the
      // hospital's undiscounted service unit as its standard amount.
      standardAmount: payload.internalServiceId ? undefined : cashLine.rate,
      quantity: cashLine.quantity,
      nonAdmissibleAmount: payload.nonAdmissibleAmount,
      sponsorApprovalCap: payload.sponsorApprovalCap,
      balanceBillingApproved: payload.balanceBillingApproved,
      approvedUncoveredTreatment: payload.approvedUncoveredTreatment
    });

    const contracted = amount(quote.amounts.contracted);
    const standard = amount(quote.amounts.hospitalStandard);
    const coverage = appointmentId ? await activeAppointmentCoverage(hospitalId, appointmentId, session) : null;
    const policy = await resolveFinancialPolicy({
      hospitalId,
      user,
      encounterType: 'OPD',
      serviceType: payload.serviceType || serviceTypeFromCharge(payload.chargeType),
      serviceCategory: payload.serviceCategory,
      serviceCode: payload.serviceCode || payload.payerServiceCode,
      payerCategory: coverage?.payerCategory || (coverage ? 'SPONSORED' : 'SELF'),
      departmentId: payload.departmentId,
      urgency: payload.urgency,
      effectiveAt: payload.effectiveAt || payload.chargeDate || operationNow(),
      selectedMode: payload.selectedMode,
      inheritedMode: payload.inheritedMode,
      requestedDeposit: payload.requestedDeposit,
      patientLiability: quote.amounts.patientLiability,
      sponsorLiability: quote.amounts.sponsorLiability,
      contractedAmount: contracted,
      adjustments: {
        discountType: payload.discountType,
        discountRate: payload.discountRate,
        discountAmount: payload.discountAmount,
        discountValue: payload.discountValue,
        discountReason: payload.discountReason,
        taxMode: payload.taxMode,
        taxRate: payload.taxRate,
        taxReason: payload.taxReason
      },
      overrideReason: payload.overrideReason
    });
    const adjusted = policy.amounts;
    quote.amounts = {
      ...quote.amounts,
      patientLiability: adjusted.patientLiability,
      sponsorLiability: adjusted.sponsorLiability,
      hospitalConcession: amount(Number(quote.amounts.hospitalConcession || 0) + adjusted.discountAmount)
    };
    const [billNumber, hospital] = await Promise.all([
      nextFinancialNumber({ documentType: 'BILL', hospitalId, session }),
      Hospital.findById(hospitalId, null, sessionOptions(session)).lean()
    ]);
    const now = operationNow();
    const itemType = ['Consultation', 'Procedure', 'Lab Test', 'Radiology'].includes(payload.chargeType)
      ? payload.chargeType
      : 'Other';
    const lineQuantity = cashLine.quantity;
    const lineUnitPrice = lineQuantity ? amount(contracted / lineQuantity) : contracted;
    const snapshot = pricingSnapshot(quote, {
      internalServiceModel: payload.internalServiceModel,
      internalServiceId: payload.internalServiceId
    });
    const bill = new Bill({
      hospital_id: hospitalId,
      bill_number: billNumber,
      document_stage: 'GENERATED',
      patient_id: patient._id,
      appointment_id: appointmentId || undefined,
      gross_amount: standard,
      subtotal: contracted,
      line_discount_total: adjusted.discountAmount,
      bill_discount_total: 0,
      discount: adjusted.discountAmount,
      discount_type: adjusted.discountType,
      discount_reason: adjusted.discountReason,
      taxable_amount: adjusted.taxableAmount,
      tax_amount: adjusted.taxAmount,
      rounding_adjustment: 0,
      total_amount: adjusted.netAmount,
      paid_amount: 0,
      balance_due: adjusted.patientLiability,
      payment_method: 'Pending',
      status: adjusted.requiresDiscountApproval ? 'Discount Pending Approval' : (quote.amounts.patientLiability <= 0 ? 'Paid' : 'Pending'),
      discount_approval: adjusted.requiresDiscountApproval ? {
        status: 'PENDING',
        requested_by: user?._id,
        requested_at: now,
        discount_amount: adjusted.discountAmount,
        discount_percentage: adjusted.discountRate,
        reason: adjusted.discountReason || 'Staff discount request'
      } : undefined,
      generated_at: now,
      created_by: user?._id,
      notes: payload.notes,
      idempotency_key: payload.idempotencyKey,
      patient_snapshot: patient.toObject ? patient.toObject() : patient,
      encounter_snapshot: {
        encounterType: 'OPD',
        appointmentId: appointmentId || payload.encounterSnapshot?.appointmentId || null,
        doctorId: payload.encounterSnapshot?.doctorId || payload.doctorId || null,
        doctorName: payload.encounterSnapshot?.doctorName || '',
        departmentId: payload.encounterSnapshot?.departmentId || payload.departmentId || null,
        departmentName: payload.encounterSnapshot?.departmentName || '',
        departmentCode: payload.encounterSnapshot?.departmentCode || ''
      },
      hospital_snapshot: hospital || {},
      payer_allocation: {
        coverage_id: coverage?._id,
        payer_id: coverage?.payerId?._id || coverage?.payerId,
        rate_card_id: quote.rateCard?.id,
        rate_card_version: quote.rateCard?.version,
        standard_amount: quote.amounts.hospitalStandard,
        contracted_amount: quote.amounts.contracted,
        eligible_amount: quote.amounts.eligible,
        patient_liability: adjusted.patientLiability,
        sponsor_liability: adjusted.sponsorLiability,
        non_admissible_amount: quote.amounts.nonAdmissible,
        contractual_adjustment: quote.amounts.hospitalAdjustment,
        hospital_concession: quote.amounts.hospitalConcession,
        package_absorbed: quote.amounts.packageAbsorbed,
        fallback_count: quote.resultType === 'cash_fallback' ? 1 : 0
      },
      items: [{
        description: String(payload.description).trim(),
        charge_type: payload.chargeType || 'Miscellaneous',
        charge_head: payload.chargeHead || payload.chargeType || 'MISCELLANEOUS',
        charge_date: payload.chargeDate || now,
        quantity: lineQuantity,
        unit_price: lineUnitPrice,
        gross_amount: contracted,
        discount_type: adjusted.discountType,
        discount_rate: adjusted.discountRate,
        discount_amount: adjusted.discountAmount,
        discount_reason: adjusted.discountReason,
        taxable_amount: adjusted.taxableAmount,
        tax_mode: adjusted.taxMode,
        tax_name: adjusted.taxName,
        tax_code: adjusted.taxCode,
        tax_rate: adjusted.taxRate,
        tax_amount: adjusted.taxAmount,
        net_amount: adjusted.netAmount,
        amount: adjusted.netAmount,
        item_type: itemType,
        procedure_id: payload.internalServiceModel === 'Procedure' ? payload.internalServiceId : undefined,
        procedure_code: payload.internalServiceModel === 'Procedure' ? payload.serviceCode : undefined,
        lab_test_id: payload.internalServiceModel === 'LabTest' ? payload.internalServiceId : undefined,
        lab_test_code: payload.internalServiceModel === 'LabTest' ? payload.serviceCode : undefined,
        radiology_test_id: payload.internalServiceModel === 'ImagingTest' ? payload.internalServiceId : undefined,
        radiology_test_code: payload.internalServiceModel === 'ImagingTest' ? payload.serviceCode : undefined,
        pricing_snapshot: snapshot,
        standard_amount: quote.amounts.hospitalStandard,
        contracted_amount: quote.amounts.contracted,
        eligible_amount: quote.amounts.eligible,
        patient_liability: adjusted.patientLiability,
        sponsor_liability: adjusted.sponsorLiability,
        non_admissible_amount: quote.amounts.nonAdmissible,
        contractual_adjustment: quote.amounts.hospitalAdjustment,
        hospital_concession: quote.amounts.hospitalConcession,
        package_absorbed: quote.amounts.packageAbsorbed,
        source_snapshot: {
          sourceModule: 'OPD',
          originModule: payload.sourceModule || undefined,
          sourceId: payload.sourceId || undefined,
          sourceLineKey: payload.sourceLineKey || undefined,
          taxExemptionReason: payload.taxExemptionReason || '',
          createdFrom: payload.createdFrom || 'OPDRevenueWorkspace',
          encounterSnapshot: payload.encounterSnapshot || {
            encounterType: 'OPD',
            appointmentId: appointmentId || null,
            doctorId: payload.doctorId || null,
            departmentId: payload.departmentId || null
          },
          pricingResultType: quote.resultType,
          fallbackReason: quote.fallbackReason,
          financialPolicy: policy.policySnapshot,
          selectedMode: policy.selectedMode,
          requiredNow: policy.requiredNow,
          clearanceState: policy.clearanceState
        }
      }]
    });
    await bill.save(sessionOptions(session));

    if (adjusted.requiresDiscountApproval) {
      try {
        const ApprovalRequest = require('../models/ApprovalRequest');
        await ApprovalRequest.create([{
          hospitalId,
          requestType: 'DISCOUNT_APPROVAL',
          patientId: patient._id,
          appointmentId: appointmentId || undefined,
          billId: bill._id,
          details: {
            billId: bill._id,
            billNumber: bill.bill_number,
            appointmentId: appointmentId || undefined,
            totalBillAmount: Number(bill.subtotal || bill.gross_amount || bill.total_amount || 0),
            totalDueAmount: Number(bill.balance_due != null ? bill.balance_due : bill.total_amount || 0),
            discountAmount: adjusted.discountAmount,
            requestedDiscountPercentage: adjusted.discountRate,
            reason: adjusted.discountReason || 'Staff discount request',
            encounterType: 'OPD'
          },
          requestedBy: user?._id,
          status: 'Pending'
        }], sessionOptions(session));
      } catch (apprErr) {
        console.warn('Could not create ApprovalRequest in addOPDCharge:', apprErr.message);
      }
    }

    await replaceCoverageUtilization({
      coverage,
      quote,
      hospitalId,
      encounterType: 'OPD',
      appointmentId,
      patientId: patient._id,
      sourceType: 'BillItem',
      sourceId: bill._id,
      sourceLineId: bill.items[0]?._id,
      internalServiceModel: payload.internalServiceModel,
      internalServiceId: payload.internalServiceId,
      userId: user?._id,
      session
    });

    if (coverage && quote.rateCardItemId && quote.packageCode) {
      await activatePackageEpisode({
        quote,
        coverage,
        hospitalId,
        encounterType: 'OPD',
        encounterId: appointmentId,
        patientId: patient._id,
        sourceType: 'BillItem',
        sourceId: bill._id,
        userId: user?._id,
        session
      });
    }
    if (quote.packageAdjudication) {
      await recordPackageUtilization({
        decision: quote.packageAdjudication,
        input: {
          serviceType: payload.serviceType || serviceTypeFromCharge(payload.chargeType),
          internalServiceModel: payload.internalServiceModel,
          internalServiceId: payload.internalServiceId,
          internalCode: payload.serviceCode,
          description: payload.description,
          quantity: lineQuantity
        },
        quote,
        sourceType: 'BillItem',
        sourceId: bill._id,
        sourceLineId: bill.items[0]?._id,
        session
      });
    }
    return { bill, quote, financialPolicy: policy, alreadyExists: false };
  });
}

function billPaymentHistory(bills = []) {
  const groups = new Map();
  bills.forEach((bill) => (bill.payments || []).forEach((payment, index) => {
    const receipt = String(payment.reference || `${bill.bill_number || bill._id}-P${index + 1}`);
    const key = receipt;
    if (!groups.has(key)) groups.set(key, {
      date: payment.date || bill.paid_at || bill.updatedAt || bill.createdAt,
      amount: 0,
      method: payment.method || bill.payment_method || 'Cash',
      reference: payment.reference || '',
      status: 'Completed',
      receipt_number: receipt,
      receipt_type: 'Payment',
      payment_breakdown: []
    });
    const row = groups.get(key);
    row.amount = amount(row.amount + Number(payment.amount || 0));
    row.payment_breakdown.push({
      method: payment.method || bill.payment_method || 'Cash',
      amount: amount(payment.amount),
      reference: payment.reference || ''
    });
  }));
  return Array.from(groups.values()).sort((left, right) => new Date(left.date || 0) - new Date(right.date || 0));
}

function billServiceItems(bill) {
  const billItems = bill.items || [];
  const billTotal = amount(bill.total_amount || billItems.reduce((sum, item) => sum + Number(item.net_amount || item.amount || 0), 0));
  const billAllocation = bill.payer_allocation || {};
  const allocationFields = [
    'standard_amount', 'contracted_amount', 'eligible_amount', 'patient_liability',
    'sponsor_liability', 'non_admissible_amount', 'contractual_adjustment',
    'hospital_concession', 'package_absorbed'
  ];
  const billHasAllocationEvidence = allocationFields.some((field) => Math.abs(Number(billAllocation[field] || 0)) > 1e-9);

  return billItems.map((item) => {
    const quantity = Number(item.quantity || 1);
    const gross = amount(item.gross_amount || (Number(item.unit_price || 0) * quantity) || item.amount);
    const discount = amount(item.discount_amount);
    const tax = amount(item.tax_amount);
    const taxable = amount(item.taxable_amount || Math.max(0, gross - discount));
    const net = amount(item.net_amount || item.amount || taxable + tax);
    const rawType = String(item.item_type || 'Other');
    const serviceType = ['Consultation', 'Procedure', 'Lab Test', 'Radiology', 'Purchase'].includes(rawType) ? rawType : 'Other';
    const ratio = billTotal > 0 ? Math.max(0, net / billTotal) : (billItems.length ? 1 / billItems.length : 1);
    const itemHasAllocationEvidence = allocationFields.some((field) => Math.abs(Number(item[field] || 0)) > 1e-9);
    // Older bills sometimes persisted an all-zero item allocation while keeping the
    // real payer split at bill level. Fall back proportionally only for that legacy
    // shape; otherwise explicit item zeroes remain authoritative.
    const useBillAllocationFallback = !itemHasAllocationEvidence && billHasAllocationEvidence;
    const allocated = (field) => amount(Number(billAllocation[field] || 0) * ratio);
    const allocationValue = (field, fallback = 0) => {
      if (useBillAllocationFallback) return allocated(field);
      if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
        const parsed = Number(item[field]);
        if (Number.isFinite(parsed)) return amount(parsed);
      }
      return amount(fallback);
    };

    return {
      description: item.description || 'OPD charge',
      charge_type: item.charge_type || rawType,
      charge_head: item.charge_head || item.charge_type || rawType,
      charge_date: item.charge_date || bill.generated_at,
      quantity,
      unit_price: amount(item.unit_price || (quantity ? gross / quantity : gross)),
      gross_amount: gross,
      standard_amount: allocationValue('standard_amount', gross),
      contracted_amount: allocationValue('contracted_amount', gross),
      eligible_amount: allocationValue('eligible_amount', net),
      patient_liability: allocationValue('patient_liability', net),
      sponsor_liability: allocationValue('sponsor_liability', 0),
      non_admissible_amount: allocationValue('non_admissible_amount', 0),
      contractual_adjustment: allocationValue('contractual_adjustment', 0),
      hospital_concession: allocationValue('hospital_concession', discount),
      package_absorbed: allocationValue('package_absorbed', 0),
      discount_type: item.discount_type || 'fixed',
      discount_rate: Number(item.discount_rate || 0),
      discount_amount: discount,
      discount_reason: item.discount_reason,
      taxable_amount: taxable,
      tax_mode: item.tax_mode || 'exclusive',
      tax_name: item.tax_name,
      tax_code: item.tax_code,
      tax_rate: Number(item.tax_rate || 0),
      tax_amount: tax,
      net_amount: net,
      total_price: net,
      service_type: serviceType,
      bill_id: bill._id,
      source_snapshot: item.source_snapshot || {}
    };
  });
}

async function issueOPDInvoice(patientId, payload, user) {
  return runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    if (payload.idempotencyKey) {
      const existing = await Invoice.findOne({ hospital_id: hospitalId, idempotency_key: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) return { invoice: existing, alreadyExists: true };
    }

    const filter = {
      hospital_id: hospitalId,
      patient_id: patient._id,
      is_deleted: { $ne: true },
      $or: [{ admission_id: { $exists: false } }, { admission_id: null }],
      $and: [
        { $or: [{ invoice_id: { $exists: false } }, { invoice_id: null }] },
        { $or: [{ invoice_ids: { $exists: false } }, { invoice_ids: { $size: 0 } }] },
        { document_stage: { $ne: 'VOID' } }
      ]
    };
    if (Array.isArray(payload.billIds) && payload.billIds.length) {
      const pendingRequested = await Bill.findOne({
        hospital_id: hospitalId,
        patient_id: patient._id,
        _id: { $in: payload.billIds },
        $or: [
          { status: 'Discount Pending Approval' },
          { 'discount_approval.status': 'PENDING' }
        ]
      }, null, sessionOptions(session));
      if (pendingRequested) {
        throw financialError('A selected OPD bill is waiting for discount approval. Issue the invoice after the approval decision is posted.', 409, 'DISCOUNT_APPROVAL_PENDING');
      }
      filter._id = { $in: payload.billIds };
    } else {
      filter.status = { $ne: 'Discount Pending Approval' };
      filter['discount_approval.status'] = { $ne: 'PENDING' };
    }
    const bills = await Bill.find(filter, null, sessionOptions(session)).sort({ generated_at: 1, createdAt: 1 });
    if (!bills.length) throw financialError('There are no uninvoiced OPD bills for this patient', 409);

    const encounterKeys = new Set(bills.map((bill) => appointmentIdFromBillSource(bill) || 'CASH'));
    if (encounterKeys.size > 1) {
      throw financialError(
        'One OPD invoice cannot combine bills from different appointments. Select a single appointment (or only cash/walk-in bills) and issue the invoice again.',
        409,
        'OPD_INVOICE_MIXED_ENCOUNTERS'
      );
    }

    const serviceItems = bills.flatMap(billServiceItems);
    const gross = amount(bills.reduce((sum, bill) => sum + Number(bill.gross_amount || bill.subtotal || 0), 0));
    const lineDiscount = amount(bills.reduce((sum, bill) => sum + Number(bill.line_discount_total || bill.discount || 0), 0));
    const billDiscount = amount(bills.reduce((sum, bill) => sum + Number(bill.bill_discount_total || 0), 0));
    const taxable = amount(bills.reduce((sum, bill) => sum + Number(bill.taxable_amount ?? Math.max(0, Number(bill.gross_amount || bill.subtotal || 0) - Number(bill.line_discount_total || bill.discount || 0) - Number(bill.bill_discount_total || 0))), 0));
    const tax = amount(bills.reduce((sum, bill) => sum + Number(bill.tax_amount || 0), 0));
    const rounding = amount(bills.reduce((sum, bill) => sum + Number(bill.rounding_adjustment || 0), 0));
    // Bill totals are historical snapshots. Summing them preserves inclusive-tax
    // and rounding decisions exactly instead of recalculating with current rules.
    const total = amount(bills.reduce((sum, bill) => sum + Number(bill.total_amount || 0), 0));
    const paid = amount(bills.reduce((sum, bill) => sum + Number(bill.paid_amount || 0), 0));
    const settlementDiscount = amount(bills.reduce((sum, bill) => sum + Number(bill.settlement_discount_amount || 0), 0));
    const creditNotes = amount(bills.reduce((sum, bill) => sum + Number(bill.credit_note_amount || 0), 0));
    const inheritedPayments = billPaymentHistory(bills);
    const payerAllocation = bills.reduce((acc, bill) => {
      const alloc = bill.payer_allocation || {};
      acc.standard_amount = amount((acc.standard_amount || 0) + Number(alloc.standard_amount || bill.gross_amount || bill.subtotal || 0));
      acc.contracted_amount = amount((acc.contracted_amount || 0) + Number(alloc.contracted_amount || bill.total_amount || 0));
      acc.eligible_amount = amount((acc.eligible_amount || 0) + Number(alloc.eligible_amount || alloc.contracted_amount || bill.total_amount || 0));
      acc.patient_liability = amount((acc.patient_liability || 0) + Number(alloc.patient_liability ?? bill.total_amount ?? 0));
      acc.sponsor_liability = amount((acc.sponsor_liability || 0) + Number(alloc.sponsor_liability || 0));
      acc.non_admissible_amount = amount((acc.non_admissible_amount || 0) + Number(alloc.non_admissible_amount || 0));
      acc.contractual_adjustment = amount((acc.contractual_adjustment || 0) + Number(alloc.contractual_adjustment || 0));
      acc.hospital_concession = amount((acc.hospital_concession || 0) + Number(alloc.hospital_concession || 0));
      acc.package_absorbed = amount((acc.package_absorbed || 0) + Number(alloc.package_absorbed || 0));
      acc.sponsor_paid_amount = amount((acc.sponsor_paid_amount || 0) + Number(alloc.sponsor_paid_amount || 0));
      if (!acc.coverage_id && alloc.coverage_id) acc.coverage_id = alloc.coverage_id;
      if (!acc.payer_id && alloc.payer_id) acc.payer_id = alloc.payer_id;
      if (!acc.claim_id && alloc.claim_id) acc.claim_id = alloc.claim_id;
      return acc;
    }, {
      standard_amount: 0,
      contracted_amount: 0,
      eligible_amount: 0,
      patient_liability: 0,
      sponsor_liability: 0,
      non_admissible_amount: 0,
      contractual_adjustment: 0,
      hospital_concession: 0,
      package_absorbed: 0,
      sponsor_paid_amount: 0
    });
    const invoiceNumber = await nextFinancialNumber({ documentType: 'INVOICE', hospitalId, session });
    const hospital = await Hospital.findById(hospitalId, null, sessionOptions(session)).lean();
    const now = operationNow();
    const billEncounterSnapshot = bills
      .map((bill) => bill.encounter_snapshot || bill.items?.find((item) => item?.source_snapshot?.encounterSnapshot)?.source_snapshot?.encounterSnapshot)
      .find((snapshot) => snapshot && (snapshot.doctorId || snapshot.doctorName || snapshot.departmentId || snapshot.departmentName));
    const encounterSnapshot = payload.encounterSnapshot || billEncounterSnapshot || {};
    const invoice = new Invoice({
      hospital_id: hospitalId,
      invoice_number: invoiceNumber,
      patient_id: patient._id,
      customer_type: 'Patient',
      customer_name: [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') || patient.name || 'Patient',
      customer_phone: patient.phone || patient.mobile || '',
      appointment_id: (() => {
        const linkedAppointmentId = [...encounterKeys][0];
        return linkedAppointmentId && linkedAppointmentId !== 'CASH' ? linkedAppointmentId : undefined;
      })(),
      bill_id: bills[0]._id,
      bill_ids: bills.map((bill) => bill._id),
      invoice_type: serviceItems.some((item) => item.service_type !== 'Consultation') ? 'Mixed' : 'Appointment',
      document_stage: 'ISSUED',
      issued_at: now,
      issue_date: now,
      due_date: new Date(now.getTime() + (Number(payload.dueInDays ?? 7) * 86400000)),
      service_items: serviceItems,
      payer_allocation: payerAllocation,
      gross_amount: gross,
      subtotal: gross,
      line_discount_total: lineDiscount,
      bill_discount_total: billDiscount,
      discount: amount(lineDiscount + billDiscount),
      taxable_amount: taxable,
      tax,
      rounding_adjustment: rounding,
      total,
      amount_paid: paid,
      payment_history: inheritedPayments,
      receipt_numbers: inheritedPayments.map((payment) => payment.receipt_number).filter(Boolean),
      settlement_discount_amount: settlementDiscount,
      credit_note_total: creditNotes,
      balance_due: amount(Math.max(0, total - paid - settlementDiscount - creditNotes)),
      status: total - paid - settlementDiscount - creditNotes <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Pending',
      notes: payload.notes || `Consolidated OPD invoice for ${bills.length} bill(s)`,
      idempotency_key: payload.idempotencyKey,
      created_by: user?._id,
      patient_snapshot: patient.toObject ? patient.toObject() : patient,
      encounter_snapshot: {
        encounterType: encounterSnapshot.encounterType || 'OPD',
        appointmentId: encounterSnapshot.appointmentId || (() => {
          const linkedAppointmentId = [...encounterKeys][0];
          return linkedAppointmentId && linkedAppointmentId !== 'CASH' ? linkedAppointmentId : null;
        })(),
        doctorId: encounterSnapshot.doctorId || null,
        doctorName: encounterSnapshot.doctorName || '',
        departmentId: encounterSnapshot.departmentId || null,
        departmentName: encounterSnapshot.departmentName || '',
        departmentCode: encounterSnapshot.departmentCode || ''
      },
      hospital_snapshot: hospital || {},
      print_snapshot: {
        billNumbers: bills.map((bill) => bill.bill_number),
        aggregateScope: [...encounterKeys][0] !== 'CASH' ? 'OPD_APPOINTMENT' : 'OPD_PATIENT',
        appointmentId: [...encounterKeys][0] !== 'CASH' ? [...encounterKeys][0] : undefined,
        discountApprovalPending: false
      },
      ...clinicalFlagsFromServiceItems(serviceItems)
    });
    await invoice.save(sessionOptions(session));
    for (const bill of bills) {
      bill.invoice_id = invoice._id;
      bill.invoice_ids = Array.from(new Set([...(bill.invoice_ids || []).map(id), id(invoice._id)])).filter(Boolean);
      bill.document_stage = 'INVOICED';
      bill.invoiced_at = now;
      await bill.save(sessionOptions(session));
    }
    return { invoice, bills, alreadyExists: false };
  });
}

async function linkedBillsForInvoice(invoice, session) {
  const ids = [...(invoice.bill_ids || []), invoice.bill_id].map(id).filter(Boolean);
  return ids.length ? Bill.find({ _id: { $in: ids } }, null, sessionOptions(session)).sort({ generated_at: 1 }) : [];
}

async function invoiceHasPendingDiscount({ hospitalId, patientId, invoiceId, session = null }) {
  if (!invoiceId) return false;
  const query = Bill.exists({
    hospital_id: hospitalId,
    patient_id: patientId,
    is_deleted: { $ne: true },
    $and: [
      { $or: [{ status: 'Discount Pending Approval' }, { 'discount_approval.status': 'PENDING' }] },
      { $or: [{ invoice_id: invoiceId }, { invoice_ids: invoiceId }] }
    ]
  });
  if (session) query.session(session);
  return Boolean(await query);
}

async function excludePendingDiscountInvoices(invoices, { hospitalId, patientId, session = null }) {
  const ids = (invoices || []).map((invoice) => invoice?._id).filter(Boolean);
  if (!ids.length) return invoices || [];
  const query = Bill.find({
    hospital_id: hospitalId,
    patient_id: patientId,
    is_deleted: { $ne: true },
    $and: [
      { $or: [{ status: 'Discount Pending Approval' }, { 'discount_approval.status': 'PENDING' }] },
      { $or: [{ invoice_id: { $in: ids } }, { invoice_ids: { $in: ids } }] }
    ]
  }).select('invoice_id invoice_ids').lean();
  if (session) query.session(session);
  const pendingBills = await query;
  const blocked = new Set();
  pendingBills.forEach((bill) => [bill.invoice_id, ...(bill.invoice_ids || [])].map(id).filter(Boolean).forEach((invoiceId) => blocked.add(invoiceId)));
  return (invoices || []).filter((invoice) => !blocked.has(id(invoice._id)));
}

async function syncOPDInvoiceFromBills(invoiceId, hospitalId, session = null) {
  const invoice = await Invoice.findOne({ _id: invoiceId, hospital_id: hospitalId }, null, sessionOptions(session));
  if (!invoice) return null;

  const bills = await linkedBillsForInvoice(invoice, session);
  if (!bills.length) return invoice;

  const serviceItems = bills.flatMap(billServiceItems);
  const gross = amount(bills.reduce((sum, bill) => sum + Number(bill.gross_amount || bill.subtotal || 0), 0));
  const lineDiscount = amount(bills.reduce((sum, bill) => sum + Number(bill.line_discount_total || bill.discount || 0), 0));
  const billDiscount = amount(bills.reduce((sum, bill) => sum + Number(bill.bill_discount_total || 0), 0));
  const taxable = amount(bills.reduce((sum, bill) => sum + Number(bill.taxable_amount ?? Math.max(0, Number(bill.gross_amount || bill.subtotal || 0) - Number(bill.line_discount_total || bill.discount || 0) - Number(bill.bill_discount_total || 0))), 0));
  const tax = amount(bills.reduce((sum, bill) => sum + Number(bill.tax_amount || 0), 0));
  const rounding = amount(bills.reduce((sum, bill) => sum + Number(bill.rounding_adjustment || 0), 0));
  const total = amount(bills.reduce((sum, bill) => sum + Number(bill.total_amount || 0), 0));
  const paid = amount(bills.reduce((sum, bill) => sum + Number(bill.paid_amount || 0), 0));
  const settlementDiscount = amount(bills.reduce((sum, bill) => sum + Number(bill.settlement_discount_amount || 0), 0));
  const creditNotes = amount(bills.reduce((sum, bill) => sum + Number(bill.credit_note_amount || 0), 0));
  const encounterKeys = new Set(bills.map((bill) => appointmentIdFromBillSource(bill) || 'CASH'));
  const onlyEncounterKey = encounterKeys.size === 1 ? [...encounterKeys][0] : null;

  invoice.service_items = serviceItems;
  invoice.gross_amount = gross;
  invoice.subtotal = gross;
  invoice.line_discount_total = lineDiscount;
  invoice.bill_discount_total = billDiscount;
  invoice.discount = amount(lineDiscount + billDiscount);
  invoice.taxable_amount = taxable;
  invoice.tax = tax;
  invoice.rounding_adjustment = rounding;
  invoice.total = total;
  invoice.amount_paid = paid;
  invoice.settlement_discount_amount = settlementDiscount;
  invoice.credit_note_total = creditNotes;
  invoice.balance_due = amount(Math.max(0, total - paid - settlementDiscount - creditNotes));
  invoice.invoice_type = serviceItems.some((item) => item.service_type !== 'Consultation') ? 'Mixed' : 'Appointment';
  invoice.appointment_id = onlyEncounterKey && onlyEncounterKey !== 'CASH' ? onlyEncounterKey : undefined;
  const existingEncounterSnapshot = invoice.encounter_snapshot?.toObject?.() || invoice.encounter_snapshot || {};
  if (!(existingEncounterSnapshot.doctorId || existingEncounterSnapshot.doctorName || existingEncounterSnapshot.departmentId || existingEncounterSnapshot.departmentName)) {
    const billEncounterSnapshot = bills
      .map((bill) => bill.encounter_snapshot || bill.items?.find((item) => item?.source_snapshot?.encounterSnapshot)?.source_snapshot?.encounterSnapshot)
      .find((snapshot) => snapshot && (snapshot.doctorId || snapshot.doctorName || snapshot.departmentId || snapshot.departmentName));
    if (billEncounterSnapshot) invoice.encounter_snapshot = billEncounterSnapshot;
  }
  const discountApprovalPending = bills.some(isDiscountApprovalPendingBill);
  invoice.status = invoice.balance_due <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Pending';
  invoice.print_snapshot = {
    ...(invoice.print_snapshot?.toObject?.() || invoice.print_snapshot || {}),
    billNumbers: bills.map((bill) => bill.bill_number),
    aggregateScope: encounterKeys.size === 1 && onlyEncounterKey !== 'CASH' ? 'OPD_APPOINTMENT' : 'OPD_PATIENT',
    appointmentId: encounterKeys.size === 1 && onlyEncounterKey !== 'CASH' ? onlyEncounterKey : undefined,
    discountApprovalPending
  };
  Object.assign(invoice, clinicalFlagsFromServiceItems(serviceItems));
  await invoice.save(sessionOptions(session));
  return invoice;
}

async function applyToBill(bill, paymentAmount, discountAmount, payload, receiptNumber, user, session) {
  if (discountAmount) {
    bill.settlement_discount_amount = amount(Number(bill.settlement_discount_amount || 0) + discountAmount);
    bill.discount_reason = payload.settlementDiscountReason;
  }
  if (paymentAmount) {
    bill.paid_amount = amount(Number(bill.paid_amount || 0) + paymentAmount);
    bill.payment_method = payload.paymentMethod || 'Cash';
    bill.payments = bill.payments || [];
    bill.payments.push({ method: payload.paymentMethod || 'Cash', amount: paymentAmount, reference: receiptNumber || payload.reference, date: operationNow() });
  }
  await bill.save(sessionOptions(session));
}

async function previewOPDPayment(patientId, payload, user) {
  const { patient, hospitalId } = await findPatient(patientId, user);
  const discountRequested = amount(payload.settlementDiscountAmount);
  const taxAdjustment = amount(payload.taxAdjustmentAmount);
  const amountTendered = amount(payload.amountTendered ?? payload.amount);
  const amountAppliedRequested = amount(payload.amountApplied ?? payload.amount);

  const invoiceFilter = {
    hospital_id: hospitalId, patient_id: patient._id, is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Refunded', 'Discount Pending Approval'] }, document_stage: { $ne: 'VOID' }, balance_due: { $gt: 0 },
    $or: [{ admission_id: { $exists: false } }, { admission_id: null }]
  };
  const billFilter = {
    hospital_id: hospitalId, patient_id: patient._id, is_deleted: { $ne: true }, status: { $ne: 'Discount Pending Approval' }, balance_due: { $gt: 0 },
    $and: [
      { $or: [{ admission_id: { $exists: false } }, { admission_id: null }] },
      { $or: [{ invoice_id: { $exists: false } }, { invoice_id: null }] },
      { $or: [{ invoice_ids: { $exists: false } }, { invoice_ids: { $size: 0 } }] }
    ]
  };
  if (payload.appointmentId) {
    scopeBillFilterToAppointment(billFilter, payload.appointmentId);
  }
  if (payload.invoiceId) {
    const requestedInvoice = await Invoice.findOne({ _id: payload.invoiceId, hospital_id: hospitalId, patient_id: patient._id }).lean();
    if (payload.appointmentId && requestedInvoice && !(await invoiceBelongsToAppointment(requestedInvoice, payload.appointmentId, { hospitalId, patientId: patient._id }))) {
      throw financialError('The selected invoice does not belong to this appointment.', 409, 'OPD_ENCOUNTER_MISMATCH');
    }
    if (requestedInvoice && await invoiceHasPendingDiscount({ hospitalId, patientId: patient._id, invoiceId: requestedInvoice._id })) {
      throw financialError('This invoice contains a bill waiting for discount approval. Collect the final payment after the approval decision is posted.', 409, 'DISCOUNT_APPROVAL_PENDING');
    }
    invoiceFilter._id = payload.invoiceId;
  }
  let billResolvedInvoice = null;
  if (payload.billId) {
    const resolved = await resolveRequestedBillToInvoice({
      billId: payload.billId,
      hospitalId,
      patientId: patient._id,
      appointmentId: payload.appointmentId
    });
    billResolvedInvoice = resolved.invoice;
    if (billResolvedInvoice) invoiceFilter._id = billResolvedInvoice._id;
    else billFilter._id = payload.billId;
  }
  let invoices = (payload.billId && !billResolvedInvoice) ? [] : await Invoice.find(invoiceFilter).sort({ issue_date: 1 });
  invoices = await scopeInvoicesToAppointment(invoices, payload.appointmentId, { hospitalId, patientId: patient._id });
  invoices = await excludePendingDiscountInvoices(invoices, { hospitalId, patientId: patient._id });
  const bills = (payload.invoiceId || billResolvedInvoice) ? [] : await Bill.find(billFilter).sort({ generated_at: 1 });
  if (!invoices.length && !bills.length) throw financialError('No outstanding OPD bill or invoice was found', 409, 'NO_OUTSTANDING_DOCUMENT');

  if (taxAdjustment !== 0) {
    throw financialError(
      'Tax is finalised during charge/invoice creation. Payment collection cannot rewrite tax on a financial document.',
      409,
      'PAYMENT_TAX_ADJUSTMENT_NOT_ALLOWED'
    );
  }

  const outstandingBefore = amount(
    invoices.reduce((sum, row) => sum + Number(row.balance_due || 0), 0) +
    bills.reduce((sum, row) => sum + Number(row.balance_due || 0), 0)
  );
  if (discountRequested > outstandingBefore + 0.01) {
    throw financialError('Settlement discount cannot exceed outstanding amount', 400, 'DISCOUNT_EXCEEDS_OUTSTANDING', { maximumAllowed: outstandingBefore });
  }
  const netPayable = amount(Math.max(0, outstandingBefore - discountRequested));
  const amountApplied = amount(Math.min(netPayable, Math.max(0, amountAppliedRequested)));
  const overpayment = amount(Math.max(0, amountAppliedRequested - netPayable));
  const changeReturned = payload.overpaymentDisposition === 'RETURN_CHANGE' ? overpayment : 0;
  const advanceCreated = payload.overpaymentDisposition === 'CREATE_ADVANCE' ? overpayment : 0;
  const warnings = [];
  if (overpayment > 0 && !payload.overpaymentDisposition) warnings.push({ code: 'OVERPAYMENT_DISPOSITION_REQUIRED', message: 'Choose return change or credit excess to patient advance.' });

  return {
    patientId: patient._id,
    outstandingBefore,
    taxAdjustment,
    settlementDiscount: discountRequested,
    netPayable,
    amountTendered,
    requestedAmountApplied: amountAppliedRequested,
    amountApplied,
    overpayment,
    changeReturned,
    advanceCreated,
    balanceAfter: amount(Math.max(0, netPayable - amountApplied)),
    maximumAllowed: netPayable,
    suggestedAmount: netPayable,
    canSubmit: overpayment <= 0 || Boolean(payload.overpaymentDisposition),
    warnings
  };
}

async function syncOPDClinicalFinancialClearance({ patientId, appointmentId, user }) {
  const hospitalId = assertUserHospital(user);
  const LabRequest = require('../models/LabRequest');
  const RadiologyRequest = require('../models/RadiologyRequest');
  const ProcedureRequest = require('../models/ProcedureRequest');
  // Lazy-load to avoid the existing chargePosting -> patientFinancial import cycle.
  const { getSourceFinancialStatus } = require('./chargePosting.service');
  const financialUser = user?.hospital_id ? user : { ...user, hospital_id: hospitalId };

  const encounterFilter = {
    hospitalId,
    patientId,
    sourceType: 'OPD',
    ...(appointmentId ? { appointmentId } : {})
  };
  const sources = [
    ['LabRequest', LabRequest],
    ['RadiologyRequest', RadiologyRequest],
    ['ProcedureRequest', ProcedureRequest]
  ];

  const failures = [];
  for (const [sourceModule, Model] of sources) {
    const requests = await Model.find(encounterFilter).select('_id').lean();
    for (const request of requests) {
      try {
        await getSourceFinancialStatus({ sourceModule, sourceId: request._id, user: financialUser });
      } catch (error) {
        // Payment itself is already committed. Keep the source synchronisation
        // retryable rather than falsely reporting that money collection failed.
        failures.push({ sourceModule, sourceId: request._id, message: error.message });
      }
    }
  }
  return failures;
}

async function recordOPDPayment(patientId, payload, user) {
  const settlement = await runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    const settlementPreview = await previewOPDPayment(patientId, payload, user);
    const requestedAmount = amount(payload.amountApplied ?? payload.amount);
    const discountRequested = amount(payload.settlementDiscountAmount);
    const taxAdjustment = amount(payload.taxAdjustmentAmount);
    if (requestedAmount < 0 || discountRequested < 0) throw financialError('Amounts cannot be negative');
    if (requestedAmount <= 0 && discountRequested <= 0) throw financialError('Enter a payment or settlement discount');
    if (discountRequested > 0 && !String(payload.settlementDiscountReason || '').trim()) throw financialError('Settlement discount reason is required');
    if (taxAdjustment !== 0) {
      throw financialError(
        'Tax is finalised during charge/invoice creation. Payment collection cannot rewrite tax on a financial document.',
        409,
        'PAYMENT_TAX_ADJUSTMENT_NOT_ALLOWED'
      );
    }
    const paymentMethod = payload.paymentMethod || 'Cash';
    if (!PAYMENT_METHODS.includes(paymentMethod)) throw financialError('Unsupported payment method');

    if (payload.idempotencyKey) {
      const idempotencyPattern = new RegExp(`^${String(payload.idempotencyKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::|$)`);
      const existingTransactions = await FinancialTransaction.find(
        { idempotencyKey: { $regex: idempotencyPattern } },
        null,
        sessionOptions(session)
      ).sort({ createdAt: 1 });
      if (existingTransactions.length) {
        return {
          receiptNumber: existingTransactions[0].transactionNumber,
          transactions: existingTransactions,
          alreadyExists: true
        };
      }
    }

    const invoiceFilter = {
      hospital_id: hospitalId,
      patient_id: patient._id,
      is_deleted: { $ne: true },
      status: { $nin: ['Cancelled', 'Refunded', 'Discount Pending Approval'] },
      document_stage: { $ne: 'VOID' },
      balance_due: { $gt: 0 },
      $or: [{ admission_id: { $exists: false } }, { admission_id: null }]
    };
    const billFilter = {
      hospital_id: hospitalId,
      patient_id: patient._id,
      is_deleted: { $ne: true },
      status: { $ne: 'Discount Pending Approval' },
      balance_due: { $gt: 0 },
      $and: [
        { $or: [{ admission_id: { $exists: false } }, { admission_id: null }] },
        { $or: [{ invoice_id: { $exists: false } }, { invoice_id: null }] },
        { $or: [{ invoice_ids: { $exists: false } }, { invoice_ids: { $size: 0 } }] }
      ]
    };
    if (payload.appointmentId) {
      scopeBillFilterToAppointment(billFilter, payload.appointmentId);
    }
    if (payload.invoiceId) {
      const requestedInvoice = await Invoice.findOne({ _id: payload.invoiceId, hospital_id: hospitalId, patient_id: patient._id }, null, sessionOptions(session));
      if (payload.appointmentId && requestedInvoice && !(await invoiceBelongsToAppointment(requestedInvoice, payload.appointmentId, { hospitalId, patientId: patient._id, session }))) {
        throw financialError('The selected invoice does not belong to this appointment.', 409, 'OPD_ENCOUNTER_MISMATCH');
      }
      if (requestedInvoice && await invoiceHasPendingDiscount({ hospitalId, patientId: patient._id, invoiceId: requestedInvoice._id, session })) {
        throw financialError('This invoice contains a bill waiting for discount approval. Collect the final payment after the approval decision is posted.', 409, 'DISCOUNT_APPROVAL_PENDING');
      }
      invoiceFilter._id = payload.invoiceId;
    }
    let billResolvedInvoice = null;
    if (payload.billId) {
      const resolved = await resolveRequestedBillToInvoice({
        billId: payload.billId,
        hospitalId,
        patientId: patient._id,
        appointmentId: payload.appointmentId,
        session
      });
      billResolvedInvoice = resolved.invoice;
      if (billResolvedInvoice) invoiceFilter._id = billResolvedInvoice._id;
      else billFilter._id = payload.billId;
    }
    let invoices = (payload.billId && !billResolvedInvoice) ? [] : await Invoice.find(invoiceFilter, null, sessionOptions(session)).sort({ issue_date: 1 });
    invoices = await scopeInvoicesToAppointment(invoices, payload.appointmentId, { hospitalId, patientId: patient._id, session });
    invoices = await excludePendingDiscountInvoices(invoices, { hospitalId, patientId: patient._id, session });
    let bills = (payload.invoiceId || billResolvedInvoice) ? [] : await Bill.find(billFilter, null, sessionOptions(session)).sort({ generated_at: 1 });
    if (!invoices.length && !bills.length) throw financialError('No outstanding OPD bill or invoice was found', 409, 'NO_OUTSTANDING_DOCUMENT');
    const outstandingBefore = amount(
      invoices.reduce((sum, row) => sum + Number(row.balance_due || 0), 0) +
      bills.reduce((sum, row) => sum + Number(row.balance_due || 0), 0)
    );
    if (discountRequested > 0) {
      await resolveFinancialPolicy({
        hospitalId,
        user,
        encounterType: 'OPD',
        serviceType: 'SETTLEMENT',
        serviceCode: 'OPD-SETTLEMENT',
        payerCategory: 'SELF',
        patientLiability: outstandingBefore,
        sponsorLiability: 0,
        contractedAmount: outstandingBefore,
        adjustments: {
          discountType: 'fixed',
          discountAmount: discountRequested,
          discountReason: payload.settlementDiscountReason
        }
      });
    }
    if (discountRequested > outstandingBefore + 0.01) throw financialError('Settlement discount cannot exceed outstanding amount');
    if (requestedAmount > outstandingBefore - discountRequested + 0.01) throw financialError(
      'Payment cannot exceed outstanding amount after discount', 409, 'PAYMENT_EXCEEDS_NET_PAYABLE',
      { maximumAllowed: settlementPreview.maximumAllowed, effectiveOutstanding: settlementPreview.netPayable, suggestedAmount: settlementPreview.suggestedAmount }
    );

    const receiptNumber = await nextFinancialNumber({ documentType: 'RECEIPT', hospitalId, session });
    let remainingDiscount = discountRequested;
    let remainingPayment = requestedAmount;
    const transactions = [];

    if (paymentMethod === 'OPDAdvance' && requestedAmount > 0) {
      const available = await getOPDAdvanceBalance({ hospitalId, patientId: patient._id, session });
      if (requestedAmount > available + 0.01) throw financialError(`Insufficient OPD advance. Available ₹${available.toFixed(2)}`, 409);
      const nextBalance = amount(available - requestedAmount);
      await PatientAdvanceLedger.create([{
        hospitalId, patientId: patient._id, walletType: 'OPD_SHARED', transactionType: 'OUTSTANDING_SETTLEMENT_DEBIT',
        direction: 'DEBIT', amount: requestedAmount, openingBalance: available, paymentMethod: 'OPDAdvance',
        referenceNumber: receiptNumber, documentType: 'Invoice', sourceModule: 'OPD', sourceId: patient._id,
        balanceAfter: nextBalance, notes: payload.notes || 'OPD advance utilised', createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:advance` : undefined
      }], sessionOptions(session));
    }

    const documents = [
      ...invoices.map((document) => ({ type: 'invoice', document })),
      ...bills.map((document) => ({ type: 'bill', document }))
    ];

    for (const row of documents) {
      const document = row.document;
      const due = amount(document.balance_due);
      const discountPart = amount(Math.min(Math.max(0, due), remainingDiscount));
      remainingDiscount = amount(remainingDiscount - discountPart);
      const availableAfterDiscount = amount(Math.max(0, due - discountPart));
      const paymentPart = amount(Math.min(availableAfterDiscount, remainingPayment));
      remainingPayment = amount(remainingPayment - paymentPart);

      let documentAllocations = [];
      if (row.type === 'invoice') {
        if (discountPart) {
          document.settlement_discount_amount = amount(Number(document.settlement_discount_amount || 0) + discountPart);
          document.discount_details = { type: 'fixed', reason: payload.settlementDiscountReason, approved_by: payload.discountApprovedBy || user?._id, approved_at: operationNow() };
        }
        if (paymentPart) {
          document.amount_paid = amount(Number(document.amount_paid || 0) + paymentPart);
          document.payment_history = document.payment_history || [];
          document.payment_history.push({
            date: operationNow(), amount: paymentPart, method: paymentMethod, reference: payload.reference,
            status: 'Completed', collected_by: user?._id, transaction_id: receiptNumber,
            receipt_number: receiptNumber, receipt_type: payload.receiptType || 'Payment',
            amount_before_settlement: outstandingBefore, settlement_discount_amount: discountPart,
            settlement_discount_reason: payload.settlementDiscountReason,
            settlement_discount_approved_by: discountPart ? (payload.discountApprovedBy || user?._id) : undefined,
            advance_applied: paymentMethod === 'OPDAdvance' ? paymentPart : 0,
            balance_after: amount(availableAfterDiscount - paymentPart),
            payment_breakdown: [{ method: paymentMethod, amount: paymentPart, reference: payload.reference }]
          });
        }
        document.receipt_numbers = Array.from(new Set([...(document.receipt_numbers || []), receiptNumber]));
        if (paymentMethod === 'OPDAdvance') document.advance_applied = amount(Number(document.advance_applied || 0) + paymentPart);
        await document.save(sessionOptions(session));

        let billPayment = paymentPart;
        let billDiscount = discountPart;
        documentAllocations = [];
        const linkedBills = await linkedBillsForInvoice(document, session);
        for (const linkedBill of linkedBills) {
          const linkedDue = amount(linkedBill.balance_due);
          const applyDiscount = amount(Math.min(linkedDue, billDiscount));
          billDiscount = amount(billDiscount - applyDiscount);
          const applyPayment = amount(Math.min(Math.max(0, linkedDue - applyDiscount), billPayment));
          billPayment = amount(billPayment - applyPayment);
          if (applyPayment > 0) {
            documentAllocations.push({ documentType: 'Bill', documentId: linkedBill._id, amount: applyPayment });
          }
          await applyToBill(linkedBill, applyPayment, applyDiscount, payload, receiptNumber, user, session);
        }
        if (paymentPart > 0 && !documentAllocations.length) {
          documentAllocations.push({ documentType: 'Invoice', documentId: document._id, amount: paymentPart });
        }
      } else {
        documentAllocations = paymentPart > 0
          ? [{ documentType: 'Bill', documentId: document._id, amount: paymentPart }]
          : [];
        await applyToBill(document, paymentPart, discountPart, payload, receiptNumber, user, session);
      }

      if (paymentPart > 0) {
        const receiptSummary = {
          originalAmount: due,
          discountAmount: discountPart,
          discountPercent: due > 0 ? amount((discountPart / due) * 100) : 0,
          netPayable: availableAfterDiscount
        };
        const usesAdvance = paymentMethod === 'OPDAdvance';
        const externalReceived = usesAdvance ? 0 : paymentPart;
        const transaction = new FinancialTransaction({
          hospitalId, patientId: patient._id,
          billId: row.type === 'bill' ? document._id : document.bill_id,
          invoiceId: row.type === 'invoice' ? document._id : undefined,
          transactionNumber: receiptNumber,
          transactionType: usesAdvance ? 'ADVANCE_UTILISATION' : 'RECEIPT',
          direction: 'CREDIT', amount: paymentPart, paymentMethod, paymentReference: payload.reference,
          receiptType: payload.receiptType || 'Payment', amountBeforeSettlement: outstandingBefore,
          settlementDiscountAmount: discountPart, settlementDiscountReason: payload.settlementDiscountReason,
          settlementDiscountApprovedBy: discountPart ? (payload.discountApprovedBy || user?._id) : undefined,
          advanceApplied: usesAdvance ? paymentPart : 0,
          amountReceived: externalReceived,
          amountTendered: externalReceived,
          amountApplied: paymentPart,
          externalMoneyMovement: !usesAdvance,
          cashFlowClass: usesAdvance ? 'WALLET_UTILISATION' : 'EXTERNAL_COLLECTION',
          balanceAfter: amount(availableAfterDiscount - paymentPart),
          paymentBreakdown: [{ method: paymentMethod, amount: paymentPart, reference: payload.reference }],
          documentAllocations,
          sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED', remarks: payload.notes,
          createdBy: user?._id,
          idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:${row.type}:${document._id}` : undefined,
          metadata: { receiptSummary, externalReceived }
        });
        await transaction.save(sessionOptions(session));
        transactions.push(transaction);
      }
      if (discountPart > 0) {
        const adjustment = new FinancialTransaction({
          hospitalId, patientId: patient._id,
          billId: row.type === 'bill' ? document._id : document.bill_id,
          invoiceId: row.type === 'invoice' ? document._id : undefined,
          transactionNumber: receiptNumber,
          transactionType: 'SETTLEMENT', direction: 'CREDIT', amount: discountPart,
          paymentMethod: 'Adjustment', receiptType: 'Adjustment', amountBeforeSettlement: outstandingBefore,
          settlementDiscountAmount: discountPart, settlementDiscountReason: payload.settlementDiscountReason,
          settlementDiscountApprovedBy: payload.discountApprovedBy || user?._id,
          // A settlement concession reduces receivable liability but does not
          // represent money entering the hospital. Be explicit instead of
          // relying on FinancialTransaction's external-money defaults.
          externalMoneyMovement: false,
          cashFlowClass: 'NON_CASH_ADJUSTMENT',
          amountTendered: 0,
          amountApplied: 0,
          amountReceived: 0, balanceAfter: amount(availableAfterDiscount - paymentPart),
          documentAllocations: [{ documentType: row.type === 'invoice' ? 'Invoice' : 'Bill', documentId: document._id, amount: discountPart }],
          sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED', remarks: payload.settlementDiscountReason,
          createdBy: user?._id,
          idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:discount:${row.type}:${document._id}` : undefined
        });
        await adjustment.save(sessionOptions(session));
        transactions.push(adjustment);
      }
      if (remainingPayment <= 0 && remainingDiscount <= 0) break;
    }
    if (remainingPayment > 0.01 || remainingDiscount > 0.01) {
      throw financialError('The requested settlement could not be fully allocated. Refresh the workspace and try again.', 409);
    }

    let changeReturned = settlementPreview.changeReturned || 0;
    let advanceCreated = 0;
    if (settlementPreview.advanceCreated > 0) {
      advanceCreated = amount(settlementPreview.advanceCreated);
      const openingAdvance = await getOPDAdvanceBalance({ hospitalId, patientId: patient._id, session });
      const balanceAfterAdvance = amount(openingAdvance + advanceCreated);
      await PatientAdvanceLedger.create([{
        hospitalId, patientId: patient._id, walletType: 'OPD_SHARED', transactionType: 'ADVANCE_DEPOSIT',
        direction: 'CREDIT', amount: advanceCreated, openingBalance: openingAdvance, paymentMethod,
        referenceNumber: receiptNumber, documentType: 'Receipt', sourceModule: 'OPD', sourceId: patient._id,
        balanceAfter: balanceAfterAdvance, notes: payload.notes || 'Excess payment credited to OPD advance',
        createdBy: user?._id, idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:excess-advance-ledger` : undefined
      }], sessionOptions(session));
      const advanceTransaction = new FinancialTransaction({
        hospitalId, patientId: patient._id, transactionNumber: receiptNumber,
        transactionType: 'ADVANCE_DEPOSIT', direction: 'CREDIT', amount: advanceCreated,
        paymentMethod, paymentReference: payload.reference, receiptType: 'Advance', amountReceived: advanceCreated,
        amountTendered: advanceCreated, amountApplied: 0,
        externalMoneyMovement: true, cashFlowClass: 'ADVANCE_RECEIPT',
        balanceAfter: balanceAfterAdvance, sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED',
        remarks: 'Excess settlement amount credited to OPD advance', createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:excess-advance` : undefined,
        metadata: { linkedReceiptNumber: receiptNumber, overpaymentDisposition: 'CREATE_ADVANCE' }
      });
      await advanceTransaction.save(sessionOptions(session));
      transactions.push(advanceTransaction);
    }
    return {
      receiptNumber,
      transactions,
      amountApplied: requestedAmount,
      amountTendered: settlementPreview.amountTendered,
      changeReturned,
      advanceCreated,
      receiptSummary: transactions.find((transaction) => transaction.metadata?.receiptSummary)?.metadata?.receiptSummary || null,
      alreadyExists: false
    };
  });

  const clearanceSyncFailures = await syncOPDClinicalFinancialClearance({
    patientId,
    appointmentId: payload.appointmentId,
    user
  });
  if (clearanceSyncFailures.length) settlement.clearanceSyncPending = clearanceSyncFailures;
  return settlement;
}

async function recordOPDAdvance(patientId, payload, user) {
  const deposit = amount(payload.amount);
  if (deposit <= 0) throw financialError('Advance amount must be greater than zero');
  const paymentMethod = payload.paymentMethod || 'Cash';
  if (!PAYMENT_METHODS.includes(paymentMethod) || paymentMethod === 'OPDAdvance') throw financialError('Unsupported advance payment method');
  return runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne({ idempotencyKey: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) return { receiptNumber: existing.transactionNumber, advanceBalance: existing.balanceAfter, alreadyExists: true };
    }
    const receiptNumber = await nextFinancialNumber({ documentType: 'ADVANCE_RECEIPT', hospitalId, session });
    const opening = await getOPDAdvanceBalance({ hospitalId, patientId: patient._id, session });
    const balanceAfter = amount(opening + deposit);
    await PatientAdvanceLedger.create([{
      hospitalId, patientId: patient._id, walletType: 'OPD_SHARED', transactionType: 'ADVANCE_DEPOSIT',
      direction: 'CREDIT', amount: deposit, openingBalance: opening, paymentMethod, referenceNumber: receiptNumber,
      documentType: 'Receipt', sourceModule: 'OPD', sourceId: patient._id, balanceAfter,
      notes: payload.notes || 'OPD patient advance received', createdBy: user?._id, idempotencyKey: payload.idempotencyKey
    }], sessionOptions(session));
    const transaction = new FinancialTransaction({
      hospitalId, patientId: patient._id, transactionNumber: receiptNumber, transactionType: 'ADVANCE_DEPOSIT',
      direction: 'CREDIT', amount: deposit, paymentMethod, paymentReference: payload.reference,
      receiptType: 'Advance', amountReceived: deposit, amountTendered: deposit, amountApplied: 0,
      externalMoneyMovement: true, cashFlowClass: 'ADVANCE_RECEIPT',
      balanceAfter, sourceModule: 'OPD', sourceId: patient._id,
      status: 'POSTED', remarks: payload.notes, createdBy: user?._id, idempotencyKey: payload.idempotencyKey,
      metadata: { walletType: 'OPD_SHARED' }
    });
    await transaction.save(sessionOptions(session));
    return { receiptNumber, transaction, advanceBalance: balanceAfter, alreadyExists: false };
  });
}

async function refundOPDAdvance(patientId, payload, user) {
  const refund = amount(payload.amount);
  if (refund <= 0) throw financialError('Refund amount must be greater than zero');
  if (!String(payload.reason || '').trim()) throw financialError('Refund reason is required');
  const paymentMethod = payload.paymentMethod || 'Cash';
  if (!EXTERNAL_PAYMENT_METHODS.has(paymentMethod)) {
    throw financialError('Advance refunds must use an external refund method such as Cash, Card, UPI or Bank');
  }

  return runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne({
        hospitalId,
        idempotencyKey: payload.idempotencyKey,
        transactionType: 'ADVANCE_REFUND'
      }, null, sessionOptions(session));
      if (existing) {
        return {
          refundNumber: existing.transactionNumber,
          transaction: existing,
          advanceBalance: existing.balanceAfter,
          alreadyExists: true
        };
      }
    }

    const opening = await getOPDAdvanceBalance({ hospitalId, patientId: patient._id, session });
    if (refund > opening + 0.01) {
      throw financialError(`Refund cannot exceed available OPD advance of ₹${opening.toFixed(2)}`, 409);
    }
    const refundNumber = await nextFinancialNumber({ documentType: 'ADVANCE_REFUND', hospitalId, session });
    const balanceAfter = amount(opening - refund);

    await PatientAdvanceLedger.create([{
      hospitalId,
      patientId: patient._id,
      walletType: 'OPD_SHARED',
      transactionType: 'REFUND_PAID',
      direction: 'DEBIT',
      amount: refund,
      openingBalance: opening,
      paymentMethod,
      referenceNumber: refundNumber,
      documentType: 'Refund',
      sourceModule: 'OPD',
      sourceId: patient._id,
      balanceAfter,
      notes: payload.reason.trim(),
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey
    }], sessionOptions(session));

    const transaction = new FinancialTransaction({
      hospitalId,
      patientId: patient._id,
      transactionNumber: refundNumber,
      transactionType: 'ADVANCE_REFUND',
      direction: 'DEBIT',
      amount: refund,
      paymentMethod,
      paymentReference: payload.reference,
      receiptType: 'Refund',
      amountReceived: 0,
      amountTendered: 0,
      amountApplied: 0,
      externalMoneyMovement: true,
      cashFlowClass: 'REFUND',
      balanceAfter,
      sourceModule: 'OPD',
      sourceId: patient._id,
      status: 'POSTED',
      remarks: payload.reason.trim(),
      createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey,
      metadata: { walletType: 'OPD_SHARED', walletOpeningBalance: opening, walletBalanceAfter: balanceAfter }
    });
    await transaction.save(sessionOptions(session));
    return { refundNumber, transaction, advanceBalance: balanceAfter, alreadyExists: false };
  });
}

module.exports = {
  calculateLineAmounts,
  billServiceItems,
  clinicalFlagsFromServiceItems,
  resolveRequestedBillToInvoice,
  rejectOPDBillDiscount,
  getPatientWorkspace,
  syncOPDInvoiceFromBills,
  addOPDCharge,
  issueOPDInvoice,
  previewOPDPayment,
  recordOPDPayment,
  recordOPDAdvance,
  refundOPDAdvance
};
