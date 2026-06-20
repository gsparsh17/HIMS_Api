const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const FinancialTransaction = require('../models/FinancialTransaction');
const Sale = require('../models/Sale');
const { money, nextFinancialNumber } = require('../utils/financeNumbers');

const ACTIVE_CHARGE_FILTER = { $or: [{ status: { $exists: false } }, { status: 'ACTIVE' }, { status: 'INVOICED' }] };
const UNBILLED_CHARGE_FILTER = { isBilled: false, $or: [{ status: { $exists: false } }, { status: 'ACTIVE' }] };
const FINANCE_PAYMENT_METHODS = ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'Bank', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment'];

function assertAmount(value, label = 'Amount') {
  const amount = money(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error(`${label} must be greater than zero`);
    error.statusCode = 400;
    throw error;
  }
  return amount;
}

function dateKey(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

function serviceTypeForCharge(chargeType) {
  if (chargeType === 'Consultation' || chargeType === 'Doctor Visit') return 'Consultation';
  if (chargeType === 'Procedure' || chargeType === 'Surgery') return 'Procedure';
  if (chargeType === 'Lab Test') return 'Lab Test';
  if (chargeType === 'Radiology') return 'Radiology';
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

function invoiceFilterForAdmission(admissionId) {
  // An admission may have legacy procedure/lab/radiology/pharmacy invoices as
  // well as new IPD Interim/Final invoices. Use admission_id as the source of
  // truth, then exclude non-revenue and reversed documents. Restricting this
  // to only IPD Interim/Final hides genuine legacy dues during clearance.
  return {
    admission_id: admissionId,
    is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Refunded'] },
    invoice_type: { $nin: ['Purchase', 'Credit Note'] },
    document_stage: { $ne: 'VOID' }
  };
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

async function findAdmission(admissionId, session) {
  const admission = await IPDAdmission.findById(admissionId, null, sessionOptions(session));
  if (!admission) {
    const error = new Error('Admission not found');
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

async function calculateAdmissionFinancials(admissionId, { session, persist = true } = {}) {
  const admission = await findAdmission(admissionId, session);
  const charges = await IPDCharge.find(
    { admissionId, ...ACTIVE_CHARGE_FILTER },
    null,
    sessionOptions(session)
  ).sort({ chargeDate: 1, createdAt: 1 });
  const unbilledCharges = charges.filter((charge) => !charge.isBilled && (charge.status === undefined || charge.status === 'ACTIVE'));
  const invoices = await Invoice.find(invoiceFilterForAdmission(admissionId), null, sessionOptions(session)).sort({ issue_date: 1, created_at: 1 });

  const totalChargeAmount = sumCharges(charges);
  const unbilledTotal = sumCharges(unbilledCharges);
  const invoicedGross = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0));
  const creditNotes = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.credit_note_total) || 0), 0));
  const invoicePaid = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.amount_paid) || 0), 0));
  const invoiceOutstanding = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.balance_due) || 0), 0));
  const overallDue = money(unbilledTotal + invoiceOutstanding);

  if (persist) {
    admission.totalBillAmount = totalChargeAmount;
    admission.invoicedAmount = money(invoicedGross - creditNotes);
    admission.paidAmount = invoicePaid;
    admission.dueAmount = overallDue;
    await admission.save(sessionOptions(session));
  }

  return {
    admission,
    charges,
    unbilledCharges,
    invoices,
    totalChargeAmount,
    unbilledTotal,
    invoicedGross,
    creditNotes,
    invoicePaid,
    invoiceOutstanding,
    overallDue,
    advanceAvailable: money(admission.advanceAmount || 0),
    advanceReceived: money(admission.advanceReceivedAmount || 0),
    advanceUtilized: money(admission.advanceUtilizedAmount || 0),
    advanceRefunded: money(admission.advanceRefundedAmount || 0)
  };
}

