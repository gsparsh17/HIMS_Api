const { operationNow } = require('../utils/operationTimeContext');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const HospitalCharges = require('../models/HospitalCharges');
const Prescription = require('../models/Prescription');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const RadiologyRequest = require('../models/RadiologyRequest');
const LabRequest = require('../models/LabRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const ImagingTest = require('../models/ImagingTest');
const LabTest = require('../models/LabTest');
const Procedure = require('../models/Procedure');
const ClaimCase = require('../models/ClaimCase');
const SponsorLedgerEntry = require('../models/SponsorLedgerEntry');
const ipdFinancial = require('../services/ipdFinancial.service');
const { syncLegacyInvoiceReceipt, makeChargeLineKey } = require('../services/legacyFinancialBridge.service');
const { requestHospitalId } = require('../utils/hospitalScope');
const { nextFinancialNumber, money } = require('../utils/financeNumbers');
const billingPatientService = require('../services/billingPatient.service');
const patientFinancial = require('../services/patientFinancial.service');
const { resolveDoctorTariff } = require('../services/doctorTariff.service');
const { resolveFinancialPolicy } = require('../services/financialPolicy.service');
const { _hasActionPermission } = require('../middlewares/auth');

// ========== OPD billing scope + ledger helpers ==========
function billScope(req, extra = {}) {
  return { ...extra, hospital_id: requestHospitalId(req) };
}

async function findIssuedInvoiceLinkedToBill(req, bill) {
  if (!bill) return null;
  const hospitalId = requestHospitalId(req);
  const linkedIds = [
    ...(bill.invoice_ids || []),
    ...(bill.invoice_id ? [bill.invoice_id] : [])
  ].map((value) => value?._id || value).filter(Boolean);

  const or = [
    { bill_id: bill._id },
    { bill_ids: bill._id }
  ];
  if (linkedIds.length) or.push({ _id: { $in: linkedIds } });

  return Invoice.findOne({
    hospital_id: hospitalId,
    is_deleted: { $ne: true },
    document_stage: { $in: ['ISSUED', 'CREDIT_NOTE'] },
    $or: or
  }).select('_id invoice_number document_stage invoice_type linked_invoice_id');
}

function canEmergencyDeleteIssuedDocument(req) {
  return Boolean(_hasActionPermission(req.user, 'billing_delete_issued_document'));
}

async function issuedBillDeletionContext(req, bill) {
  const issuedInvoice = await findIssuedInvoiceLinkedToBill(req, bill);
  return {
    issuedInvoice,
    isIssued: Boolean(issuedInvoice || bill?.document_stage === 'INVOICED')
  };
}

async function issuedDeletionFinancialExposure(req, bill) {
  const hospitalId = requestHospitalId(req);
  const linkedIds = [
    ...(bill?.invoice_ids || []),
    ...(bill?.invoice_id ? [bill.invoice_id] : [])
  ].map((value) => value?._id || value).filter(Boolean);
  const or = [{ bill_id: bill._id }, { bill_ids: bill._id }];
  if (linkedIds.length) or.push({ _id: { $in: linkedIds } });

  const invoices = await Invoice.find({
    hospital_id: hospitalId,
    is_deleted: { $ne: true },
    document_stage: 'ISSUED',
    invoice_type: { $ne: 'Credit Note' },
    $or: or
  }).select('_id invoice_number total amount_paid refunded_amount advance_transferred_amount settlement_discount_amount credit_note_total balance_due status payer_allocation appointment_id admission_id').lean();

  const invoiceIds = invoices.map((invoice) => invoice._id);
  const sponsorLedgerRows = invoiceIds.length
    ? await SponsorLedgerEntry.find({ hospitalId, invoiceId: { $in: invoiceIds } })
      .select('_id invoiceId claimId entryNumber entryType debit credit reference')
      .lean()
    : [];
  const appointmentIds = invoices.map((row) => row.appointment_id).filter(Boolean);
  const admissionIds = invoices.map((row) => row.admission_id).filter(Boolean);
  const claimIds = invoices.map((row) => row.payer_allocation?.claim_id).filter(Boolean);
  const claimOr = [];
  if (appointmentIds.length) claimOr.push({ appointmentId: { $in: appointmentIds } });
  if (admissionIds.length) claimOr.push({ admissionId: { $in: admissionIds } });
  if (claimIds.length) claimOr.push({ _id: { $in: claimIds } });
  const activeClaims = claimOr.length
    ? await ClaimCase.find({
        hospitalId,
        status: { $nin: ['cancelled', 'closed'] },
        $or: claimOr
      }).select('_id claimNumber status appointmentId admissionId coverageId payerId amounts').lean()
    : [];

  const ledgerByInvoice = new Map();
  sponsorLedgerRows.forEach((entry) => {
    const key = String(entry.invoiceId || '');
    const current = ledgerByInvoice.get(key) || { debit: 0, credit: 0, entries: [] };
    current.debit += Number(entry.debit || 0);
    current.credit += Number(entry.credit || 0);
    current.entries.push(entry);
    ledgerByInvoice.set(key, current);
  });

  const rows = invoices.map((invoice) => {
    const unresolvedCollected = money(Math.max(
      0,
      Number(invoice.amount_paid || 0) -
        Number(invoice.refunded_amount || 0) -
        Number(invoice.advance_transferred_amount || 0)
    ));
    const allocation = invoice.payer_allocation || {};
    const sponsorLiability = money(allocation.sponsor_liability || 0);
    const sponsorPaid = money(allocation.sponsor_paid_amount || 0);
    const sponsorCredited = money(allocation.sponsor_credit_amount || 0);
    const sponsorContractOutstanding = money(Math.max(0, sponsorLiability - sponsorPaid - sponsorCredited));
    const ledger = ledgerByInvoice.get(String(invoice._id));
    const sponsorLedgerOutstanding = money(Math.max(0, Number(ledger?.debit || 0) - Number(ledger?.credit || 0)));
    const unresolvedSponsor = money(Math.max(sponsorContractOutstanding, sponsorLedgerOutstanding));
    const claims = activeClaims.filter((claim) =>
      (invoice.appointment_id && String(claim.appointmentId || '') === String(invoice.appointment_id)) ||
      (invoice.admission_id && String(claim.admissionId || '') === String(invoice.admission_id)) ||
      (allocation.claim_id && String(claim._id) === String(allocation.claim_id))
    );
    return {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoice_number,
      total: money(invoice.total || 0),
      amountPaid: money(invoice.amount_paid || 0),
      refundedAmount: money(invoice.refunded_amount || 0),
      advanceTransferredAmount: money(invoice.advance_transferred_amount || 0),
      unresolvedCollected,
      balanceDue: money(invoice.balance_due || 0),
      sponsorLiability,
      sponsorPaid,
      sponsorCredited,
      sponsorLedgerOutstanding,
      unresolvedSponsor,
      activeClaims: claims.map((claim) => ({
        claimId: claim._id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        sponsorPaidAmount: money(claim.amounts?.sponsorPaidAmount || 0),
        outstandingSponsorAmount: money(claim.amounts?.outstandingSponsorAmount || 0)
      })),
      status: invoice.status
    };
  });

  return {
    invoices: rows,
    unresolvedCollected: money(rows.reduce((sum, row) => sum + row.unresolvedCollected, 0)),
    unresolvedSponsor: money(rows.reduce((sum, row) => sum + row.unresolvedSponsor, 0)),
    activeSponsorClaims: activeClaims.map((claim) => ({
      claimId: claim._id,
      claimNumber: claim.claimNumber,
      status: claim.status,
      sponsorPaidAmount: money(claim.amounts?.sponsorPaidAmount || 0),
      outstandingSponsorAmount: money(claim.amounts?.outstandingSponsorAmount || 0)
    }))
  };
}

async function requireIssuedDeletionFinanceResolved(req, res, bill) {
  const exposure = await issuedDeletionFinancialExposure(req, bill);
  if (exposure.unresolvedCollected > 0) {
    res.status(409).json({
      success: false,
      code: 'ISSUED_DOCUMENT_FINANCE_RESOLUTION_REQUIRED',
      error: 'This issued document still has collected patient money allocated to it. Refund or move/reclassify the collection through the canonical finance workflow before emergency archival, then retry deletion.',
      unresolvedCollected: exposure.unresolvedCollected,
      unresolvedSponsor: exposure.unresolvedSponsor,
      invoices: exposure.invoices,
      requiredAction: 'refund_or_advance_resolution'
    });
    return { ...exposure, allowed: false };
  }

  const hasSponsorExposure = exposure.unresolvedSponsor > 0.01 || exposure.activeSponsorClaims.length > 0;
  if (!hasSponsorExposure) return { ...exposure, allowed: true, sponsorOverride: false };

  const sponsorOverride = req.body?.sponsorOverride === true;
  const sponsorOverrideReason = String(req.body?.sponsorOverrideReason || '').trim();
  const canOverrideSponsor = sponsorOverride
    && sponsorOverrideReason
    && _hasActionPermission(req.user, 'claim_manage');
  if (canOverrideSponsor) {
    return {
      ...exposure,
      allowed: true,
      sponsorOverride: true,
      sponsorOverrideReason,
      sponsorOverrideBy: req.user?._id
    };
  }

  res.status(409).json({
    success: false,
    code: 'ISSUED_DOCUMENT_SPONSOR_RESOLUTION_REQUIRED',
    error: 'This issued document still has sponsor/insurance receivable or an active claim. Resolve the sponsor exposure first, or use an explicit sponsor override with claim-management authority for emergency archival.',
    unresolvedCollected: exposure.unresolvedCollected,
    unresolvedSponsor: exposure.unresolvedSponsor,
    activeSponsorClaims: exposure.activeSponsorClaims,
    invoices: exposure.invoices,
    requiredAction: 'resolve_sponsor_or_explicit_override',
    sponsorOverrideRequirements: {
      sponsorOverride: true,
      sponsorOverrideReason: 'required',
      requiredPermission: 'claim_manage'
    }
  });
  return { ...exposure, allowed: false };
}

async function requireIssuedDeletionAuthority(req, res, bill) {
  const context = await issuedBillDeletionContext(req, bill);
  if (!context.isIssued) return { ...context, allowed: true };
  if (canEmergencyDeleteIssuedDocument(req)) return { ...context, allowed: true };

  res.status(403).json({
    success: false,
    code: 'ISSUED_DOCUMENT_DELETE_PERMISSION_REQUIRED',
    error: 'Deleting an issued Bill / Invoice is an emergency authority. Ask an administrator or a user granted "Emergency delete issued Bill / Invoice" permission.',
    requiredAction: 'billing_delete_issued_document',
    billId: bill?._id,
    invoiceId: context.issuedInvoice?._id || bill?.invoice_id || null,
    invoiceNumber: context.issuedInvoice?.invoice_number || null
  });
  return { ...context, allowed: false };
}

async function archiveInvoicesLinkedToBill(req, bill, deletionInfo) {
  const hospitalId = requestHospitalId(req);
  const linkedIds = [
    ...(bill.invoice_ids || []),
    ...(bill.invoice_id ? [bill.invoice_id] : [])
  ].map((value) => value?._id || value).filter(Boolean);

  const or = [
    { bill_id: bill._id },
    { bill_ids: bill._id }
  ];
  if (linkedIds.length) or.push({ _id: { $in: linkedIds } });

  const result = await Invoice.updateMany({
    hospital_id: hospitalId,
    is_deleted: { $ne: true },
    $or: or
  }, {
    $set: {
      is_deleted: true,
      is_active: false,
      deleted_at: deletionInfo.deleted_at,
      deleted_by: deletionInfo.deleted_by,
      deletion_reason: deletionInfo.deletion_reason
    }
  });

  return Number(result.modifiedCount ?? result.nModified ?? 0);
}

async function markInvoicesLinkedToBillForDeletionRequest(req, bill, deletionRequestId) {
  const hospitalId = requestHospitalId(req);
  const linkedIds = [
    ...(bill.invoice_ids || []),
    ...(bill.invoice_id ? [bill.invoice_id] : [])
  ].map((value) => value?._id || value).filter(Boolean);
  const or = [{ bill_id: bill._id }, { bill_ids: bill._id }];
  if (linkedIds.length) or.push({ _id: { $in: linkedIds } });

  return Invoice.updateMany({
    hospital_id: hospitalId,
    is_deleted: { $ne: true },
    $or: or
  }, deletionRequestId
    ? { $set: { deletion_request_id: deletionRequestId } }
    : { $unset: { deletion_request_id: 1 } });
}

function buildOpdLedgerEntries(bill, invoice) {
  const documentTotal = money(invoice?.total ?? bill?.total_amount);
  const documentDate = bill?.generated_at || bill?.createdAt || invoice?.issue_date || invoice?.createdAt;
  const documentNumber = invoice?.invoice_number || bill?.bill_number || String(bill?._id || '');
  const documentKind = invoice ? 'INVOICE' : 'BILL';

  const entries = [{
    date: documentDate,
    kind: documentKind,
    number: documentNumber,
    description: invoice ? `${invoice.invoice_type || 'OPD'} invoice issued` : 'OPD bill generated',
    debit: documentTotal,
    credit: 0
  }];

  const payments = invoice?.payment_history?.length
    ? invoice.payment_history
    : (bill?.payments || []).map((entry) => ({
        ...entry,
        date: entry.date,
        status: entry.status || 'Completed'
      }));

  for (const payment of payments || []) {
    const amount = money(payment.amount);
    if (!amount) continue;
    const refunded = String(payment.status || '').toLowerCase() === 'refunded';
    entries.push({
      date: payment.date || payment.createdAt || bill?.paid_at || bill?.updatedAt,
      kind: refunded ? 'REFUND' : 'PAYMENT',
      number: payment.transaction_id || payment.reference || documentNumber,
      description: `${payment.method || bill?.payment_method || 'Payment'}${payment.reference ? ` · ${payment.reference}` : ''}`,
      debit: refunded ? amount : 0,
      credit: refunded ? 0 : amount
    });
  }

  const settlementDiscount = money(bill?.settlement_discount_amount);
  if (settlementDiscount > 0) {
    entries.push({
      date: bill?.updatedAt || bill?.paid_at || bill?.generated_at,
      kind: 'DISCOUNT',
      number: documentNumber,
      description: 'Settlement discount',
      debit: 0,
      credit: settlementDiscount
    });
  }

  const creditNoteAmount = money(bill?.credit_note_amount);
  if (creditNoteAmount > 0) {
    entries.push({
      date: bill?.updatedAt || bill?.paid_at || bill?.generated_at,
      kind: 'CREDIT_NOTE',
      number: documentNumber,
      description: 'Credit note adjustment',
      debit: 0,
      credit: creditNoteAmount
    });
  }

  let balance = 0;
  return entries
    .filter((entry) => entry.date)
    .sort((left, right) => new Date(left.date) - new Date(right.date))
    .map((entry) => {
      balance = money(balance + money(entry.debit) - money(entry.credit));
      return { ...entry, balance };
    });
}

// ========== HELPERS: IPD charge + financial reconciliation ==========
async function createOrUpdateIPDCharge({
  hospitalId,
  admissionId,
  patientId,
  chargeType,
  description,
  quantity,
  rate,
  sourceModule,
  sourceId,
  sourceLineKey,
  isAutoGenerated = true,
  addedBy,
  notes
}) {
  if (!admissionId) return null;

  const admission = await IPDAdmission.findById(admissionId).select('hospitalId patientId').lean();
  const scopedHospitalId = hospitalId || admission?.hospitalId;
  if (!scopedHospitalId) {
    const error = new Error('Hospital context is required to create an IPD charge');
    error.statusCode = 400;
    throw error;
  }

  const lookup = {
    admissionId,
    sourceModule,
    sourceId,
    isBilled: false,
    $and: [
      { $or: [{ status: { $exists: false } }, { status: 'ACTIVE' }] },
      { $or: [
        { hospitalId: scopedHospitalId },
        { hospitalId: { $exists: false } },
        { hospitalId: null }
      ] }
    ]
  };
  // A prescription can contain several medicines/rows with the same source.
  // The stable bill-line key prevents one item overwriting another.
  if (sourceLineKey) lookup['sourceReference.lineKey'] = sourceLineKey;

  const existingCharge = await IPDCharge.findOne(lookup);
  const netAmount = Number(((Number(quantity || 1) * Number(rate || 0))).toFixed(2));

  if (existingCharge) {
    existingCharge.hospitalId = scopedHospitalId;
    existingCharge.patientId = patientId || existingCharge.patientId || admission?.patientId;
    existingCharge.description = description;
    existingCharge.quantity = Number(quantity || 1);
    existingCharge.rate = Number(rate || 0);
    existingCharge.amount = netAmount;
    existingCharge.netAmount = netAmount;
    existingCharge.status = 'ACTIVE';
    existingCharge.notes = notes || existingCharge.notes;
    if (sourceLineKey) {
      existingCharge.sourceReference = {
        ...(existingCharge.sourceReference?.toObject?.() || existingCharge.sourceReference || {}),
        module: sourceModule,
        documentId: sourceId,
        lineKey: sourceLineKey
      };
    }
    await existingCharge.save();
    return existingCharge;
  }

  const charge = new IPDCharge({
    hospitalId: scopedHospitalId,
    admissionId,
    patientId: patientId || admission?.patientId,
    chargeType,
    description,
    quantity: Number(quantity || 1),
    rate: Number(rate || 0),
    amount: netAmount,
    netAmount,
    sourceModule,
    sourceId,
    sourceReference: {
      module: sourceModule,
      documentId: sourceId,
      lineKey: sourceLineKey
    },
    status: 'ACTIVE',
    isAutoGenerated,
    isBilled: false,
    addedBy,
    notes,
    chargeDate: operationNow()
  });
  await charge.save();
  return charge;
}

async function markIPDChargeAsBilled(admissionId, sourceModule, sourceId, invoiceId, invoiceNumber, sourceLineKey, billId) {
  if (!admissionId) return null;

  const admission = await IPDAdmission.findById(admissionId).select('hospitalId').lean();
  if (!admission?.hospitalId) return null;

  const lookup = {
    admissionId,
    sourceModule,
    sourceId,
    isBilled: false,
    $and: [
      { $or: [{ status: { $exists: false } }, { status: 'ACTIVE' }] },
      { $or: [
        { hospitalId: admission.hospitalId },
        { hospitalId: { $exists: false } },
        { hospitalId: null }
      ] }
    ]
  };
  if (sourceLineKey) lookup['sourceReference.lineKey'] = sourceLineKey;

  const ipdCharge = await IPDCharge.findOne(lookup);
  if (!ipdCharge) return null;

  ipdCharge.hospitalId = admission.hospitalId;
  ipdCharge.isBilled = true;
  ipdCharge.status = 'INVOICED';
  ipdCharge.invoiceId = invoiceId;
  if (billId) ipdCharge.billId = billId;
  ipdCharge.billedAt = operationNow();
  ipdCharge.sourceReference = {
    ...(ipdCharge.sourceReference?.toObject?.() || ipdCharge.sourceReference || {}),
    module: sourceModule,
    documentId: sourceId,
    invoiceNumber,
    lineKey: sourceLineKey
  };
  await ipdCharge.save();
  await updateAdmissionTotals(admissionId);
  return ipdCharge;
}

async function updateAdmissionTotals(admissionId) {
  if (!admissionId) return;
  // The finance service accounts for active charges, issued invoices, advances,
  // receipts and credit notes. It prevents legacy bill totals from masking dues.
  await ipdFinancial.calculateAdmissionFinancials(admissionId);
}


async function applyAuthoritativeOpdAppointmentPricing({ hospitalId, patientId, appointmentId, items }) {
  if (!appointmentId) return { items, pricing: null };

  const appointment = await Appointment.findOne({
    _id: appointmentId,
    hospital_id: hospitalId,
    is_active: { $ne: false }
  }).select('_id patient_id doctor_id appointment_type').lean();

  if (!appointment) {
    const error = new Error('Active appointment not found for this hospital');
    error.statusCode = 404;
    throw error;
  }
  if (String(appointment.patient_id) !== String(patientId)) {
    const error = new Error('Bill patient does not match the appointment patient');
    error.statusCode = 409;
    throw error;
  }

  // Do not require the doctor to still be active here: an appointment may be billed
  // after a clinician is deactivated, and the preserved Doctor ObjectId remains authoritative.
  const [doctor, hospitalCharges] = await Promise.all([
    Doctor.findOne({ _id: appointment.doctor_id, hospitalId })
      .select('_id firstName lastName opdConsultationFee')
      .lean(),
    HospitalCharges.findOne({ hospital: hospitalId, is_active: { $ne: false } }).lean()
  ]);
  if (!doctor) {
    const error = new Error('Appointment doctor reference could not be resolved');
    error.statusCode = 409;
    throw error;
  }

  const doctorFee = doctor.opdConsultationFee;
  const hasDoctorFee = doctorFee !== null
    && doctorFee !== undefined
    && doctorFee !== ''
    && Number.isFinite(Number(doctorFee))
    && Number(doctorFee) >= 0;
  const hospitalFee = Number(hospitalCharges?.opdCharges?.consultationFee || 0);
  const consultationFee = hasDoctorFee ? Number(doctorFee) : hospitalFee;
  const source = hasDoctorFee ? 'doctor' : 'hospital';
  const doctorName = [doctor.firstName, doctor.lastName].filter(Boolean).join(' ').trim();

  const normalized = (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
  const consultationIndex = normalized.findIndex((item) =>
    item?.item_type === 'Consultation' || /opd\s+consultation\s+fee/i.test(String(item?.description || ''))
  );
  const consultationLine = {
    ...(consultationIndex >= 0 ? normalized[consultationIndex] : {}),
    description: `OPD Consultation Fee (Dr. ${doctorName || 'Doctor'} — ${source === 'doctor' ? 'doctor rate' : 'hospital default'})`,
    amount: consultationFee,
    quantity: 1,
    item_type: 'Consultation',
    pricing_snapshot: {
      pricingSource: source,
      doctorId: doctor._id,
      doctorOpdConsultationFee: hasDoctorFee ? Number(doctorFee) : null,
      hospitalDefaultConsultationFee: hospitalFee
    }
  };
  if (consultationIndex >= 0) normalized[consultationIndex] = consultationLine;
  else normalized.push(consultationLine);

  // If the front desk chose to charge registration, make that line authoritative too.
  const registrationIndex = normalized.findIndex((item) =>
    item?.item_type === 'Registration Fee' || /opd\s+registration\s+fee/i.test(String(item?.description || ''))
  );
  if (registrationIndex >= 0) {
    normalized[registrationIndex] = {
      ...normalized[registrationIndex],
      description: 'OPD Registration Fee',
      amount: Number(hospitalCharges?.opdCharges?.registrationFee || 0),
      quantity: 1,
      item_type: 'Registration Fee'
    };
  }

  // Recalculate the configured OPD discount after replacing the consultation rate.
  const discountIndex = normalized.findIndex((item) => /^discount$/i.test(String(item?.description || '').trim()));
  const discountValue = Number(hospitalCharges?.opdCharges?.discountValue || 0);
  if (discountValue > 0) {
    const registrationAmount = registrationIndex >= 0 ? Number(normalized[registrationIndex].amount || 0) : 0;
    const discountBase = registrationAmount + consultationFee;
    const discountAmount = hospitalCharges?.opdCharges?.discountType === 'Percentage'
      ? (discountBase * discountValue) / 100
      : discountValue;
    const discountLine = {
      ...(discountIndex >= 0 ? normalized[discountIndex] : {}),
      description: 'Discount',
      amount: -Math.max(0, Number(discountAmount || 0)),
      quantity: 1,
      item_type: 'Other',
      pricing_snapshot: {
        pricingSource: 'hospital',
        discountType: hospitalCharges?.opdCharges?.discountType || 'Fixed',
        discountValue
      }
    };
    if (discountIndex >= 0) normalized[discountIndex] = discountLine;
    else normalized.push(discountLine);
  } else if (discountIndex >= 0) {
    normalized.splice(discountIndex, 1);
  }

  return {
    items: normalized,
    pricing: { consultationFee, source, doctorId: doctor._id }
  };
}


async function createCanonicalAppointmentBilling(req, payload) {
  const hospitalId = requestHospitalId(req);
  const appointment = await Appointment.findOne({
    _id: payload.appointment_id,
    hospital_id: hospitalId,
    is_active: { $ne: false }
  }).lean();
  if (!appointment) {
    const error = new Error('Active appointment not found for this hospital');
    error.statusCode = 404;
    throw error;
  }
  if (String(appointment.patient_id) !== String(payload.patient_id)) {
    const error = new Error('Bill patient does not match the appointment patient');
    error.statusCode = 409;
    throw error;
  }

  const rootKey = String(
    req.get('Idempotency-Key') || payload.idempotencyKey || `appointment:${appointment._id}:billing`
  ).trim();
  const existingInvoice = await Invoice.findOne({
    hospital_id: hospitalId,
    idempotency_key: `${rootKey}:invoice`
  });
  if (existingInvoice) {
    const bills = await Bill.find({ _id: { $in: existingInvoice.bill_ids?.length ? existingInvoice.bill_ids : [existingInvoice.bill_id].filter(Boolean) } });
    return { bill: bills[0] || null, bills, invoice: existingInvoice, alreadyExists: true };
  }

  const unsafeClinicalItems = (payload.items || []).filter((item) =>
    ['Procedure', 'Lab Test', 'Radiology'].includes(item?.item_type)
      || item?.procedure_id || item?.lab_test_id || item?.radiology_test_id
  );
  if (unsafeClinicalItems.length) {
    const error = new Error('Clinical requests must post their source-linked charge through the canonical source-finance workflow');
    error.statusCode = 409;
    error.code = 'SOURCE_FINANCE_REQUIRED';
    error.canonicalEndpoint = '/api/source-finance/:sourceModule/:sourceId/charge';
    throw error;
  }

  const hospitalCharges = await HospitalCharges.findOne({
    hospital: hospitalId,
    effectiveFrom: { $lte: operationNow() },
    is_active: { $ne: false }
  }).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
  const tariff = await resolveDoctorTariff({
    hospitalId,
    doctorId: appointment.doctor_id,
    encounterType: 'OPD',
    visitType: appointment.appointment_type,
    appointmentId: appointment._id,
    serviceDate: appointment.appointment_date
  });
  const selectedMode = payload.selectedMode || payload.selectedBillingMode || appointment.selectedBillingMode;
  const created = [];
  const resolvedDiscountType = payload.discountType || payload.discount_type || (payload.discountRate || payload.discount_rate ? 'percentage' : 'fixed');
  // Percentage inputs must be explicit rates. `discount` is a monetary amount
  // in legacy appointment callers and must never be reinterpreted as a percent.
  const rawDiscountRate = resolvedDiscountType === 'percentage'
    ? Number(payload.discountRate ?? payload.discount_rate ?? payload.discountValue ?? 0)
    : 0;
  const resolvedDiscountRate = Math.max(0, Math.min(100, Number.isFinite(rawDiscountRate) ? rawDiscountRate : 0));
  let remainingFixedDiscount = resolvedDiscountType === 'fixed' ? Number(payload.discountAmount ?? payload.discount_amount ?? (payload.discountValue ?? payload.discount ?? 0)) : 0;
  const resolvedDiscountReason = payload.discountReason || payload.discount_reason;

  const sourceItems = Array.isArray(payload.items) ? payload.items : [];
  let lineNo = 0;
  for (const item of sourceItems) {
    const type = String(item.item_type || 'Other');
    let rate;
    let description = String(item.description || '').trim();
    let chargeType = type;
    let serviceType = type;
    let serviceCode;
    let pricingSnapshot;
    if (type === 'Consultation' || /consultation/i.test(description)) {
      rate = Number(tariff.amount || 0);
      description = description || 'OPD Consultation';
      chargeType = 'Consultation';
      serviceType = 'consultation';
      serviceCode = appointment.appointment_type === 'follow-up' ? 'OPD-CONS-FOLLOWUP' : 'OPD-CONS-NEW';
      pricingSnapshot = tariff.pricingSnapshot;
    } else if (type === 'Registration Fee' || /registration\s+fee/i.test(description)) {
      rate = Number(hospitalCharges?.opdCharges?.registrationFee || 0);
      description = 'OPD Registration Fee';
      chargeType = 'Registration Fee';
      serviceType = 'registration';
      serviceCode = 'OPD-REG';
    } else {
      if (!_hasActionPermission(req.user, 'pricing_override')) {
        const error = new Error('Manual OPD line pricing requires pricing override permission');
        error.statusCode = 403;
        error.code = 'MANUAL_PRICING_PERMISSION_REQUIRED';
        throw error;
      }
      rate = Number(item.amount || 0) / Math.max(1, Number(item.quantity || 1));
      if (!description) throw Object.assign(new Error('Manual bill item description is required'), { statusCode: 400 });
    }

    const allowZeroCharge = payload.allowZeroCharge === true
      && _hasActionPermission(req.user, 'pricing_override')
      && String(payload.zeroChargeReason || payload.overrideReason || '').trim();
    if (Number(rate || 0) <= 0 && !allowZeroCharge) {
      const error = new Error(`${description || chargeType || 'OPD service'} resolved to ₹0. Configure a valid tariff or use an authorised zero-charge override with a reason.`);
      error.statusCode = 409;
      error.code = 'ZERO_TARIFF_REQUIRES_OVERRIDE';
      throw error;
    }

    const lineQty = Math.max(1, Number(item.quantity || 1));
    const lineGross = rate * lineQty;
    let lineDiscountRate = 0;
    let lineDiscountAmount = 0;
    if (resolvedDiscountType === 'percentage') {
      lineDiscountRate = resolvedDiscountRate;
      lineDiscountAmount = lineGross > 0 ? Math.round((lineGross * lineDiscountRate) / 100) : 0;
    } else if (remainingFixedDiscount > 0) {
      lineDiscountAmount = Math.min(lineGross, remainingFixedDiscount);
      remainingFixedDiscount = Math.max(0, remainingFixedDiscount - lineDiscountAmount);
      lineDiscountRate = lineGross > 0 ? Math.round((lineDiscountAmount / lineGross) * 100) : 0;
    }

    const result = await patientFinancial.addOPDCharge(payload.patient_id, {
      appointmentId: appointment._id,
      description,
      chargeType,
      serviceType,
      serviceCode,
      rate,
      quantity: lineQty,
      selectedMode,
      requestedDeposit: payload.requestedDeposit,
      discountType: resolvedDiscountType,
      discountValue: resolvedDiscountType === 'percentage' ? lineDiscountRate : lineDiscountAmount,
      discountRate: lineDiscountRate,
      discountAmount: lineDiscountAmount,
      discountReason: resolvedDiscountReason,
      taxMode: payload.taxMode || payload.tax_mode,
      taxRate: payload.taxRate || payload.tax_rate,
      overrideReason: payload.billingModeOverrideReason || payload.overrideReason,
      idempotencyKey: `${rootKey}:line:${lineNo}`,
      notes: payload.notes,
      createdFrom: 'AppointmentBillingCompatibility'
    }, req.user);
    if (pricingSnapshot && result?.bill?.items?.[0]) {
      result.bill.items[0].pricing_snapshot = {
        ...(result.bill.items[0].pricing_snapshot || {}),
        doctorTariff: pricingSnapshot
      };
      await result.bill.save();
    }
    created.push(result);
    lineNo += 1;
  }

  if (!created.length) {
    const defaultRate = Number(tariff.amount || 0);
    const allowZeroCharge = payload.allowZeroCharge === true
      && _hasActionPermission(req.user, 'pricing_override')
      && String(payload.zeroChargeReason || payload.overrideReason || '').trim();
    if (defaultRate <= 0 && !allowZeroCharge) {
      const error = new Error('OPD Consultation resolved to ₹0. Configure a valid doctor tariff or use an authorised zero-charge override with a reason.');
      error.statusCode = 409;
      error.code = 'ZERO_TARIFF_REQUIRES_OVERRIDE';
      throw error;
    }
    let lineDiscountRate = 0;
    let lineDiscountAmount = 0;
    if (resolvedDiscountType === 'percentage') {
      lineDiscountRate = resolvedDiscountRate;
      lineDiscountAmount = defaultRate > 0 ? Math.round((defaultRate * lineDiscountRate) / 100) : 0;
    } else {
      lineDiscountAmount = Math.min(defaultRate, remainingFixedDiscount);
      lineDiscountRate = defaultRate > 0 ? Math.round((lineDiscountAmount / defaultRate) * 100) : 0;
    }

    const result = await patientFinancial.addOPDCharge(payload.patient_id, {
      appointmentId: appointment._id,
      description: 'OPD Consultation',
      chargeType: 'Consultation',
      serviceType: 'consultation',
      serviceCode: appointment.appointment_type === 'follow-up' ? 'OPD-CONS-FOLLOWUP' : 'OPD-CONS-NEW',
      rate: defaultRate,
      quantity: 1,
      selectedMode,
      requestedDeposit: payload.requestedDeposit,
      discountType: resolvedDiscountType,
      discountValue: resolvedDiscountType === 'percentage' ? lineDiscountRate : lineDiscountAmount,
      discountRate: lineDiscountRate,
      discountAmount: lineDiscountAmount,
      discountReason: resolvedDiscountReason,
      taxMode: payload.taxMode || payload.tax_mode,
      taxRate: payload.taxRate || payload.tax_rate,
      idempotencyKey: `${rootKey}:line:0`,
      createdFrom: 'AppointmentBillingCompatibility'
    }, req.user);
    created.push(result);
  }

  const bills = created.map((row) => row.bill).filter(Boolean);
  const requiredNow = money(created.reduce((sum, row) => sum + Number(row.financialPolicy?.requiredNow || 0), 0));
  const primaryBill = bills[0];
  const explicitApprovalPending = String(payload.status || '').toLowerCase() === 'discount pending approval';
  let discountApprovalPending = bills.some((bill) =>
    bill.status === 'Discount Pending Approval' || bill.discount_approval?.status === 'PENDING'
  );

  // Compatibility callers may explicitly request admin approval. Canonical
  // addOPDCharge already creates the request when policy requires approval;
  // only create a record here when the caller explicitly asked for approval
  // and no canonical pending request exists yet.
  if (explicitApprovalPending && !discountApprovalPending && primaryBill && Number(primaryBill.discount || payload.discount || 0) > 0) {
    primaryBill.status = 'Discount Pending Approval';
    primaryBill.discount_approval = {
      status: 'PENDING',
      requested_by: req.user?._id,
      requested_at: new Date(),
      discount_amount: Number(primaryBill.discount || payload.discount || 0),
      discount_percentage: Number(payload.discount_rate ?? payload.discountRate ?? 0),
      reason: payload.discount_reason || payload.discountReason || 'Staff discount request'
    };
    await primaryBill.save();
    discountApprovalPending = true;

    try {
      const ApprovalRequest = require('../models/ApprovalRequest');
      const existingApproval = await ApprovalRequest.findOne({
        hospitalId,
        billId: primaryBill._id,
        requestType: 'DISCOUNT_APPROVAL',
        status: 'Pending'
      });
      if (!existingApproval) {
        await ApprovalRequest.create({
          hospitalId,
          requestType: 'DISCOUNT_APPROVAL',
          patientId: payload.patient_id,
          appointmentId: appointment._id,
          billId: primaryBill._id,
          details: {
            billId: primaryBill._id,
            billNumber: primaryBill.bill_number,
            appointmentId: appointment._id,
            totalBillAmount: Number(primaryBill.subtotal || primaryBill.gross_amount || primaryBill.total_amount || 0),
            totalDueAmount: Number(primaryBill.balance_due != null ? primaryBill.balance_due : primaryBill.total_amount || 0),
            discountAmount: Number(primaryBill.discount || payload.discount || 0),
            requestedDiscountPercentage: Number(payload.discount_rate ?? payload.discountRate ?? (primaryBill.subtotal ? Math.round((Number(primaryBill.discount) / Number(primaryBill.subtotal)) * 100) : 0)),
            reason: payload.discount_reason || payload.discountReason || 'Staff discount request',
            encounterType: 'OPD'
          },
          requestedBy: req.user?._id,
          status: 'Pending'
        });
      }
    } catch (apprErr) {
      console.warn('Could not create ApprovalRequest record for OPD discount:', apprErr.message);
    }
  }

  if (discountApprovalPending) {
    return {
      bill: primaryBill || null,
      bills,
      invoice: null,
      payment: null,
      financialPolicy: created.map((row) => row.financialPolicy),
      requiredNow,
      discountApprovalPending: true,
      alreadyExists: false
    };
  }

  const invoiceResult = await patientFinancial.issueOPDInvoice(payload.patient_id, {
    billIds: bills.map((bill) => bill._id),
    idempotencyKey: `${rootKey}:invoice`,
    notes: payload.notes || `Appointment ${appointment._id} invoice`
  }, req.user);
  const invoice = invoiceResult.invoice;
  const explicitPayment = payload.paymentAmount ?? payload.amountPaid ?? payload.paid_amount ?? payload.paidAmount;
  const isPaidOrPartial = ['paid', 'partially paid', 'partial', 'discount pending approval'].includes(String(payload.status || '').toLowerCase());
  const shouldCollect = explicitPayment !== undefined || isPaidOrPartial;
  if (shouldCollect && !_hasActionPermission(req.user, 'settlement')) {
    const error = new Error('Settlement permission is required when direct appointment billing also collects patient money.');
    error.statusCode = 403;
    error.code = 'SETTLEMENT_PERMISSION_REQUIRED';
    throw error;
  }
  let payment = null;
  if (shouldCollect && Number(invoice.balance_due || 0) > 0) {
    const amountToCollect = explicitPayment !== undefined
      ? money(Math.min(Number(explicitPayment || 0), Number(invoice.balance_due || 0)))
      : (String(payload.status || '').toLowerCase() === 'paid' ? money(Number(invoice.balance_due || 0)) : 0);
    if (amountToCollect > 0) {
      payment = await patientFinancial.recordOPDPayment(payload.patient_id, {
        invoiceId: invoice._id,
        amount: amountToCollect,
        amountApplied: amountToCollect,
        amountTendered: amountToCollect,
        paymentMethod: payload.payment_method || 'Cash',
        reference: payload.transaction_id,
        idempotencyKey: `${rootKey}:payment`
      }, req.user);
    }
  }


  const refreshedInvoice = await Invoice.findOne({ _id: invoice._id, hospital_id: hospitalId });
  return {
    bill: bills[0] || null,
    bills,
    invoice: refreshedInvoice || invoice,
    payment,
    financialPolicy: created.map((row) => row.financialPolicy),
    requiredNow,
    alreadyExists: false
  };
}

// ========== MAIN CREATE BILL FUNCTION ==========
exports.createBill = async (req, res) => {
  try {
    const {
      patient_id,
      appointment_id,
      admission_id,
      prescription_id,
      payment_method,
      items,
      status = 'Draft',
      total_amount,
      subtotal,
      tax_amount = 0,
      discount = 0,
      notes,
      transaction_id
    } = req.body;


    if (!patient_id || !payment_method) {
      return res.status(400).json({ error: 'Patient ID and Payment Method are required' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one bill item is required' });
    }

    if (appointment_id && !admission_id) {
      const result = await createCanonicalAppointmentBilling(req, {
        ...req.body,
        patient_id,
        appointment_id,
        payment_method,
        items,
        status,
        transaction_id,
        notes
      });
      return res.status(result.alreadyExists ? 200 : 201).json({ success: true, ...result });
    }
    if (admission_id) {
      return res.status(409).json({
        success: false,
        code: 'LEGACY_IPD_BILLING_DISABLED',
        error: 'Direct IPD Bill creation is retired. Add a canonical IPD/source charge and invoice it through Finance.',
        canonicalChargeEndpoint: `/api/finance/ipd/${admission_id}/charges`,
        canonicalInvoiceEndpoint: `/api/finance/ipd/${admission_id}/invoices`
      });
    }

    if (['Partially Paid', 'Partial'].includes(String(status || '').trim())) {
      return res.status(400).json({
        success: false,
        code: 'PARTIAL_PAYMENT_REQUIRES_LEDGER',
        error: 'Do not set Partially Paid manually. Create the invoice as Pending, then record the actual partial amount through the canonical payment workflow.'
      });
    }

    const hospitalId = requestHospitalId(req);

    // Remaining direct /billing use is a genuine Finance manual-adjustment path.
    // Clinical source documents must never use it, and manual pricing requires
    // an explicit pricing-override capability plus an auditable reason.
    const unsafeClinicalItems = (items || []).filter((item) =>
      ['Procedure', 'Lab Test', 'Radiology'].includes(item?.item_type)
        || item?.procedure_id || item?.lab_test_id || item?.radiology_test_id
    );
    if (unsafeClinicalItems.length) {
      return res.status(409).json({
        success: false,
        code: 'SOURCE_FINANCE_REQUIRED',
        error: 'Clinical requests must use the canonical source-finance workflow',
        canonicalEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge'
      });
    }
    if (!_hasActionPermission(req.user, 'pricing_override')) {
      return res.status(403).json({
        success: false,
        code: 'MANUAL_PRICING_PERMISSION_REQUIRED',
        error: 'Direct manual billing requires pricing override permission'
      });
    }
    const pricingOverrideReason = String(req.body?.pricingOverrideReason || req.body?.overrideReason || notes || '').trim();
    if (!pricingOverrideReason) {
      return res.status(400).json({ success: false, code: 'PRICING_OVERRIDE_REASON_REQUIRED', error: 'Manual pricing reason is required' });
    }

    let billingItems = items.map((item) => ({ ...item }));
    if (appointment_id && !admission_id) {
      const priced = await applyAuthoritativeOpdAppointmentPricing({
        hospitalId,
        patientId: patient_id,
        appointmentId: appointment_id,
        items: billingItems
      });
      billingItems = priced.items;
    }

    // Even manual Finance billing never trusts browser subtotal/total. The
    // manually-entered line prices are the audited exception; discount/tax still
    // pass through hospital policy/ranges and are snapshotted on the bill.
    const calculatedSubtotal = money(billingItems.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const manualPolicy = await resolveFinancialPolicy({
      hospitalId,
      user: req.user,
      encounterType: 'OPD',
      serviceType: 'other',
      patientLiability: calculatedSubtotal,
      sponsorLiability: 0,
      contractedAmount: calculatedSubtotal,
      selectedMode: req.body?.selectedMode || req.body?.selectedBillingMode,
      requestedDeposit: req.body?.requestedDeposit,
      adjustments: {
        discountType: req.body?.discountType || (Number(discount || 0) ? 'fixed' : undefined),
        discountAmount: req.body?.discountAmount ?? (Number(discount || 0) || undefined),
        discountRate: req.body?.discountRate,
        discountValue: req.body?.discountValue,
        discountReason: req.body?.discountReason || pricingOverrideReason,
        taxMode: req.body?.taxMode,
        taxRate: req.body?.taxRate,
        taxReason: req.body?.taxReason
      },
      overrideReason: req.body?.billingModeOverrideReason
    });
    const calculatedTotal = money(manualPolicy.amounts.totalLiability);
    const resolvedTaxAmount = money(manualPolicy.amounts.taxAmount || 0);
    const resolvedDiscountAmount = money(manualPolicy.amounts.discountAmount || 0);
    const manualKey = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
    if (!manualKey) {
      return res.status(400).json({ success: false, code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'Manual billing requires an idempotency key' });
    }
    const existingManualBill = await Bill.findOne({ hospital_id: hospitalId, idempotency_key: manualKey });
    if (existingManualBill) {
      const existingInvoice = existingManualBill.invoice_id ? await Invoice.findOne({ _id: existingManualBill.invoice_id, hospital_id: hospitalId }) : null;
      return res.json({ success: true, reused: true, bill: existingManualBill, invoice: existingInvoice });
    }

    const billNumber = await nextFinancialNumber({
      documentType: 'BILL',
      hospitalId
    });

    const bill = new Bill({
      hospital_id: hospitalId,
      bill_number: billNumber,
      document_stage: status === 'Draft' ? 'DRAFT' : 'GENERATED',
      patient_id,
      appointment_id,
      admission_id,
      prescription_id,
      total_amount: calculatedTotal,
      subtotal: calculatedSubtotal,
      tax_amount: resolvedTaxAmount,
      discount: resolvedDiscountAmount,
      payment_method: 'Pending',
      status: status === 'Draft' ? 'Draft' : (calculatedTotal <= 0 ? 'Paid' : 'Pending'),
      paid_amount: 0,
      payments: [],
      items: billingItems.map(item => ({
        description: item.description,
        amount: Number(item.amount || 0),
        quantity: item.quantity || 1,
        item_type: item.item_type || 'Other',
        procedure_code: item.procedure_code,
        procedure_id: item.procedure_id,
        lab_test_code: item.lab_test_code,
        lab_test_id: item.lab_test_id,
        radiology_test_code: item.radiology_test_code,
        radiology_test_id: item.radiology_test_id,
        prescription_id: item.prescription_id,
        admission_id: admission_id,
        pricing_snapshot: {
          ...(item.pricing_snapshot || {}),
          manualPricingOverride: { reason: pricingOverrideReason, actorId: req.user?._id },
          financialPolicy: manualPolicy.policySnapshot,
          tax: { mode: manualPolicy.amounts.taxMode, rate: manualPolicy.amounts.taxRate, amount: manualPolicy.amounts.taxAmount },
          discount: { type: manualPolicy.amounts.discountType, rate: manualPolicy.amounts.discountRate, amount: manualPolicy.amounts.discountAmount }
        }
      })),
      notes: notes || pricingOverrideReason,
      idempotency_key: manualKey,
      created_by: req.user?._id
    });

    await bill.save();

    // ========== CREATE IPD CHARGES FOR EACH ITEM (if admission_id exists) ==========
    const createdCharges = [];
    if (admission_id) {
      for (const [itemIndex, item] of billingItems.entries()) {
        let chargeType = null;
        let sourceModule = null;
        let sourceId = null;
        let chargeDescription = item.description;
        let rate = item.amount / (item.quantity || 1);

        if (item.item_type === 'Procedure') {
          chargeType = 'Procedure';
          sourceModule = 'Procedure';
          sourceId = item.procedure_id;
          chargeDescription = `Procedure: ${item.description}`;
        } else if (item.item_type === 'Lab Test') {
          chargeType = 'Lab Test';
          sourceModule = 'Lab';
          sourceId = item.lab_test_id;
          chargeDescription = `Lab Test: ${item.description}`;
        } else if (item.item_type === 'Radiology') {
          chargeType = 'Radiology';
          sourceModule = 'Radiology';
          sourceId = item.radiology_test_id;
          chargeDescription = `Radiology: ${item.description}`;
        } else if (item.item_type === 'Medicine') {
          chargeType = 'Pharmacy';
          sourceModule = 'Pharmacy';
          sourceId = item.sale_id || item.pharmacy_sale_id || bill._id;
          chargeDescription = `Medicine: ${item.description}`;
        } else if (item.item_type === 'Consultation') {
          chargeType = 'Consultation';
          sourceModule = 'Manual';
          chargeDescription = `Consultation: ${item.description}`;
        } else {
          chargeType = 'Miscellaneous';
          sourceModule = 'Manual';
          chargeDescription = item.description;
        }

        if (chargeType && sourceModule) {
          const charge = await createOrUpdateIPDCharge({
            admissionId: admission_id,
            patientId: patient_id,
            chargeType,
            description: chargeDescription,
            quantity: item.quantity || 1,
            rate: rate,
            sourceModule,
            sourceId: sourceId || bill._id,
            sourceLineKey: makeChargeLineKey(bill._id, itemIndex, sourceId || bill._id),
            isAutoGenerated: true,
            addedBy: req.user?._id,
            notes: notes || `Billed via ${sourceModule} module`
          });
          if (charge) createdCharges.push(charge);
        }
      }
      
      // Update admission totals after creating charges
      await updateAdmissionTotals(admission_id);
    }

    let invoice = null;
    if (status !== 'Draft') {
      const issued = await patientFinancial.issueOPDInvoice(patient_id, {
        billIds: [bill._id],
        idempotencyKey: `${manualKey}:invoice`,
        notes: notes || pricingOverrideReason
      }, req.user);
      invoice = issued.invoice;
      if (status === 'Paid' && calculatedTotal > 0) {
        await patientFinancial.recordOPDPayment(patient_id, {
          invoiceId: invoice._id,
          amount: calculatedTotal,
          paymentMethod: payment_method,
          reference: transaction_id,
          notes: notes || pricingOverrideReason,
          idempotencyKey: `${manualKey}:payment`
        }, req.user);
        invoice = await Invoice.findById(invoice._id);
      }
    }

    const populatedBill = await Bill.findById(bill._id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('admission_id', 'admissionNumber admissionDate')
      .populate('prescription_id', 'prescription_number diagnosis procedure_requests lab_test_requests radiology_test_requests')
      .populate('invoice_id', 'invoice_number status')
      .populate('created_by', 'name');

    res.status(201).json({
      success: true,
      message: 'Bill created successfully',
      bill: populatedBill,
      invoice: invoice,
      ipdChargesCreated: createdCharges.length
    });
  } catch (err) {
    console.error('Error creating bill:', err);
    res.status(400).json({ error: err.message });
  }
};

// ========== REMAINING FUNCTIONS (keep as is from your original) ==========

exports.updateBillStatus = async (req, res) => {
  try {
    const bill = await Bill.findOne(billScope(req, { _id: req.params.id }));
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const requestedStatus = String(req.body?.status || '').trim();
    const attemptsCollection = req.body?.paid_amount !== undefined
      || req.body?.payment_method
      || req.body?.payment_reference
      || ['Paid', 'Partially Paid', 'Partial', 'Refunded', 'Partially Refunded'].includes(requestedStatus);

    if (attemptsCollection) {
      return res.status(409).json({
        success: false,
        code: 'CANONICAL_SETTLEMENT_REQUIRED',
        error: 'Bill status is not a payment API. Collect or refund money through the canonical Finance settlement workflow.',
        canonicalWorkspaceEndpoint: `/api/finance/patients/${bill.patient_id}/workspace`,
        canonicalPaymentEndpoint: `/api/finance/patients/${bill.patient_id}/payments`
      });
    }

    const isInvoiced = Boolean(bill.invoice_id || (bill.invoice_ids || []).length || bill.document_stage === 'INVOICED');
    if (isInvoiced && requestedStatus && requestedStatus !== bill.status) {
      return res.status(409).json({
        success: false,
        code: 'INVOICED_BILL_IMMUTABLE',
        error: 'This bill belongs to an issued invoice. Change financial state through invoice settlement, credit-note, refund or void workflows instead.'
      });
    }

    const allowedAdministrativeStatuses = new Set(['Draft', 'Pending', 'Cancelled']);
    if (requestedStatus && !allowedAdministrativeStatuses.has(requestedStatus)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_BILL_ADMIN_STATUS',
        error: 'Unsupported administrative bill status.'
      });
    }

    if (requestedStatus) bill.status = requestedStatus;
    if (req.body?.notes) {
      bill.notes = bill.notes
        ? `${bill.notes}
${operationNow().toLocaleDateString()}: ${req.body.notes}`
        : `${operationNow().toLocaleDateString()}: ${req.body.notes}`;
    }
    if (requestedStatus === 'Cancelled') bill.document_stage = 'VOID';
    await bill.save();
    return res.json({ success: true, message: 'Bill administrative status updated', bill });
  } catch (err) {
    console.error('Error updating bill status:', err);
    return res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
  }
};

exports.getAllBills = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      patient_id,
      has_procedures,
      has_lab_tests,
      has_radiology,
      start_date,
      end_date,
      includeDeleted = false
    } = req.query;

    const filter = billScope(req);
    
    if (!includeDeleted) {
      filter.is_deleted = { $ne: true };
    }
    
    if (status) filter.status = status;
    if (patient_id) filter.patient_id = patient_id;

    if (has_procedures === 'true') {
      filter['items.item_type'] = 'Procedure';
    }
    if (has_lab_tests === 'true') {
      filter['items.item_type'] = 'Lab Test';
    }
    if (has_radiology === 'true') {
      filter['items.item_type'] = 'Radiology';
    }

    if (start_date && end_date) {
      filter.generated_at = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const bills = await Bill.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('admission_id', 'admissionNumber admissionDate')
      .populate('prescription_id', 'prescription_number')
      .populate('invoice_id', 'invoice_number total')
      .sort({ generated_at: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Bill.countDocuments(filter);

    const statsFilter = { ...filter, is_deleted: { $ne: true } };
    
    const totalRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...statsFilter } },
      { $group: { _id: null, total: { $sum: '$total_amount' } } }
    ]);

    const procedureRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...statsFilter } },
      { $unwind: '$items' },
      { $match: { 'items.item_type': 'Procedure' } },
      { $group: { _id: null, total: { $sum: '$items.amount' } } }
    ]);

    const labTestRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...statsFilter } },
      { $unwind: '$items' },
      { $match: { 'items.item_type': 'Lab Test' } },
      { $group: { _id: null, total: { $sum: '$items.amount' } } }
    ]);

    const radiologyRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...statsFilter } },
      { $unwind: '$items' },
      { $match: { 'items.item_type': 'Radiology' } },
      { $group: { _id: null, total: { $sum: '$items.amount' } } }
    ]);

    res.json({
      success: true,
      bills,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      statistics: {
        totalRevenue: totalRevenue[0]?.total || 0,
        procedureRevenue: procedureRevenue[0]?.total || 0,
        labTestRevenue: labTestRevenue[0]?.total || 0,
        radiologyRevenue: radiologyRevenue[0]?.total || 0,
        totalBills: total
      }
    });
  } catch (err) {
    console.error('Error fetching bills:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getBillLedger = async (req, res) => {
  try {
    const bill = await Bill.findOne(billScope(req, {
      _id: req.params.id,
      is_deleted: { $ne: true }
    }))
      .populate('patient_id', 'first_name last_name patientId phone address age gender')
      .populate({
        path: 'appointment_id',
        select: 'appointment_date type doctor_id department_id',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName name' },
          { path: 'department_id', select: 'name' }
        ]
      })
      .populate({
        path: 'admission_id',
        select: 'admissionNumber admissionDate status primaryDoctorId departmentId wardId roomId bedId',
        populate: [
          { path: 'primaryDoctorId', select: 'firstName lastName name' },
          { path: 'departmentId', select: 'name' },
          { path: 'wardId', select: 'name wardName' },
          { path: 'roomId', select: 'roomNumber name' },
          { path: 'bedId', select: 'bedNumber bed_number' }
        ]
      })
      .populate('invoice_id');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found in this hospital' });
    }

    const invoice = bill.invoice_id || null;
    const entries = buildOpdLedgerEntries(bill, invoice);
    const totalBilled = money(invoice?.total ?? bill.total_amount);
    const totalPaid = money(invoice?.amount_paid ?? bill.paid_amount);
    const totalAdjustments = money((bill.settlement_discount_amount || 0) + (bill.credit_note_amount || 0));
    const balanceDue = money(invoice?.balance_due ?? bill.balance_due ?? Math.max(0, totalBilled - totalPaid - totalAdjustments));

    return res.json({
      success: true,
      patient: bill.patient_id,
      appointment: bill.appointment_id,
      admission: bill.admission_id,
      bill,
      invoice,
      entries,
      totals: {
        totalBilled,
        totalPaid,
        totalAdjustments,
        balanceDue
      }
    });
  } catch (err) {
    console.error('Error fetching OPD bill ledger:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.getBillById = async (req, res) => {
  try {
    const bill = await Bill.findOne(billScope(req, { _id: req.params.id }))
      .populate('patient_id', 'first_name last_name patientId phone address age gender')
      .populate({
        path: 'appointment_id',
        select: 'appointment_date type doctor_id department_id',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName name' },
          { path: 'department_id', select: 'name' }
        ]
      })
      .populate({
        path: 'admission_id',
        select: 'admissionNumber admissionDate status primaryDoctorId departmentId wardId roomId bedId',
        populate: [
          { path: 'primaryDoctorId', select: 'firstName lastName name' },
          { path: 'departmentId', select: 'name' },
          { path: 'wardId', select: 'name wardName' },
          { path: 'roomId', select: 'roomNumber name' },
          { path: 'bedId', select: 'bedNumber bed_number' }
        ]
      })
      .populate('prescription_id', 'prescription_number diagnosis procedure_requests lab_test_requests radiology_test_requests')
      .populate('invoice_id')
      .populate('created_by', 'name')
      .populate('deleted_by', 'name')
      .populate('deletion_request.requested_by', 'name')
      .populate('deletion_request.reviewed_by', 'name');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    let procedures = [];
    let lab_tests = [];
    let radiology_tests = [];

    if (bill.prescription_id) {
      if (bill.prescription_id.procedure_requests) {
        procedures = bill.prescription_id.procedure_requests;
      }
      if (bill.prescription_id.lab_test_requests) {
        lab_tests = bill.prescription_id.lab_test_requests;
      }
      if (bill.prescription_id.radiology_test_requests) {
        radiology_tests = bill.prescription_id.radiology_test_requests;
      }
    }

    res.json({
      success: true,
      bill,
      procedures,
      lab_tests,
      radiology_tests
    });
  } catch (err) {
    console.error('Error fetching bill:', err);
    res.status(500).json({ error: err.message });
  }
};

