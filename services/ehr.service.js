const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const Prescription = require('../models/Prescription');
const LabReport = require('../models/LabReport');
const RadiologyRequest = require('../models/RadiologyRequest');
const DischargeSummary = require('../models/DischargeSummary');
const EHRBundle = require('../models/EHRBundle');

function normalizeGender(gender) {
  const value = String(gender || '').toLowerCase();
  if (['male', 'female', 'other', 'unknown'].includes(value)) return value;
  return 'unknown';
}

function iso(date) {
  if (!date) return undefined;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean).filter(v => v !== undefined && v !== null && v !== '');
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj)
      .map(([k, v]) => [k, clean(v)])
      .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
  );
}

function makeEntry(resource) {
  return {
    fullUrl: `urn:uuid:${resource.id}`,
    resource: clean(resource)
  };
}

async function collectPatientRecords(patientId) {
  const id = new mongoose.Types.ObjectId(patientId);
  const [
    patient,
    appointments,
    admissions,
    prescriptions,
    labReports,
    radiologyReports,
    dischargeSummaries
  ] = await Promise.all([
    Patient.findById(id).lean(),
    Appointment.find({ patient_id: id }).sort({ appointment_date: -1 }).limit(200).lean(),
    IPDAdmission.find({ patientId: id }).sort({ admissionDate: -1 }).limit(50).lean(),
    Prescription.find({ patient_id: id }).sort({ issue_date: -1 }).limit(200).lean(),
    LabReport.find({ patient_id: id }).sort({ report_date: -1 }).limit(200).lean(),
    RadiologyRequest.find({ patientId: id }).sort({ requestedDate: -1 }).limit(200).lean(),
    DischargeSummary.find({ patientId: id }).sort({ dischargeDate: -1 }).limit(100).lean()
  ]);

  if (!patient) throw new Error('Patient not found');
  return { patient, appointments, admissions, prescriptions, labReports, radiologyReports, dischargeSummaries };
}

function createPatientResource(patient) {
  return {
    resourceType: 'Patient',
    id: `patient-${patient._id}`,
    identifier: [
      patient.patientId ? { system: 'https://mediqliq.local/patient-id', value: patient.patientId } : null,
      patient.uhid ? { system: 'https://mediqliq.local/uhid', value: patient.uhid } : null,
      patient.abha?.number ? { system: 'https://healthid.ndhm.gov.in/abha-number', value: patient.abha.number } : null,
      patient.abha?.address ? { system: 'https://healthid.ndhm.gov.in/abha-address', value: patient.abha.address } : null
    ].filter(Boolean),
    name: [{
      text: [patient.salutation, patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' '),
      given: [patient.first_name, patient.middle_name].filter(Boolean),
      family: patient.last_name
    }],
    telecom: [
      patient.phone ? { system: 'phone', value: patient.phone } : null,
      patient.email ? { system: 'email', value: patient.email } : null
    ].filter(Boolean),
    gender: normalizeGender(patient.gender),
    birthDate: patient.dob ? new Date(patient.dob).toISOString().slice(0, 10) : undefined,
    address: patient.address ? [{ text: patient.address, city: patient.city, state: patient.state, postalCode: patient.zipCode }] : undefined
  };
}

function createComposition(patient, records, bundleId) {
  return {
    resourceType: 'Composition',
    id: `composition-${bundleId}`,
    status: 'final',
    type: { text: 'Hospital EMR Summary' },
    subject: { reference: `Patient/patient-${patient._id}` },
    date: new Date().toISOString(),
    title: `EMR/EHR Summary for ${[patient.first_name, patient.last_name].filter(Boolean).join(' ')}`,
    section: [
      { title: 'Prescriptions', entry: records.prescriptions.map(r => ({ reference: `MedicationRequest/rx-${r._id}` })) },
      { title: 'Diagnoses', entry: records.prescriptions.filter(r => r.diagnosis).map(r => ({ reference: `Condition/condition-${r._id}` })) },
      { title: 'Lab Reports', entry: records.labReports.map(r => ({ reference: `DiagnosticReport/lab-${r._id}` })) },
      { title: 'Radiology Reports', entry: records.radiologyReports.map(r => ({ reference: `DiagnosticReport/rad-${r._id}` })) },
      { title: 'Discharge Summaries', entry: records.dischargeSummaries.map(r => ({ reference: `DocumentReference/discharge-${r._id}` })) }
    ]
  };
}

