const crypto = require('crypto');
const Patient = require('../../models/Patient');
const Appointment = require('../../models/Appointment');
const Prescription = require('../../models/Prescription');
const LabReport = require('../../models/LabReport');
const RadiologyRequest = require('../../models/RadiologyRequest');
const DischargeSummary = require('../../models/DischargeSummary');
const Vital = require('../../models/Vital');
const Invoice = require('../../models/Invoice');
const Immunization = require('../../models/Immunization');
const ClinicalDocument = require('../../models/ClinicalDocument');
const EHRBundle = require('../../models/EHRBundle');
const abdmConfig = require('../../config/abdm.config');
const { normalizeInternalHiTypes } = require('../../utils/abdmHiTypes');

const PROFILE_NAMES = {
  PRESCRIPTION: 'PrescriptionRecord',
  DIAGNOSTIC_REPORT: 'DiagnosticReportRecord',
  OP_CONSULTATION: 'OPConsultRecord',
  DISCHARGE_SUMMARY: 'DischargeSummaryRecord',
  IMMUNIZATION_RECORD: 'ImmunizationRecord',
  HEALTH_DOCUMENT_RECORD: 'HealthDocumentRecord',
  WELLNESS_RECORD: 'WellnessRecord',
  INVOICE: 'InvoiceRecord'
};

const ALL_HI_TYPES = Object.keys(PROFILE_NAMES);

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function iso(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter((item) => item !== undefined && item !== null && item !== '');
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, clean(item)])
      .filter(([, item]) => item !== undefined && item !== null && item !== '' && !(Array.isArray(item) && item.length === 0))
  );
}

function profileUrl(hiType) {
  return `${abdmConfig.fhirProfileBase}/${PROFILE_NAMES[hiType]}`;
}

function patientResource(patient) {
  return clean({
    resourceType: 'Patient',
    id: `patient-${patient._id}`,
    identifier: [
      patient.uhid ? { system: 'https://mediqliq.com/identifier/uhid', value: patient.uhid } : undefined,
      patient.abha?.number
        ? { system: 'https://healthid.ndhm.gov.in/abha-number', value: patient.abha.number }
        : undefined,
      patient.abha?.address
        ? { system: 'https://healthid.ndhm.gov.in/abha-address', value: patient.abha.address }
        : undefined
    ],
    name: [
      {
        text: [patient.salutation, patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' '),
        given: [patient.first_name, patient.middle_name].filter(Boolean),
        family: patient.last_name
      }
    ],
    telecom: [
      patient.phone ? { system: 'phone', value: patient.phone } : undefined,
      patient.email ? { system: 'email', value: patient.email } : undefined
    ],
    gender: ['male', 'female', 'other'].includes(String(patient.gender).toLowerCase())
      ? String(patient.gender).toLowerCase()
      : 'unknown',
    birthDate: patient.dob ? new Date(patient.dob).toISOString().slice(0, 10) : undefined,
    address: patient.address
      ? [
          {
            text: patient.address,
            city: patient.city,
            district: patient.district,
            state: patient.state,
            postalCode: patient.zipCode
          }
        ]
      : undefined
  });
}

function bundleDocument({ hiType, patient, resources, title, date }) {
  const patientRes = patientResource(patient);
  const compositionId = id('composition');
  const composition = clean({
    resourceType: 'Composition',
    id: compositionId,
    meta: { profile: [profileUrl(hiType)] },
    status: 'final',
    type: { text: PROFILE_NAMES[hiType] },
    subject: { reference: `Patient/${patientRes.id}` },
    date: iso(date) || new Date().toISOString(),
    title: title || PROFILE_NAMES[hiType],
    section: [
      {
        title: title || PROFILE_NAMES[hiType],
        entry: resources.map((resource) => ({ reference: `${resource.resourceType}/${resource.id}` }))
      }
    ]
  });

  const entries = [composition, patientRes, ...resources].map((resource) => ({
    fullUrl: `urn:uuid:${resource.id}`,
    resource
  }));

  return clean({
    resourceType: 'Bundle',
    id: id('bundle'),
    meta: { profile: [profileUrl(hiType)] },
    identifier: { system: 'https://mediqliq.com/abdm/ehr-bundle', value: crypto.randomUUID() },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: entries
  });
}