async function getRunningBill(admissionId) {
  const snapshot = await calculateAdmissionFinancials(admissionId);
  const admission = await IPDAdmission.findById(admissionId)
    .populate('patientId', 'first_name last_name patientId phone age gender')
    .populate('primaryDoctorId', 'firstName lastName specialization')
    .populate('departmentId', 'name');

  const receipts = await FinancialTransaction.find({ admissionId, status: 'POSTED' })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const advanceLedger = await PatientAdvanceLedger.find({ admissionId, status: 'POSTED' })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const unbilledChargesByDate = snapshot.unbilledCharges.reduce((accumulator, charge) => {
    const key = dateKey(charge.chargeDate);
    accumulator[key] = accumulator[key] || [];
    accumulator[key].push(charge);
    return accumulator;
  }, {});

  const billedCharges = snapshot.charges.filter((charge) => charge.isBilled);

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
      invoicedAmount: snapshot.invoicedGross,
      paidAmount: snapshot.invoicePaid,
      dueAmount: snapshot.overallDue,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      unbilledTotal: snapshot.unbilledTotal,
      advanceAmount: snapshot.advanceAvailable,
      advanceReceivedAmount: snapshot.advanceReceived,
      advanceUtilizedAmount: snapshot.advanceUtilized,
      advanceRefundedAmount: snapshot.advanceRefunded,
      patientId: admission.patientId,
      primaryDoctorId: admission.primaryDoctorId,
      departmentId: admission.departmentId
    },
    patient: admission.patientId,
    unbilledCharges: snapshot.unbilledCharges,
    unbilledChargesByDate,
    unbilledSummary: groupChargeSummary(snapshot.unbilledCharges),
    billedCharges,
    billedSummary: {
      total: sumCharges(billedCharges),
      count: billedCharges.length,
      bySource: billedCharges.reduce((result, charge) => {
        const source = charge.sourceReference?.module || charge.sourceModule;
        result[source] = money((result[source] || 0) + (Number(charge.netAmount) || 0));
        return result;
      }, {})
    },
    invoices: snapshot.invoices,
    receipts,
    advanceLedger,
    financialSummary: {
      totalChargeAmount: snapshot.totalChargeAmount,
      unbilledTotal: snapshot.unbilledTotal,
      invoicedGross: snapshot.invoicedGross,
      creditNotes: snapshot.creditNotes,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      paidAmount: snapshot.invoicePaid,
      overallDue: snapshot.overallDue,
      advanceAvailable: snapshot.advanceAvailable
    }
  };
}

async function addManualCharge(payload, user) {
  const admission = await findAdmission(payload.admissionId);
  const quantity = Number(payload.quantity || 1);
  const rate = assertAmount(payload.rate, 'Rate');
  if (!Number.isFinite(quantity) || quantity <= 0) {
    const error = new Error('Quantity must be greater than zero');
    error.statusCode = 400;
    throw error;
  }
  if (payload.chargeType === 'Bed') {
    const key = dateKey(payload.chargeDate || new Date());
    const existing = await IPDCharge.findOne({
      admissionId: admission._id,
      chargeType: 'Bed',
      chargeDateKey: key,
      $or: [{ status: { $exists: false } }, { status: { $in: ['ACTIVE', 'INVOICED'] } }]
    });
    if (existing) {
      const error = new Error('Bed charge already exists for this admission and date');
      error.statusCode = 409;
      throw error;
    }
  }

  const charge = await IPDCharge.create({
    hospitalId: hospitalIdFor(admission, user),
    admissionId: admission._id,
    patientId: admission.patientId,
    chargeType: payload.chargeType || 'Miscellaneous',
    description: payload.description,
    quantity,
    rate,
    discount: money(payload.discount || 0),
    tax: money(payload.tax || 0),
    sourceModule: payload.sourceModule || 'Manual',
    sourceId: payload.sourceId,
    sourceReference: payload.sourceReference,
    chargeDate: payload.chargeDate || new Date(),
    chargeDateKey: dateKey(payload.chargeDate || new Date()),
    idempotencyKey: payload.idempotencyKey,
    notes: payload.notes,
    addedBy: user?._id
  });
  await calculateAdmissionFinancials(admission._id);
  return charge;
}

