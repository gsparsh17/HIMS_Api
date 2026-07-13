const crypto = require('crypto');
const Patient = require('../../models/Patient');
const Appointment = require('../../models/Appointment');
const Prescription = require('../../models/Prescription');
const LabReport = require('../../models/LabReport');
const RadiologyRequest = require('../../models/RadiologyRequest');
const DischargeSummary = require('../../models/DischargeSummary');
const Vital = require('../../models/Vital');
const IPDVitals = require('../../models/IPDVitals');
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
      patient.abha?.number ? { system: 'https://healthid.ndhm.gov.in/abha-number', value: patient.abha.number } : undefined,
      patient.abha?.address ? { system: 'https://healthid.ndhm.gov.in/abha-address', value: patient.abha.address } : undefined
    ],
    name: [{
      text: [patient.salutation, patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' '),
      given: [patient.first_name, patient.middle_name].filter(Boolean),
      family: patient.last_name
    }],
    telecom: [
      patient.phone ? { system: 'phone', value: patient.phone } : undefined,
      patient.email ? { system: 'email', value: patient.email } : undefined
    ],
    gender: ['male', 'female', 'other'].includes(String(patient.gender).toLowerCase())
      ? String(patient.gender).toLowerCase()
      : 'unknown',
    birthDate: patient.dob ? new Date(patient.dob).toISOString().slice(0, 10) : undefined,
    address: patient.address ? [{ text: patient.address, city: patient.city, district: patient.district, state: patient.state, postalCode: patient.zipCode }] : undefined
  });
}

function rewriteReferences(value, referenceMap) {
  if (Array.isArray(value)) return value.map((item) => rewriteReferences(item, referenceMap));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'reference' && typeof item === 'string' && referenceMap.has(item)) output[key] = referenceMap.get(item);
    else output[key] = rewriteReferences(item, referenceMap);
  }
  return output;
}

function bundleDocument({ hiType, patient, resources, title, date, careContextReference }) {
  const sourceResources = [patientResource(patient), ...resources];
  const referenceMap = new Map();
  const normalized = sourceResources.map((resource) => {
    const uuid = crypto.randomUUID();
    referenceMap.set(`${resource.resourceType}/${resource.id}`, `urn:uuid:${uuid}`);
    return { ...resource, id: uuid, __fullUrl: `urn:uuid:${uuid}` };
  });

  const patientEntry = normalized.find((resource) => resource.resourceType === 'Patient');
  const clinicalEntries = normalized.filter((resource) => resource.resourceType !== 'Patient');
  const compositionUuid = crypto.randomUUID();
  const composition = clean({
    resourceType: 'Composition',
    id: compositionUuid,
    meta: { profile: [profileUrl(hiType)] },
    status: 'final',
    type: { text: PROFILE_NAMES[hiType] },
    subject: { reference: patientEntry.__fullUrl },
    date: iso(date) || new Date().toISOString(),
    title: title || PROFILE_NAMES[hiType],
    identifier: careContextReference
      ? { system: 'https://mediqliq.com/abdm/care-context', value: careContextReference }
      : undefined,
    section: [{
      title: title || PROFILE_NAMES[hiType],
      entry: clinicalEntries.map((resource) => ({ reference: resource.__fullUrl }))
    }]
  });

  const entries = [
    { fullUrl: `urn:uuid:${compositionUuid}`, resource: composition },
    ...normalized.map((resource) => {
      const { __fullUrl, ...withoutMarker } = resource;
      return { fullUrl: __fullUrl, resource: rewriteReferences(withoutMarker, referenceMap) };
    })
  ];

  return clean({
    resourceType: 'Bundle',
    id: crypto.randomUUID(),
    identifier: { system: 'https://mediqliq.com/abdm/ehr-bundle', value: crypto.randomUUID() },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: entries
  });
}

function patientRef(patient) {
  return `Patient/patient-${patient._id}`;
}

function medicationResources(prescriptions, patient) {
  const resources = [];
  for (const prescription of prescriptions) {
    for (const [index, item] of (prescription.items || []).entries()) {
      resources.push(clean({
        resourceType: 'MedicationRequest',
        id: `medreq-${prescription._id}-${index}`,
        status: prescription.status === 'Cancelled' ? 'cancelled' : 'active',
        intent: 'order',
        subject: { reference: patientRef(patient) },
        authoredOn: iso(prescription.issue_date || prescription.createdAt),
        medicationCodeableConcept: {
          coding: item.nlem_code ? [{ system: 'https://mediqliq.com/code-system/nlem', code: item.nlem_code, display: item.medicine_name }] : undefined,
          text: item.medicine_name
        },
        dosageInstruction: [{
          text: [item.dosage, item.frequency, item.duration, item.instructions, item.timing].filter(Boolean).join(' | '),
          route: item.route_of_administration ? { text: item.route_of_administration } : undefined
        }],
        note: prescription.notes ? [{ text: prescription.notes }] : undefined
      }));
    }
  }
  return resources;
}

