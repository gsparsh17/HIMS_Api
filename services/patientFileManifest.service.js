const IPDAdmission = require('../models/IPDAdmission');
const IPDInitialAssessment = require('../models/IPDInitialAssessment');
const IPDNursingAdmissionAssessment = require('../models/IPDNursingAdmissionAssessment');
const IPDVitals = require('../models/IPDVitals');
const IPDMedicationChart = require('../models/IPDMedicationChart');
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
const DischargeSummary = require('../models/DischargeSummary');
const ClinicalDocument = require('../models/ClinicalDocument');
const EncounterDocument = require('../models/EncounterDocument');
const DocumentSignature = require('../models/DocumentSignature');
const { requireHospitalId, idString } = require('./tenantScope.service');
const { listTemplates: listSurgeryFormTemplates } = require('../config/otSurgeryFormTemplates');

const CATEGORY_ORDER = [
  'admission', 'consent', 'assessment', 'progress', 'nursing', 'vitals', 'medication',
  'investigation', 'procedure', 'ot', 'anesthesia', 'recovery', 'transfusion', 'discharge', 'attachment', 'financial'
];

const PACKETS = {
  clinical: CATEGORY_ORDER.filter((category) => category !== 'financial'),
  ot: ['admission', 'consent', 'assessment', 'investigation', 'procedure', 'ot', 'anesthesia', 'recovery', 'medication', 'attachment'],
  nursing: ['admission', 'assessment', 'nursing', 'vitals', 'medication', 'progress', 'recovery'],
  investigation: ['investigation', 'attachment'],
  discharge: ['admission', 'assessment', 'progress', 'nursing', 'vitals', 'medication', 'investigation', 'procedure', 'ot', 'anesthesia', 'recovery', 'discharge'],
  financial: ['financial']
};