async function generateBedCharge(admissionId, payload, user) {
  const admission = await IPDAdmission.findById(admissionId).populate('bedId');
  if (!admission) {
    const error = new Error('Admission not found');
    error.statusCode = 404;
    throw error;
  }
  if (!admission.bedId) {
    const error = new Error('No bed is allocated for this admission');
    error.statusCode = 400;
    throw error;
  }

  const chargeDate = new Date(payload.date || new Date());
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
    admissionId,
    chargeType: 'Bed',
    chargeDateKey: key,
    $or: [{ status: { $exists: false } }, { status: { $in: ['ACTIVE', 'INVOICED'] } }]
  });
  if (existing) return { charge: existing, alreadyExists: true };

  const dailyRate = money(payload.dailyRate || admission.bedId.dailyCharge || 0);
  if (dailyRate < 0) {
    const error = new Error('Daily bed rate cannot be negative');
    error.statusCode = 400;
    throw error;
  }

  const charge = await IPDCharge.create({
    hospitalId: hospitalIdFor(admission, user),
    admissionId,
    patientId: admission.patientId,
    chargeType: 'Bed',
    description: `Bed charges — ${admission.bedId.bedNumber || 'Allocated bed'} (${admission.bedId.bedType || 'General'}) for ${key}`,
    quantity: 1,
    rate: dailyRate,
    sourceModule: 'Bed',
    sourceId: admission.bedId._id,
    sourceReference: { module: 'Bed', documentId: admission.bedId._id },
    chargeDate,
    chargeDateKey: key,
    isAutoGenerated: true,
    idempotencyKey: `bed:${admissionId}:${key}`,
    addedBy: user?._id
  });
  await calculateAdmissionFinancials(admissionId);
  return { charge, alreadyExists: false };
}

async function applyDiscount(admissionId, payload, user) {
  const admission = await findAdmission(admissionId);
  const discountAmount = assertAmount(payload.discountAmount, 'Discount amount');
  const activeCharges = await IPDCharge.find({ admissionId, ...ACTIVE_CHARGE_FILTER });
  const chargeable = money(activeCharges
    .filter((charge) => charge.adjustmentType !== 'DISCOUNT' && charge.chargeType !== 'Discount')
    .reduce((sum, charge) => sum + Math.max(0, Number(charge.netAmount) || 0), 0));
  const existingDiscount = money(activeCharges
    .filter((charge) => charge.adjustmentType === 'DISCOUNT' || charge.chargeType === 'Discount')
    .reduce((sum, charge) => sum + Math.abs(Number(charge.netAmount) || 0), 0));

  if (discountAmount > money(chargeable - existingDiscount)) {
    const error = new Error('Discount cannot exceed the available chargeable amount');
    error.statusCode = 400;
    throw error;
  }
  if (!payload.discountReason?.trim()) {
    const error = new Error('Discount reason is required');
    error.statusCode = 400;
    throw error;
  }

  const discountCharge = await IPDCharge.create({
    hospitalId: hospitalIdFor(admission, user),
    admissionId,
    patientId: admission.patientId,
    chargeType: 'Discount',
    adjustmentType: 'DISCOUNT',
    description: `Authorised discount — ${payload.discountReason.trim()}`,
    quantity: 1,
    rate: 0,
    discount: discountAmount,
    tax: 0,
    sourceModule: 'Billing',
    sourceReference: { module: 'Billing' },
    chargeDate: new Date(),
    notes: payload.notes || payload.discountReason.trim(),
    discountDetails: {
      type: payload.discountType === 'percentage' ? 'percentage' : 'fixed',
      reason: payload.discountReason.trim(),
      approvedBy: payload.approvedBy || user?._id,
      approvedAt: new Date()
    },
    addedBy: user?._id
  });

  admission.discountAmount = money((admission.discountAmount || 0) + discountAmount);
  admission.discountReason = payload.discountReason.trim();
  await admission.save();
  await calculateAdmissionFinancials(admissionId);
  return discountCharge;
}

async function voidCharge(admissionId, chargeId, payload, user) {
  const charge = await IPDCharge.findOne({ _id: chargeId, admissionId });
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
  charge.voidedAt = new Date();
  await charge.save();
  await calculateAdmissionFinancials(admissionId);
  return charge;
}