function diagnosticResources(labs, radiology, patient) {
  const allowExternalUrls = String(process.env.ABDM_ALLOW_EXTERNAL_DOCUMENT_URLS || 'false').toLowerCase() === 'true';
  return [
    ...labs.map((report) => clean({
      resourceType: 'DiagnosticReport',
      id: `lab-${report._id}`,
      status: 'final',
      category: [{ text: 'Laboratory' }],
      code: { text: report.report_type || 'Laboratory report' },
      subject: { reference: patientRef(patient) },
      effectiveDateTime: iso(report.report_date || report.createdAt),
      issued: iso(report.updatedAt || report.report_date),
      conclusion: report.notes,
      presentedForm: allowExternalUrls && report.file_url
        ? [{ contentType: 'application/pdf', url: report.file_url, title: report.report_type || 'Laboratory report' }]
        : undefined
    })),
    ...radiology.map((report) => clean({
      resourceType: 'DiagnosticReport',
      id: `radiology-${report._id}`,
      status: ['Completed', 'Reported'].includes(report.status) ? 'final' : 'registered',
      category: [{ text: 'Radiology' }],
      code: { text: report.testName || 'Radiology report' },
      subject: { reference: patientRef(patient) },
      effectiveDateTime: iso(report.performedAt || report.requestedDate),
      issued: iso(report.reportedAt || report.updatedAt || report.requestedDate),
      conclusion: [report.findings, report.impression].filter(Boolean).join('\n'),
      presentedForm: allowExternalUrls && report.report_url
        ? [{ contentType: 'application/pdf', url: report.report_url, title: report.testName || 'Radiology report' }]
        : undefined
    }))
  ];
}

function consultationResources(appointments, prescriptions, patient) {
  const resources = appointments.map((appointment) => clean({
    resourceType: 'Encounter',
    id: `encounter-${appointment._id}`,
    status: appointment.status === 'Completed' ? 'finished' : appointment.status === 'Cancelled' ? 'cancelled' : 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    type: [{ text: appointment.appointment_type }],
    subject: { reference: patientRef(patient) },
    period: { start: iso(appointment.actual_start_time || appointment.start_time || appointment.appointment_date), end: iso(appointment.actual_end_time || appointment.end_time) },
    reasonCode: appointment.notes ? [{ text: appointment.notes }] : undefined
  }));
  for (const prescription of prescriptions) {
    if (!prescription.diagnosis) continue;
    resources.push(clean({
      resourceType: 'Condition',
      id: `condition-${prescription._id}`,
      clinicalStatus: { text: 'active' },
      subject: { reference: patientRef(patient) },
      code: {
        coding: prescription.diagnosis_icd11_code ? [{ system: 'https://icd.who.int/browse11/l-m/en', code: prescription.diagnosis_icd11_code }] : undefined,
        text: prescription.diagnosis
      },
      recordedDate: iso(prescription.issue_date || prescription.createdAt)
    }));
  }
  return resources;
}

function dischargeResources(summaries, patient) {
  return summaries.map((summary) => {
    const safeSummary = {
      admissionDate: summary.admissionDate,
      dischargeDate: summary.dischargeDate,
      finalDiagnosis: summary.finalDiagnosis,
      conditionOnDischarge: summary.conditionOnDischarge,
      treatmentSummary: summary.treatmentSummary,
      medicationsOnDischarge: summary.medicationsOnDischarge,
      followUpAdvice: summary.followUpAdvice
    };
    return clean({
      resourceType: 'DocumentReference',
      id: `discharge-${summary._id}`,
      status: summary.status === 'Finalized' ? 'current' : 'preliminary',
      type: { text: 'Discharge Summary' },
      subject: { reference: patientRef(patient) },
      date: iso(summary.finalizedAt || summary.updatedAt || summary.dischargeDate),
      description: [summary.finalDiagnosis, summary.conditionOnDischarge, summary.followUpAdvice].filter(Boolean).join('\n'),
      content: [{ attachment: { contentType: 'application/json', title: 'Discharge Summary', data: Buffer.from(JSON.stringify(safeSummary)).toString('base64') } }]
    });
  });
}

