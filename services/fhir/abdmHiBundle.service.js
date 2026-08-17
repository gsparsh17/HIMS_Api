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

const NRCES_IDENTIFIER_TYPE_SYSTEM = `${abdmConfig.fhirProfileBase.replace(/\/StructureDefinition$/, '')}/CodeSystem/ndhm-identifier-type-code`;
const V2_IDENTIFIER_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const ORGANIZATION_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/organization-type';
const LOINC_SYSTEM = 'http://loinc.org';
const UCUM_SYSTEM = 'http://unitsofmeasure.org';

function coding(system, code, display) {
  return { coding: [{ system, code, display }], text: display };
}

function identifierType(system, code, display) {
  return { coding: [{ system, code, display }] };
}

function identifier({ typeSystem, typeCode, typeDisplay, system, value }) {
  if (!value) return undefined;
  return {
    type: identifierType(typeSystem, typeCode, typeDisplay),
    system,
    value: String(value)
  };
}

function quantity(value, unit, code = unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return { value: numeric, unit, system: UCUM_SYSTEM, code };
}

function numericValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function xhtmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generatedNarrative(label, value) {
  const suffix = value === undefined || value === null || value === '' ? '' : `: ${xhtmlEscape(value)}`;
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${xhtmlEscape(label)}${suffix}</p></div>`
  };
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
  const organizationName = hospital.hospitalName || hospital.name || 'Healthcare Provider';
  return clean({
    resourceType: 'Organization',
    id: `organization-${hospital._id}`,
    text: generatedNarrative('Healthcare Provider', organizationName),
    active: true,
    identifier: [
      identifier({
        typeSystem: V2_IDENTIFIER_TYPE_SYSTEM,
        typeCode: 'PRN',
        typeDisplay: 'Provider number',
        system: 'https://facility.ndhm.gov.in',
        value: hospital.onboarding?.hfrFacilityId
      }),
      identifier({
        typeSystem: NRCES_IDENTIFIER_TYPE_SYSTEM,
        typeCode: 'OIN',
        typeDisplay: 'Other identifier',
        system: 'https://mediqliq.com/identifier/hospital',
        value: hospital.hospitalID
      })
    ],
    type: [{
      coding: [{
        system: ORGANIZATION_TYPE_SYSTEM,
        code: 'prov',
        display: 'Healthcare Provider'
      }]
    }],
    name: organizationName,
    telecom: [
      hospital.contact ? { system: 'phone', value: hospital.contact, use: 'work' } : undefined,
      hospital.email ? { system: 'email', value: hospital.email, use: 'work' } : undefined
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
  const displayName = [patient.salutation, patient.first_name, patient.middle_name, patient.last_name]
    .filter(Boolean)
    .join(' ') || patient.uhid || 'Patient';
  return clean({
    resourceType: 'Patient',
    id: `patient-${patient._id}`,
    text: generatedNarrative('Patient', displayName),
    identifier: [
      identifier({
        typeSystem: V2_IDENTIFIER_TYPE_SYSTEM,
        typeCode: 'MR',
        typeDisplay: 'Medical record number',
        system: 'https://mediqliq.com/identifier/uhid',
        value: patient.uhid || patient.patientId
      }),
      identifier({
        typeSystem: NRCES_IDENTIFIER_TYPE_SYSTEM,
        typeCode: 'HIN',
        typeDisplay: 'Health ID issued by NDHM',
        system: 'https://healthid.ndhm.gov.in',
        value: patient.abha?.number
      }),
      identifier({
        typeSystem: NRCES_IDENTIFIER_TYPE_SYSTEM,
        typeCode: 'ABHA',
        typeDisplay: 'Ayushman Bharat Health Account (ABHA) ID',
        system: 'https://healthid.ndhm.gov.in/abha-address',
        value: patient.abha?.address
      })
    ],
    name: [{
      text: displayName,
      given: [patient.first_name, patient.middle_name].filter(Boolean),
      family: patient.last_name
    }],
    telecom: [
      patient.phone ? { system: 'phone', value: patient.phone, use: 'home' } : undefined,
      patient.email ? { system: 'email', value: patient.email, use: 'home' } : undefined
    ],
    gender: ['male', 'female', 'other'].includes(String(patient.gender).toLowerCase())
      ? String(patient.gender).toLowerCase()
      : 'unknown',
    birthDate: patient.dob ? new Date(patient.dob).toISOString().slice(0, 10) : undefined,
    address: patient.address ? [{
      text: patient.address,
      city: patient.city,
      district: patient.district,
      state: patient.state,
      postalCode: patient.zipCode,
      country: 'IN'
    }] : undefined,
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
    language: 'en-IN',
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

function wellnessResources(vitals, patient, hospital) {
  const resources = [];
  const performer = hospital ? [{ reference: `Organization/organization-${hospital._id}` }] : undefined;

  const observation = ({ vital, suffix, profileName, code, display, valueQuantity, component }) => clean({
    resourceType: 'Observation',
    __profileName: profileName,
    id: `observation-${vital._id}-${suffix}`,
    text: generatedNarrative(display, valueQuantity?.value ?? ''),
    status: 'final',
    code: coding(LOINC_SYSTEM, code, display),
    subject: { reference: patientRef(patient) },
    effectiveDateTime: iso(vital.recorded_at || vital.recordedAt || vital.createdAt),
    performer,
    valueQuantity,
    component
  });

  for (const vital of vitals) {
    const bpString = vital.bp || vital.bloodPressureString;
    const bpMatch = bpString ? String(bpString).match(/(\d+(?:\.\d+)?)\s*[/\\-]\s*(\d+(?:\.\d+)?)/) : null;
    const systolic = numericValue(vital.bloodPressure?.systolic ?? bpMatch?.[1]);
    const diastolic = numericValue(vital.bloodPressure?.diastolic ?? bpMatch?.[2]);
    if (systolic !== undefined && diastolic !== undefined) {
      resources.push(observation({
        vital,
        suffix: 'blood-pressure',
        profileName: 'ObservationVitalSigns',
        code: '85354-9',
        display: 'Blood pressure panel with all children optional',
        component: [
          {
            code: coding(LOINC_SYSTEM, '8480-6', 'Systolic blood pressure'),
            valueQuantity: quantity(systolic, 'mmHg', 'mm[Hg]')
          },
          {
            code: coding(LOINC_SYSTEM, '8462-4', 'Diastolic blood pressure'),
            valueQuantity: quantity(diastolic, 'mmHg', 'mm[Hg]')
          }
        ]
      }));
    }

    const pulse = numericValue(vital.pulse);
    if (pulse !== undefined) {
      resources.push(observation({
        vital,
        suffix: 'heart-rate',
        profileName: 'ObservationVitalSigns',
        code: '8867-4',
        display: 'Heart rate',
        valueQuantity: quantity(pulse, 'beats/minute', '/min')
      }));
    }

    const spo2 = numericValue(vital.spo2);
    if (spo2 !== undefined) {
      resources.push(observation({
        vital,
        suffix: 'oxygen-saturation',
        profileName: 'ObservationVitalSigns',
        code: '2708-6',
        display: 'Oxygen saturation in Arterial blood',
        valueQuantity: quantity(spo2, '%', '%')
      }));
    }

    const temperature = numericValue(vital.temperature);
    if (temperature !== undefined) {
      const declaredUnit = String(vital.temperatureUnit || '').toLowerCase();
      const fahrenheit = declaredUnit.startsWith('f') || (!declaredUnit && temperature > 45);
      resources.push(observation({
        vital,
        suffix: 'temperature',
        profileName: 'ObservationVitalSigns',
        code: '61008-9',
        display: 'Body surface temperature',
        valueQuantity: quantity(
          temperature,
          fahrenheit ? 'degF' : 'Cel',
          fahrenheit ? '[degF]' : 'Cel'
        )
      }));
    }

    const respiratoryRate = numericValue(vital.respiratoryRate ?? vital.respiratory_rate);
    if (respiratoryRate !== undefined) {
      resources.push(observation({
        vital,
        suffix: 'respiratory-rate',
        profileName: 'ObservationVitalSigns',
        code: '9279-1',
        display: 'Respiratory rate',
        valueQuantity: quantity(respiratoryRate, 'breaths/minute', '/min')
      }));
    }

    const weight = numericValue(vital.weight);
    if (weight !== undefined) {
      const rawWeight = String(vital.weight || '').toLowerCase();
      const pounds = /\blb|pound/.test(rawWeight);
      resources.push(observation({
        vital,
        suffix: 'body-weight',
        profileName: 'ObservationBodyMeasurement',
        code: '29463-7',
        display: 'Body weight',
        valueQuantity: quantity(weight, pounds ? 'lb' : 'kg', pounds ? '[lb_av]' : 'kg')
      }));
    }

    const height = numericValue(vital.height);
    if (height !== undefined) {
      const rawHeight = String(vital.height || '').toLowerCase();
      let unit = 'cm';
      let code = 'cm';
      if (/\bin\b|inch/.test(rawHeight)) { unit = 'in'; code = '[in_i]'; }
      else if (/\b(m|metre|meter)s?\b/.test(rawHeight) && !/cm/.test(rawHeight)) { unit = 'm'; code = 'm'; }
      resources.push(observation({
        vital,
        suffix: 'body-height',
        profileName: 'ObservationBodyMeasurement',
        code: '8302-2',
        display: 'Body height',
        valueQuantity: quantity(height, unit, code)
      }));
    }

    const bloodSugar = numericValue(vital.bloodSugar ?? vital.random_blood_sugar);
    if (bloodSugar !== undefined) {
      resources.push(observation({
        vital,
        suffix: 'blood-glucose',
        profileName: 'ObservationGeneralAssessment',
        code: '2339-0',
        display: 'Glucose [Mass/volume] in Blood',
        valueQuantity: quantity(bloodSugar, 'mg/dL', 'mg/dL')
      }));
    }

    // painScore is intentionally not projected into WellnessRecord until a
    // value-set-conformant NRCeS code is selected. The source row remains in
    // the packet manifest/hash, so omitting an unsupported FHIR projection does
    // not weaken the immutable source binding.
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
    case 'WELLNESS_RECORD': return wellnessResources(records.vitals, records.patient, records.hospital);
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