async function issueIPDInvoice(admissionId, payload = {}, user) {
  const invoiceKind = payload.invoiceKind === 'final' ? 'IPD Final' : 'IPD Interim';
  return runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session);
    if (payload.idempotencyKey) {
      const existing = await Invoice.findOne({ idempotency_key: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) return { invoice: existing, bill: await Bill.findById(existing.bill_id, null, sessionOptions(session)), alreadyExists: true };
    }

    const charges = await IPDCharge.find(
      { admissionId, ...UNBILLED_CHARGE_FILTER },
      null,
      sessionOptions(session)
    ).sort({ chargeDate: 1, createdAt: 1 });

    if (!charges.length) {
      const error = new Error('There are no unbilled active charges for this admission');
      error.statusCode = 409;
      throw error;
    }

    const subtotal = money(charges.reduce((sum, charge) => sum + (Number(charge.amount) || 0), 0));
    const discount = money(charges.reduce((sum, charge) => sum + (Number(charge.discount) || 0), 0));
    const tax = money(charges.reduce((sum, charge) => sum + (Number(charge.tax) || 0), 0));
    const total = money(subtotal - discount + tax);
    if (total < 0) {
      const error = new Error('Invoice total cannot be negative');
      error.statusCode = 400;
      throw error;
    }

    const hospitalId = hospitalIdFor(admission, user);
    const billNumber = await nextFinancialNumber({ documentType: 'BILL', hospitalId, session });
    const bill = new Bill({
      hospital_id: hospitalId,
      bill_number: billNumber,
      document_stage: 'GENERATED',
      patient_id: admission.patientId,
      admission_id: admission._id,
      total_amount: total,
      subtotal,
      tax_amount: tax,
      discount,
      discount_type: 'fixed',
      discount_reason: charges.filter((charge) => charge.discountDetails?.reason).map((charge) => charge.discountDetails.reason).join('; ') || undefined,
      payment_method: 'Pending',
      status: 'Generated',
      items: charges.map((charge) => ({
        description: charge.description,
        amount: money(charge.amount),
        quantity: charge.quantity,
        item_type: chargeItemType(charge.chargeType),
        tax_amount: money(charge.tax),
        discount_amount: money(charge.discount),
        taxable_amount: money(charge.amount - charge.discount),
        admission_id: admission._id
      })),
      notes: payload.notes || `${invoiceKind} operational bill for ${admission.admissionNumber}`,
      created_by: user?._id
    });
    await bill.save(sessionOptions(session));

    const invoiceNumber = await nextFinancialNumber({ documentType: 'INVOICE', hospitalId, session });
    const invoice = new Invoice({
      hospital_id: hospitalId,
      invoice_number: invoiceNumber,
      patient_id: admission.patientId,
      admission_id: admission._id,
      bill_id: bill._id,
      invoice_type: invoiceKind,
      document_stage: 'ISSUED',
      is_final_ipd_invoice: invoiceKind === 'IPD Final',
      issue_date: new Date(),
      due_date: payload.dueDate ? new Date(payload.dueDate) : new Date(),
      issued_at: new Date(),
      subtotal,
      gross_amount: subtotal,
      discount,
      tax,
      total,
      amount_paid: 0,
      balance_due: total,
      status: total === 0 ? 'Paid' : 'Issued',
      idempotency_key: payload.idempotencyKey,
      discount_details: {
        type: 'fixed',
        reason: bill.discount_reason,
        approved_by: user?._id,
        approved_at: new Date()
      },
      service_items: charges.map((charge) => ({
        description: charge.description,
        quantity: charge.quantity,
        unit_price: money(charge.rate),
        total_price: money(charge.amount),
        tax_rate: charge.amount ? money((charge.tax / charge.amount) * 100) : 0,
        tax_amount: money(charge.tax),
        service_type: serviceTypeForCharge(charge.chargeType),
        bill_id: bill._id
      })),
      notes: payload.notes || `${invoiceKind} issued from ${charges.length} IPD charge(s) for admission ${admission.admissionNumber}`,
      created_by: user?._id
    });
    await invoice.save(sessionOptions(session));

    bill.invoice_id = invoice._id;
    bill.invoice_ids = [invoice._id];
    bill.document_stage = 'INVOICED';
    bill.invoiced_at = new Date();
    await bill.save(sessionOptions(session));

    const ids = charges.map((charge) => charge._id);
    const update = await IPDCharge.updateMany(
      { _id: { $in: ids }, admissionId, ...UNBILLED_CHARGE_FILTER },
      {
        $set: {
          isBilled: true,
          status: 'INVOICED',
          billId: bill._id,
          invoiceId: invoice._id,
          billedAt: new Date(),
          sourceReference: { module: 'IPD', documentId: bill._id, invoiceNumber: invoice.invoice_number, billNumber }
        }
      },
      sessionOptions(session)
    );
    if (update.modifiedCount !== charges.length) {
      const error = new Error('Invoice issuance stopped because one or more charges changed during processing');
      error.statusCode = 409;
      throw error;
    }

    if (invoiceKind === 'IPD Final') admission.finalInvoiceId = invoice._id;
    admission.financialClearanceStatus = 'in_progress';
    await admission.save(sessionOptions(session));
    return { invoice, bill, alreadyExists: false };
  }).then(async (result) => {
    await calculateAdmissionFinancials(admissionId);
    return result;
  });
}