// Generate bill for procedures (using procedure_requests from prescription)
exports.generateProcedureBill = async (req, res) => {
  return res.status(409).json({
    success: false,
    code: 'SOURCE_FINANCE_REQUIRED',
    error: 'Procedure billing is source-owned. Post the clinical request through source-finance and let the canonical OPD/IPD invoice workflow issue the patient document.',
    canonicalChargeEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge',
    canonicalOpdInvoiceEndpoint: '/api/finance/patients/:patientId/invoices',
    canonicalIpdInvoiceEndpoint: '/api/finance/ipd/:admissionId/invoices'
  });
};

exports.generateLabTestBill = async (req, res) => {
  return res.status(409).json({
    success: false,
    code: 'SOURCE_FINANCE_REQUIRED',
    error: 'Lab billing is source-owned. Post the clinical request through source-finance and let the canonical OPD/IPD invoice workflow issue the patient document.',
    canonicalChargeEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge',
    canonicalOpdInvoiceEndpoint: '/api/finance/patients/:patientId/invoices',
    canonicalIpdInvoiceEndpoint: '/api/finance/ipd/:admissionId/invoices'
  });
};

exports.generateRadiologyBill = async (req, res) => {
  return res.status(409).json({
    success: false,
    code: 'SOURCE_FINANCE_REQUIRED',
    error: 'Radiology billing is source-owned. Post the clinical request through source-finance and let the canonical OPD/IPD invoice workflow issue the patient document.',
    canonicalChargeEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge',
    canonicalOpdInvoiceEndpoint: '/api/finance/patients/:patientId/invoices',
    canonicalIpdInvoiceEndpoint: '/api/finance/ipd/:admissionId/invoices'
  });
};