function packetCategories(packetType) {
  return PACKETS[packetType] || PACKETS.clinical;
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
    documentDate: date || record?.updatedAt || record?.createdAt || new Date(),
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
    .populate('patientId', 'first_name last_name name patient_id uhid age gender date_of_birth phone')
    .populate('primaryDoctorId', 'first_name last_name name specialization')
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
    signatures
  ] = await Promise.all([
    IPDInitialAssessment.findOne({ admissionId }).lean(),
    IPDNursingAdmissionAssessment.findOne({ admissionId }).lean(),
    IPDVitals.find({ admissionId }).sort({ recordedAt: 1 }).lean(),
    IPDMedicationChart.find({ admissionId }).sort({ startDate: 1, createdAt: 1 }).lean(),
    IPDRound.find({ admissionId }).sort({ roundDateTime: 1 }).lean(),
    NursingNote.find({ admissionId }).sort({ noteDateTime: 1 }).lean(),
    IPDConsent.find({ admissionId, $or: [{ hospitalId }, { hospitalId: null }] }).sort({ createdAt: 1 }).lean(),
    LabRequest.find({ admissionId, sourceType: 'IPD' }).sort({ requestedDate: 1 }).lean(),
    LabReport.find({ patient_id: patientId }).sort({ report_date: 1 }).lean(),
    RadiologyRequest.find({ admissionId, sourceType: 'IPD' }).sort({ requestedDate: 1 }).lean(),
    ProcedureRequest.find({ admissionId, sourceType: 'IPD' }).sort({ requestedDate: 1 }).lean(),
    OTRequest.find(caseFilter).sort({ requestedDate: 1 }).lean(),
    DischargeSummary.findOne({ admissionId }).lean(),
    ClinicalDocument.find({ patientId, status: 'current' }).sort({ documentDate: 1 }).lean(),
    EncounterDocument.find({ hospitalId, admissionId }).sort({ documentDate: 1 }).lean(),
    DocumentSignature.find({ hospitalId, admissionId, status: 'signed' }).sort({ signedAt: -1 }).lean()
  ]);

  const documents = [];
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

  consents.forEach((record) => documents.push(manifestItem({
    record, category: 'consent', documentType: record.templateId, title: record.templateName,
    sourceModel: 'IPDConsent', rendererKey: 'ipd-consent', status: statusOf(record.status, { complete: ['Completed'], final: ['Signed'] }),
    date: record.completedAt || record.updatedAt, required: Boolean(record.relatedOTCaseId), relatedCaseId: record.relatedOTCaseId || record.relatedProcedureId,
    relatedCaseType: record.relatedOTCaseId ? 'OTRequest' : record.relatedProcedureId ? 'ProcedureRequest' : undefined,
    templateId: record.templateId, templateVersion: record.templateVersion
  })));

  const vitalsByDate = new Map();
  vitals.forEach((record) => {
    const key = record.chartDate || new Date(record.recordedAt || record.createdAt).toISOString().slice(0, 10);
    if (!vitalsByDate.has(key)) vitalsByDate.set(key, []);
    vitalsByDate.get(key).push(record);
  });
  vitalsByDate.forEach((rows, chartDate) => documents.push(manifestItem({
    record: rows[0], category: 'vitals', documentType: 'vitals_ews', title: `Vitals & EWS - ${chartDate}`,
    sourceModel: 'IPDVitals', rendererKey: 'vitals-ews', status: 'Completed/Unsigned', date: rows[0].recordedAt,
    metadata: { chartDate, recordIds: rows.map((row) => String(row._id)), count: rows.length }
  })));

  medications.forEach((record) => documents.push(manifestItem({ record, category: 'medication', documentType: 'medication_chart', title: `Medication Chart${record.medicineName ? ` - ${record.medicineName}` : ''}`, sourceModel: 'IPDMedicationChart', rendererKey: 'medication-chart', status: clinicalStatus(record), date: record.startDate || record.createdAt, metadata: { medicineName: record.medicineName, frequency: record.frequency } })));
  rounds.forEach((record) => documents.push(manifestItem({ record, category: 'progress', documentType: record.roundType === 'Doctor Note' ? 'doctors_note' : 'consultant_round', title: record.roundType === 'Doctor Note' ? "Doctor's Note" : 'Consultant Daily Assessment', sourceModel: 'IPDRound', rendererKey: record.roundType === 'Doctor Note' ? 'doctors-note' : 'consultant-round', status: clinicalStatus(record), date: record.roundDateTime, authorName: record.doctorName }))); 
  nursingNotes.forEach((record) => documents.push(manifestItem({ record, category: 'nursing', documentType: 'nursing_note', title: 'Nursing Progress Note', sourceModel: 'NursingNote', rendererKey: 'nursing-note', status: 'Completed/Unsigned', date: record.noteDateTime, authorName: record.nurseName || record.createdByName })));

  labRequests.forEach((record) => {
    const reportUrl = record.report_url || record.external_report_url;
    documents.push(manifestItem({ record, category: 'investigation', documentType: 'lab_report', title: record.testName || 'Laboratory Report', sourceModel: 'LabRequest', rendererKey: record.manual_report ? 'lab-report-structured' : 'file-document', status: statusOf(record.status, { complete: ['Completed'], final: ['Reported'] }), date: record.reportedAt || record.processing_completed_at || record.requestedDate, fileUrl: reportUrl, mimeType: record.report_mime_type, metadata: { testCode: record.testCode, category: record.category, abnormal: record.is_abnormal, reportMode: record.report_mode } }));
  });
  const knownLabRequestIds = new Set(labRequests.map((record) => idString(record._id)));
  const encounterStart = admission.admissionDate ? new Date(admission.admissionDate) : new Date(0);
  const encounterEnd = admission.dischargeDate ? new Date(admission.dischargeDate) : new Date();
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

  radiology.forEach((record) => documents.push(manifestItem({ record, category: 'investigation', documentType: 'radiology_report', title: record.testName || 'Radiology Report', sourceModel: 'RadiologyRequest', rendererKey: record.manual_report ? 'radiology-report-structured' : 'file-document', status: statusOf(record.status, { complete: ['Completed'], final: ['Reported'] }), date: record.reportedAt || record.performedAt || record.requestedDate, fileUrl: record.report_url || record.external_report_url, mimeType: record.report_mime_type, metadata: { testCode: record.testCode, category: record.category, impression: record.impression, reportMode: record.report_mode } })));
  procedures.forEach((record) => documents.push(manifestItem({ record, category: 'procedure', documentType: 'procedure_record', title: record.procedureName || 'Procedure', sourceModel: 'ProcedureRequest', rendererKey: 'procedure-record', status: statusOf(record.status, { complete: ['Completed'] }), date: record.completedAt || record.scheduledDate || record.requestedDate, relatedCaseId: record._id, relatedCaseType: 'ProcedureRequest', metadata: { procedureCode: record.procedureCode, findings: record.findings, complications: record.complications } })));

  const otChildResults = await Promise.all(otCases.map(async (otCase) => {
    const filter = { hospitalId, caseId: otCase._id };
    const [readiness, safety, pac, anaesthesia, operative, recovery, inventory, structuredForms] = await Promise.all([
      OTReadinessChecklist.findOne(filter).lean(), OTSurgicalSafetyChecklist.findOne(filter).lean(),
      OTPreAnaesthesiaAssessment.findOne(filter).lean(), OTAnesthesiaRecord.findOne(filter).lean(),
      OTOperativeNote.findOne(filter).lean(), OTRecoveryRecord.findOne(filter).lean(), OTCaseInventoryUsage.findOne(filter).lean(),
      OTClinicalForm.find(filter).sort({ updatedAt: 1 }).lean()
    ]);
    return { otCase, readiness, safety, pac, anaesthesia, operative, recovery, inventory, structuredForms };
  }));
  otChildResults.forEach(({ otCase, readiness, safety, pac, anaesthesia, operative, recovery, inventory, structuredForms }) => {
    const caseMetadata = { requestNumber: otCase.requestNumber, procedureName: otCase.procedureName, urgency: otCase.urgency, caseStatus: otCase.status };
    documents.push(manifestItem({ record: otCase, category: 'ot', documentType: 'ot_case_summary', title: `OT/Surgery Case - ${otCase.procedureName}`, sourceModel: 'OTRequest', rendererKey: 'ot-case-summary', status: statusOf(otCase.status, { complete: ['Completed', 'Transferred', 'Closed'], final: ['Closed'] }), date: otCase.scheduledStart || otCase.requestedDate, relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', required: true, metadata: caseMetadata }));
    const children = [
      [readiness, 'ot', 'ot_readiness', 'Pre-Operative Readiness Checklist', 'OTReadinessChecklist', 'ot-readiness', ['Ready', 'Ready With Bypass']],
      [safety, 'ot', 'surgical_safety_checklist', 'Surgical Safety Checklist', 'OTSurgicalSafetyChecklist', 'ot-safety-checklist', ['Completed']],
      [pac, 'anesthesia', 'pre_anaesthesia_assessment', 'Preoperative Anaesthesia Record (PAC)', 'OTPreAnaesthesiaAssessment', 'ot-pac', ['Completed', 'Signed']],
      [anaesthesia, 'anesthesia', 'anaesthesia_record', 'Intra/Post Operative Anaesthesia Record', 'OTAnesthesiaRecord', 'ot-anesthesia-record', ['Completed', 'Signed']],
      [operative, 'ot', 'operative_note', 'Operation Notes', 'OTOperativeNote', 'ot-operative-note', ['Completed', 'Signed']],
      [recovery, 'recovery', 'recovery_record', 'Post Anaesthesia Recovery Record', 'OTRecoveryRecord', 'ot-recovery', ['Ready For Transfer', 'Transferred', 'Signed']],
      [inventory, 'ot', 'ot_inventory_usage', 'OT Consumables & Implants Record', 'OTCaseInventoryUsage', 'ot-inventory-usage', ['Reconciled']]
    ];
    children.forEach(([record, category, documentType, title, sourceModel, rendererKey, completed]) => {
      if (record) documents.push(manifestItem({ record, category, documentType, title, sourceModel, rendererKey, status: statusOf(record.status || record.overallStatus, { complete: completed.filter((value) => value !== 'Signed'), final: completed.includes('Signed') ? ['Signed'] : [] }), date: record.updatedAt, relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', required: true, metadata: caseMetadata }));
      else documents.push({ key: `required:${sourceModel}:${otCase._id}`, category, documentType, title, sourceModel, rendererKey, status: 'Not Started', required: true, relatedCaseId: String(otCase._id), relatedCaseType: 'OTRequest', metadata: caseMetadata });
    });

    const structuredTemplateList = listSurgeryFormTemplates().filter((template) => template.implementation === 'structured');
    const structuredMap = new Map((structuredForms || []).map((record) => [record.templateId, record]));
    structuredTemplateList.forEach((template) => {
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
          metadata: { ...caseMetadata, stage: template.stage, referencePages: template.referencePages || [] }
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

  uploadedClinical.forEach((record) => documents.push(manifestItem({ record, category: 'attachment', documentType: record.documentType || 'external_document', title: record.title, sourceModel: 'ClinicalDocument', rendererKey: record.fileUrl ? 'file-document' : 'text-document', status: 'Completed/Unsigned', date: record.documentDate, fileUrl: record.fileUrl, mimeType: record.mimeType, metadata: { description: record.description, source: record.source } })));

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

  const categoryRank = new Map(CATEGORY_ORDER.map((category, index) => [category, index]));
  documents.sort((a, b) => {
    const categoryDiff = (categoryRank.get(a.category) ?? 999) - (categoryRank.get(b.category) ?? 999);
    if (categoryDiff) return categoryDiff;
    return new Date(a.documentDate || 0) - new Date(b.documentDate || 0);
  });

  const filtered = documents.filter((document) => {
    if (document.visibility === 'financial' && !['admin', 'mediqliq_super_admin', 'accountant', 'staff', 'registrar'].includes(req.user.role)) return false;
    if (options.category && document.category !== options.category) return false;
    if (options.status && document.status !== options.status) return false;
    return true;
  });

  const counts = filtered.reduce((acc, document) => {
    acc[document.status] = (acc[document.status] || 0) + 1;
    return acc;
  }, {});
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
      bed: admission.bedId
    },
    counts,
    categories: CATEGORY_ORDER,
    packets: Object.keys(PACKETS),
    documents: filtered
  };
}

module.exports = { buildManifest, packetCategories, CATEGORY_ORDER, PACKETS };