function allocationPlan(invoices, amount, payload) {
  const openInvoices = invoices.filter((invoice) => money(invoice.balance_due) > 0);
  if (!openInvoices.length) {
    const error = new Error('There are no outstanding IPD invoices to settle');
    error.statusCode = 409;
    throw error;
  }

  let allocations = Array.isArray(payload.allocations) && payload.allocations.length ? payload.allocations : null;
  if (!allocations && payload.invoiceId) allocations = [{ invoiceId: payload.invoiceId, amount }];
  if (!allocations) {
    let remaining = amount;
    allocations = openInvoices.map((invoice) => {
      const applied = Math.min(remaining, money(invoice.balance_due));
      remaining = money(remaining - applied);
      return { invoiceId: invoice._id.toString(), amount: applied };
    }).filter((entry) => entry.amount > 0);
  }

  const indexed = new Map(openInvoices.map((invoice) => [invoice._id.toString(), invoice]));
  const normalised = allocations.map((entry) => {
    const invoice = indexed.get(String(entry.invoiceId));
    const value = assertAmount(entry.amount, 'Allocated amount');
    if (!invoice) {
      const error = new Error('A payment allocation references an invoice that is not outstanding for this admission');
      error.statusCode = 400;
      throw error;
    }
    if (value > money(invoice.balance_due)) {
      const error = new Error(`Allocated amount is greater than the open balance on invoice ${invoice.invoice_number}`);
      error.statusCode = 400;
      throw error;
    }
    return { invoice, amount: value };
  });
  const allocated = money(normalised.reduce((sum, entry) => sum + entry.amount, 0));
  if (allocated !== amount) {
    const error = new Error('Payment amount must exactly match allocated invoice amount');
    error.statusCode = 400;
    throw error;
  }
  return normalised;
}