function medicationResources(prescriptions, patient) {
  const resources = [];
  for (const prescription of prescriptions) {
    for (const [index, item] of (prescription.items || []).entries()) {
      resources.push(
        clean({
          resourceType: 'MedicationRequest',
          id: `medreq-${prescription._id}-${index}`,
          status: prescription.status === 'Cancelled' ? 'cancelled' : 'active',
          intent: 'order',
          subject: { reference: `Patient/patient-${patient._id}` },
          authoredOn: iso(prescription.issue_date || prescription.createdAt),
          medicationCodeableConcept: {
            coding: item.nlem_code
              ? [{ system: 'https://mediqliq.com/code-system/nlem', code: item.nlem_code, display: item.medicine_name }]
              : undefined,
            text: item.medicine_name
          },
          dosageInstruction: [
            {
              text: [item.dosage, item.frequency, item.duration, item.instructions, item.timing].filter(Boolean).join(' | '),
              route: item.route_of_administration ? { text: item.route_of_administration } : undefined
            }
          ],
          note: prescription.notes ? [{ text: prescription.notes }] : undefined
        })
      );
    }
  }
  return resources;
}

function diagnosticResources(labs, radiology, patient) {
  return [
    ...labs.map((report) =>
      clean({
        resourceType: 'DiagnosticReport',
        id: `lab-${report._id}`,
        status: 'final',
        category: [{ text: 'Laboratory' }],
        code: { text: report.report_type || 'Laboratory report' },
        subject: { reference: `Patient/patient-${patient._id}` },
        effectiveDateTime: iso(report.report_date || report.createdAt),
        issued: iso(report.updatedAt || report.report_date),
        conclusion: report.notes,
        presentedForm: report.file_url
          ? [{ contentType: 'application/pdf', url: report.file_url, title: report.report_type || 'Laboratory report' }]
          : undefined
      })
    ),
    ...radiology.map((report) =>
      clean({
        resourceType: 'DiagnosticReport',
        id: `radiology-${report._id}`,
        status: ['Completed', 'Reported'].includes(report.status) ? 'final' : 'registered',
        category: [{ text: 'Radiology' }],
        code: { text: report.testName || 'Radiology report' },
        subject: { reference: `Patient/patient-${patient._id}` },
        effectiveDateTime: iso(report.performedAt || report.requestedDate),
        issued: iso(report.reportedAt || report.updatedAt || report.requestedDate),
        conclusion: [report.findings, report.impression].filter(Boolean).join('\n'),
        presentedForm: report.report_url
          ? [{ contentType: 'application/pdf', url: report.report_url, title: report.testName || 'Radiology report' }]
          : undefined
      })
    )
  ];
}

function consultationResources(appointments, prescriptions, patient) {
  const resources = [];
  for (const appointment of appointments) {
    resources.push(
      clean({
        resourceType: 'Encounter',
        id: `encounter-${appointment._id}`,
        status: appointment.status === 'Completed' ? 'finished' : appointment.status === 'Cancelled' ? 'cancelled' : 'in-progress',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
        type: [{ text: appointment.appointment_type }],
        subject: { reference: `Patient/patient-${patient._id}` },
        period: {
          start: iso(appointment.actual_start_time || appointment.start_time || appointment.appointment_date),
          end: iso(appointment.actual_end_time || appointment.end_time)
        },
        reasonCode: appointment.notes ? [{ text: appointment.notes }] : undefined
      })
    );
  }
  for (const prescription of prescriptions) {
    if (!prescription.diagnosis) continue;
    resources.push(
      clean({
        resourceType: 'Condition',
        id: `condition-${prescription._id}`,
        clinicalStatus: { text: 'active' },
        subject: { reference: `Patient/patient-${patient._id}` },
        code: {
          coding: prescription.diagnosis_icd11_code
            ? [{ system: 'https://icd.who.int/browse11/l-m/en', code: prescription.diagnosis_icd11_code }]
            : undefined,
          text: prescription.diagnosis
        },
        recordedDate: iso(prescription.issue_date || prescription.createdAt)
      })
    );
  }
  return resources;
}