function immunizationResources(items, patient) {
  return items.map((item) => clean({
    resourceType: 'Immunization',
    id: `immunization-${item._id}`,
    status: item.status || 'completed',
    vaccineCode: { coding: item.vaccineCode ? [{ system: 'https://mediqliq.com/code-system/vaccine', code: item.vaccineCode }] : undefined, text: item.vaccineName },
    patient: { reference: patientRef(patient) },
    occurrenceDateTime: iso(item.occurrenceDate),
    lotNumber: item.batchNumber,
    manufacturer: item.manufacturer ? { display: item.manufacturer } : undefined,
    route: item.route ? { text: item.route } : undefined,
    site: item.site ? { text: item.site } : undefined,
    protocolApplied: item.doseNumber ? [{ doseNumberString: item.doseNumber, seriesDosesString: item.seriesDoses }] : undefined,
    note: item.notes ? [{ text: item.notes }] : undefined
  }));
}

function healthDocumentResources(items, patient) {
  const allowExternalUrls = String(process.env.ABDM_ALLOW_EXTERNAL_DOCUMENT_URLS || 'false').toLowerCase() === 'true';
  return items.map((item) => clean({
    resourceType: 'DocumentReference',
    id: `healthdoc-${item._id}`,
    status: item.status || 'current',
    type: { text: item.documentType },
    subject: { reference: patientRef(patient) },
    date: iso(item.documentDate),
    description: item.description,
    content: [{
      attachment: allowExternalUrls && item.fileUrl
        ? { contentType: item.mimeType || 'application/octet-stream', url: item.fileUrl, title: item.title }
        : { contentType: item.mimeType || 'text/plain', data: Buffer.from(item.contentText || '').toString('base64'), title: item.title }
    }]
  }));
}

function wellnessResources(vitals, patient) {
  const mapping = [
    ['bp', 'Blood pressure'],
    ['bloodPressureString', 'Blood pressure'],
    ['weight', 'Body weight'],
    ['height', 'Body height'],
    ['pulse', 'Pulse rate'],
    ['spo2', 'Oxygen saturation'],
    ['temperature', 'Body temperature'],
    ['respiratory_rate', 'Respiratory rate'],
    ['respiratoryRate', 'Respiratory rate'],
    ['random_blood_sugar', 'Random blood sugar'],
    ['bloodSugar', 'Blood sugar'],
    ['painScore', 'Pain score']
  ];
  const resources = [];
  for (const vital of vitals) {
    const enriched = {
      ...vital,
      bloodPressureString:
        vital.bloodPressureString ||
        (vital.bloodPressure?.systolic && vital.bloodPressure?.diastolic
          ? `${vital.bloodPressure.systolic}/${vital.bloodPressure.diastolic}`
          : undefined)
    };
    for (const [field, label] of mapping) {
      if (enriched[field] === undefined || enriched[field] === null || enriched[field] === '') continue;
      resources.push(clean({
        resourceType: 'Observation',
        id: `observation-${vital._id}-${field}`,
        status: 'final',
        code: { text: label },
        subject: { reference: patientRef(patient) },
        effectiveDateTime: iso(vital.recorded_at || vital.recordedAt || vital.createdAt),
        valueString: String(enriched[field])
      }));
    }
  }
  return resources;
}

function invoiceResources(invoices, patient) {
  return invoices.map((invoice) => clean({
    resourceType: 'Invoice',
    id: `invoice-${invoice._id}`,
    status: invoice.document_stage === 'VOID' ? 'cancelled' : invoice.status === 'Paid' ? 'balanced' : 'issued',
    identifier: invoice.invoice_number ? [{ system: 'https://mediqliq.com/identifier/invoice', value: invoice.invoice_number }] : undefined,
    subject: { reference: patientRef(patient) },
    date: iso(invoice.issued_at || invoice.created_at || invoice.createdAt),
    totalNet: invoice.subtotal !== undefined ? { value: invoice.subtotal, currency: 'INR' } : undefined,
    totalGross: invoice.total !== undefined ? { value: invoice.total, currency: 'INR' } : undefined,
    note: invoice.balance_due !== undefined ? [{ text: `Balance due: INR ${invoice.balance_due}` }] : undefined
  }));
}