exports.adminDeleteBill = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const bill = await Bill.findOne(billScope(req, { _id: id })).populate('patient_id').populate('invoice_id');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const issuedContext = await requireIssuedDeletionAuthority(req, res, bill);
    if (!issuedContext.allowed) return;
    if (issuedContext.isIssued && !String(reason || '').trim()) {
      return res.status(400).json({
        success: false,
        code: 'DELETION_REASON_REQUIRED',
        error: 'A detailed reason is required for emergency deletion of an issued Bill / Invoice.'
      });
    }
    let financeResolution = null;
    if (issuedContext.isIssued) {
      financeResolution = await requireIssuedDeletionFinanceResolved(req, res, bill);
      if (!financeResolution.allowed) return;
    }

    const deletionInfo = {
      deleted_by: req.user?._id,
      deleted_by_name: req.user?.name || 'Authorized user',
      deleted_at: new Date(),
      deletion_reason: String(reason || (issuedContext.isIssued ? '' : 'Authorized direct deletion')).trim(),
      bill_amount: bill.total_amount,
      bill_id: bill._id,
      patient_name: bill.patient_id ? 
        `${bill.patient_id.first_name} ${bill.patient_id.last_name}` : 'Unknown',
      invoice_number: bill.invoice_id?.invoice_number,
      sponsor_override: Boolean(financeResolution?.sponsorOverride),
      sponsor_override_reason: financeResolution?.sponsorOverrideReason,
      unresolved_sponsor_at_archive: money(financeResolution?.unresolvedSponsor || 0),
      active_sponsor_claims_at_archive: financeResolution?.activeSponsorClaims || []
    };

    const archivedInvoiceCount = issuedContext.isIssued
      ? await archiveInvoicesLinkedToBill(req, bill, deletionInfo)
      : 0;

    if (bill.prescription_id) {
      const prescription = await Prescription.findById(bill.prescription_id);
      if (prescription) {
        let needsUpdate = false;
        
        for (const item of bill.items) {
          if (item.item_type === 'Procedure' && item.procedure_id) {
            const procIndex = prescription.procedure_requests?.findIndex(
              p => p._id.toString() === item.procedure_id.toString()
            );
            if (procIndex !== -1) {
              prescription.procedure_requests[procIndex].is_billed = false;
              prescription.procedure_requests[procIndex].invoice_id = null;
              needsUpdate = true;
            }
          }
          
          if (item.item_type === 'Lab Test' && item.lab_test_id) {
            const testIndex = prescription.lab_test_requests?.findIndex(
              t => t._id.toString() === item.lab_test_id.toString()
            );
            if (testIndex !== -1) {
              prescription.lab_test_requests[testIndex].is_billed = false;
              prescription.lab_test_requests[testIndex].invoice_id = null;
              needsUpdate = true;
            }
          }
          
          if (item.item_type === 'Radiology' && item.radiology_test_id) {
            const radIndex = prescription.radiology_test_requests?.findIndex(
              r => r._id.toString() === item.radiology_test_id.toString()
            );
            if (radIndex !== -1) {
              prescription.radiology_test_requests[radIndex].is_billed = false;
              prescription.radiology_test_requests[radIndex].invoice_id = null;
              needsUpdate = true;
            }
          }
        }
        
        if (needsUpdate) {
          await prescription.save();
        }
      }
    }

    bill.is_deleted = true;
    bill.is_active = false;
    bill.deleted_at = deletionInfo.deleted_at;
    bill.deleted_by = req.user?._id || null;
    bill.deletion_reason = deletionInfo.deletion_reason;
    await bill.save();

    res.json({
      success: true,
      message: issuedContext.isIssued
        ? 'Issued Bill and linked Invoice(s) emergency-archived successfully'
        : 'Unissued bill archived successfully',
      emergencyIssuedDeletion: issuedContext.isIssued,
      archivedInvoiceCount,
      deletion_info: deletionInfo
    });
  } catch (err) {
    console.error('Error in adminDeleteBill:', err);
    res.status(500).json({ error: err.message });
  }
};

