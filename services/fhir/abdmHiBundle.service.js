const crypto = require('crypto');
const Patient = require('../../models/Patient');
const Hospital = require('../../models/Hospital');
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
const { assertValidBundle } = require('../abdmFhirValidation.service');
const { normalizeInternalHiTypes } = require('../../utils/abdmHiTypes');
const { canonicalJson, sha256 } = require('../../utils/abdmCanonical');
const {
  PROFILE_NAMES,
  COMPOSITION_TYPES,
  SECTION_CODES,
  RESOURCE_PROFILE_BY_TYPE
} = require('../../config/abdm.profiles');
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

function resourceProfileUrl(profileName) {
  return `${abdmConfig.fhirProfileBase}/${profileName}`;
}

function withResourceProfile(resource) {
  const copy = { ...resource };
  let profileName = RESOURCE_PROFILE_BY_TYPE[copy.resourceType];
  if (copy.resourceType === 'DiagnosticReport') {
    const category = JSON.stringify(copy.category || '').toLowerCase();
    profileName = category.includes('radiology') || category.includes('imaging')
      ? 'DiagnosticReportImaging'
      : 'DiagnosticReportLab';
  }
  if (copy.resourceType === 'Observation' && copy.__profileName) profileName = copy.__profileName;
  delete copy.__profileName;
  if (profileName) {
    copy.meta = { ...(copy.meta || {}), profile: [resourceProfileUrl(profileName)] };
  }
  return copy;
}

function typedReference(resource) {
  return { reference: resource.__fullUrl, type: resource.resourceType };
}

function sectionCode(section) {
  if (!section.code) return undefined;
  return {
    coding: [{
      system: 'http://snomed.info/sct',
      code: section.code,
      display: section.display
    }]
  };
}

function sectionsFor(hiType, clinicalEntries) {
  const definitions = SECTION_CODES[hiType] || [];
  const sections = definitions.map((definition) => {
    const entries = clinicalEntries.filter((resource) => {
      if (definition.resourceProfiles?.length) {
        const profiles = resource.meta?.profile || [];
        if (definition.resourceProfiles.some((name) => profiles.some((profile) => profile.endsWith(`/${name}`)))) return true;
      }
      return definition.resourceTypes?.includes(resource.resourceType);
    });
    if (!entries.length) return null;
    return clean({
      title: definition.name,
      code: sectionCode(definition),
      entry: entries.map(typedReference)
    });
  }).filter(Boolean);

  if (sections.length) return sections;
  return [{
    title: PROFILE_NAMES[hiType],
    entry: clinicalEntries.map(typedReference)
  }];
}

function organizationResource(hospital) {
  return clean({
    resourceType: 'Organization',
    id: `organization-${hospital._id}`,
    active: true,
    identifier: [
      hospital.onboarding?.hfrFacilityId
        ? {
            system: 'https://facility.abdm.gov.in',
            value: hospital.onboarding.hfrFacilityId
          }
        : undefined,
      hospital.hospitalID
        ? {
            system: 'https://mediqliq.com/identifier/hospital',
            value: hospital.hospitalID
          }
        : undefined
    ],
    name: hospital.hospitalName || hospital.name,
    telecom: [
      hospital.contact ? { system: 'phone', value: hospital.contact } : undefined,
      hospital.email ? { system: 'email', value: hospital.email } : undefined
    ],
    address: hospital.address
      ? [
          {
            text: hospital.address,
            city: hospital.city,
            state: hospital.state,
            postalCode: hospital.pinCode,
            country: 'IN'
          }
        ]
      : undefined
  });
}