const COLLECTIONS = {
  Appointment: { model: Appointment, bucket: 'appointments', patientField: 'patient_id', dateField: 'appointment_date' },
  Prescription: { model: Prescription, bucket: 'prescriptions', patientField: 'patient_id', dateField: 'issue_date' },
  LabReport: { model: LabReport, bucket: 'labs', patientField: 'patient_id', dateField: 'report_date' },
  RadiologyRequest: { model: RadiologyRequest, bucket: 'radiology', patientField: 'patientId', dateField: 'requestedDate' },
  DischargeSummary: { model: DischargeSummary, bucket: 'discharges', patientField: 'patientId', dateField: 'dischargeDate' },
  Vital: { model: Vital, bucket: 'vitals', patientField: 'patient_id', dateField: 'recorded_at' },
  IPDVitals: { model: IPDVitals, bucket: 'vitals', patientField: 'patientId', dateField: 'recordedAt' },
  Invoice: { model: Invoice, bucket: 'invoices', patientField: 'patient_id', dateField: 'created_at' },
  Immunization: { model: Immunization, bucket: 'immunizations', patientField: 'patientId', dateField: 'occurrenceDate' },
  ClinicalDocument: { model: ClinicalDocument, bucket: 'documents', patientField: 'patientId', dateField: 'documentDate' }
};

async function loadRecords(patientId, { dateRange = {}, recordReferences = [] } = {}) {
  const patient = await Patient.findById(patientId).lean();
  if (!patient) throw new Error('Patient not found');
  const records = { patient, appointments: [], prescriptions: [], labs: [], radiology: [], discharges: [], vitals: [], invoices: [], immunizations: [], documents: [] };

  const grouped = new Map();
  for (const reference of recordReferences || []) {
    if (!reference?.model || !reference?.recordId || !COLLECTIONS[reference.model]) continue;
    if (!grouped.has(reference.model)) grouped.set(reference.model, []);
    grouped.get(reference.model).push(reference.recordId);
  }

  if (grouped.size) {
    await Promise.all(Array.from(grouped.entries()).map(async ([name, ids]) => {
      const config = COLLECTIONS[name];
      records[config.bucket] = await config.model.find({ _id: { $in: ids }, [config.patientField]: patientId }).lean();
    }));
    return records;
  }

  const range = {};
  if (dateRange?.from) range.$gte = new Date(dateRange.from);
  if (dateRange?.to) range.$lte = new Date(dateRange.to);
  await Promise.all(Object.values(COLLECTIONS).map(async (config) => {
    const query = { [config.patientField]: patientId };
    if (Object.keys(range).length) query[config.dateField] = range;
    records[config.bucket] = await config.model.find(query).sort({ [config.dateField]: -1 }).lean();
  }));
  return records;
}

function resourcesFor(hiType, records) {
  switch (hiType) {
    case 'PRESCRIPTION': return medicationResources(records.prescriptions, records.patient);
    case 'DIAGNOSTIC_REPORT': return diagnosticResources(records.labs, records.radiology, records.patient);
    case 'OP_CONSULTATION': return consultationResources(records.appointments, records.prescriptions, records.patient);
    case 'DISCHARGE_SUMMARY': return dischargeResources(records.discharges, records.patient);
    case 'IMMUNIZATION_RECORD': return immunizationResources(records.immunizations, records.patient);
    case 'HEALTH_DOCUMENT_RECORD': return healthDocumentResources(records.documents, records.patient);
    case 'WELLNESS_RECORD': return wellnessResources(records.vitals, records.patient);
    case 'INVOICE': return invoiceResources(records.invoices, records.patient);
    default: return [];
  }
}

async function generateAbdmHiBundle(patientId, options = {}) {
  const records = await loadRecords(patientId, {
    dateRange: options.dateRange || {},
    recordReferences: options.recordReferences || []
  });
  const normalizedRequested = normalizeInternalHiTypes(options.hiTypes || []);
  const requested = normalizedRequested.length ? normalizedRequested : ALL_HI_TYPES;
  const bundles = {};

  for (const hiType of requested) {
    const resources = resourcesFor(hiType, records);
    if (!resources.length) continue;
    bundles[hiType] = bundleDocument({
      hiType,
      patient: records.patient,
      resources,
      title: PROFILE_NAMES[hiType],
      careContextReference: options.careContextReference
    });
  }

  const saved = [];
  if (options.persist !== false) {
    for (const [hiType, bundle] of Object.entries(bundles)) {
      const contentHash = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
      saved.push(await EHRBundle.findOneAndUpdate(
        {
          patientId: records.patient._id,
          bundleType: hiType,
          careContextReference: options.careContextReference || null,
          contentHash
        },
        {
          patientId: records.patient._id,
          abhaNumber: records.patient.abha?.number,
          abhaAddress: records.patient.abha?.address,
          bundleType: hiType,
          status: 'generated',
          sourceModules: [hiType],
          careContextReference: options.careContextReference,
          contentHash,
          bundle,
          createdBy: options.createdBy
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ));
    }
  }

  return { bundles, saved, hiTypes: Object.keys(bundles) };
}

module.exports = { ALL_HI_TYPES, PROFILE_NAMES, generateAbdmHiBundle };