function dischargeResources(summaries, patient) {
  return summaries.map((summary) =>
    clean({
      resourceType: 'DocumentReference',
      id: `discharge-${summary._id}`,
      status: summary.status === 'Finalized' ? 'current' : 'preliminary',
      type: { text: 'Discharge Summary' },
      subject: { reference: `Patient/patient-${patient._id}` },
      date: iso(summary.finalizedAt || summary.updatedAt || summary.dischargeDate),
      description: [summary.finalDiagnosis, summary.conditionOnDischarge, summary.followUpAdvice].filter(Boolean).join('\n'),
      content: [
        {
          attachment: {
            contentType: 'application/json',
            title: 'Discharge Summary',
            data: Buffer.from(JSON.stringify(summary)).toString('base64')
          }
        }
      ]
    })
  );
}

function immunizationResources(items, patient) {
  return items.map((item) =>
    clean({
      resourceType: 'Immunization',
      id: `immunization-${item._id}`,
      status: item.status || 'completed',
      vaccineCode: {
        coding: item.vaccineCode ? [{ system: 'https://mediqliq.com/code-system/vaccine', code: item.vaccineCode }] : undefined,
        text: item.vaccineName
      },
      patient: { reference: `Patient/patient-${patient._id}` },
      occurrenceDateTime: iso(item.occurrenceDate),
      lotNumber: item.batchNumber,
      manufacturer: item.manufacturer ? { display: item.manufacturer } : undefined,
      route: item.route ? { text: item.route } : undefined,
      site: item.site ? { text: item.site } : undefined,
      protocolApplied: item.doseNumber
        ? [{ doseNumberString: item.doseNumber, seriesDosesString: item.seriesDoses }]
        : undefined,
      note: item.notes ? [{ text: item.notes }] : undefined
    })
  );
}

function healthDocumentResources(items, patient) {
  return items.map((item) =>
    clean({
      resourceType: 'DocumentReference',
      id: `healthdoc-${item._id}`,
      status: item.status || 'current',
      type: { text: item.documentType },
      subject: { reference: `Patient/patient-${patient._id}` },
      date: iso(item.documentDate),
      description: item.description,
      content: [
        {
          attachment: item.fileUrl
            ? { contentType: item.mimeType || 'application/octet-stream', url: item.fileUrl, title: item.title }
            : {
                contentType: item.mimeType || 'text/plain',
                data: Buffer.from(item.contentText || '').toString('base64'),
                title: item.title
              }
        }
      ]
    })
  );
}

function wellnessResources(vitals, patient) {
  const mapping = [
    ['bp', 'Blood pressure'],
    ['weight', 'Body weight'],
    ['height', 'Body height'],
    ['pulse', 'Pulse rate'],
    ['spo2', 'Oxygen saturation'],
    ['temperature', 'Body temperature'],
    ['respiratory_rate', 'Respiratory rate'],
    ['random_blood_sugar', 'Random blood sugar']
  ];
  const resources = [];
  for (const vital of vitals) {
    for (const [field, label] of mapping) {
      if (!vital[field]) continue;
      resources.push(
        clean({
          resourceType: 'Observation',
          id: `observation-${vital._id}-${field}`,
          status: 'final',
          code: { text: label },
          subject: { reference: `Patient/patient-${patient._id}` },
          effectiveDateTime: iso(vital.recorded_at || vital.createdAt),
          valueString: String(vital[field])
        })
      );
    }
  }
  return resources;
}

function invoiceResources(invoices, patient) {
  return invoices.map((invoice) =>
    clean({
      resourceType: 'Invoice',
      id: `invoice-${invoice._id}`,
      status: invoice.document_stage === 'VOID' ? 'cancelled' : invoice.status === 'Paid' ? 'balanced' : 'issued',
      identifier: invoice.invoice_number
        ? [{ system: 'https://mediqliq.com/identifier/invoice', value: invoice.invoice_number }]
        : undefined,
      subject: { reference: `Patient/patient-${patient._id}` },
      date: iso(invoice.issued_at || invoice.created_at || invoice.createdAt),
      totalNet: invoice.subtotal !== undefined ? { value: invoice.subtotal, currency: 'INR' } : undefined,
      totalGross: invoice.total !== undefined ? { value: invoice.total, currency: 'INR' } : undefined,
      note: invoice.balance_due !== undefined ? [{ text: `Balance due: INR ${invoice.balance_due}` }] : undefined
    })
  );
}