async function recordIPDPayment(admissionId, payload, user) {
  const amount = assertAmount(payload.amount, 'Payment amount');
  const paymentMethod = payload.paymentMethod || 'Cash';
  if (!FINANCE_PAYMENT_METHODS.includes(paymentMethod)) {
    const error = new Error('Unsupported payment method');
    error.statusCode = 400;
    throw error;
  }

  return runFinancialTransaction(async (session) => {
    const admission = await findAdmission(admissionId, session);
    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne({ idempotencyKey: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) return { receiptNumber: existing.transactionNumber, transactions: [existing], alreadyExists: true };
    }

    const invoices = await Invoice.find(invoiceFilterForAdmission(admissionId), null, sessionOptions(session)).sort({ issue_date: 1, created_at: 1 });
    const plan = allocationPlan(invoices, amount, payload);
    const hospitalId = hospitalIdFor(admission, user);
    const receiptNumber = await nextFinancialNumber({ documentType: 'RECEIPT', hospitalId, session });

    let updatedAdvance = null;
    if (paymentMethod === 'IPDAdvance' || payload.useAdvance === true) {
      updatedAdvance = await IPDAdmission.findOneAndUpdate(
        { _id: admission._id, advanceAmount: { $gte: amount } },
        { $inc: { advanceAmount: -amount, advanceUtilizedAmount: amount } },
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
        amount,
        openingBalance: money(updatedAdvance.advanceAmount + amount),
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

    const transactions = [];
    for (const entry of plan) {
      const invoice = entry.invoice;
      invoice.amount_paid = money((invoice.amount_paid || 0) + entry.amount);
      invoice.payment_history.push({
        date: new Date(),
        amount: entry.amount,
        method: paymentMethod,
        reference: payload.reference,
        status: 'Completed',
        collected_by: user?._id,
        transaction_id: receiptNumber
      });
      invoice.receipt_numbers = Array.from(new Set([...(invoice.receipt_numbers || []), receiptNumber]));
      await invoice.save(sessionOptions(session));

      const transaction = new FinancialTransaction({
        hospitalId,
        patientId: admission.patientId,
        admissionId: admission._id,
        billId: invoice.bill_id,
        invoiceId: invoice._id,
        transactionNumber: receiptNumber,
        transactionType: paymentMethod === 'IPDAdvance' || payload.useAdvance === true ? 'ADVANCE_UTILISATION' : 'RECEIPT',
        direction: 'CREDIT',
        amount: entry.amount,
        paymentMethod,
        paymentReference: payload.reference,
        sourceModule: 'IPD',
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
    return { receiptNumber, transactions, updatedAdvance, alreadyExists: false };
  }).then(async (result) => {
    await calculateAdmissionFinancials(admissionId);
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
    const admission = await findAdmission(admissionId, session);
    if (payload.idempotencyKey) {
      const existing = await FinancialTransaction.findOne({ idempotencyKey: payload.idempotencyKey }, null, sessionOptions(session));
      if (existing) return { receiptNumber: existing.transactionNumber, advanceBalance: admission.advanceAmount, alreadyExists: true };
    }
    const hospitalId = hospitalIdFor(admission, user);
    const receiptNumber = await nextFinancialNumber({ documentType: 'ADVANCE_RECEIPT', hospitalId, session });
    const updated = await IPDAdmission.findByIdAndUpdate(
      admissionId,
      { $inc: { advanceAmount: amount, advanceReceivedAmount: amount }, $set: { financialClearanceStatus: 'in_progress' } },
      { new: true, ...sessionOptions(session) }
    );
    const openingBalance = money(updated.advanceAmount - amount);

    await PatientAdvanceLedger.create([{
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
    }], sessionOptions(session));

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
    return { receiptNumber, advanceBalance: money(updated.advanceAmount), transaction, alreadyExists: false };
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
    const admission = await findAdmission(admissionId, session);
    const hospitalId = hospitalIdFor(admission, user);
    const refundNumber = await nextFinancialNumber({ documentType: 'ADVANCE_REFUND', hospitalId, session });
    const updated = await IPDAdmission.findOneAndUpdate(
      { _id: admission._id, advanceAmount: { $gte: amount } },
      { $inc: { advanceAmount: -amount, advanceRefundedAmount: amount } },
      { new: true, ...sessionOptions(session) }
    );
    if (!updated) {
      const error = new Error('Refund amount exceeds the available IPD advance balance');
      error.statusCode = 409;
      throw error;
    }

    await PatientAdvanceLedger.create([{
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
    }], sessionOptions(session));

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
    if (!['IPD Interim', 'IPD Final', 'Pharmacy', 'Mixed', 'Other'].includes(invoice.invoice_type) || invoice.document_stage === 'VOID') {
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

    const admission = invoice.admission_id ? await findAdmission(invoice.admission_id, session) : null;
    const hospitalId = invoice.hospital_id || hospitalIdFor(admission, user);
    const noteNumber = await nextFinancialNumber({ documentType: 'CREDIT_NOTE', hospitalId, session });
    const creditNote = new Invoice({
      hospital_id: hospitalId,
      invoice_number: noteNumber,
      patient_id: invoice.patient_id,
      admission_id: invoice.admission_id,
      bill_id: invoice.bill_id,
      invoice_type: 'Credit Note',
      document_stage: 'CREDIT_NOTE',
      linked_invoice_id: invoice._id,
      issue_date: new Date(),
      due_date: new Date(),
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
      metadata: { creditNoteInvoiceId: creditNote._id }
    });
    await transaction.save(sessionOptions(session));
    return { creditNote, originalInvoice: invoice, transaction };
  }).then(async (result) => {
    if (result.originalInvoice.admission_id) await calculateAdmissionFinancials(result.originalInvoice.admission_id);
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

  const credit = await createCreditNote(invoiceId, { amount, reason: payload.reason }, user);
  return runFinancialTransaction(async (session) => {
    const invoice = await Invoice.findById(invoiceId, null, sessionOptions(session));
    const admission = invoice.admission_id ? await findAdmission(invoice.admission_id, session) : null;
    const hospitalId = invoice.hospital_id || hospitalIdFor(admission, user);
    const refundNumber = await nextFinancialNumber({ documentType: 'ADVANCE_REFUND', hospitalId, session });
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
      metadata: { creditNoteNumber: credit.creditNote.invoice_number }
    });
    await transaction.save(sessionOptions(session));
    return { creditNote: credit.creditNote, refundNumber, transaction };
  });
}

async function getFinancialLedger(admissionId) {
  const snapshot = await calculateAdmissionFinancials(admissionId);
  const [transactions, advanceLedger] = await Promise.all([
    FinancialTransaction.find({ admissionId, status: 'POSTED' }).sort({ createdAt: 1 }).lean(),
    PatientAdvanceLedger.find({ admissionId, status: 'POSTED' }).sort({ createdAt: 1 }).lean()
  ]);

  const entries = [
    ...snapshot.invoices.map((invoice) => ({
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
      totalCharged: snapshot.totalChargeAmount,
      invoiced: snapshot.invoicedGross,
      paid: snapshot.invoicePaid,
      due: snapshot.overallDue,
      advanceAvailable: snapshot.advanceAvailable
    },
    invoices: snapshot.invoices,
    transactions,
    advanceLedger,
    entries
  };
}

async function getFinancialClearance(admissionId) {
  const snapshot = await calculateAdmissionFinancials(admissionId);
  const admission = snapshot.admission;
  const pendingPharmacySales = await Sale.find({
    admission_id: admissionId,
    balance_due: { $gt: 0 },
    status: { $in: ['Pending', 'Partially Paid'] }
  }).select('sale_number balance_due total_amount payment_deferred include_in_discharge_clearance sale_date').lean();
  const pharmacyDue = money(pendingPharmacySales.reduce((sum, sale) => sum + (Number(sale.balance_due) || 0), 0));
  const hasPharmacyTransactions = await Sale.exists({ admission_id: admissionId });
  const pharmacyCleared = ['cleared', 'exempted'].includes(admission.pharmacyClearanceStatus) || (!hasPharmacyTransactions && pharmacyDue === 0);
  const finalInvoice = snapshot.invoices.find((invoice) => invoice.invoice_type === 'IPD Final') || null;

  const checks = {
    unbilledChargesResolved: snapshot.unbilledTotal === 0,
    issuedInvoicesSettled: snapshot.invoiceOutstanding === 0,
    pharmacyClearance: pharmacyCleared && pharmacyDue === 0,
    advanceReconciled: true,
    finalInvoiceAvailable: Boolean(finalInvoice) || snapshot.unbilledTotal === 0,
    financialExceptionApproved: admission.financialClearanceStatus === 'exception_approved'
  };
  const ready = (checks.unbilledChargesResolved && checks.issuedInvoicesSettled && checks.pharmacyClearance) || checks.financialExceptionApproved;

  return {
    success: true,
    ready,
    checks,
    summary: {
      totalCharges: snapshot.totalChargeAmount,
      unbilledCharges: snapshot.unbilledTotal,
      invoiceOutstanding: snapshot.invoiceOutstanding,
      dueAmount: snapshot.overallDue,
      advanceAvailable: snapshot.advanceAvailable,
      pharmacyDue,
      finalInvoiceNumber: finalInvoice?.invoice_number || null
    },
    pendingPharmacySales,
    invoices: snapshot.invoices
  };
}

async function finaliseFinancialClearance(admissionId, payload, user) {
  let clearance = await getFinancialClearance(admissionId);
  let issuedInvoice = null;
  if (clearance.summary.unbilledCharges > 0) {
    const issued = await issueIPDInvoice(admissionId, { invoiceKind: 'final', notes: payload.notes, idempotencyKey: payload.idempotencyKey }, user);
    issuedInvoice = issued.invoice;
    clearance = await getFinancialClearance(admissionId);
  }

  const admission = await findAdmission(admissionId);
  const exceptionAllowed = Boolean(payload.allowException && user && ['admin', 'accountant', 'mediqliq_super_admin'].includes(user.role));
  if (!clearance.ready && !exceptionAllowed) {
    const error = new Error('Financial clearance cannot be completed while IPD dues or pharmacy clearances remain');
    error.statusCode = 409;
    error.details = clearance;
    throw error;
  }

  admission.financialClearanceStatus = clearance.ready ? 'cleared' : 'exception_approved';
  admission.financialClearedAt = new Date();
  admission.financialClearedBy = user?._id;
  if (!clearance.ready) {
    admission.financialClearanceException = {
      reason: payload.exceptionReason || 'Authorised financial discharge exception',
      approvedBy: user?._id,
      approvedAt: new Date(),
      outstandingAccepted: clearance.summary.dueAmount + clearance.summary.pharmacyDue
    };
  }
  if (issuedInvoice) admission.finalInvoiceId = issuedInvoice._id;
  await admission.save();
  return { clearance: await getFinancialClearance(admissionId), issuedInvoice, admission };
}

module.exports = {
  calculateAdmissionFinancials,
  getRunningBill,
  addManualCharge,
  generateBedCharge,
  applyDiscount,
  voidCharge,
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
