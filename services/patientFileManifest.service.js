const IPDAdmission = require('../models/IPDAdmission');
const { operationNow } = require('../utils/operationTimeContext');
const { hospitalDateKey } = require('../utils/hospitalDateTime');
const Hospital = require('../models/Hospital');
const IPDInitialAssessment = require('../models/IPDInitialAssessment');
const IPDNursingAdmissionAssessment = require('../models/IPDNursingAdmissionAssessment');
const IPDVitals = require('../models/IPDVitals');
const IPDMedicationChart = require('../models/IPDMedicationChart');
require('../models/Medicine'); // Register Medicine for nested discharge-medication population.
const IPDRound = require('../models/IPDRound');
const NursingNote = require('../models/NursingNote');
const IPDConsent = require('../models/IPDConsent');
const LabRequest = require('../models/LabRequest');
const LabReport = require('../models/LabReport');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const OTRequest = require('../models/OTRequest');
const OTReadinessChecklist = require('../models/OTReadinessChecklist');
const OTSurgicalSafetyChecklist = require('../models/OTSurgicalSafetyChecklist');
const OTPreAnaesthesiaAssessment = require('../models/OTPreAnaesthesiaAssessment');
const OTAnesthesiaRecord = require('../models/OTAnesthesiaRecord');
const OTOperativeNote = require('../models/OTOperativeNote');
const OTRecoveryRecord = require('../models/OTRecoveryRecord');
const OTCaseInventoryUsage = require('../models/OTCaseInventoryUsage');
const OTClinicalForm = require('../models/OTClinicalForm');
const OTSchedule = require('../models/OTSchedule');
const OTSpecimen = require('../models/OTSpecimen');
const DischargeSummary = require('../models/DischargeSummary');
const ClinicalDocument = require('../models/ClinicalDocument');
const EncounterDocument = require('../models/EncounterDocument');
const DocumentSignature = require('../models/DocumentSignature');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const ClaimCase = require('../models/ClaimCase');
const PackageEpisode = require('../models/PackageEpisode');
const ClaimEvidence = require('../models/ClaimEvidence');
const { templates: ipdConsentTemplates } = require('../data/ipdConsentTemplates');
const { requireHospitalId, idString } = require('./tenantScope.service');
const { listTemplates: listSurgeryFormTemplates } = require('../config/otSurgeryFormTemplates');
const { buildAccommodationPrintData } = require('./ipdAccommodationPrint.service');
const { completionIssues } = require('./patientPacketValidation.service');
const { hasModuleAccess } = require('../middlewares/auth');

const CATEGORY_ORDER = [
  'admission', 'consent', 'assessment', 'progress', 'nursing', 'vitals', 'medication',
  'investigation', 'procedure', 'ot', 'anesthesia', 'recovery', 'transfusion', 'discharge', 'payer', 'attachment', 'financial'
];

const PACKET_DEFINITIONS = Object.freeze({
  patient_file: {
    label: 'Patient File',
    description: 'Concise admission-to-discharge patient file with core clinical course and outcome.',
    categories: ['admission', 'assessment', 'progress', 'nursing', 'vitals', 'medication', 'discharge'],
    match: () => true
  },
  clinical: {
    label: 'Clinical Packet',
    description: 'Admission, assessments, progress, nursing course, vitals, medication chart and discharge summary. Detailed investigations, OT and billing are excluded.',
    categories: ['admission', 'assessment', 'progress', 'nursing', 'vitals', 'medication', 'discharge'],
    match: () => true
  },
  mrd_file: {
    label: 'MRD File',
    description: 'Complete clinical medical-record file without finance-only documents.',
    categories: CATEGORY_ORDER.filter((category) => !['financial', 'payer'].includes(category)),
    match: () => true
  },
  complete_patient_file: {
    label: 'Complete Patient File',
    description: 'One deduplicated copy of every applicable completed clinical, investigation, OT, discharge, payer and financial document.',
    categories: CATEGORY_ORDER,
    match: () => true
  },
  ot_packet: {
    label: 'OT Packet',
    description: 'Applicable consents, PAC/checklists, operative/anaesthesia records, recovery, specimen and implant evidence.',
    categories: ['consent', 'assessment', 'procedure', 'ot', 'anesthesia', 'recovery', 'transfusion', 'attachment'],
    match: (document) => document.relatedCaseType === 'OTRequest' || /an(a|ae)esthesia|operation|operative|surgery|surgical|high risk|blood transfusion|pre.?op|post.?op|recovery|implant|specimen|ot/i.test(`${document.documentType} ${document.title} ${document.rendererKey}`)
  },
  pmjay: {
    label: 'PMJAY Packet',
    description: 'Claim-review packet based on accepted legacy evidence patterns: eligibility/preauth, clinical justification, relevant investigations, pre/post evidence, OT/procedure proof, outcome and selected claim/financial documents.',
    categories: ['admission', 'assessment', 'progress', 'investigation', 'consent', 'procedure', 'ot', 'anesthesia', 'recovery', 'discharge', 'payer', 'attachment', 'financial'],
    match: (document) => {
      if (['payer', 'financial', 'investigation', 'discharge', 'assessment', 'progress'].includes(document.category)) return true;
      if (document.category === 'attachment') return Boolean(document.relatedCaseType === 'OTRequest' || document.metadata?.pmjayRelevant);
      return /consent|pre.?op|post.?op|operation|operative|surgery|surgical|an(a|ae)esthesia|pac|recovery|implant|specimen|procedure|ot/i.test(`${document.documentType} ${document.title} ${document.rendererKey}`);
    }
  },
  insurance: {
    label: 'Insurance Packet',
    description: 'Payer-aware claim-support packet for non-PMJAY insurance/TPA/corporate/government sponsored encounters.',
    categories: ['admission', 'assessment', 'progress', 'investigation', 'consent', 'procedure', 'ot', 'anesthesia', 'recovery', 'discharge', 'payer', 'attachment', 'financial'],
    match: (document) => {
      if (['payer', 'financial', 'discharge', 'assessment', 'progress'].includes(document.category)) return true;
      if (document.category === 'investigation') return true;
      if (document.category === 'attachment') return Boolean(document.metadata?.insuranceRelevant || document.metadata?.pmjayRelevant);
      return /consent|pre.?op|post.?op|operation|operative|surgery|surgical|an(a|ae)esthesia|pac|recovery|implant|specimen|procedure|ot/i.test(`${document.documentType} ${document.title} ${document.rendererKey}`);
    }
  },
  mlc_tpa_ayushman_file: {
    label: 'Legacy MLC / TPA Insurance File',
    description: 'Backward-compatible insurance/MLC packet. Use the dedicated PMJAY Packet for Ayushman Bharat claims.',
    categories: CATEGORY_ORDER.filter((category) => category !== 'financial'),
    match: (document) => /admission|discharge|lama|death|mlc|initial assessment|progress|nursing|vital|medication|transfusion|consent|ot|operative|an(a|ae)esthesia|pathology|lab|radiology|implant|payer|claim|pre.?auth/i.test(`${document.documentType} ${document.title} ${document.category}`)
  },
  nursing: { label: 'Nursing Packet', categories: ['admission', 'assessment', 'nursing', 'vitals', 'medication', 'progress', 'recovery'], match: () => true },
  investigation: { label: 'Investigation Packet', description: 'Finalized pathology, microbiology, radiology, ECG/echo and histopathology evidence.', categories: ['investigation'], match: () => true },
  discharge: { label: 'Discharge Packet', categories: ['admission', 'assessment', 'progress', 'nursing', 'vitals', 'medication', 'discharge'], match: () => true },
  financial: { label: 'Financial Packet', description: 'Bills, itemized invoices and payment/settlement receipts for this admission.', categories: ['financial'], match: () => true },
  // Backward-compatible aliases retained for older deep links.
  ot: { label: 'OT Packet', categories: ['consent', 'assessment', 'procedure', 'ot', 'anesthesia', 'recovery', 'transfusion', 'attachment'], match: () => true }
});