function prescriptionEntries(prescriptions, patient) {
  const entries = [];
  prescriptions.forEach(rx => {
    if (rx.diagnosis) {
      entries.push(makeEntry({
        resourceType: 'Condition',
        id: `condition-${rx._id}`,
        subject: { reference: `Patient/patient-${patient._id}` },
        code: { text: rx.diagnosis, coding: rx.diagnosis_icd11_code ? [{ system: 'https://icd.who.int/browse11/l-m/en', code: rx.diagnosis_icd11_code }] : undefined },
        recordedDate: iso(rx.issue_date)
      }));
    }

    (rx.items || []).forEach((item, index) => {
      entries.push(makeEntry({
        resourceType: 'MedicationRequest',
        id: `rx-${rx._id}-${index}`,
        status: rx.status === 'Cancelled' ? 'cancelled' : 'active',
        intent: 'order',
        subject: { reference: `Patient/patient-${patient._id}` },
        authoredOn: iso(rx.issue_date),
        medicationCodeableConcept: { text: item.medicine_name },
        dosageInstruction: [{
          text: [item.dosage, item.frequency, item.duration, item.instructions, item.timing].filter(Boolean).join(' | '),
          route: item.route_of_administration ? { text: item.route_of_administration } : undefined
        }],
        note: rx.notes ? [{ text: rx.notes }] : undefined
      }));
    });
  });
  return entries;
}

function labEntries(labReports, patient) {
  return labReports.map(report => makeEntry({
    resourceType: 'DiagnosticReport',
    id: `lab-${report._id}`,
    status: 'final',
    category: [{ text: 'Laboratory' }],
    code: { text: report.report_type || 'Lab report' },
    subject: { reference: `Patient/patient-${patient._id}` },
    effectiveDateTime: iso(report.report_date),
    issued: iso(report.createdAt || report.report_date),
    conclusion: report.notes,
    presentedForm: report.file_url ? [{ contentType: 'application/pdf', url: report.file_url, title: report.report_type || 'Lab report' }] : undefined
  }));
}

function radiologyEntries(radiologyReports, patient) {
  return radiologyReports.map(report => makeEntry({
    resourceType: 'DiagnosticReport',
    id: `rad-${report._id}`,
    status: ['Completed', 'Reported'].includes(report.status) ? 'final' : 'registered',
    category: [{ text: 'Radiology' }],
    code: { text: report.testName || 'Radiology report', coding: report.testCode ? [{ code: report.testCode, display: report.testName }] : undefined },
    subject: { reference: `Patient/patient-${patient._id}` },
    effectiveDateTime: iso(report.performedAt || report.requestedDate),
    issued: iso(report.reportedAt || report.updatedAt || report.requestedDate),
    conclusion: [report.findings, report.impression].filter(Boolean).join('\n'),
    presentedForm: report.report_url ? [{ contentType: 'application/pdf', url: report.report_url, title: report.testName || 'Radiology report' }] : undefined
  }));
}

function dischargeEntries(dischargeSummaries, patient) {
  return dischargeSummaries.map(summary => makeEntry({
    resourceType: 'DocumentReference',
    id: `discharge-${summary._id}`,
    status: summary.status === 'Finalized' ? 'current' : 'preliminary',
    type: { text: 'Discharge Summary' },
    subject: { reference: `Patient/patient-${patient._id}` },
    date: iso(summary.finalizedAt || summary.updatedAt || summary.dischargeDate),
    description: [summary.finalDiagnosis, summary.conditionOnDischarge, summary.followUpAdvice].filter(Boolean).join('\n'),
    content: [{ attachment: { contentType: 'text/plain', title: 'Discharge Summary', data: Buffer.from(JSON.stringify(clean(summary))).toString('base64') } }]
  }));
}

async function generateEhrBundle(patientId, options = {}) {
  const records = await collectPatientRecords(patientId);
  const { patient } = records;
  const bundleId = new mongoose.Types.ObjectId().toString();

  const entries = [
    makeEntry(createComposition(patient, records, bundleId)),
    makeEntry(createPatientResource(patient)),
    ...prescriptionEntries(records.prescriptions, patient),
    ...labEntries(records.labReports, patient),
    ...radiologyEntries(records.radiologyReports, patient),
    ...dischargeEntries(records.dischargeSummaries, patient)
  ];

  const bundle = clean({
    resourceType: 'Bundle',
    id: bundleId,
    type: 'document',
    timestamp: new Date().toISOString(),
    identifier: {
      system: 'https://mediqliq.local/ehr-bundle',
      value: bundleId
    },
    entry: entries
  });

  const ehrBundle = await EHRBundle.create({
    patientId: patient._id,
    abhaNumber: patient.abha?.number,
    abhaAddress: patient.abha?.address,
    bundleType: options.bundleType || 'EMR_SUMMARY',
    status: 'generated',
    sourceModules: ['prescriptions', 'diagnosis', 'lab_reports', 'radiology_reports', 'discharge_summaries'],
    bundle,
    recordCounts: {
      appointments: records.appointments.length,
      admissions: records.admissions.length,
      prescriptions: records.prescriptions.length,
      labReports: records.labReports.length,
      radiologyReports: records.radiologyReports.length,
      dischargeSummaries: records.dischargeSummaries.length
    },
    createdBy: options.createdBy
  });

  return { ehrBundle, bundle, records };
}

module.exports = {
  collectPatientRecords,
  generateEhrBundle
};