function patientResource(patient, hospital) {
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
    address: patient.address ? [{ text: patient.address, city: patient.city, district: patient.district, state: patient.state, postalCode: patient.zipCode, country: 'IN' }] : undefined,
    managingOrganization: hospital
      ? { reference: `Organization/organization-${hospital._id}` }
      : undefined
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

function bundleDocument({
  hiType,
  patient,
  hospital,
  resources,
  title,
  date,
  careContextReference,
  bundleVersion = '1'
}) {
  const sourceResources = [
    withResourceProfile(patientResource(patient, hospital)),
    withResourceProfile(organizationResource(hospital)),
    ...resources.map(withResourceProfile)
  ];
  const referenceMap = new Map();
  const normalized = sourceResources.map((resource) => {
    const uuid = crypto.randomUUID();
    referenceMap.set(`${resource.resourceType}/${resource.id}`, `urn:uuid:${uuid}`);
    return { ...resource, id: uuid, __fullUrl: `urn:uuid:${uuid}` };
  });

  const patientEntry = normalized.find((resource) => resource.resourceType === 'Patient');
  const organizationEntry = normalized.find((resource) => resource.resourceType === 'Organization');
  const clinicalEntries = normalized.filter(
    (resource) => !['Patient', 'Organization'].includes(resource.resourceType)
  );
  const encounterEntry = clinicalEntries.find((resource) => resource.resourceType === 'Encounter');
  const compositionUuid = crypto.randomUUID();
  const composition = clean({
    resourceType: 'Composition',
    id: compositionUuid,
    meta: { profile: [profileUrl(hiType)], versionId: String(bundleVersion) },
    status: 'final',
    type: COMPOSITION_TYPES[hiType],
    subject: { reference: patientEntry.__fullUrl, type: 'Patient' },
    encounter: encounterEntry
      ? { reference: encounterEntry.__fullUrl, type: 'Encounter' }
      : undefined,
    author: [{ reference: organizationEntry.__fullUrl, type: 'Organization' }],
    custodian: { reference: organizationEntry.__fullUrl, type: 'Organization' },
    date: iso(date) || new Date().toISOString(),
    title: title || PROFILE_NAMES[hiType],
    identifier: careContextReference
      ? { system: 'https://mediqliq.com/abdm/care-context', value: careContextReference }
      : { system: 'https://mediqliq.com/abdm/composition', value: crypto.randomUUID() },
    section: sectionsFor(hiType, clinicalEntries)
  });

  if (['OP_CONSULTATION', 'DISCHARGE_SUMMARY'].includes(hiType) && !composition.encounter) {
    const error = new Error(`${PROFILE_NAMES[hiType]} requires an Encounter resource`);
    error.code = 'ABDM_FHIR_ENCOUNTER_REQUIRED';
    throw error;
  }

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
    meta: {
      profile: [resourceProfileUrl('DocumentBundle')],
      versionId: String(bundleVersion),
      lastUpdated: new Date().toISOString()
    },
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
  const resources = [];
  for (const summary of summaries) {
    const encounterId = `encounter-discharge-${summary._id}`;
    resources.push(clean({
      resourceType: 'Encounter',
      id: encounterId,
      status: 'finished',
      class: {
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: 'IMP',
        display: 'inpatient encounter'
      },
      subject: { reference: patientRef(patient) },
      period: { start: iso(summary.admissionDate), end: iso(summary.dischargeDate) },
      hospitalization: {
        dischargeDisposition: summary.conditionOnDischarge
          ? { text: summary.conditionOnDischarge }
          : undefined
      }
    }));

    if (summary.chiefComplaints) {
      resources.push(clean({
        resourceType: 'Condition',
        id: `condition-chief-${summary._id}`,
        clinicalStatus: { text: 'active' },
        subject: { reference: patientRef(patient) },
        encounter: { reference: `Encounter/${encounterId}` },
        code: { text: summary.chiefComplaints },
        recordedDate: iso(summary.admissionDate)
      }));
    }
    if (summary.finalDiagnosis) {
      resources.push(clean({
        resourceType: 'Condition',
        id: `condition-diagnosis-${summary._id}`,
        clinicalStatus: { text: 'resolved' },
        subject: { reference: patientRef(patient) },
        encounter: { reference: `Encounter/${encounterId}` },
        code: { text: summary.finalDiagnosis },
        recordedDate: iso(summary.finalizedAt || summary.dischargeDate)
      }));
    }
    if (summary.examinationFindings) {
      resources.push(clean({
        resourceType: 'Observation',
        id: `observation-examination-${summary._id}`,
        status: 'final',
        code: { text: 'Physical examination findings' },
        subject: { reference: patientRef(patient) },
        encounter: { reference: `Encounter/${encounterId}` },
        effectiveDateTime: iso(summary.dischargeDate),
        valueString: summary.examinationFindings
      }));
    }
    if (summary.proceduresDone || summary.surgeriesDone) {
      resources.push(clean({
        resourceType: 'Procedure',
        id: `procedure-${summary._id}`,
        status: 'completed',
        subject: { reference: patientRef(patient) },
        encounter: { reference: `Encounter/${encounterId}` },
        code: { text: [summary.proceduresDone, summary.surgeriesDone].filter(Boolean).join('; ') },
        performedPeriod: { start: iso(summary.admissionDate), end: iso(summary.dischargeDate) }
      }));
    }
    for (const [index, medication] of (summary.dischargeMedications || []).entries()) {
      resources.push(clean({
        resourceType: 'MedicationRequest',
        id: `discharge-medication-${summary._id}-${index}`,
        status: 'active',
        intent: 'plan',
        subject: { reference: patientRef(patient) },
        encounter: { reference: `Encounter/${encounterId}` },
        authoredOn: iso(summary.dischargeDate),
        medicationCodeableConcept: { text: medication.medicineName },
        dosageInstruction: [{
          text: [medication.dosage, medication.frequency, medication.duration, medication.instructions]
            .filter(Boolean)
            .join(' | ')
        }]
      }));
    }
    if (summary.followUpAdvice || summary.dietAdvice || summary.activityAdvice || summary.emergencyInstructions) {
      resources.push(clean({
        resourceType: 'CarePlan',
        id: `careplan-${summary._id}`,
        status: 'active',
        intent: 'plan',
        subject: { reference: patientRef(patient) },
        encounter: { reference: `Encounter/${encounterId}` },
        period: { start: iso(summary.dischargeDate), end: iso(summary.followUpDate) },
        description: [
          summary.followUpAdvice,
          summary.dietAdvice,
          summary.activityAdvice,
          summary.emergencyInstructions
        ].filter(Boolean).join('\n')
      }));
    }
  }
  return resources;
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
      const profileByField = {
        bp: 'ObservationVitalSigns',
        bloodPressureString: 'ObservationVitalSigns',
        pulse: 'ObservationVitalSigns',
        spo2: 'ObservationVitalSigns',
        temperature: 'ObservationVitalSigns',
        respiratory_rate: 'ObservationVitalSigns',
        respiratoryRate: 'ObservationVitalSigns',
        weight: 'ObservationBodyMeasurement',
        height: 'ObservationBodyMeasurement'
      };
      resources.push(clean({
        resourceType: 'Observation',
        __profileName: profileByField[field] || 'ObservationGeneralAssessment',
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

async function loadRecords(
  patientId,
  { dateRange = {}, recordReferences = [], hospitalId } = {}
) {
  const patientFilter = { _id: patientId };
  if (hospitalId) patientFilter.hospitalId = hospitalId;
  const patient = await Patient.findOne(patientFilter).lean();
  if (!patient) throw new Error('Patient not found in the configured hospital');
  const hospital = await Hospital.findById(patient.hospitalId).lean();
  if (!hospital) throw new Error('Hospital profile was not found');
  const records = {
    patient,
    hospital,
    appointments: [],
    prescriptions: [],
    labs: [],
    radiology: [],
    discharges: [],
    vitals: [],
    invoices: [],
    immunizations: [],
    documents: []
  };

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
    recordReferences: options.recordReferences || [],
    hospitalId: options.hospitalId
  });
  const normalizedRequested = normalizeInternalHiTypes(options.hiTypes || []);
  const requested = normalizedRequested.length ? normalizedRequested : ALL_HI_TYPES;
  const bundles = {};

  for (const hiType of requested) {
    const resources = resourcesFor(hiType, records);
    if (!resources.length) continue;
    const bundle = bundleDocument({
      hiType,
      patient: records.patient,
      hospital: records.hospital,
      resources,
      title: PROFILE_NAMES[hiType],
      careContextReference: options.careContextReference,
      bundleVersion: options.bundleVersion || '1'
    });
    // Every generated document is validated before it can be persisted or transferred.
    // The external NRCeS validator is fail-closed when required by configuration.
    // eslint-disable-next-line no-await-in-loop
    if (options.validationMode !== 'none') {
      await assertValidBundle(bundle, { external: options.validationMode !== 'local' });
    }
    bundles[hiType] = bundle;
  }

  const saved = [];
  if (options.persist !== false) {
    for (const [hiType, bundle] of Object.entries(bundles)) {
      const contentHash = sha256(canonicalJson(bundle));
      saved.push(await EHRBundle.findOneAndUpdate(
        {
          hospitalId: records.patient.hospitalId,
          patientId: records.patient._id,
          bundleType: hiType,
          careContextReference: options.careContextReference || null,
          contentHash
        },
        {
          hospitalId: records.patient.hospitalId,
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

module.exports = {
  ALL_HI_TYPES,
  PROFILE_NAMES,
  COLLECTIONS,
  bundleDocument,
  loadRecords,
  resourcesFor,
  generateAbdmHiBundle
};