async function loadRecords(patientId, dateRange = {}) {
  const dateFilter = {};
  if (dateRange?.from || dateRange?.to) {
    if (dateRange.from) dateFilter.$gte = new Date(dateRange.from);
    if (dateRange.to) dateFilter.$lte = new Date(dateRange.to);
  }
  const withDate = (field) => (Object.keys(dateFilter).length ? { [field]: dateFilter } : {});

  const [patient, appointments, prescriptions, labs, radiology, discharges, vitals, invoices, immunizations, documents] = await Promise.all([
    Patient.findById(patientId).lean(),
    Appointment.find({ patient_id: patientId, ...withDate('appointment_date') }).sort({ appointment_date: -1 }).lean(),
    Prescription.find({ patient_id: patientId, ...withDate('issue_date') }).sort({ issue_date: -1 }).lean(),
    LabReport.find({ patient_id: patientId, ...withDate('report_date') }).sort({ report_date: -1 }).lean(),
    RadiologyRequest.find({ patientId, ...withDate('requestedDate') }).sort({ requestedDate: -1 }).lean(),
    DischargeSummary.find({ patientId, ...withDate('dischargeDate') }).sort({ dischargeDate: -1 }).lean(),
    Vital.find({ patient_id: patientId, ...withDate('recorded_at') }).sort({ recorded_at: -1 }).lean(),
    Invoice.find({ patient_id: patientId, ...withDate('created_at') }).sort({ created_at: -1 }).lean(),
    Immunization.find({ patientId, ...withDate('occurrenceDate') }).sort({ occurrenceDate: -1 }).lean(),
    ClinicalDocument.find({ patientId, ...withDate('documentDate') }).sort({ documentDate: -1 }).lean()
  ]);
  if (!patient) throw new Error('Patient not found');
  return { patient, appointments, prescriptions, labs, radiology, discharges, vitals, invoices, immunizations, documents };
}

async function generateAbdmHiBundle(patientId, options = {}) {
  const records = await loadRecords(patientId, options.dateRange || {});
  const normalizedRequested = normalizeInternalHiTypes(options.hiTypes || []);
  const requested = normalizedRequested.length ? normalizedRequested : ALL_HI_TYPES;

  const bundles = {};
  for (const hiType of requested) {
    let resources = [];
    switch (hiType) {
      case 'PRESCRIPTION':
        resources = medicationResources(records.prescriptions, records.patient);
        break;
      case 'DIAGNOSTIC_REPORT':
        resources = diagnosticResources(records.labs, records.radiology, records.patient);
        break;
      case 'OP_CONSULTATION':
        resources = consultationResources(records.appointments, records.prescriptions, records.patient);
        break;
      case 'DISCHARGE_SUMMARY':
        resources = dischargeResources(records.discharges, records.patient);
        break;
      case 'IMMUNIZATION_RECORD':
        resources = immunizationResources(records.immunizations, records.patient);
        break;
      case 'HEALTH_DOCUMENT_RECORD':
        resources = healthDocumentResources(records.documents, records.patient);
        break;
      case 'WELLNESS_RECORD':
        resources = wellnessResources(records.vitals, records.patient);
        break;
      case 'INVOICE':
        resources = invoiceResources(records.invoices, records.patient);
        break;
      default:
        break;
    }
    if (resources.length) {
      bundles[hiType] = bundleDocument({
        hiType,
        patient: records.patient,
        resources,
        title: PROFILE_NAMES[hiType]
      });
    }
  }

  const saved = [];
  for (const [hiType, bundle] of Object.entries(bundles)) {
    saved.push(
      await EHRBundle.create({
        patientId: records.patient._id,
        abhaNumber: records.patient.abha?.number,
        abhaAddress: records.patient.abha?.address,
        bundleType: hiType,
        status: 'generated',
        sourceModules: [hiType],
        bundle
      })
    );
  }

  return { bundles, saved, hiTypes: Object.keys(bundles) };
}

module.exports = {
  ALL_HI_TYPES,
  PROFILE_NAMES,
  generateAbdmHiBundle
};