// Request deletion (staff)
exports.requestBillDeletion = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Deletion reason is required' });
    }

    const bill = await Bill.findOne(billScope(req, { _id: id }));

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    if (bill.is_deleted) {
      return res.status(400).json({ error: 'Bill is already deleted' });
    }

    const issuedContext = await issuedBillDeletionContext(req, bill);

    if (bill.deletion_request && bill.deletion_request.status === 'pending') {
      return res.status(400).json({ 
        error: 'A deletion request is already pending for this bill',
        request: bill.deletion_request
      });
    }

    bill.deletion_request = {
      requested_by: req.user._id,
      requested_at: new Date(),
      reason: reason,
      status: 'pending'
    };

    await bill.save();

    if (issuedContext.isIssued) {
      await markInvoicesLinkedToBillForDeletionRequest(req, bill, bill._id);
    }

    res.json({
      success: true,
      message: issuedContext.isIssued
        ? 'Emergency issued-document deletion request submitted. An authorized administrator must approve it.'
        : 'Deletion request submitted successfully. Waiting for admin approval.',
      requiresIssuedDeleteAuthority: issuedContext.isIssued,
      bill
    });
  } catch (err) {
    console.error('Error requesting bill deletion:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get pending deletion requests (admin)
exports.getPendingDeletionRequests = async (req, res) => {
  try {
    const bills = await Bill.find(billScope(req, {
      'deletion_request.status': 'pending',
      is_deleted: false
    }))
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date')
      .populate('admission_id', 'admissionNumber')
      .populate('invoice_id', 'invoice_number total')
      .populate('deletion_request.requested_by', 'name email')
      .sort({ 'deletion_request.requested_at': -1 });

    res.json({
      success: true,
      count: bills.length,
      requests: bills
    });
  } catch (err) {
    console.error('Error fetching deletion requests:', err);
    res.status(500).json({ error: err.message });
  }
};

// Review deletion request (admin)
exports.reviewDeletionRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, review_notes } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use "approve" or "reject"' });
    }

    const bill = await Bill.findOne(billScope(req, { _id: id })).populate('invoice_id');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    if (!bill.deletion_request || bill.deletion_request.status !== 'pending') {
      return res.status(400).json({ error: 'No pending deletion request found for this bill' });
    }

    const issuedContext = await issuedBillDeletionContext(req, bill);
    if (action === 'approve' && issuedContext.isIssued && !canEmergencyDeleteIssuedDocument(req)) {
      return res.status(403).json({
        success: false,
        code: 'ISSUED_DOCUMENT_DELETE_PERMISSION_REQUIRED',
        error: 'Approving deletion of an issued Bill / Invoice requires the "Emergency delete issued Bill / Invoice" permission.',
        requiredAction: 'billing_delete_issued_document'
      });
    }
    if (action === 'approve' && issuedContext.isIssued) {
      const financeResolution = await requireIssuedDeletionFinanceResolved(req, res, bill);
      if (!financeResolution.allowed) return;
    }

    bill.deletion_request.status = action === 'approve' ? 'approved' : 'rejected';
    bill.deletion_request.reviewed_by = req.user._id;
    bill.deletion_request.reviewed_at = new Date();
    if (review_notes) {
      bill.deletion_request.review_notes = review_notes;
    }

    if (action === 'reject' && issuedContext.isIssued) {
      await markInvoicesLinkedToBillForDeletionRequest(req, bill, null);
    }

    let archivedInvoiceCount = 0;
    if (action === 'approve') {
      const deletedAt = new Date();
      bill.is_deleted = true;
      bill.is_active = false;
      bill.deleted_at = deletedAt;
      bill.deleted_by = req.user._id;
      bill.deletion_reason = bill.deletion_request.reason;

      if (issuedContext.isIssued) {
        archivedInvoiceCount = await archiveInvoicesLinkedToBill(req, bill, {
          deleted_by: req.user._id,
          deleted_at: deletedAt,
          deletion_reason: bill.deletion_request.reason
        });
      }

      if (bill.prescription_id) {
        const prescription = await Prescription.findById(bill.prescription_id);
        if (prescription) {
          let needsUpdate = false;
          
          for (const item of bill.items) {
            if (item.item_type === 'Procedure' && item.procedure_id) {
              const procIndex = prescription.procedure_requests?.findIndex(
                p => p._id.toString() === item.procedure_id.toString()
              );
              if (procIndex !== -1) {
                prescription.procedure_requests[procIndex].is_billed = false;
                prescription.procedure_requests[procIndex].invoice_id = null;
                needsUpdate = true;
              }
            }
            
            if (item.item_type === 'Lab Test' && item.lab_test_id) {
              const testIndex = prescription.lab_test_requests?.findIndex(
                t => t._id.toString() === item.lab_test_id.toString()
              );
              if (testIndex !== -1) {
                prescription.lab_test_requests[testIndex].is_billed = false;
                prescription.lab_test_requests[testIndex].invoice_id = null;
                needsUpdate = true;
              }
            }
            
            if (item.item_type === 'Radiology' && item.radiology_test_id) {
              const radIndex = prescription.radiology_test_requests?.findIndex(
                r => r._id.toString() === item.radiology_test_id.toString()
              );
              if (radIndex !== -1) {
                prescription.radiology_test_requests[radIndex].is_billed = false;
                prescription.radiology_test_requests[radIndex].invoice_id = null;
                needsUpdate = true;
              }
            }
          }
          
          if (needsUpdate) {
            await prescription.save();
          }
        }
      }
    }

    await bill.save();

    res.json({
      success: true,
      message: action === 'approve' && issuedContext.isIssued
        ? 'Emergency issued-document deletion approved; Bill and linked Invoice(s) were archived.'
        : `Deletion request ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
      emergencyIssuedDeletion: action === 'approve' && issuedContext.isIssued,
      archivedInvoiceCount,
      bill
    });
  } catch (err) {
    console.error('Error reviewing deletion request:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get deleted bills (admin)
exports.getDeletedBills = async (req, res) => {
  try {
    const { page = 1, limit = 10, start_date, end_date } = req.query;

    const filter = billScope(req, { is_deleted: true });

    if (start_date && end_date) {
      filter.deleted_at = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const bills = await Bill.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date')
      .populate('admission_id', 'admissionNumber')
      .populate('invoice_id', 'invoice_number total')
      .populate('deleted_by', 'name email')
      .populate('deletion_request.requested_by', 'name email')
      .populate('deletion_request.reviewed_by', 'name email')
      .sort({ deleted_at: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Bill.countDocuments(filter);

    res.json({
      success: true,
      bills,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    console.error('Error fetching deleted bills:', err);
    res.status(500).json({ error: err.message });
  }
};

// Main delete function
exports.deleteBill = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (canEmergencyDeleteIssuedDocument(req)) {
      return exports.adminDeleteBill(req, res);
    }
    return exports.requestBillDeletion(req, res);
  } catch (err) {
    console.error('Error in deleteBill:', err);
    res.status(500).json({ error: err.message });
  }
};



// Compact billing dashboard transaction read model. This endpoint deliberately
// contains only fields rendered by the dashboard table; full financial documents
// remain on the existing detail routes and are fetched on demand.
exports.getBillingTransactionWorklist = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const data = await billingPatientService.listBillingTransactions({
      hospitalId,
      search: req.query.search || '',
      status: req.query.status || 'All',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      scope: req.query.scope || 'all',
      limit: req.query.limit || 50,
      page: req.query.page || 1
    });
    res.json({ success: true, data });
  } catch (error) {
    if (next) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Patient-first billing dashboard summaries and encounter details.
exports.getPatientBillingSummaries = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const data = await billingPatientService.listPatientBillingSummaries({
      hospitalId,
      type: req.query.type || 'all',
      search: req.query.search || '',
      status: req.query.status || 'All',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      limit: req.query.limit || 250,
      page: req.query.page || 1
    });
    res.json({ success: true, ...data });
  } catch (error) {
    if (next) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.getPatientBillingDetails = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const data = await billingPatientService.getPatientBillingDetails({
      hospitalId,
      patientId: req.params.patientId,
      admissionId: req.query.admissionId || null
    });
    res.json({ success: true, data });
  } catch (error) {
    if (next) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Export helpers for use in other modules
exports.createOrUpdateIPDCharge = createOrUpdateIPDCharge;
exports.markIPDChargeAsBilled = markIPDChargeAsBilled;
exports.updateAdmissionTotals = updateAdmissionTotals;
/**
 * Issue an invoice from an existing generated bill without forcing payment.
 * This supports the patient billing workspace where creation, preview, issue
 * and print are intentionally kept on one screen.
 */
exports.generateInvoiceFromBill = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const bill = await Bill.findOne({
      _id: req.params.id,
      hospital_id: hospitalId,
      is_deleted: { $ne: true }
    });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    if (bill.admission_id) {
      return res.status(409).json({
        success: false,
        code: 'CANONICAL_IPD_INVOICE_REQUIRED',
        error: 'IPD bills are invoiced from the admission finance workspace.',
        canonicalEndpoint: `/api/finance/ipd/${bill.admission_id}/invoices`
      });
    }

    const linkedInvoiceId = bill.invoice_id || (bill.invoice_ids || [])[0];
    if (linkedInvoiceId) {
      const existing = await Invoice.findOne({ _id: linkedInvoiceId, hospital_id: hospitalId, is_deleted: { $ne: true } });
      if (existing) return res.json({ success: true, message: 'Invoice already issued', invoice: existing, bill });
    }

    const rootKey = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || `bill:${bill._id}:invoice`).trim();
    const issued = await patientFinancial.issueOPDInvoice(bill.patient_id, {
      billIds: [bill._id],
      dueInDays: req.body?.dueInDays,
      notes: req.body?.notes || bill.notes,
      idempotencyKey: rootKey
    }, req.user);

    return res.status(issued.alreadyExists ? 200 : 201).json({
      success: true,
      message: issued.alreadyExists ? 'Invoice already issued' : 'Invoice issued successfully',
      invoice: issued.invoice,
      bills: issued.bills || [bill]
    });
  } catch (error) {
    if (next) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  }
};

exports.processOPDRefund = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const bill = await Bill.findOne({ _id: req.params.id, hospital_id: hospitalId, is_deleted: { $ne: true } });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const linkedInvoiceId = bill.invoice_id || (bill.invoice_ids || [])[0];
    if (!linkedInvoiceId) {
      return res.status(409).json({
        success: false,
        code: 'REFUND_REQUIRES_INVOICE',
        error: 'Refunds are posted against the canonical invoice/transaction ledger. Issue the invoice first.'
      });
    }

    const result = await ipdFinancial.refundInvoice(linkedInvoiceId, {
      amount: req.body?.amount,
      reason: req.body?.reason || 'Patient Request',
      paymentMethod: req.body?.payment_method || req.body?.paymentMethod || 'Cash',
      reference: req.body?.transaction_id || req.body?.reference,
      idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey || `bill:${bill._id}:refund:${req.body?.transaction_id || req.body?.amount || 'request'}`
    }, req.user);

    return res.json({
      success: true,
      message: 'Refund posted through canonical invoice ledger',
      refundReceipt: {
        refundNumber: result.refundNumber,
        refundAmount: result.transaction?.amount,
        paymentMethod: result.transaction?.paymentMethod,
        reason: result.transaction?.remarks,
        transaction: result.transaction,
        creditNote: result.creditNote,
        invoiceId: linkedInvoiceId,
        billId: bill._id
      }
    });
  } catch (error) {
    if (next) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  }
};

exports.getRefundReceipt = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const { id: billId, refundId } = req.params;

    const bill = await Bill.findOne({ _id: billId, hospital_id: hospitalId })
      .populate('patient_id')
      .populate('appointment_id')
      .populate('refund_history.refunded_by', 'name email role');

    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const refund = (bill.refund_history || []).find(
      (r) => String(r._id) === String(refundId) || r.refund_number === refundId
    );

    if (!refund) return res.status(404).json({ error: 'Refund record not found' });

    return res.json({
      success: true,
      refundReceipt: {
        refundNumber: refund.refund_number,
        refundDate: refund.refunded_at,
        refundAmount: refund.amount,
        paymentMethod: refund.payment_method,
        reason: refund.reason,
        refundedBy: refund.refunded_by,
        bill,
        patient: bill.patient_id,
        appointment: bill.appointment_id
      }
    });
  } catch (error) {
    if (next) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

/**
 * Review Discount Approval (Approve or Reject)
 */
exports.reviewDiscountApproval = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const billId = req.params.id;
    const { action, approvalNotes, rejectionReason } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: "Action must be 'approve' or 'reject'" });
    }

    const bill = await Bill.findOne({ _id: billId, hospital_id: hospitalId })
      .populate('patient_id')
      .populate('discount_approval.requested_by', 'name email role');

    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    // Enforce self-approval prevention: user cannot approve their own discount unless unrestricted super admin
    const isSelfApproval = String(bill.discount_approval?.requested_by?._id || bill.discount_approval?.requested_by) === String(req.user?._id);
    const isUnrestrictedAdmin = req.user?.role === 'mediqliq_super_admin' || (req.user?.role === 'admin' && !req.user?.enforceModulePermissions);

    if (isSelfApproval && !isUnrestrictedAdmin) {
      return res.status(403).json({ error: 'Self-approval of discounts is not permitted. Another authorized user must approve.' });
    }

    const now = operationNow();

    if (action === 'approve') {
      bill.discount_approval = {
        ...(bill.discount_approval?.toObject?.() || bill.discount_approval || {}),
        status: 'APPROVED',
        approved_by: req.user?._id,
        approved_at: now,
        approval_notes: String(approvalNotes || '').trim()
      };
      // Determine next status based on payment collected
      const paid = Number(bill.paid_amount || 0);
      const total = Number(bill.total_amount || 0);
      if (paid >= total && total > 0) {
        bill.status = 'Paid';
      } else if (paid > 0) {
        bill.status = 'Partially Paid';
      } else {
        bill.status = 'Pending';
      }
    } else {
      // Reject: restore the pre-discount line/tax values, then let the Bill
      // schema recompute the collectible balance from the restored document.
      bill.discount_approval = {
        ...(bill.discount_approval?.toObject?.() || bill.discount_approval || {}),
        status: 'REJECTED',
        approved_by: req.user?._id,
        approved_at: now,
        rejection_reason: String(rejectionReason || 'Discount rejected').trim()
      };
      patientFinancial.rejectOPDBillDiscount(bill);
      bill.balance_due = money(Math.max(0, Number(bill.total_amount || 0) - Number(bill.paid_amount || 0)));
      bill.status = Number(bill.paid_amount || 0) >= bill.total_amount ? 'Paid' : (Number(bill.paid_amount || 0) > 0 ? 'Partially Paid' : 'Pending');
    }

    await bill.save();

    if (bill.invoice_id) {
      try {
        const invoiceId = bill.invoice_id?._id || bill.invoice_id;
        await patientFinancial.syncOPDInvoiceFromBills(invoiceId, hospitalId);
      } catch (invErr) {
        console.warn('Could not sync consolidated invoice on discount review:', invErr.message);
      }
    }

    try {
      const ApprovalRequest = require('../models/ApprovalRequest');
      await ApprovalRequest.updateMany(
        { hospitalId, $or: [{ billId: bill._id }, { 'details.billId': bill._id }], status: 'Pending' },
        {
          status: action === 'approve' ? 'Approved' : 'Rejected',
          approvedBy: req.user?._id,
          approvedAt: now,
          ...(action === 'reject' ? { rejectionReason: String(rejectionReason || 'Discount rejected').trim() } : {})
        }
      );
    } catch (apprErr) {
      console.warn('Could not update ApprovalRequest from bill discount review:', apprErr.message);
    }

    const populated = await Bill.findById(bill._id)
      .populate('patient_id')
      .populate('discount_approval.requested_by', 'name email role')
      .populate('discount_approval.approved_by', 'name email role');

    return res.json({
      success: true,
      message: `Discount request ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
      bill: populated
    });
  } catch (error) {
    if (next) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

/**
 * Get Bill / Billing Details by Appointment ID
 *
 * Bill does not have top-level doctor_id / department_id fields. Those belong
 * to Appointment (and bill item snapshots), so populate through appointment_id
 * instead of asking Mongoose to populate non-schema paths. Legacy Desk bills
 * that lost appointment_id are still addressable by their canonical source key.
 */
exports.getBillByAppointmentId = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const { appointmentId } = req.params;
    const sourceLinePrefix = `appointment:${String(appointmentId)}:`;

    const bill = await Bill.findOne({
      hospital_id: hospitalId,
      $or: [
        { appointment_id: appointmentId },
        { 'details.appointmentId': appointmentId },
        { 'items.source_snapshot.appointmentId': appointmentId },
        { 'items.source_snapshot.sourceLineKey': { $regex: `^${sourceLinePrefix}` } },
        { 'items.source_snapshot.originModule': 'Appointment', 'items.source_snapshot.sourceId': String(appointmentId) }
      ],
      is_deleted: { $ne: true }
    })
      .populate('patient_id')
      .populate({
        path: 'appointment_id',
        select: 'appointment_number token serial_number appointment_date start_time duration_minutes type consultation_type status doctor_id department_id patient_id',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName first_name last_name name specialization' },
          { path: 'department_id', select: 'name department_name' }
        ]
      })
      .populate('invoice_id')
      .populate('discount_approval.requested_by', 'name email role')
      .populate('discount_approval.approved_by', 'name email role')
      .sort({ createdAt: -1 });

    if (!bill) {
      const invoice = await Invoice.findOne({
        hospital_id: hospitalId,
        $or: [{ appointment_id: appointmentId }, { 'details.appointmentId': appointmentId }],
        is_deleted: { $ne: true }
      })
        .populate('patient_id')
        .populate({
          path: 'appointment_id',
          select: 'appointment_number token serial_number appointment_date start_time duration_minutes type consultation_type status doctor_id department_id patient_id',
          populate: [
            { path: 'doctor_id', select: 'firstName lastName first_name last_name name specialization' },
            { path: 'department_id', select: 'name department_name' }
          ]
        })
        .sort({ createdAt: -1 });

      if (invoice) {
        return res.json({ success: true, bill: invoice, invoice });
      }
      return res.status(404).json({ success: false, error: 'Bill not found for this appointment' });
    }

    // A short-lived Desk bug retained the stable sourceId/sourceLineKey but
    // omitted bill.appointment_id. Repair the response for print/slip callers
    // immediately, and repair the persisted link best-effort for future reads.
    const billObject = bill.toObject ? bill.toObject() : { ...bill };
    if (!bill.appointment_id) {
      const appointment = await Appointment.findOne({ _id: appointmentId, hospital_id: hospitalId })
        .populate('doctor_id', 'firstName lastName first_name last_name name specialization')
        .populate('department_id', 'name department_name')
        .lean();
      if (appointment) {
        bill.appointment_id = appointment._id;
        await bill.save().catch((repairError) => {
          console.warn('Could not repair legacy bill appointment link:', repairError.message);
        });
        billObject.appointment_id = appointment;
      }
    }

    if (bill.invoice_id && typeof bill.invoice_id === 'object') {
      billObject.invoice = bill.invoice_id;
      if (Array.isArray(bill.invoice_id.service_items) && bill.invoice_id.service_items.length > 0) {
        billObject.invoice_service_items = bill.invoice_id.service_items;
      }
      if (bill.invoice_id.payer_allocation) {
        billObject.invoice_payer_allocation = bill.invoice_id.payer_allocation;
      }
    }

    return res.json({
      success: true,
      bill: billObject,
      invoice: (bill.invoice_id && typeof bill.invoice_id === 'object') ? bill.invoice_id : undefined,
      data: { bill: billObject, invoice: (bill.invoice_id && typeof bill.invoice_id === 'object') ? bill.invoice_id : undefined }
    });
  } catch (error) {
    if (next) return next(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Get Bill by Admission ID
 */
exports.getBillByAdmissionId = async (req, res, next) => {
  try {
    const hospitalId = requestHospitalId(req);
    const { admissionId } = req.params;

    const bill = await Bill.findOne({
      hospital_id: hospitalId,
      admission_id: admissionId,
      is_deleted: { $ne: true }
    })
      .populate('patient_id')
      .populate('discount_approval.requested_by', 'name email role')
      .populate('discount_approval.approved_by', 'name email role')
      .sort({ createdAt: -1 });

    if (!bill) {
      return res.status(404).json({ success: false, error: 'Bill not found for this admission' });
    }

    return res.json({ success: true, bill, data: { bill } });
  } catch (error) {
    if (next) return next(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

