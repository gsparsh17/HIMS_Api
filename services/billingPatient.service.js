const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const IPDCharge = require('../models/IPDCharge');
const IPDAdmission = require('../models/IPDAdmission');
const Patient = require('../models/Patient');

const asNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const idString = (value) => String(value?._id || value || '');

const patientDisplayName = (patient = {}) => (
  [patient.first_name || patient.firstName, patient.middle_name || patient.middleName, patient.last_name || patient.lastName].filter(Boolean).join(' ')
  || patient.name
  || 'Patient'
);

const latestDate = (...values) => {
  const dates = values.flat().filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.getTime()));
  return dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))) : null;
};

const billOutstanding = (bill) => asNumber(
  bill.balance_due !== undefined
    ? bill.balance_due
    : Math.max(0, asNumber(bill.total_amount) - asNumber(bill.paid_amount))
);

const invoiceOutstanding = (invoice) => asNumber(
  invoice.balance_due !== undefined
    ? invoice.balance_due
    : Math.max(0, asNumber(invoice.total) - asNumber(invoice.amount_paid))
);

function chargeSection(charge = {}) {
  const type = String(charge.chargeType || '').toLowerCase();
  const source = String(charge.sourceModule || '').toLowerCase();
  const description = String(charge.description || '').toLowerCase();
  if (type.includes('bed') || source === 'bed' || description.includes('room')) return 'Room & Bed Charges';
  if (type.includes('doctor') || type.includes('consult') || source.includes('doctor')) return 'Doctor Charges';
  if (type.includes('surgery') || type.includes('ot') || source.includes('ot')) return 'Surgery / OT Charges';
  if (type.includes('procedure') || source.includes('procedure')) return 'Procedure Charges';
  if (type.includes('lab') || source === 'lab' || source.includes('pathology')) return 'Laboratory';
  if (type.includes('radiology') || source.includes('radiology') || source.includes('imaging')) return 'Radiology';
  if (type.includes('pharmacy') || type.includes('consum') || source.includes('pharmacy') || description.includes('medicine')) return 'Consumables';
  return 'Miscellaneous';
}

function dateKey(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'Undated';
  return date.toISOString().slice(0, 10);
}

function groupCharges(charges = []) {
  const sections = new Map();
  charges.forEach((charge) => {
    const section = chargeSection(charge);
    const day = dateKey(charge.chargeDate || charge.createdAt);
    if (!sections.has(section)) sections.set(section, new Map());
    const dates = sections.get(section);
    if (!dates.has(day)) dates.set(day, []);
    dates.get(day).push(charge);
  });

  return Array.from(sections.entries()).map(([section, dates]) => ({
    section,
    total: Array.from(dates.values()).flat().reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0),
    dates: Array.from(dates.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, items]) => ({
        date,
        total: items.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0),
        items
      }))
  }));
}