const PACKETS = Object.freeze(Object.fromEntries(
  Object.entries(PACKET_DEFINITIONS).map(([key, definition]) => [key, definition.categories])
));


function packetDefinition(packetType) {
  return PACKET_DEFINITIONS[packetType] || PACKET_DEFINITIONS.mrd_file;
}

function packetCategories(packetType) {
  return packetDefinition(packetType).categories;
}

function packetDocuments(packetType, documents = []) {
  const definition = packetDefinition(packetType);
  const selected = documents.filter((document) => definition.categories.includes(document.category) && definition.match(document));

  const normalizedType = String(packetType || '').toLowerCase();
  if (normalizedType === 'pmjay' || normalizedType === 'pmjay_packet') {
    const hasPmjayDischarge = selected.some((document) => document.documentType === 'pmjay_discharge_summary');
    const pmjaySelected = hasPmjayDischarge
      ? selected.filter((document) => !(document.documentType === 'discharge_summary' && document.sourceModel === 'DischargeSummary'))
      : selected;
    const sectionRank = (document) => {
      if (document.documentType === 'pmjay_claim_summary') return 0;
      if (document.category === 'payer' && document.metadata?.pmjaySection === 'eligibility_authorization') return 1;
      if (document.category === 'admission') return 2;
      if (['assessment', 'progress'].includes(document.category)) return 3;
      if (document.category === 'investigation') return 4;
      if (document.category === 'attachment' && document.metadata?.evidenceStage === 'preop') return 5;
      if (['consent', 'procedure', 'ot', 'anesthesia', 'recovery'].includes(document.category)) return 6;
      if (document.category === 'attachment' && document.metadata?.evidenceStage === 'intraop') return 7;
      if (document.category === 'attachment' && document.metadata?.evidenceStage === 'postop') return 8;
      if (document.category === 'discharge') return 9;
      if (document.category === 'financial') return 10;
      if (document.category === 'payer' && document.metadata?.pmjaySection === 'query_response') return 12;
      if (document.category === 'payer') return 11;
      return 13;
    };
    return pmjaySelected.slice().sort((a, b) => {
      const rank = sectionRank(a) - sectionRank(b);
      if (rank) return rank;
      return new Date(a.documentDate || 0) - new Date(b.documentDate || 0);
    });
  }

  if (normalizedType === 'investigation') {
    const investigationRank = (document) => {
      const text = `${document.documentType || ''} ${document.title || ''}`.toLowerCase();
      if (/pathology|histopath/.test(text)) return 3;
      if (/radiology|x.?ray|ct|mri|ultrasound|usg/.test(text)) return 2;
      if (/ecg|echo|cardio/.test(text)) return 4;
      return 1;
    };
    return selected.slice().sort((a, b) => {
      const date = new Date(a.documentDate || 0) - new Date(b.documentDate || 0);
      if (date) return date;
      return investigationRank(a) - investigationRank(b);
    });
  }

  return selected;
}

function statusOf(value, { final = [], complete = [] } = {}) {
  if (final.includes(value)) return 'Final/Signed';
  if (complete.includes(value)) return 'Completed/Unsigned';
  if (!value || ['Pending', 'Not Started', 'Requested'].includes(value)) return 'Not Started';
  return 'Draft';
}

function objectId(record) {
  return record?._id || record?.id;
}

function otDocumentDate(record, sourceModel) {
  if (!record) return null;
  const fields = {
    OTReadinessChecklist: ['completedAt', 'evaluatedAt'],
    OTSurgicalSafetyChecklist: ['finalizedAt', 'attestedAt', 'completedAt'],
    OTPreAnaesthesiaAssessment: ['signedAt', 'assessedAt'],
    OTAnesthesiaRecord: ['signedAt', 'closureAt', 'incisionAt', 'inductionAt', 'recordedAt'],
    OTOperativeNote: ['signedAt', 'surgeryDate', 'closureAt', 'incisionAt'],
    OTRecoveryRecord: ['signedAt', 'transferAt', 'receivedAt', 'recordedAt'],
    OTCaseInventoryUsage: ['reconciledAt']
  };
  for (const field of fields[sourceModel] || []) {
    if (record[field]) return record[field];
  }
  return record.createdAt || record.updatedAt || null;
}

function manifestItem({ record, category, documentType, title, sourceModel, rendererKey, status, date, authorName, fileUrl, mimeType, relatedCaseId, relatedCaseType, required = false, visibility = 'clinical', metadata = {}, templateId, templateVersion, formTemplate }) {
  return {
    key: `${sourceModel}:${objectId(record)}`,
    id: String(objectId(record)),
    category,
    documentType,
    title,
    sourceModel,
    sourceId: String(objectId(record)),
    sourceRevision: Number(record?.version || record?.revision || 1),
    rendererKey,
    status,
    documentDate: date || record?.createdAt || record?.updatedAt || null,
    authorName,
    fileUrl,
    mimeType,
    relatedCaseId: relatedCaseId ? String(relatedCaseId) : undefined,
    relatedCaseType,
    required,
    visibility,
    templateId,
    templateVersion,
    formTemplate,
    metadata,
    content: record || null
  };
}

function clinicalStatus(record) {
  return statusOf(record?.status, { final: ['Signed', 'Finalized', 'StaffCompleted'], complete: ['Completed', 'Reported'] });
}

