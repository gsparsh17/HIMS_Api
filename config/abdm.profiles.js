const PROFILE_NAMES = Object.freeze({
  PRESCRIPTION: 'PrescriptionRecord',
  DIAGNOSTIC_REPORT: 'DiagnosticReportRecord',
  OP_CONSULTATION: 'OPConsultRecord',
  DISCHARGE_SUMMARY: 'DischargeSummaryRecord',
  IMMUNIZATION_RECORD: 'ImmunizationRecord',
  HEALTH_DOCUMENT_RECORD: 'HealthDocumentRecord',
  WELLNESS_RECORD: 'WellnessRecord',
  INVOICE: 'InvoiceRecord'
});

const COMPOSITION_TYPES = Object.freeze({
  PRESCRIPTION: {
    coding: [{ system: 'http://snomed.info/sct', code: '440545006', display: 'Prescription record' }]
  },
  DIAGNOSTIC_REPORT: {
    // The exact member is derived from the diagnostic report category by the builder.
    coding: [{ system: 'http://snomed.info/sct', code: '721981007', display: 'Diagnostic studies report' }]
  },
  OP_CONSULTATION: {
    coding: [{ system: 'http://snomed.info/sct', code: '371530004', display: 'Clinical consultation report' }]
  },
  DISCHARGE_SUMMARY: {
    coding: [{ system: 'http://snomed.info/sct', code: '373942005', display: 'Discharge summary' }]
  },
  IMMUNIZATION_RECORD: {
    coding: [{ system: 'http://snomed.info/sct', code: '41000179103', display: 'Immunization record' }]
  },
  HEALTH_DOCUMENT_RECORD: {
    coding: [{ system: 'http://snomed.info/sct', code: '419891008', display: 'Record artifact' }]
  },
  WELLNESS_RECORD: { text: 'Wellness Record' },
  INVOICE: { text: 'Invoice Record' }
});

const SECTION_CODES = Object.freeze({
  PRESCRIPTION: [{ name: 'Prescription', code: '440545006', display: 'Prescription record', resourceTypes: ['MedicationRequest', 'Binary'] }],
  DIAGNOSTIC_REPORT: [{ name: 'Diagnostic Report', code: '721981007', display: 'Diagnostic studies report', resourceTypes: ['DiagnosticReport', 'DocumentReference'] }],
  OP_CONSULTATION: [
    { name: 'Chief Complaints', code: '422843007', display: 'Chief complaint section', resourceTypes: ['Condition'] },
    { name: 'Physical Examination', code: '425044008', display: 'Physical exam section', resourceTypes: ['Observation'] },
    { name: 'Allergies', code: '722446000', display: 'Allergy record', resourceTypes: ['AllergyIntolerance'] },
    { name: 'Medical History', code: '371529009', display: 'History and physical report', resourceTypes: ['Condition', 'Procedure'] },
    { name: 'Investigation Advice', code: '721963009', display: 'Order document', resourceTypes: ['ServiceRequest'] },
    { name: 'Medications', code: '721912009', display: 'Medication summary document', resourceTypes: ['MedicationRequest', 'MedicationStatement'] },
    { name: 'Follow Up', code: '390906007', display: 'Follow-up encounter', resourceTypes: ['Appointment'] },
    { name: 'Procedures', code: '371525003', display: 'Clinical procedure report', resourceTypes: ['Procedure'] },
    { name: 'Referrals', code: '306206005', display: 'Referral to service', resourceTypes: ['ServiceRequest'] },
    { name: 'Other Observations', code: '404684003', display: 'Clinical finding', resourceTypes: ['Observation', 'Condition'] },
    { name: 'Documents', code: '371530004', display: 'Clinical consultation report', resourceTypes: ['DocumentReference'] }
  ],
  DISCHARGE_SUMMARY: [
    { name: 'Chief Complaints', code: '422843007', display: 'Chief complaint section', resourceTypes: ['Condition'] },
    { name: 'Physical Examination', code: '425044008', display: 'Physical exam section', resourceTypes: ['Observation'] },
    { name: 'Allergies', code: '722446000', display: 'Allergy record', resourceTypes: ['AllergyIntolerance'] },
    { name: 'Medical History', code: '1003642006', display: 'Past medical history section', resourceTypes: ['Condition'] },
    { name: 'Investigations', code: '721981007', display: 'Diagnostic studies report', resourceTypes: ['DiagnosticReport', 'Observation'] },
    { name: 'Medications', code: '1003606003', display: 'Medication history section', resourceTypes: ['MedicationRequest', 'MedicationStatement'] },
    { name: 'Procedures', code: '1003640003', display: 'History of past procedure section', resourceTypes: ['Procedure'] },
    { name: 'Care Plan', code: '734163000', display: 'Care plan', resourceTypes: ['CarePlan'] },
    { name: 'Documents', code: '373942005', display: 'Discharge summary', resourceTypes: ['DocumentReference'] }
  ],
  IMMUNIZATION_RECORD: [{ name: 'Immunizations', code: '41000179103', display: 'Immunization record', resourceTypes: ['Immunization', 'ImmunizationRecommendation', 'DocumentReference'] }],
  HEALTH_DOCUMENT_RECORD: [{ name: 'Documents', code: '419891008', display: 'Record artifact', resourceTypes: ['DocumentReference'] }],
  WELLNESS_RECORD: [
    { name: 'Vital Signs', resourceProfiles: ['ObservationVitalSigns'] },
    { name: 'Body Measurement', resourceProfiles: ['ObservationBodyMeasurement'] },
    { name: 'Physical Activity', resourceProfiles: ['ObservationPhysicalActivity'] },
    { name: 'General Assessment', resourceProfiles: ['ObservationGeneralAssessment'] },
    { name: 'Women Health', resourceProfiles: ['ObservationWomenHealth'] },
    { name: 'Lifestyle', resourceProfiles: ['ObservationLifestyle'] },
    { name: 'Other Observations', resourceProfiles: ['Observation'], resourceTypes: ['Condition'] },
    { name: 'Document Reference', resourceTypes: ['DocumentReference'] }
  ],
  INVOICE: [{ name: 'Invoice', resourceTypes: ['Invoice'] }]
});

const RESOURCE_PROFILE_BY_TYPE = Object.freeze({
  Patient: 'Patient',
  Organization: 'Organization',
  Practitioner: 'Practitioner',
  PractitionerRole: 'PractitionerRole',
  Encounter: 'Encounter',
  Appointment: 'Appointment',
  Condition: 'Condition',
  Procedure: 'Procedure',
  AllergyIntolerance: 'AllergyIntolerance',
  Medication: 'Medication',
  MedicationRequest: 'MedicationRequest',
  MedicationStatement: 'MedicationStatement',
  ServiceRequest: 'ServiceRequest',
  DiagnosticReport: 'DiagnosticReportLab',
  Specimen: 'Specimen',
  ImagingStudy: 'ImagingStudy',
  Media: 'Media',
  DocumentReference: 'DocumentReference',
  Binary: 'Binary',
  Immunization: 'Immunization',
  ImmunizationRecommendation: 'ImmunizationRecommendation',
  Observation: 'Observation',
  Invoice: 'Invoice',
  ChargeItem: 'ChargeItem',
  CarePlan: 'CarePlan'
});

module.exports = {
  PROFILE_NAMES,
  COMPOSITION_TYPES,
  SECTION_CODES,
  RESOURCE_PROFILE_BY_TYPE
};