async function listPatientBillingSummaries({ hospitalId, type = 'all', search = '', limit = 250 }) {
  const [bills, invoices, admissions, charges] = await Promise.all([
    Bill.find({ hospital_id: hospitalId, is_deleted: { $ne: true } })
      .populate('patient_id', 'first_name middle_name last_name patientId uhid phone gender dob age')
      .populate('admission_id', 'admissionNumber status admissionDate dischargeDate')
      .sort({ updatedAt: -1 }).lean(),
    Invoice.find({ hospital_id: hospitalId, is_deleted: { $ne: true } })
      .select('patient_id admission_id appointment_id total amount_paid balance_due status updated_at updatedAt created_at createdAt invoice_type')
      .lean(),
    IPDAdmission.find({ hospitalId })
      .populate('patientId', 'first_name middle_name last_name patientId uhid phone gender dob age')
      .populate('primaryDoctorId', 'firstName lastName first_name last_name name')
      .populate('wardId', 'name wardName')
      .populate('bedId', 'bedNumber bed_number name')
      .sort({ updatedAt: -1 }).lean(),
    IPDCharge.find({ hospitalId, status: { $ne: 'VOIDED' } }).sort({ chargeDate: -1 }).lean()
  ]);

  const invoiceByAdmission = new Map();
  const invoiceByPatientOpd = new Map();
  invoices.forEach((invoice) => {
    const admissionId = idString(invoice.admission_id);
    if (admissionId) {
      if (!invoiceByAdmission.has(admissionId)) invoiceByAdmission.set(admissionId, []);
      invoiceByAdmission.get(admissionId).push(invoice);
    } else {
      const patientId = idString(invoice.patient_id);
      if (!patientId) return;
      if (!invoiceByPatientOpd.has(patientId)) invoiceByPatientOpd.set(patientId, []);
      invoiceByPatientOpd.get(patientId).push(invoice);
    }
  });

  const chargesByAdmission = new Map();
  charges.forEach((charge) => {
    const admissionId = idString(charge.admissionId);
    if (!chargesByAdmission.has(admissionId)) chargesByAdmission.set(admissionId, []);
    chargesByAdmission.get(admissionId).push(charge);
  });

  const ipdRows = admissions.map((admission) => {
    const admissionId = idString(admission._id);
    const patient = admission.patientId || {};
    const relatedInvoices = invoiceByAdmission.get(admissionId) || [];
    const relatedCharges = chargesByAdmission.get(admissionId) || [];
    const unbilled = relatedCharges.filter((charge) => !charge.isBilled && charge.status !== 'INVOICED');
    const issuedTotal = relatedInvoices.reduce((sum, invoice) => sum + asNumber(invoice.total), 0);
    const chargeTotal = relatedCharges.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0);
    const unbilledTotal = unbilled.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0);
    const calculatedOutstanding = relatedInvoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0) + unbilledTotal;
    // Admission totals are the canonical running-bill values and avoid counting
    // the same operational charge twice when an interim/pharmacy invoice is
    // later consolidated into a final IPD invoice.
    const totalBill = admission.totalBillAmount !== undefined
      ? asNumber(admission.totalBillAmount)
      : (chargeTotal || issuedTotal + unbilledTotal);
    const outstanding = admission.dueAmount !== undefined
      ? asNumber(admission.dueAmount)
      : calculatedOutstanding;
    return {
      encounterType: 'IPD',
      rowKey: `ipd:${admissionId}`,
      patientId: idString(patient._id),
      patientName: patientDisplayName(patient),
      uhid: patient.uhid || patient.patientId || '—',
      phone: patient.phone || '',
      admissionId,
      admissionNumber: admission.admissionNumber || admission.shipNumber || '—',
      admissionStatus: admission.status || 'Admitted',
      consultant: patientDisplayName(admission.primaryDoctorId || {}),
      ward: admission.wardId?.name || admission.wardId?.wardName || '',
      bed: admission.bedId?.bedNumber || admission.bedId?.bed_number || admission.bedId?.name || '',
      totalBill,
      outstandingAmount: outstanding,
      invoiceCount: relatedInvoices.length,
      chargeCount: relatedCharges.length,
      lastUpdated: latestDate(
        admission.updatedAt,
        relatedInvoices.map((item) => item.updated_at || item.updatedAt || item.created_at || item.createdAt),
        relatedCharges.map((item) => item.updatedAt || item.chargeDate || item.createdAt)
      )
    };
  });

  const opdBills = bills.filter((bill) => !bill.admission_id);
  const opdMap = new Map();
  opdBills.forEach((bill) => {
    const patient = bill.patient_id || {};
    const patientId = idString(patient._id || bill.patient_id);
    if (!patientId) return;
    if (!opdMap.has(patientId)) {
      opdMap.set(patientId, {
        encounterType: 'OPD',
        rowKey: `opd:${patientId}`,
        patientId,
        patientName: patientDisplayName(patient),
        uhid: patient.uhid || patient.patientId || '—',
        phone: patient.phone || '',
        admissionId: null,
        admissionNumber: 'OPD',
        admissionStatus: 'OPD',
        totalBill: 0,
        outstandingAmount: 0,
        billCount: 0,
        invoiceCount: 0,
        chargeCount: 0,
        lastUpdated: null
      });
    }
    const row = opdMap.get(patientId);
    row.totalBill += asNumber(bill.total_amount);
    row.outstandingAmount += billOutstanding(bill);
    row.billCount += 1;
    row.lastUpdated = latestDate(row.lastUpdated, bill.updatedAt || bill.createdAt || bill.generated_at);
  });
  for (const [patientId, relatedInvoices] of invoiceByPatientOpd.entries()) {
    const row = opdMap.get(patientId);
    if (!row) continue;
    row.invoiceCount = relatedInvoices.length;
    row.lastUpdated = latestDate(row.lastUpdated, relatedInvoices.map((item) => item.updated_at || item.updatedAt || item.created_at || item.createdAt));
  }
  const opdRows = Array.from(opdMap.values());

  let rows = type === 'ipd' ? ipdRows : type === 'opd' ? opdRows : [...ipdRows, ...opdRows];
  const term = String(search || '').trim().toLowerCase();
  if (term) {
    rows = rows.filter((row) => [row.patientName, row.uhid, row.phone, row.admissionNumber]
      .some((value) => String(value || '').toLowerCase().includes(term)));
  }
  rows.sort((left, right) => new Date(right.lastUpdated || 0) - new Date(left.lastUpdated || 0));

  return {
    rows: rows.slice(0, Math.max(1, Math.min(1000, Number(limit) || 250))),
    counts: { all: ipdRows.length + opdRows.length, ipd: ipdRows.length, opd: opdRows.length }
  };
}

