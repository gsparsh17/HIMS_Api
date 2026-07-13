const crypto = require('crypto');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const LabReport = require('../models/LabReport');
const RadiologyRequest = require('../models/RadiologyRequest');
const DischargeSummary = require('../models/DischargeSummary');
const Invoice = require('../models/Invoice');
const Immunization = require('../models/Immunization');
const ClinicalDocument = require('../models/ClinicalDocument');
const Vital = require('../models/Vital');
const IPDVitals = require('../models/IPDVitals');
const AbdmCareContext = require('../models/AbdmCareContext');
const { toAbdmHiType } = require('../utils/abdmHiTypes');

function opaque(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function patientReference(patient) {
  return patient.abha?.patientReference || opaque('PAT');
}

function displayDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

async function ensurePatientReference(patient) {
  if (patient.abha?.patientReference) return patient.abha.patientReference;
  const reference = patientReference(patient);
  await Patient.updateOne({ _id: patient._id }, { 'abha.patientReference': reference });
  return reference;
}

async function upsertContext({ patient, hiType, display, records, dateFrom, dateTo, naturalKey }) {
  const pRef = await ensurePatientReference(patient);
  const existing = naturalKey
    ? await AbdmCareContext.findOne({ patientId: patient._id, 'metadata.naturalKey': naturalKey })
    : null;
  if (existing) {
    existing.display = display;
    existing.hiType = hiType;
    existing.records = records;
    existing.dateFrom = dateFrom;
    existing.dateTo = dateTo;
    existing.abhaAddress = patient.abha?.address;
    existing.abhaNumber = patient.abha?.number;
    existing.active = true;
    existing.metadata = { ...(existing.metadata || {}), naturalKey, refreshedAt: new Date() };
    await existing.save();
    return existing;
  }

  return AbdmCareContext.create({
    patientId: patient._id,
    patientReference: pRef,
    referenceNumber: opaque('CC'),
    display,
    hiType,
    records,
    dateFrom,
    dateTo,
    abhaAddress: patient.abha?.address,
    abhaNumber: patient.abha?.number,
    active: true,
    metadata: { naturalKey }
  });
}

async function buildPatientCareContexts(patientId) {
  const patient = await Patient.findById(patientId);
  if (!patient) throw new Error('Patient not found');

  const [appointments, prescriptions, labs, radiology, discharges, invoices, immunizations, documents, opdVitals, ipdVitals] = await Promise.all([
    Appointment.find({ patient_id: patient._id }).sort({ appointment_date: -1 }).lean(),
    Prescription.find({ patient_id: patient._id }).sort({ issue_date: -1 }).lean(),
    LabReport.find({ patient_id: patient._id }).sort({ report_date: -1 }).lean(),
    RadiologyRequest.find({ patientId: patient._id }).sort({ requestedDate: -1 }).lean(),
    DischargeSummary.find({ patientId: patient._id }).sort({ dischargeDate: -1 }).lean(),
    Invoice.find({ patient_id: patient._id }).sort({ created_at: -1 }).lean(),
    Immunization.find({ patientId: patient._id }).sort({ occurrenceDate: -1 }).lean(),
    ClinicalDocument.find({ patientId: patient._id }).sort({ documentDate: -1 }).lean(),
    Vital.find({ patient_id: patient._id }).sort({ recorded_at: -1 }).lean(),
    IPDVitals.find({ patientId: patient._id }).sort({ recordedAt: -1 }).lean()
  ]);

  const contexts = [];

  for (const appointment of appointments) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'OP_CONSULTATION',
        display: `OP Consultation ${displayDate(appointment.appointment_date || appointment.createdAt)}`,
        records: [{ model: 'Appointment', recordId: appointment._id }],
        dateFrom: appointment.appointment_date || appointment.createdAt,
        dateTo: appointment.appointment_date || appointment.updatedAt,
        naturalKey: `Appointment:${appointment._id}`
      })
    );
  }

  for (const prescription of prescriptions) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'PRESCRIPTION',
        display: `Prescription ${displayDate(prescription.issue_date || prescription.createdAt)}`,
        records: [{ model: 'Prescription', recordId: prescription._id }],
        dateFrom: prescription.issue_date || prescription.createdAt,
        dateTo: prescription.updatedAt || prescription.issue_date,
        naturalKey: `Prescription:${prescription._id}`
      })
    );
  }

  for (const report of labs) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'DIAGNOSTIC_REPORT',
        display: `Lab Report ${report.report_type || ''} ${displayDate(report.report_date || report.createdAt)}`.trim(),
        records: [{ model: 'LabReport', recordId: report._id }],
        dateFrom: report.report_date || report.createdAt,
        dateTo: report.updatedAt || report.report_date,
        naturalKey: `LabReport:${report._id}`
      })
    );
  }

  for (const report of radiology) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'DIAGNOSTIC_REPORT',
        display: `Radiology ${report.testName || ''} ${displayDate(report.requestedDate || report.createdAt)}`.trim(),
        records: [{ model: 'RadiologyRequest', recordId: report._id }],
        dateFrom: report.requestedDate || report.createdAt,
        dateTo: report.reportedAt || report.updatedAt,
        naturalKey: `RadiologyRequest:${report._id}`
      })
    );
  }

  for (const summary of discharges) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'DISCHARGE_SUMMARY',
        display: `Discharge Summary ${displayDate(summary.dischargeDate || summary.createdAt)}`,
        records: [{ model: 'DischargeSummary', recordId: summary._id }],
        dateFrom: summary.admissionDate || summary.createdAt,
        dateTo: summary.dischargeDate || summary.updatedAt,
        naturalKey: `DischargeSummary:${summary._id}`
      })
    );
  }

  for (const invoice of invoices) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'INVOICE',
        display: `Invoice ${invoice.invoice_number || invoice.invoiceNumber || invoice._id}`,
        records: [{ model: 'Invoice', recordId: invoice._id }],
        dateFrom: invoice.created_at || invoice.createdAt,
        dateTo: invoice.updated_at || invoice.updatedAt,
        naturalKey: `Invoice:${invoice._id}`
      })
    );
  }

  for (const immunization of immunizations) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'IMMUNIZATION_RECORD',
        display: `Immunization ${immunization.vaccineName} ${displayDate(immunization.occurrenceDate)}`,
        records: [{ model: 'Immunization', recordId: immunization._id }],
        dateFrom: immunization.occurrenceDate,
        dateTo: immunization.occurrenceDate,
        naturalKey: `Immunization:${immunization._id}`
      })
    );
  }

  for (const document of documents) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'HEALTH_DOCUMENT_RECORD',
        display: document.title,
        records: [{ model: 'ClinicalDocument', recordId: document._id }],
        dateFrom: document.documentDate,
        dateTo: document.documentDate,
        naturalKey: `ClinicalDocument:${document._id}`
      })
    );
  }


  for (const vital of opdVitals) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'WELLNESS_RECORD',
        display: `OPD Vitals ${displayDate(vital.recorded_at || vital.createdAt)}`,
        records: [{ model: 'Vital', recordId: vital._id }],
        dateFrom: vital.recorded_at || vital.createdAt,
        dateTo: vital.updatedAt || vital.recorded_at,
        naturalKey: `Vital:${vital._id}`
      })
    );
  }

  for (const vital of ipdVitals) {
    contexts.push(
      await upsertContext({
        patient,
        hiType: 'WELLNESS_RECORD',
        display: `IPD Vitals ${displayDate(vital.recordedAt || vital.createdAt)}`,
        records: [{ model: 'IPDVitals', recordId: vital._id }],
        dateFrom: vital.recordedAt || vital.createdAt,
        dateTo: vital.updatedAt || vital.recordedAt,
        naturalKey: `IPDVitals:${vital._id}`
      })
    );
  }

  return contexts;
}

async function groupedForAbdm(patientId) {
  const patient = await Patient.findById(patientId);
  if (!patient) throw new Error('Patient not found');
  const contexts = await AbdmCareContext.find({ patientId, active: { $ne: false } }).sort({ createdAt: -1 }).lean();
  const groups = new Map();
  for (const context of contexts) {
    if (!groups.has(context.hiType)) groups.set(context.hiType, []);
    groups.get(context.hiType).push(context);
  }
  return {
    patient,
    patientGroups: Array.from(groups.entries()).map(([hiType, items]) => ({
      referenceNumber: items[0]?.patientReference,
      display: [patient.first_name, patient.last_name].filter(Boolean).join(' '),
      careContexts: items.map((item) => ({
        referenceNumber: item.referenceNumber,
        display: item.display
      })),
      hiType: toAbdmHiType(hiType),
      count: items.length
    }))
  };
}

module.exports = {
  buildPatientCareContexts,
  groupedForAbdm,
  ensurePatientReference
};
