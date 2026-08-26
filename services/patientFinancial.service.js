const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const Hospital = require('../models/Hospital');
const FinancialTransaction = require('../models/FinancialTransaction');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const billingPatientService = require('./billingPatient.service');
const { money, nextFinancialNumber } = require('../utils/financeNumbers');
const { assertUserHospital } = require('../utils/hospitalScope');
const { quotePricing, pricingSnapshot, serviceTypeFromCharge } = require('./pricingEngine.service');
const { activeAppointmentCoverage } = require('./coverage.service');
const { activatePackageEpisode, recordPackageUtilization } = require('./packageAdjudication.service');
const { replaceCoverageUtilization } = require('./coverageUtilization.service');
const { resolveFinancialPolicy } = require('./financialPolicy.service');
const { _hasActionPermission } = require('../middlewares/auth');

const PAYMENT_METHODS = [
  'Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme',
  'Bank', 'OPDAdvance', 'Adjustment'
];

const sessionOptions = (session) => (session ? { session } : {});
const id = (value) => String(value?._id || value || '');
const amount = (value) => money(Number(value || 0));

function financialError(message, statusCode = 400, code = 'FINANCIAL_VALIDATION_ERROR', details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function calculateLineAmounts(payload = {}) {
  const quantity = Number(payload.quantity || 1);
  const rate = amount(payload.rate);
  if (!Number.isFinite(quantity) || quantity <= 0) throw financialError('Quantity must be greater than zero');
  if (rate < 0) throw financialError('Rate cannot be negative');

  const gross = amount(quantity * rate);
  const discountType = payload.discountType === 'percentage' ? 'percentage' : 'fixed';
  const discountRate = amount(payload.discountRate);
  let discountAmount = amount(payload.discountAmount);
  if (discountType === 'percentage') {
    discountAmount = amount(gross * Math.max(0, Math.min(100, discountRate)) / 100);
  } else {
    discountAmount = Math.max(0, Math.min(gross, discountAmount));
  }

  const afterDiscount = amount(gross - discountAmount);
  const taxMode = ['inclusive', 'exempt'].includes(payload.taxMode) ? payload.taxMode : 'exclusive';
  const taxRate = taxMode === 'exempt' ? 0 : Math.max(0, Number(payload.taxRate || 0));
  if (taxRate > 100) throw financialError('Tax rate cannot exceed 100%');

  let taxableAmount = afterDiscount;
  let taxAmount = 0;
  let netAmount = afterDiscount;
  if (taxMode === 'inclusive' && taxRate > 0) {
    taxableAmount = amount(afterDiscount / (1 + taxRate / 100));
    taxAmount = amount(afterDiscount - taxableAmount);
  } else if (taxMode === 'exclusive' && taxRate > 0) {
    taxAmount = amount(taxableAmount * taxRate / 100);
    netAmount = amount(taxableAmount + taxAmount);
  }

  return {
    quantity,
    rate,
    grossAmount: gross,
    discountType,
    discountRate,
    discountAmount,
    taxableAmount,
    taxMode,
    taxRate,
    taxAmount,
    netAmount
  };
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

async function getPatientWorkspace(patientId, user) {
  const hospitalId = assertUserHospital(user);
  return billingPatientService.getPatientBillingDetails({ hospitalId, patientId, admissionId: null });
}

async function addOPDCharge(patientId, payload, user) {
  return runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    if (payload.idempotencyKey) {
      const existing = await Bill.findOne({ hospital_id: hospitalId, idempotency_key: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) {
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
    const cashLine = calculateLineAmounts(payload);
    if (!String(payload.description || '').trim()) throw financialError('Charge description is required');

    const appointmentId = payload.appointmentId || null;
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
          taxExemptionReason: payload.taxExemptionReason || '',
          createdFrom: payload.createdFrom || 'OPDRevenueWorkspace',
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
  return (bill.items || []).map((item) => {
    const quantity = Number(item.quantity || 1);
    const gross = amount(item.gross_amount || (Number(item.unit_price || 0) * quantity) || item.amount);
    const discount = amount(item.discount_amount);
    const tax = amount(item.tax_amount);
    const taxable = amount(item.taxable_amount || Math.max(0, gross - discount));
    const net = amount(item.net_amount || item.amount || taxable + tax);
    const rawType = String(item.item_type || 'Other');
    const serviceType = ['Consultation', 'Procedure', 'Lab Test', 'Radiology', 'Purchase'].includes(rawType) ? rawType : 'Other';
    return {
      description: item.description || 'OPD charge',
      charge_type: item.charge_type || rawType,
      charge_head: item.charge_head || item.charge_type || rawType,
      charge_date: item.charge_date || bill.generated_at,
      quantity,
      unit_price: amount(item.unit_price || (quantity ? gross / quantity : gross)),
      gross_amount: gross,
      standard_amount: gross,
      contracted_amount: gross,
      sponsor_liability: 0,
      patient_liability: net,
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
    if (Array.isArray(payload.billIds) && payload.billIds.length) filter._id = { $in: payload.billIds };
    const bills = await Bill.find(filter, null, sessionOptions(session)).sort({ generated_at: 1, createdAt: 1 });
    if (!bills.length) throw financialError('There are no uninvoiced OPD bills for this patient', 409);

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
    const invoiceNumber = await nextFinancialNumber({ documentType: 'INVOICE', hospitalId, session });
    const hospital = await Hospital.findById(hospitalId, null, sessionOptions(session)).lean();
    const now = operationNow();
    const invoice = new Invoice({
      hospital_id: hospitalId,
      invoice_number: invoiceNumber,
      patient_id: patient._id,
      customer_type: 'Patient',
      customer_name: [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') || patient.name || 'Patient',
      customer_phone: patient.phone || patient.mobile || '',
      appointment_id: bills.find((bill) => bill.appointment_id)?.appointment_id,
      bill_id: bills[0]._id,
      bill_ids: bills.map((bill) => bill._id),
      invoice_type: serviceItems.some((item) => item.service_type !== 'Consultation') ? 'Mixed' : 'Appointment',
      document_stage: 'ISSUED',
      issued_at: now,
      issue_date: now,
      due_date: new Date(now.getTime() + (Number(payload.dueInDays ?? 7) * 86400000)),
      service_items: serviceItems,
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
      status: bills.some((bill) => bill.status === 'Discount Pending Approval')
        ? 'Discount Pending Approval'
        : (total - paid - settlementDiscount - creditNotes <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Pending'),
      notes: payload.notes || `Consolidated OPD invoice for ${bills.length} bill(s)`,
      idempotency_key: payload.idempotencyKey,
      created_by: user?._id,
      patient_snapshot: patient.toObject ? patient.toObject() : patient,
      hospital_snapshot: hospital || {},
      print_snapshot: { billNumbers: bills.map((bill) => bill.bill_number), aggregateScope: 'OPD_PATIENT' }
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

async function applyToBill(bill, paymentAmount, discountAmount, taxAdjustment, payload, receiptNumber, user, session) {
  if (taxAdjustment) {
    bill.tax_amount = amount(Number(bill.tax_amount || 0) + taxAdjustment);
    bill.total_amount = amount(Number(bill.total_amount || 0) + taxAdjustment);
  }
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
    status: { $nin: ['Cancelled', 'Refunded'] }, document_stage: { $ne: 'VOID' }, balance_due: { $gt: 0 },
    $or: [{ admission_id: { $exists: false } }, { admission_id: null }]
  };
  const billFilter = {
    hospital_id: hospitalId, patient_id: patient._id, is_deleted: { $ne: true }, balance_due: { $gt: 0 },
    $and: [
      { $or: [{ admission_id: { $exists: false } }, { admission_id: null }] },
      { $or: [{ invoice_id: { $exists: false } }, { invoice_id: null }] },
      { $or: [{ invoice_ids: { $exists: false } }, { invoice_ids: { $size: 0 } }] }
    ]
  };
  if (payload.invoiceId) invoiceFilter._id = payload.invoiceId;
  if (payload.billId) billFilter._id = payload.billId;
  const invoices = payload.billId ? [] : await Invoice.find(invoiceFilter).sort({ issue_date: 1 });
  const bills = payload.invoiceId ? [] : await Bill.find(billFilter).sort({ generated_at: 1 });
  if (!invoices.length && !bills.length) throw financialError('No outstanding OPD bill or invoice was found', 409, 'NO_OUTSTANDING_DOCUMENT');

  if (taxAdjustment !== 0 && invoices.length + bills.length !== 1) {
    throw financialError(
      'Select one bill or invoice for a tax adjustment',
      400,
      'TAX_ADJUSTMENT_DOCUMENT_REQUIRED'
    );
  }

  if (taxAdjustment !== 0) {
    const taxTarget = invoices[0] || bills[0];
    const currentTax = amount(invoices.length ? taxTarget.tax : taxTarget.tax_amount);
    if (taxAdjustment < 0 && Math.abs(taxAdjustment) > currentTax + 0.01) {
      throw financialError(
        `Tax reduction cannot exceed the current tax amount of ₹${currentTax.toFixed(2)}`,
        400,
        'TAX_REDUCTION_EXCEEDS_DOCUMENT_TAX',
        { maximumReduction: currentTax }
      );
    }
    if (amount(Number(taxTarget.total || taxTarget.total_amount || 0) + taxAdjustment) < 0) {
      throw financialError(
        'Tax adjustment cannot make the document total negative',
        400,
        'INVALID_TAX_ADJUSTMENT'
      );
    }
  }

  const outstandingBefore = amount(
    invoices.reduce((sum, row) => sum + Number(row.balance_due || 0), 0) +
    bills.reduce((sum, row) => sum + Number(row.balance_due || 0), 0)
  );
  const effectiveOutstanding = amount(outstandingBefore + taxAdjustment);
  if (effectiveOutstanding < 0) throw financialError('Tax adjustment cannot reduce outstanding below zero', 400, 'INVALID_TAX_ADJUSTMENT');
  if (discountRequested > effectiveOutstanding + 0.01) {
    throw financialError('Settlement discount cannot exceed outstanding amount', 400, 'DISCOUNT_EXCEEDS_OUTSTANDING', { maximumAllowed: effectiveOutstanding });
  }
  const netPayable = amount(Math.max(0, effectiveOutstanding - discountRequested));
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

async function recordOPDPayment(patientId, payload, user) {
  return runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    const settlementPreview = await previewOPDPayment(patientId, payload, user);
    const requestedAmount = amount(payload.amountApplied ?? payload.amount);
    const discountRequested = amount(payload.settlementDiscountAmount);
    const taxAdjustment = amount(payload.taxAdjustmentAmount);
    if (requestedAmount < 0 || discountRequested < 0) throw financialError('Amounts cannot be negative');
    if (requestedAmount <= 0 && discountRequested <= 0 && taxAdjustment === 0) throw financialError('Enter a payment, discount or tax adjustment');
    if (discountRequested > 0 && !String(payload.settlementDiscountReason || '').trim()) throw financialError('Settlement discount reason is required');
    if (taxAdjustment !== 0 && !String(payload.taxAdjustmentReason || '').trim()) throw financialError('Tax adjustment reason is required');
    const paymentMethod = payload.paymentMethod || 'Cash';
    if (!PAYMENT_METHODS.includes(paymentMethod)) throw financialError('Unsupported payment method');

    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne({ idempotencyKey: { $regex: new RegExp(`^${String(payload.idempotencyKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::|$)`) } }, null, sessionOptions(session));
      if (existing) return { receiptNumber: existing.transactionNumber, alreadyExists: true };
    }

    const invoiceFilter = {
      hospital_id: hospitalId,
      patient_id: patient._id,
      is_deleted: { $ne: true },
      status: { $nin: ['Cancelled', 'Refunded'] },
      document_stage: { $ne: 'VOID' },
      balance_due: { $gt: 0 },
      $or: [{ admission_id: { $exists: false } }, { admission_id: null }]
    };
    const billFilter = {
      hospital_id: hospitalId,
      patient_id: patient._id,
      is_deleted: { $ne: true },
      balance_due: { $gt: 0 },
      $and: [
        { $or: [{ admission_id: { $exists: false } }, { admission_id: null }] },
        { $or: [{ invoice_id: { $exists: false } }, { invoice_id: null }] },
        { $or: [{ invoice_ids: { $exists: false } }, { invoice_ids: { $size: 0 } }] }
      ]
    };
    if (payload.invoiceId) invoiceFilter._id = payload.invoiceId;
    if (payload.billId) billFilter._id = payload.billId;
    let invoices = payload.billId ? [] : await Invoice.find(invoiceFilter, null, sessionOptions(session)).sort({ issue_date: 1 });
    let bills = payload.invoiceId ? [] : await Bill.find(billFilter, null, sessionOptions(session)).sort({ generated_at: 1 });
    if (!invoices.length && !bills.length) throw financialError('No outstanding OPD bill or invoice was found', 409);
    if (taxAdjustment !== 0 && invoices.length + bills.length !== 1) throw financialError('Select one bill or invoice for a tax adjustment');
    if (taxAdjustment !== 0) {
      const taxTarget = invoices[0] || bills[0];
      const currentTax = amount(invoices.length ? taxTarget.tax : taxTarget.tax_amount);
      if (taxAdjustment < 0 && Math.abs(taxAdjustment) > currentTax + 0.01) {
        throw financialError(`Tax reduction cannot exceed the current tax amount of ₹${currentTax.toFixed(2)}`);
      }
      if (amount(Number(taxTarget.total || taxTarget.total_amount || 0) + taxAdjustment) < 0) {
        throw financialError('Tax adjustment cannot make the document total negative');
      }
    }

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
    if (taxAdjustment !== 0 && !_hasActionPermission(user, 'tax_override')) {
      throw financialError('Tax adjustment requires dedicated tax override permission', 403, 'TAX_OVERRIDE_PERMISSION_REQUIRED');
    }
    if (taxAdjustment !== 0 && !String(payload.taxAdjustmentReason || payload.notes || '').trim()) {
      throw financialError('Tax adjustment reason is required', 400, 'TAX_OVERRIDE_REASON_REQUIRED');
    }
    const effectiveOutstanding = amount(outstandingBefore + taxAdjustment);
    if (effectiveOutstanding < 0) throw financialError('Tax adjustment cannot reduce the outstanding amount below zero');
    if (discountRequested > effectiveOutstanding + 0.01) throw financialError('Settlement discount cannot exceed outstanding amount');
    if (requestedAmount > effectiveOutstanding - discountRequested + 0.01) throw financialError(
      'Payment cannot exceed outstanding amount after discount', 409, 'PAYMENT_EXCEEDS_NET_PAYABLE',
      { maximumAllowed: settlementPreview.maximumAllowed, effectiveOutstanding: settlementPreview.netPayable, suggestedAmount: settlementPreview.suggestedAmount }
    );

    const receiptNumber = await nextFinancialNumber({ documentType: 'RECEIPT', hospitalId, session });
    let remainingDiscount = discountRequested;
    let remainingPayment = requestedAmount;
    let remainingTax = taxAdjustment;
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
      const taxPart = remainingTax !== 0 ? remainingTax : 0;
      remainingTax = 0;
      const discountPart = amount(Math.min(Math.max(0, due + taxPart), remainingDiscount));
      remainingDiscount = amount(remainingDiscount - discountPart);
      const availableAfterDiscount = amount(Math.max(0, due + taxPart - discountPart));
      const paymentPart = amount(Math.min(availableAfterDiscount, remainingPayment));
      remainingPayment = amount(remainingPayment - paymentPart);

      if (row.type === 'invoice') {
        if (taxPart) {
          document.tax = amount(Number(document.tax || 0) + taxPart);
          document.total = amount(Number(document.total || 0) + taxPart);
        }
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
        let billTax = taxPart;
        const linkedBills = await linkedBillsForInvoice(document, session);
        for (const linkedBill of linkedBills) {
          const linkedDue = amount(linkedBill.balance_due);
          const applyTax = billTax; billTax = 0;
          const applyDiscount = amount(Math.min(linkedDue + applyTax, billDiscount));
          billDiscount = amount(billDiscount - applyDiscount);
          const applyPayment = amount(Math.min(Math.max(0, linkedDue + applyTax - applyDiscount), billPayment));
          billPayment = amount(billPayment - applyPayment);
          await applyToBill(linkedBill, applyPayment, applyDiscount, applyTax, payload, receiptNumber, user, session);
        }
      } else {
        await applyToBill(document, paymentPart, discountPart, taxPart, payload, receiptNumber, user, session);
      }

      if (paymentPart > 0) {
        const transaction = new FinancialTransaction({
          hospitalId, patientId: patient._id,
          billId: row.type === 'bill' ? document._id : document.bill_id,
          invoiceId: row.type === 'invoice' ? document._id : undefined,
          transactionNumber: receiptNumber,
          transactionType: paymentMethod === 'OPDAdvance' ? 'ADVANCE_UTILISATION' : 'RECEIPT',
          direction: 'CREDIT', amount: paymentPart, paymentMethod, paymentReference: payload.reference,
          receiptType: payload.receiptType || 'Payment', amountBeforeSettlement: outstandingBefore,
          settlementDiscountAmount: discountPart, settlementDiscountReason: payload.settlementDiscountReason,
          settlementDiscountApprovedBy: discountPart ? (payload.discountApprovedBy || user?._id) : undefined,
          advanceApplied: paymentMethod === 'OPDAdvance' ? paymentPart : 0,
          amountReceived: paymentPart, balanceAfter: amount(availableAfterDiscount - paymentPart),
          paymentBreakdown: [{ method: paymentMethod, amount: paymentPart, reference: payload.reference }],
          sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED', remarks: payload.notes,
          createdBy: user?._id,
          idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:${row.type}:${document._id}` : undefined
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
          amountReceived: 0, balanceAfter: amount(availableAfterDiscount - paymentPart),
          sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED', remarks: payload.settlementDiscountReason,
          createdBy: user?._id,
          idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:discount:${row.type}:${document._id}` : undefined
        });
        await adjustment.save(sessionOptions(session));
        transactions.push(adjustment);
      }
      if (taxPart !== 0) {
        const taxTransaction = new FinancialTransaction({
          hospitalId, patientId: patient._id,
          billId: row.type === 'bill' ? document._id : document.bill_id,
          invoiceId: row.type === 'invoice' ? document._id : undefined,
          transactionNumber: receiptNumber,
          transactionType: 'ADJUSTMENT', direction: taxPart > 0 ? 'DEBIT' : 'CREDIT', amount: Math.abs(taxPart),
          paymentMethod: 'Adjustment', receiptType: 'Adjustment', amountBeforeSettlement: outstandingBefore,
          taxAdjustmentAmount: taxPart, amountReceived: 0,
          balanceAfter: amount(availableAfterDiscount - paymentPart),
          sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED', remarks: payload.taxAdjustmentReason,
          createdBy: user?._id,
          idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:tax:${row.type}:${document._id}` : undefined
        });
        await taxTransaction.save(sessionOptions(session));
        transactions.push(taxTransaction);
      }
      if (remainingPayment <= 0 && remainingDiscount <= 0 && remainingTax === 0) break;
    }
    if (remainingPayment > 0.01 || remainingDiscount > 0.01 || Math.abs(remainingTax) > 0.01) {
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
        balanceAfter: balanceAfterAdvance, sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED',
        remarks: 'Excess settlement amount credited to OPD advance', createdBy: user?._id,
        idempotencyKey: payload.idempotencyKey ? `${payload.idempotencyKey}:excess-advance` : undefined,
        metadata: { linkedReceiptNumber: receiptNumber, overpaymentDisposition: 'CREATE_ADVANCE' }
      });
      await advanceTransaction.save(sessionOptions(session));
      transactions.push(advanceTransaction);
    }
    return { receiptNumber, transactions, amountApplied: requestedAmount, amountTendered: settlementPreview.amountTendered, changeReturned, advanceCreated, alreadyExists: false };
  });
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
      receiptType: 'Advance', amountReceived: deposit, balanceAfter, sourceModule: 'OPD', sourceId: patient._id,
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
  return runTransaction(async (session) => {
    const { patient, hospitalId } = await findPatient(patientId, user, session);
    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne({ idempotencyKey: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) return { refundNumber: existing.transactionNumber, transaction: existing, advanceBalance: existing.balanceAfter, alreadyExists: true };
    }
    const opening = await getOPDAdvanceBalance({ hospitalId, patientId: patient._id, session });
    if (refund > opening + 0.01) throw financialError(`Refund cannot exceed available OPD advance of ₹${opening.toFixed(2)}`, 409);
    const refundNumber = await nextFinancialNumber({ documentType: 'ADVANCE_REFUND', hospitalId, session });
    const balanceAfter = amount(opening - refund);
    await PatientAdvanceLedger.create([{
      hospitalId, patientId: patient._id, walletType: 'OPD_SHARED', transactionType: 'REFUND_PAID',
      direction: 'DEBIT', amount: refund, openingBalance: opening, paymentMethod: payload.paymentMethod || 'Cash',
      referenceNumber: refundNumber, documentType: 'Refund', sourceModule: 'OPD', sourceId: patient._id,
      balanceAfter, notes: payload.reason.trim(), createdBy: user?._id,
      idempotencyKey: payload.idempotencyKey
    }], sessionOptions(session));
    const transaction = new FinancialTransaction({
      hospitalId, patientId: patient._id, transactionNumber: refundNumber, transactionType: 'ADVANCE_REFUND',
      direction: 'DEBIT', amount: refund, paymentMethod: payload.paymentMethod || 'Cash', paymentReference: payload.reference,
      receiptType: 'Refund', balanceAfter, sourceModule: 'OPD', sourceId: patient._id, status: 'POSTED',
      remarks: payload.reason.trim(), createdBy: user?._id, idempotencyKey: payload.idempotencyKey,
      metadata: { walletType: 'OPD_SHARED' }
    });
    await transaction.save(sessionOptions(session));
    return { refundNumber, transaction, advanceBalance: balanceAfter };
  });
}

module.exports = {
  calculateLineAmounts,
  getPatientWorkspace,
  addOPDCharge,
  issueOPDInvoice,
  previewOPDPayment,
  recordOPDPayment,
  recordOPDAdvance,
  refundOPDAdvance
};