async function getPatientBillingDetails({ hospitalId, patientId, admissionId }) {
  const patient = await Patient.findOne({ _id: patientId, hospitalId }).lean();
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }

  const billFilter = { hospital_id: hospitalId, patient_id: patientId, is_deleted: { $ne: true } };
  const invoiceFilter = { hospital_id: hospitalId, patient_id: patientId, is_deleted: { $ne: true } };
  const chargeFilter = { hospitalId, patientId, status: { $ne: 'VOIDED' } };
  let admission = null;
  if (admissionId) {
    billFilter.admission_id = admissionId;
    invoiceFilter.admission_id = admissionId;
    chargeFilter.admissionId = admissionId;
    admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId })
      .populate('primaryDoctorId', 'firstName lastName first_name last_name name')
      .populate('departmentId', 'name')
      .populate('wardId', 'name wardName')
      .populate('bedId', 'bedNumber bed_number name')
      .lean();
    if (!admission) {
      const error = new Error('IPD admission not found');
      error.statusCode = 404;
      throw error;
    }
  } else {
    billFilter.admission_id = { $exists: false };
    invoiceFilter.admission_id = { $exists: false };
    // OPD details intentionally exclude IPD charges.
    chargeFilter.admissionId = { $exists: false };
  }

  const [bills, invoices, charges] = await Promise.all([
    Bill.find(billFilter).sort({ generated_at: -1, createdAt: -1 }).lean(),
    Invoice.find(invoiceFilter).sort({ issue_date: -1, created_at: -1 }).lean(),
    admissionId ? IPDCharge.find(chargeFilter).sort({ chargeDate: 1, createdAt: 1 }).lean() : Promise.resolve([])
  ]);

  // OPD does not use IPDCharge rows. Convert bill line items into the same
  // charge-shaped structure so the patient detail screen can group every OPD
  // registration/consultation/service by date without a separate UI path.
  const displayCharges = admissionId
    ? charges
    : bills.flatMap((bill) => (bill.items || []).map((item, index) => ({
        _id: item._id || `${bill._id}:${index}`,
        patientId,
        appointmentId: bill.appointment_id,
        billId: bill._id,
        invoiceId: bill.invoice_id,
        chargeType: item.item_type || 'Miscellaneous',
        description: item.description || 'OPD billing item',
        quantity: Number(item.quantity || 1),
        rate: Number(item.unit_price ?? ((Number(item.amount || 0)) / Math.max(1, Number(item.quantity || 1)))),
        amount: Number(item.amount || 0),
        netAmount: Number(item.amount || 0),
        discount: Number(item.discount_amount || 0),
        tax: Number(item.tax_amount || 0),
        chargeDate: bill.generated_at || bill.createdAt,
        createdAt: bill.createdAt,
        status: bill.invoice_id ? 'INVOICED' : (bill.document_stage || 'GENERATED'),
        isBilled: Boolean(bill.invoice_id)
      })));

  const unbilledCharges = displayCharges.filter((charge) => !charge.isBilled && charge.status !== 'INVOICED');
  const invoiceTotal = invoices.reduce((sum, invoice) => sum + asNumber(invoice.total), 0);
  const billTotal = bills.reduce((sum, bill) => sum + asNumber(bill.total_amount), 0);
  const chargeTotal = displayCharges.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0);
  const unbilledTotal = unbilledCharges.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0);
  const calculatedOutstanding = admissionId
    ? invoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0) + unbilledTotal
    : bills.reduce((sum, bill) => sum + billOutstanding(bill), 0);
  const outstanding = admissionId && admission?.dueAmount !== undefined
    ? asNumber(admission.dueAmount)
    : calculatedOutstanding;
  const totalBill = admissionId
    ? (admission?.totalBillAmount !== undefined ? asNumber(admission.totalBillAmount) : (chargeTotal || invoiceTotal + unbilledTotal))
    : billTotal;
  const paidAmount = admissionId
    ? (admission?.paidAmount !== undefined ? asNumber(admission.paidAmount) : invoices.reduce((sum, invoice) => sum + asNumber(invoice.amount_paid), 0))
    : bills.reduce((sum, bill) => sum + asNumber(bill.paid_amount), 0);

  return {
    patient,
    admission,
    bills,
    invoices,
    charges: displayCharges,
    groupedCharges: groupCharges(displayCharges),
    summary: {
      totalBill,
      invoiceTotal,
      billTotal,
      unbilledTotal,
      outstandingAmount: outstanding,
      paidAmount,
      billCount: bills.length,
      invoiceCount: invoices.length,
      chargeCount: displayCharges.length
    }
  };
}

module.exports = {
  listPatientBillingSummaries,
  getPatientBillingDetails,
  groupCharges,
  chargeSection
};