async function buildManifest(req, admissionId, options = {}) {
  const hospitalId = requireHospitalId(req);
  const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId })
    .populate('patientId', 'first_name last_name name patient_id uhid age gender date_of_birth phone address city state')
    .populate('primaryDoctorId', 'firstName lastName first_name last_name name specialization education licenseNumber phone')
    .populate('departmentId', 'name')
    .populate('wardId', 'name wardName')
    .populate('roomId', 'room_number roomNumber name')
    .populate('bedId', 'bedNumber bed_number name')
    .lean();
  if (!admission) {
    const error = new Error('IPD admission not found');
    error.statusCode = 404;
    throw error;
  }

  const canViewFinancial = hasModuleAccess(req.user, 'billing_finance', 'view');
  const patientId = admission.patientId?._id || admission.patientId;
  const caseFilter = { hospitalId, admissionId: admission._id };
  const [
    doctorAssessment,
    nursingAssessment,
    vitals,
    medications,
    rounds,
    nursingNotes,
    consents,
    labRequests,
    labReports,
    radiology,
    procedures,
    otCases,
    discharge,
    uploadedClinical,
    registeredDocuments,
    signatures,
    bills,
    invoices,
    financialTransactions,
    coverage,
    claimCase,
    packageEpisodes
  ] = await Promise.all([
    IPDInitialAssessment.findOne({ admissionId, hospitalId }).lean(),
    IPDNursingAdmissionAssessment.findOne({ admissionId, hospitalId }).lean(),
    IPDVitals.find({ admissionId, hospitalId }).sort({ recordedAt: 1 }).lean(),
    IPDMedicationChart.find({ admissionId, hospitalId }).sort({ startDate: 1, createdAt: 1 }).lean(),
    IPDRound.find({ admissionId, hospitalId }).sort({ roundDateTime: 1 }).lean(),
    NursingNote.find({ admissionId, hospitalId }).sort({ noteDateTime: 1 }).lean(),
    IPDConsent.find({ admissionId, $or: [{ hospitalId }, { hospitalId: null }] }).sort({ createdAt: 1 }).lean(),
    LabRequest.find({ admissionId, hospitalId, sourceType: 'IPD' }).sort({ requestedDate: 1 }).lean(),
    LabReport.find({ patient_id: patientId, $or: [{ hospitalId }, { hospitalId: null }] }).sort({ report_date: 1 }).lean(),
    RadiologyRequest.find({ admissionId, hospitalId, sourceType: 'IPD' }).sort({ requestedDate: 1 }).lean(),
    ProcedureRequest.find({ admissionId, hospitalId, sourceType: 'IPD' }).sort({ requestedDate: 1 }).lean(),
    OTRequest.find(caseFilter).sort({ requestedDate: 1 }).lean(),
    DischargeSummary.findOne({ admissionId, hospitalId }).populate('dischargeMedications.medicineId', 'name strength dosage_form base_unit compositions').lean(),
    ClinicalDocument.find({ patientId, hospitalId, status: 'current' }).sort({ documentDate: 1 }).lean(),
    EncounterDocument.find({ hospitalId, admissionId, sourceModel: { $ne: 'PatientFileBundle' }, rendererKey: { $ne: 'rendered-patient-file' }, documentType: { $not: /_patient_file$/ } }).sort({ documentDate: 1 }).lean(),
    DocumentSignature.find({ hospitalId, admissionId, status: 'signed' }).sort({ signedAt: -1 }).lean(),
    Bill.find({ hospital_id: hospitalId, admission_id: admission._id, document_stage: { $ne: 'VOID' } }).sort({ generated_at: 1, createdAt: 1 }).lean(),
    Invoice.find({ hospital_id: hospitalId, admission_id: admission._id, document_stage: { $ne: 'VOID' } }).sort({ issue_date: 1, createdAt: 1 }).lean(),
    FinancialTransaction.find({ hospitalId, admissionId: admission._id, status: 'POSTED' }).sort({ postedAt: 1, createdAt: 1 }).lean(),
    AdmissionCoverage.findOne({ hospitalId, encounterType: 'IPD', admissionId: admission._id, active: true }).populate('payerId', 'code name type documentChecklist pricingPolicy').lean(),
    ClaimCase.findOne({ hospitalId, encounterType: 'IPD', admissionId: admission._id, status: { $ne: 'cancelled' } }).sort({ updatedAt: -1 }).populate('payerId', 'code name type').lean(),
    PackageEpisode.find({ hospitalId, encounterType: 'IPD', admissionId: admission._id, status: { $in: ['planned', 'active', 'completed'] } }).sort({ startsAt: 1 }).lean()
  ]);

  const [accommodationPrint, hospital] = await Promise.all([
    buildAccommodationPrintData({ hospitalId, admissionId: admission._id, financial: canViewFinancial }),
    Hospital.findById(hospitalId).select('hospitalID registryNo hospitalName name address city state pinCode contact email logo additionalInfo').lean()
  ]);

  const claimEvidence = claimCase
    ? await ClaimEvidence.find({ hospitalId, claimId: claimCase._id, status: 'current' }).sort({ evidenceStage: 1, capturedAt: 1, createdAt: 1 }).lean()
    : [];

  const payerRecord = coverage?.payerId && typeof coverage.payerId === 'object' ? coverage.payerId : (claimCase?.payerId && typeof claimCase.payerId === 'object' ? claimCase.payerId : null);
  const payerText = [payerRecord?.name, payerRecord?.code, admission.sponsorName, admission.insuranceDetails?.provider].filter(Boolean).join(' ');
  const isPmjay = coverage?.payerCategory === 'pmjay' || payerRecord?.type === 'pmjay' || admission.sponsorType === 'ayushman_bharat' || /pm\s*-?\s*jay|ayushman/i.test(payerText);
  const payerContext = {
    paymentType: admission.paymentType,
    sponsorType: admission.sponsorType,
    sponsorName: admission.sponsorName,
    isPmjay,
    payer: payerRecord ? { id: String(payerRecord._id), code: payerRecord.code, name: payerRecord.name, type: payerRecord.type } : null,
    coverage: coverage ? {
      id: String(coverage._id), payerCategory: coverage.payerCategory, planName: coverage.planName,
      beneficiary: coverage.beneficiary || {}, eligibility: coverage.eligibility || {}, preAuthorisation: coverage.preAuthorisation || {},
      schemeData: coverage.schemeData || {}, documentChecklist: coverage.documentChecklist || []
    } : null,
    claim: claimCase ? {
      id: String(claimCase._id), claimNumber: claimCase.claimNumber, status: claimCase.status, schemeType: claimCase.schemeType, schemeData: claimCase.schemeData || {},
      adjudicationStatus: claimCase.adjudicationStatus, preAuth: claimCase.preAuth || {}, amounts: claimCase.amounts || {}, readiness: claimCase.readiness || {},
      queryCount: claimCase.queries?.length || 0,
      queries: (claimCase.queries || []).map((query) => ({
        queryNumber: query.queryNumber,
        receivedAt: query.receivedAt,
        dueAt: query.dueAt,
        text: query.text,
        status: query.status,
        response: query.response,
        respondedAt: query.respondedAt
      })),
      settlements: (claimCase.settlements || []).map((settlement) => ({
        amount: settlement.amount,
        receivedAt: settlement.receivedAt,
        reference: settlement.reference,
        method: settlement.method
      }))
    } : null,
    packageEpisodes: (packageEpisodes || []).map((episode) => ({
      id: String(episode._id), packageCode: episode.packageCode, packageName: episode.packageName,
      status: episode.status, startsAt: episode.startsAt, endsAt: episode.endsAt,
      contractedAmount: episode.contractedAmount, approvedAmountCap: episode.approvedAmountCap
    }))
  };

  const documents = [];
  documents.push(manifestItem({
    record: { _id: `accommodation-${admission._id}`, ...accommodationPrint },
    category: 'admission',
    documentType: 'accommodation_transfer_history',
    title: 'Accommodation & Transfer History',
    sourceModel: 'IPDBedTransfer',
    rendererKey: 'accommodation-transfer-history',
    status: 'Completed/Unsigned',
    date: admission.admissionDate,
    required: true,
    visibility: 'clinical',
    metadata: { transferCount: accommodationPrint.transferTimeline.length, segmentCount: accommodationPrint.lengthOfStaySegments.length }
  }));
  documents.push(manifestItem({
    record: admission,
    category: 'admission',
    documentType: 'admission_slip',
    title: 'Admission Slip',
    sourceModel: 'IPDAdmission',
    rendererKey: 'admission-slip',
    status: 'Completed/Unsigned',
    date: admission.admissionDate,
    required: true,
    metadata: { admissionNumber: admission.admissionNumber, shipNumber: admission.shipNumber }
  }));

  if (doctorAssessment) documents.push(manifestItem({ record: doctorAssessment, category: 'assessment', documentType: 'doctor_initial_assessment', title: 'Doctor Initial Assessment', sourceModel: 'IPDInitialAssessment', rendererKey: 'doctor-initial-assessment', status: clinicalStatus(doctorAssessment), date: doctorAssessment.assessmentAt, required: true }));
  else documents.push({ key: 'required:doctor_initial_assessment', category: 'assessment', documentType: 'doctor_initial_assessment', title: 'Doctor Initial Assessment', sourceModel: 'IPDInitialAssessment', rendererKey: 'doctor-initial-assessment', status: 'Not Started', required: true });

  if (nursingAssessment) documents.push(manifestItem({ record: nursingAssessment, category: 'assessment', documentType: 'nursing_admission_assessment', title: 'Nursing Admission Assessment', sourceModel: 'IPDNursingAdmissionAssessment', rendererKey: 'nursing-admission-assessment', status: clinicalStatus(nursingAssessment), date: nursingAssessment.assessmentAt, required: true }));
  else documents.push({ key: 'required:nursing_admission_assessment', category: 'assessment', documentType: 'nursing_admission_assessment', title: 'Nursing Admission Assessment', sourceModel: 'IPDNursingAdmissionAssessment', rendererKey: 'nursing-admission-assessment', status: 'Not Started', required: true });

  const surgeryFormTemplates = listSurgeryFormTemplates();
  const surgeryTemplateById = new Map(surgeryFormTemplates.map((template) => [template.id, template]));
  const ipdConsentTemplateById = new Map((ipdConsentTemplates || []).map((template) => [template.id, template]));

  consents.forEach((record) => documents.push(manifestItem({
    record, category: 'consent', documentType: record.templateId, title: record.templateName,
    sourceModel: 'IPDConsent', rendererKey: 'ipd-consent', status: statusOf(record.status, { complete: ['Completed'], final: ['Signed'] }),
    date: record.completedAt || record.updatedAt, required: Boolean(record.relatedOTCaseId), relatedCaseId: record.relatedOTCaseId || record.relatedProcedureId,
    relatedCaseType: record.relatedOTCaseId ? 'OTRequest' : record.relatedProcedureId ? 'ProcedureRequest' : undefined,
    templateId: record.templateId, templateVersion: record.templateVersion, formTemplate: surgeryTemplateById.get(record.templateId) || ipdConsentTemplateById.get(record.templateId),
    metadata: { signatureRequired: true }
  })));

  const vitalsByDate = new Map();
  vitals.forEach((record) => {
    const key = record.chartDate || hospitalDateKey(record.recordedAt || record.createdAt);
    if (!vitalsByDate.has(key)) vitalsByDate.set(key, []);
    vitalsByDate.get(key).push(record);
  });
  vitalsByDate.forEach((rows, chartDate) => documents.push(manifestItem({
    record: { ...rows[0], chartRows: rows }, category: 'vitals', documentType: 'vitals_ews', title: `Vitals & EWS - ${chartDate}`,
    sourceModel: 'IPDVitals', rendererKey: 'vitals-ews', status: 'Completed/Unsigned', date: rows[0].recordedAt,
    metadata: { chartDate, recordIds: rows.map((row) => String(row._id)), count: rows.length }
  })));

  if (medications.length) documents.push(manifestItem({
    record: { _id: `medications-${admission._id}`, records: medications }, category: 'medication', documentType: 'medication_chart', title: 'Nursing Medication Chart',
    sourceModel: 'IPDMedicationChart', rendererKey: 'medication-chart-group', status: medications.every((record) => clinicalStatus(record) === 'Final/Signed') ? 'Final/Signed' : 'Completed/Unsigned',
    date: medications[0].startDate || medications[0].createdAt, metadata: { count: medications.length, recordIds: medications.map((record) => String(record._id)) }
  }));
  const consultantRounds = rounds.filter((record) => record.roundType !== 'Doctor Note');
  const doctorNotes = rounds.filter((record) => record.roundType === 'Doctor Note');
  if (consultantRounds.length) documents.push(manifestItem({
    record: { _id: `consultant-rounds-${admission._id}`, records: consultantRounds }, category: 'progress', documentType: 'consultant_round', title: 'Consultant Daily Assessment',
    sourceModel: 'IPDRound', rendererKey: 'consultant-round-group', status: consultantRounds.every((record) => clinicalStatus(record) === 'Final/Signed') ? 'Final/Signed' : 'Completed/Unsigned',
    date: consultantRounds[0].roundDateTime, metadata: { count: consultantRounds.length, recordIds: consultantRounds.map((record) => String(record._id)) }
  }));
  if (doctorNotes.length) documents.push(manifestItem({
    record: { _id: `doctor-notes-${admission._id}`, records: doctorNotes }, category: 'progress', documentType: 'doctors_note', title: "Doctor's Note",
    sourceModel: 'IPDRound', rendererKey: 'doctors-note-group', status: doctorNotes.every((record) => clinicalStatus(record) === 'Final/Signed') ? 'Final/Signed' : 'Completed/Unsigned',
    date: doctorNotes[0].roundDateTime, metadata: { count: doctorNotes.length, recordIds: doctorNotes.map((record) => String(record._id)) }
  }));
  if (nursingNotes.length) documents.push(manifestItem({
    record: { _id: `nursing-notes-${admission._id}`, records: nursingNotes }, category: 'nursing', documentType: 'nursing_note', title: 'Nursing Progress Notes',
    sourceModel: 'NursingNote', rendererKey: 'nursing-note-group', status: 'Completed/Unsigned', date: nursingNotes[0].noteDateTime,
    metadata: { count: nursingNotes.length, recordIds: nursingNotes.map((record) => String(record._id)) }
  }));

  labRequests.forEach((record) => {
    const reportUrl = record.report_mode === 'manual' && record.manual_report
      ? `/api/lab/requests/${record._id}/report.pdf`
      : (record.report_url || record.external_report_url);
    documents.push(manifestItem({ record, category: 'investigation', documentType: 'lab_report', title: record.testName || 'Laboratory Report', sourceModel: 'LabRequest', rendererKey: record.manual_report ? 'lab-report-structured' : 'file-document', status: statusOf(record.status, { complete: ['Result Entered', 'Completed'], final: ['Verified', 'Reported', 'Amended'] }), date: record.reportedAt || record.processing_completed_at || record.requestedDate, fileUrl: reportUrl, mimeType: record.report_mime_type, metadata: { testCode: record.testCode, category: record.category, abnormal: record.is_abnormal, reportMode: record.report_mode } }));
  });
  const knownLabRequestIds = new Set(labRequests.map((record) => idString(record._id)));
  const encounterStart = admission.admissionDate ? new Date(admission.admissionDate) : new Date(0);
  const encounterEnd = admission.dischargeDate ? new Date(admission.dischargeDate) : operationNow();
  encounterEnd.setHours(23, 59, 59, 999);
  // Lab reports linked to this admission are represented by their LabRequest row
  // above. Only include standalone/external reports when they were produced
  // during this encounter; never pull a report linked to another admission just
  // because the patient is the same.
  labReports.filter((record) => {
    if (record.lab_request_id) return false;
    const reportDate = new Date(record.report_date || record.createdAt || 0);
    return !Number.isNaN(reportDate.getTime()) && reportDate >= encounterStart && reportDate <= encounterEnd;
  }).forEach((record) => documents.push(manifestItem({ record, category: 'investigation', documentType: 'lab_report', title: record.report_type || 'Laboratory Report', sourceModel: 'LabReport', rendererKey: record.manual_report ? 'lab-report-structured' : 'file-document', status: 'Completed/Unsigned', date: record.report_date, fileUrl: record.file_url, mimeType: record.mime_type, metadata: { external: record.is_external, labName: record.external_lab_name } })));

  radiology.forEach((record) => documents.push(manifestItem({ record, category: 'investigation', documentType: 'radiology_report', title: record.testName || 'Radiology Report', sourceModel: 'RadiologyRequest', rendererKey: record.manual_report ? 'radiology-report-structured' : 'file-document', status: statusOf(record.status, { complete: ['Result Entered', 'Completed'], final: ['Verified', 'Reported', 'Amended'] }), date: record.reportedAt || record.performedAt || record.requestedDate, fileUrl: record.report_mode === 'manual' && record.manual_report ? `/api/radiology/requests/${record._id}/report.pdf` : (record.report_url || record.external_report_url), mimeType: record.report_mime_type, metadata: { testCode: record.testCode, category: record.category, impression: record.impression, reportMode: record.report_mode } })));
  procedures.forEach((record) => documents.push(manifestItem({ record, category: 'procedure', documentType: 'procedure_record', title: record.procedureName || 'Procedure', sourceModel: 'ProcedureRequest', rendererKey: 'procedure-record', status: statusOf(record.status, { complete: ['Completed'] }), date: record.completedAt || record.scheduledDate || record.requestedDate, relatedCaseId: record._id, relatedCaseType: 'ProcedureRequest', metadata: { procedureCode: record.procedureCode, findings: record.findings, complications: record.complications } })));

  const otChildResults = await Promise.all(otCases.map(async (otCase) => {
    const filter = { hospitalId, caseId: otCase._id };
    const [readiness, safety, pac, anaesthesia, operative, recovery, inventory, structuredForms, schedule, specimens] = await Promise.all([
      OTReadinessChecklist.findOne(filter).lean(), OTSurgicalSafetyChecklist.findOne(filter).lean(),
      OTPreAnaesthesiaAssessment.findOne(filter).lean(), OTAnesthesiaRecord.findOne(filter).lean(),
      OTOperativeNote.findOne(filter).lean(), OTRecoveryRecord.findOne(filter).lean(), OTCaseInventoryUsage.findOne(filter).lean(),
      OTClinicalForm.find(filter).sort({ updatedAt: 1 }).lean(),
      OTSchedule.findOne({ hospitalId, requestId: otCase._id }).populate('otRoomId', 'name roomNumber room_number').lean(),
      OTSpecimen.find({ hospitalId, caseId: otCase._id }).sort({ collectedAt: 1, createdAt: 1 }).lean()
    ]);
    return { otCase, readiness, safety, pac, anaesthesia, operative, recovery, inventory, structuredForms, schedule, specimens };
  }));
  otChildResults.forEach(({ otCase, readiness, safety, pac, anaesthesia, operative, recovery, inventory, structuredForms, schedule, specimens }) => {
    const implantUsed = Boolean((otCase.implants || []).length || (inventory?.lines || []).some((line) => Number(line.usedQuantity || 0) > 0 || line.serialNumber));
    const caseMetadata = { requestNumber: otCase.requestNumber, procedureName: otCase.procedureName, urgency: otCase.urgency, caseStatus: otCase.status, implantUsed };
    documents.push(manifestItem({ record: otCase, category: 'ot', documentType: 'ot_case_summary', title: `OT/Surgery Case - ${otCase.procedureName}`, sourceModel: 'OTRequest', rendererKey: 'ot-case-summary', status: statusOf(otCase.status, { complete: ['Completed', 'Transferred', 'Closed'], final: ['Closed'] }), date: otCase.scheduledStart || otCase.requestedDate, relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', required: true, metadata: caseMetadata }));
    if (schedule) documents.push(manifestItem({ record: schedule, category: 'ot', documentType: 'ot_schedule', title: 'OT Schedule & Surgical Team', sourceModel: 'OTSchedule', rendererKey: 'ot-schedule', status: statusOf(schedule.status, { complete: ['Completed'] }), date: schedule.scheduledStart, relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', metadata: { ...caseMetadata, teamCount: schedule.teamSnapshot?.length || 0 } }));
    (specimens || []).forEach((record) => documents.push(manifestItem({ record, category: 'ot', documentType: 'ot_specimen', title: `OT Specimen - ${record.label || record.specimenNumber}`, sourceModel: 'OTSpecimen', rendererKey: 'ot-specimen', status: statusOf(record.status, { complete: ['Collected', 'Handed Over', 'Received', 'Reported'] }), date: record.collectedAt || record.createdAt, relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', metadata: { ...caseMetadata, specimenNumber: record.specimenNumber, site: record.site } })));
    const otAttachments = [
      otCase.consent_form_url ? { name: 'Uploaded OT Consent Form', url: otCase.consent_form_url } : null,
      otCase.surgery_report_url ? { name: 'Uploaded Surgery Report', url: otCase.surgery_report_url } : null,
      ...(otCase.attachments || []).map((attachment) => ({ name: attachment.name || 'OT Attachment', url: attachment.url, uploadedAt: attachment.uploaded_at }))
    ].filter((attachment) => attachment?.url);
    otAttachments.forEach((attachment, index) => documents.push(manifestItem({ record: { _id: `${otCase._id}-attachment-${index}`, ...attachment }, category: 'attachment', documentType: 'ot_attachment', title: attachment.name, sourceModel: 'OTRequestAttachment', rendererKey: 'file-document', status: 'Completed/Unsigned', date: attachment.uploadedAt || otCase.completedAt || otCase.startedAt || otCase.scheduledStart || otCase.requestedDate || otCase.createdAt, fileUrl: attachment.url, relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', metadata: caseMetadata })));
    const children = [
      [readiness, 'ot', 'ot_readiness', 'Pre-Operative Readiness Checklist', 'OTReadinessChecklist', 'ot-readiness', ['Ready', 'Ready With Bypass']],
      [safety, 'ot', 'surgical_safety_checklist', 'Surgical Safety Checklist', 'OTSurgicalSafetyChecklist', 'ot-safety-checklist', ['Completed']],
      [pac, 'anesthesia', 'pre_anaesthesia_assessment', 'Preoperative Anaesthesia Record (PAC)', 'OTPreAnaesthesiaAssessment', 'ot-pac', ['Completed', 'Signed']],
      [anaesthesia, 'anesthesia', 'anaesthesia_record', 'Intra/Post Operative Anaesthesia Record', 'OTAnesthesiaRecord', 'ot-anesthesia-record', ['Completed', 'Signed']],
      [operative, 'ot', 'operative_note', 'Operation Notes', 'OTOperativeNote', 'ot-operative-note', ['Completed', 'Signed']],
      [recovery, 'recovery', 'recovery_record', 'Post Anaesthesia Recovery Record', 'OTRecoveryRecord', 'ot-recovery', ['Ready For Transfer', 'Transferred', 'Signed']],
      [inventory, 'ot', 'ot_inventory_usage', 'OT Consumables & Implants Record', 'OTCaseInventoryUsage', 'ot-inventory-usage', ['Reconciled']]
    ];
    const structuredReplacementBySourceModel = {
      OTReadinessChecklist: 'ot_readiness',
      OTSurgicalSafetyChecklist: 'surgical_safety_checklist',
      OTPreAnaesthesiaAssessment: 'pre_anaesthesia_assessment',
      OTAnesthesiaRecord: 'intra_post_anaesthesia_record',
      OTOperativeNote: 'operation_notes',
      OTRecoveryRecord: 'post_anaesthesia_recovery_record',
      OTCaseInventoryUsage: 'ot_consumables_implants'
    };
    const structuredIds = new Set((structuredForms || []).map((form) => form.templateId));
    children.forEach(([record, category, documentType, title, sourceModel, rendererKey, completed]) => {
      const replacementTemplateId = structuredReplacementBySourceModel[sourceModel];
      if (replacementTemplateId && structuredIds.has(replacementTemplateId)) return;
      if (record) documents.push(manifestItem({ record, category, documentType, title, sourceModel, rendererKey, status: statusOf(record.status || record.overallStatus, { complete: completed.filter((value) => value !== 'Signed'), final: completed.includes('Signed') ? ['Signed'] : [] }), date: otDocumentDate(record, sourceModel), relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', required: true, metadata: caseMetadata }));
      else documents.push({ key: `required:${sourceModel}:${otCase._id}`, category, documentType, title, sourceModel, rendererKey, status: 'Not Started', required: true, relatedCaseId: String(otCase._id), relatedCaseType: 'OTRequest', metadata: caseMetadata });
    });

    const structuredTemplateList = surgeryFormTemplates.filter((template) => template.implementation === 'structured');
    const structuredMap = new Map((structuredForms || []).map((record) => [record.templateId, record]));
    structuredTemplateList.forEach((template) => {
      const matchingConsent = template.category === 'consent' && consents.some((consent) => consent.templateId === template.id && (!consent.relatedOTCaseId || String(consent.relatedOTCaseId) === String(otCase._id)));
      if (matchingConsent) return;
      const record = structuredMap.get(template.id);
      if (record) {
        documents.push(manifestItem({
          record,
          category: template.category,
          documentType: template.id,
          title: template.title,
          sourceModel: 'OTClinicalForm',
          rendererKey: 'ot-structured-form',
          status: statusOf(record.status, { complete: ['Completed'], final: ['Signed'] }),
          date: record.completedAt || record.updatedAt,
          relatedCaseId: otCase._id,
          relatedCaseType: 'OTRequest',
          required: Boolean(template.required),
          templateId: template.id,
          templateVersion: template.version,
          formTemplate: template,
          metadata: { ...caseMetadata, stage: template.stage, referencePages: template.referencePages || [], signatureRequired: Boolean(template.signatureRoles?.length) || ['consent', 'anesthesia'].includes(template.category) }
        }));
      } else {
        documents.push({
          key: `required:OTClinicalForm:${otCase._id}:${template.id}`,
          category: template.category,
          documentType: template.id,
          title: template.title,
          sourceModel: 'OTClinicalForm',
          rendererKey: 'ot-structured-form',
          status: 'Not Started',
          required: Boolean(template.required),
          relatedCaseId: String(otCase._id),
          relatedCaseType: 'OTRequest',
          templateId: template.id,
          templateVersion: template.version,
          formTemplate: template,
          metadata: { ...caseMetadata, stage: template.stage, referencePages: template.referencePages || [] },
          content: null
        });
      }
    });
  });

  if (discharge) documents.push(manifestItem({ record: discharge, category: 'discharge', documentType: 'discharge_summary', title: 'Discharge Summary', sourceModel: 'DischargeSummary', rendererKey: 'discharge-summary', status: clinicalStatus(discharge), date: discharge.dischargeDate || discharge.updatedAt, required: admission.status === 'Discharged' || admission.status?.includes('Discharge') }));
  else documents.push({ key: 'required:discharge_summary', category: 'discharge', documentType: 'discharge_summary', title: 'Discharge Summary', sourceModel: 'DischargeSummary', rendererKey: 'discharge-summary', status: 'Not Started', required: admission.status === 'Discharged' || admission.status?.includes('Discharge') });

  uploadedClinical.forEach((record) => {
    const attachmentText = `${record.documentType || ''} ${record.title || ''} ${record.description || ''}`;
    const evidenceStage = /pre.?op|pre.?procedure|baseline/i.test(attachmentText)
      ? 'preop'
      : (/post.?op|post.?procedure|wound|discharge/i.test(attachmentText) ? 'postop' : (/ot|intra.?op|procedure.?photo/i.test(attachmentText) ? 'intraop' : 'supporting'));
    documents.push(manifestItem({
      record,
      category: 'attachment',
      documentType: record.documentType || 'external_document',
      title: record.title,
      sourceModel: 'ClinicalDocument',
      rendererKey: record.fileUrl ? 'file-document' : 'text-document',
      status: 'Completed/Unsigned',
      date: record.documentDate,
      fileUrl: record.fileUrl,
      mimeType: record.mimeType,
      metadata: {
        description: record.description,
        source: record.source,
        evidenceStage,
        pmjayRelevant: /pre.?op|post.?op|x.?ray|ct|mri|ot|wound|photo|claim|pre.?auth/i.test(attachmentText),
        insuranceRelevant: /insurance|tpa|claim|pre.?auth|approval|query|x.?ray|ct|mri|ot|wound|photo/i.test(attachmentText)
      }
    }));
  });

  claimEvidence.forEach((record) => {
    const stage = String(record.evidenceStage || 'supporting').toLowerCase();
    const category = stage === 'financial' ? 'financial' : (stage === 'query' ? 'payer' : 'attachment');
    documents.push(manifestItem({
      record,
      category,
      documentType: `claim_evidence_${String(record.evidenceType || 'other').toLowerCase()}`,
      title: record.caption || String(record.evidenceType || 'Claim Evidence').replaceAll('_', ' '),
      sourceModel: 'ClaimEvidence',
      rendererKey: record.fileUrl ? 'file-document' : 'generic-clinical-record',
      status: 'Completed/Unsigned',
      date: record.capturedAt || record.createdAt,
      fileUrl: record.fileUrl,
      visibility: category === 'financial' || category === 'payer' ? 'financial' : 'clinical',
      metadata: {
        claimEvidenceId: String(record._id),
        evidenceType: record.evidenceType,
        evidenceStage: stage,
        bodySite: record.bodySite,
        laterality: record.laterality,
        patientIdentityVisible: record.patientIdentityVisible,
        clinicalSiteVisible: record.clinicalSiteVisible,
        patientDateVisible: record.patientDateVisible,
        pmjayRelevant: isPmjay,
        insuranceRelevant: true,
        externalReady: true,
        signatureRequired: false,
        pmjaySection: stage === 'query' ? 'query_response' : undefined
      }
    }));
  });

  (bills || []).forEach((record) => {
    const stage = String(record.document_stage || '').toUpperCase();
    if (stage === 'DRAFT' || stage === 'VOID') return;
    documents.push(manifestItem({
      record, category: 'financial', documentType: 'financial_bill',
      title: record.bill_number ? `Bill ${record.bill_number}` : 'Itemized Patient Bill',
      sourceModel: 'Bill', rendererKey: 'financial-bill-summary',
      status: stage === 'INVOICED' ? 'Final/Signed' : 'Completed/Unsigned',
      date: record.invoiced_at || record.generated_at || record.createdAt,
      visibility: 'financial',
      metadata: { billId: String(record._id), billNumber: record.bill_number, externalReady: stage !== 'DRAFT', signatureRequired: false }
    }));
  });

  (invoices || []).forEach((record) => {
    const stage = String(record.document_stage || '').toUpperCase();
    if (stage === 'DRAFT' || stage === 'VOID') return;
    documents.push(manifestItem({
      record, category: 'financial', documentType: 'financial_invoice',
      title: `${record.is_final_ipd_invoice ? 'Final ' : ''}Invoice ${record.invoice_number || ''}`.trim(),
      sourceModel: 'Invoice', rendererKey: 'financial-invoice',
      status: ['ISSUED', 'CREDIT_NOTE'].includes(stage) ? 'Final/Signed' : 'Completed/Unsigned',
      date: record.issued_at || record.issue_date || record.createdAt,
      fileUrl: `/api/invoices/${record._id}/download`,
      mimeType: 'application/pdf', visibility: 'financial',
      metadata: { invoiceId: String(record._id), invoiceNumber: record.invoice_number, finalInvoice: Boolean(record.is_final_ipd_invoice), externalReady: true, signatureRequired: false }
    }));
  });

  const receiptGroups = new Map();
  (financialTransactions || []).filter((record) => ['RECEIPT', 'SETTLEMENT', 'ADVANCE_DEPOSIT', 'REFUND', 'ADVANCE_REFUND'].includes(record.transactionType)).forEach((record) => {
    const key = record.transactionNumber || String(record._id);
    if (!receiptGroups.has(key)) receiptGroups.set(key, []);
    receiptGroups.get(key).push(record);
  });
  receiptGroups.forEach((records, receiptNumber) => documents.push(manifestItem({
    record: { _id: `financial-receipt-${admission._id}-${receiptNumber}`, records, receiptNumber },
    category: 'financial', documentType: 'financial_receipt', title: `Receipt ${receiptNumber}`,
    sourceModel: 'FinancialTransaction', rendererKey: 'financial-receipt', status: 'Final/Signed',
    date: records[0]?.postedAt || records[0]?.createdAt, visibility: 'financial',
    metadata: { receiptNumber, transactionIds: records.map((record) => String(record._id)), externalReady: true, signatureRequired: false }
  })));

  if (isPmjay && discharge) {
    const primaryOperativeNote = (otChildResults || []).map((row) => row.operative).find(Boolean) || null;
    documents.push(manifestItem({
      record: { _id: `pmjay-discharge-${discharge._id}`, discharge, payerContext, operativeNote: primaryOperativeNote },
      category: 'discharge',
      documentType: 'pmjay_discharge_summary',
      title: 'PMJAY Discharge Summary',
      sourceModel: 'PMJAYDischargeSummaryView',
      rendererKey: 'pmjay-discharge-summary',
      status: clinicalStatus(discharge),
      date: discharge.dischargeDate || discharge.updatedAt,
      required: true,
      visibility: 'financial',
      metadata: { pmjayRelevant: true, externalReady: true, signatureRequired: false, pmjaySection: 'outcome', sourceDischargeId: String(discharge._id) }
    }));
  }

  if (isPmjay) {
    documents.push(manifestItem({
      record: { _id: `pmjay-summary-${admission._id}`, payerContext }, category: 'payer', documentType: 'pmjay_claim_summary',
      title: 'PMJAY Claim / Preauthorisation Summary', sourceModel: 'AdmissionCoverage', rendererKey: 'pmjay-claim-summary',
      status: 'Final/Signed', date: claimCase?.updatedAt || coverage?.updatedAt || admission.updatedAt,
      visibility: 'financial', metadata: { pmjayRelevant: true, externalReady: true, signatureRequired: false, pmjaySection: 'cover' }
    }));
    if ((claimCase?.queries || []).length) {
      documents.push(manifestItem({
        record: { _id: `pmjay-query-appendix-${admission._id}`, queries: claimCase.queries },
        category: 'payer',
        documentType: 'pmjay_query_response_appendix',
        title: 'PMJAY Query / Response Appendix',
        sourceModel: 'ClaimCase',
        rendererKey: 'generic-clinical-record',
        status: 'Completed/Unsigned',
        date: claimCase.updatedAt,
        visibility: 'financial',
        metadata: { pmjayRelevant: true, externalReady: true, signatureRequired: false, pmjaySection: 'query_response' }
      }));
    }
  }

  const payerAttachments = [
    ...((coverage?.preAuthorisation?.documents || []).map((item, index) => ({ ...item, group: 'Preauthorisation', index }))),
    ...((claimCase?.documents || []).map((item, index) => ({ ...item, group: 'Claim', index })))
  ].filter((item) => item?.url);
  payerAttachments.forEach((item) => documents.push(manifestItem({
    record: { _id: `payer-attachment-${admission._id}-${item.group}-${item.index}`, ...item }, category: 'payer',
    documentType: 'payer_claim_attachment', title: item.name || `${item.group} Document`, sourceModel: 'ClaimCaseAttachment', rendererKey: 'file-document',
    status: String(item.status || '').toLowerCase() === 'rejected' ? 'Draft' : 'Final/Signed', date: claimCase?.updatedAt || coverage?.updatedAt,
    fileUrl: item.url, mimeType: item.mimeType || 'application/pdf', visibility: 'financial', metadata: {
      pmjayRelevant: isPmjay,
      insuranceRelevant: true,
      externalReady: true,
      signatureRequired: false,
      pmjaySection: item.group === 'Preauthorisation' ? 'eligibility_authorization' : 'claim_support'
    }
  })));

  const signatureMap = new Map(signatures.map((signature) => [`${signature.sourceModel}:${signature.sourceId}`, signature]));
  documents.forEach((document) => {
    const signature = signatureMap.get(`${document.sourceModel}:${document.sourceId}`);
    if (signature) {
      document.status = 'Final/Signed';
      document.signature = {
        id: String(signature._id),
        signerName: signature.signerName,
        signerRole: signature.signerRole,
        signedAt: signature.signedAt,
        verificationCode: signature.verificationCode
      };
    }
  });

  registeredDocuments.forEach((record) => {
    if (record.sourceModel === 'PatientFileBundle' || record.rendererKey === 'rendered-patient-file' || String(record.documentType || '').endsWith('_patient_file')) return;
    const key = `${record.sourceModel}:${record.sourceId}`;
    const existing = documents.find((document) => `${document.sourceModel}:${document.sourceId}` === key);
    if (existing) {
      existing.encounterDocumentId = String(record._id);
      existing.status = record.status || existing.status;
      existing.rendererKey = record.rendererKey || existing.rendererKey;
      existing.visibility = record.visibility || existing.visibility;
    } else {
      documents.push({
        key,
        id: String(record._id),
        encounterDocumentId: String(record._id),
        category: record.category,
        documentType: record.documentType,
        title: record.title,
        sourceModel: record.sourceModel,
        sourceId: String(record.sourceId),
        sourceRevision: record.sourceRevision,
        rendererKey: record.rendererKey,
        status: record.status,
        documentDate: record.documentDate,
        authorName: record.authorName,
        fileUrl: record.fileUrl,
        mimeType: record.mimeType,
        relatedCaseId: record.relatedCaseId ? String(record.relatedCaseId) : undefined,
        relatedCaseType: record.relatedCaseType,
        required: record.required,
        visibility: record.visibility,
        metadata: record.metadata
      });
    }
  });

  const investigationCount = documents.filter((document) => document.category === 'investigation' && ['lab_report', 'radiology_report'].includes(document.documentType)).length;
  const meaningful = (value) => {
    if (value === undefined || value === null || value === false || value === '') return false;
    if (Array.isArray(value)) return value.some(meaningful);
    if (typeof value === 'object') return Object.values(value).some(meaningful);
    return !/^not applicable|not recorded|n\/?a$/i.test(String(value).trim());
  };
  documents.forEach((document) => {
    document.metadata = { ...(document.metadata || {}) };
    document.completionIssues = completionIssues(document);

    if (['ProcedureRequest', 'OTRequest', 'OTSchedule'].includes(document.sourceModel) && !document.fileUrl) {
      document.metadata.externalEligible = false;
    }

    const templateId = String(document.templateId || document.formTemplate?.id || document.documentType || '').toLowerCase();
    const formData = document.sourceModel === 'IPDConsent'
      ? (document.content?.responses || {})
      : (document.content?.formData || {});

    if (document.formTemplate?.required === false && ['Not Started', 'Draft'].includes(document.status)) {
      document.metadata.applicable = false;
    }
    if (/high[_-]?risk/.test(templateId)) {
      document.metadata.applicable = meaningful(formData.reasonHighRisk) || meaningful(formData.materialRisks) || meaningful(formData.diagnosis && formData.proposedProcedure);
    }
    if (/implant|consumables_implants/.test(templateId) || document.documentType === 'ot_inventory_usage') {
      const lines = document.content?.lines || document.content?.formData?.implants || [];
      document.metadata.applicable = Boolean(document.metadata.implantUsed || (Array.isArray(lines) && lines.some((line) => Number(line.usedQuantity || line.quantity || 0) > 0 || meaningful(line.serialNumber) || meaningful(line.implantName))));
    }
    if (/investigation[_-]?chart/.test(templateId) && investigationCount > 0 && !meaningful(formData.investigationChart || formData.results || formData.investigations)) {
      document.metadata.applicable = false;
    }

    document.applicable = document.metadata.applicable !== false;
    document.externalEligible = document.metadata.externalEligible !== false;
  });

  const categoryRank = new Map(CATEGORY_ORDER.map((category, index) => [category, index]));
  documents.sort((a, b) => {
    const categoryDiff = (categoryRank.get(a.category) ?? 999) - (categoryRank.get(b.category) ?? 999);
    if (categoryDiff) return categoryDiff;
    return new Date(a.documentDate || 0) - new Date(b.documentDate || 0);
  });

  const filtered = documents.filter((document) => {
    if (document.visibility === 'financial' && !canViewFinancial) return false;
    if (options.category && document.category !== options.category) return false;
    if (options.status && document.status !== options.status) return false;
    return true;
  });

  const counts = filtered.reduce((acc, document) => {
    acc[document.status] = (acc[document.status] || 0) + 1;
    return acc;
  }, {});
  const publicPayerContext = canViewFinancial
    ? payerContext
    : {
        paymentType: payerContext.paymentType,
        sponsorType: payerContext.sponsorType,
        sponsorName: payerContext.sponsorName,
        isPmjay: payerContext.isPmjay,
        payer: payerContext.payer
      };

  const billingSummary = canViewFinancial
    ? {
        billCount: (bills || []).filter((row) => row.document_stage !== 'VOID').length,
        invoiceCount: (invoices || []).filter((row) => row.document_stage !== 'VOID').length,
        receiptCount: receiptGroups.size,
        finalInvoiceCount: (invoices || []).filter((row) => row.document_stage === 'ISSUED' && row.is_final_ipd_invoice).length,
        totalBilled: (invoices || []).filter((row) => row.document_stage === 'ISSUED').reduce((sum, row) => sum + Number(row.total || 0), 0),
        amountPaid: (invoices || []).filter((row) => row.document_stage === 'ISSUED').reduce((sum, row) => sum + Number(row.amount_paid || 0), 0),
        balanceDue: (invoices || []).filter((row) => row.document_stage === 'ISSUED').reduce((sum, row) => sum + Number(row.balance_due || 0), 0)
      }
    : null;

  return {
    admission: {
      id: String(admission._id),
      admissionNumber: admission.admissionNumber,
      shipNumber: admission.shipNumber,
      status: admission.status,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate,
      patient: admission.patientId,
      primaryDoctor: admission.primaryDoctorId,
      department: admission.departmentId,
      ward: admission.wardId,
      room: admission.roomId,
      bed: admission.bedId,
      hospital
    },
    counts,
    categories: CATEGORY_ORDER,
    payerContext: publicPayerContext,
    billingSummary,
    packets: Object.entries(PACKET_DEFINITIONS).map(([key, definition]) => ({ key, label: definition.label, description: definition.description || '' })),
    documents: filtered
  };
}

module.exports = { buildManifest, packetCategories, packetDefinition, packetDocuments, CATEGORY_ORDER, PACKETS, PACKET_DEFINITIONS };
