const OTClinicalForm = require('../models/OTClinicalForm');
const OTSurgicalSafetyChecklist = require('../models/OTSurgicalSafetyChecklist');
const OTAnesthesiaRecord = require('../models/OTAnesthesiaRecord');
const OTOperativeNote = require('../models/OTOperativeNote');
const OTRecoveryRecord = require('../models/OTRecoveryRecord');
const OTCaseInventoryUsage = require('../models/OTCaseInventoryUsage');
const OTSpecimen = require('../models/OTSpecimen');
const OTAdditionalProcedure = require('../models/OTAdditionalProcedure');
const LabRequest = require('../models/LabRequest');
const IPDCharge = require('../models/IPDCharge');
const IPDConsent = require('../models/IPDConsent');
const { listTemplates } = require('../config/otSurgeryFormTemplates');

const CORE_NATIVE_TEMPLATE_IDS = new Set([
  'ot_readiness', 'surgical_safety_checklist', 'pre_anaesthesia_assessment',
  'intra_post_anaesthesia_record', 'operation_notes', 'post_anaesthesia_recovery_record',
  'ot_consumables_implants'
]);

function completed(status) { return ['Completed', 'Signed', 'Amended'].includes(status); }
function safetyComplete(section) { return ['Completed', 'Bypassed'].includes(section?.status); }
function money(value) { return Number(Number(value || 0).toFixed(2)); }

async function requiredStructuredForms(otCase) {
  const templates = listTemplates().filter((template) => template.required && template.implementation === 'structured' && !CORE_NATIVE_TEMPLATE_IDS.has(template.id));
  const [rows, ipdConsents] = await Promise.all([
    OTClinicalForm.find({ hospitalId: otCase.hospitalId, caseId: otCase._id, templateId: { $in: templates.map((template) => template.id) } }).select('templateId status').lean(),
    IPDConsent.find({
      hospitalId: otCase.hospitalId,
      admissionId: otCase.admissionId,
      status: { $in: ['Completed', 'Signed', 'Amended'] },
      $or: [
        { relatedOTCaseId: otCase._id },
        { scopeKey: `ot:${otCase._id}` },
        { templateId: 'general-consent', scopeKey: 'admission' }
      ]
    }).select('templateId status scopeKey relatedOTCaseId').lean()
  ]);
  const map = new Map(rows.map((row) => [row.templateId, row]));
  const ipdMap = new Map(ipdConsents.map((row) => [row.templateId, row]));
  const ipdAlternative = {
    general_consent: 'general-consent',
    surgery_procedure_consent: 'surgery-consent',
    anesthesia_consent: 'anaesthesia-consent'
  };
  return templates.map((template) => ({
    template,
    record: map.get(template.id) || (ipdAlternative[template.id] ? ipdMap.get(ipdAlternative[template.id]) : null),
    source: map.has(template.id) ? 'OTClinicalForm' : (ipdAlternative[template.id] && ipdMap.has(ipdAlternative[template.id]) ? 'IPDConsent' : null)
  }));
}

async function clinicalClosureCheck(otCase) {
  const [operative, anesthesia, recovery, inventory, safety, forms, specimens] = await Promise.all([
    OTOperativeNote.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id }),
    OTAnesthesiaRecord.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id }),
    OTRecoveryRecord.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id }),
    OTCaseInventoryUsage.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id }),
    OTSurgicalSafetyChecklist.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id }),
    requiredStructuredForms(otCase),
    OTSpecimen.find({ hospitalId: otCase.hospitalId, caseId: otCase._id }).lean()
  ]);
  const errors = [];
  if (!operative || !completed(operative.status)) errors.push('Operative note is incomplete');
  if (!anesthesia || !completed(anesthesia.status)) errors.push('Anaesthesia record is incomplete');
  if (!recovery || !['Transferred', 'Signed'].includes(recovery.status)) errors.push('Recovery/transfer record is incomplete');
  if (inventory && inventory.status !== 'Reconciled') errors.push('OT inventory usage is not reconciled');
  if (!safety || !safetyComplete(safety.signIn) || !safetyComplete(safety.timeOut) || !safetyComplete(safety.signOut)) errors.push('Surgical safety checklist is incomplete');
  const incompleteForms = forms.filter(({ record }) => !record || !completed(record.status)).map(({ template }) => template.shortTitle || template.title);
  if (incompleteForms.length) errors.push(`Required OT forms incomplete: ${incompleteForms.join(', ')}`);
  const specimenIssues = specimens.filter((row) => row.pathologyOrderId && !['Handed Over', 'Received', 'Reported'].includes(row.status));
  if (specimenIssues.length) errors.push(`${specimenIssues.length} pathology specimen(s) have not been handed over`);
  return { ok: errors.length === 0, errors, operative, anesthesia, recovery, inventory, safety, forms, specimens };
}

async function financialReconciliation(otCase) {
  const [directCharges, additional, inventory, specimens] = await Promise.all([
    IPDCharge.find({ hospitalId: otCase.hospitalId, admissionId: otCase.admissionId, sourceModule: { $in: ['OT', 'OTRequest'] }, sourceId: otCase._id, status: { $nin: ['VOIDED', 'CANCELLED', 'REVERSED'] } }).lean(),
    OTAdditionalProcedure.find({ hospitalId: otCase.hospitalId, caseId: otCase._id }).lean(),
    OTCaseInventoryUsage.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id }).lean(),
    OTSpecimen.find({ hospitalId: otCase.hospitalId, caseId: otCase._id, pathologyOrderId: { $ne: null } }).lean()
  ]);
  const labRequestIds = specimens.map((row) => row.pathologyOrderId).filter(Boolean);
  const labCharges = labRequestIds.length
    ? await IPDCharge.find({ hospitalId: otCase.hospitalId, admissionId: otCase.admissionId, sourceModule: 'LabRequest', sourceId: { $in: labRequestIds }, status: { $nin: ['VOIDED', 'CANCELLED', 'REVERSED'] } }).lean()
    : [];
  const charges = [...directCharges, ...labCharges];
  const actualGross = money(charges.reduce((sum, row) => sum + Number(row.grossAmount || row.amount || 0), 0));
  const actualNet = money(charges.reduce((sum, row) => sum + Number(row.netAmount || 0), 0));
  const patientLiability = money(charges.reduce((sum, row) => sum + Number(row.patientLiability || 0), 0));
  const sponsorLiability = money(charges.reduce((sum, row) => sum + Number(row.sponsorLiability || 0), 0));
  const packageAbsorbed = money(charges.reduce((sum, row) => sum + Number(row.packageAbsorbedAmount || row.pricingSnapshot?.amounts?.packageAbsorbed || 0), 0));
  const estimate = money(otCase.estimated_cost || otCase.total_cost || 0);
  const billingFailures = [
    ...additional.filter((row) => row.billingStatus === 'Failed').map((row) => `Additional procedure ${row.procedureName}`),
    ...((inventory?.lines || []).filter((row) => row.billingStatus === 'Failed').map((row) => `Inventory item ${row.itemSnapshot?.name || row.itemId}`)),
    ...specimens.filter((row) => row.pathologyChargeStatus === 'Failed').map((row) => `Pathology ${row.specimenNumber}`)
  ];
  const status = billingFailures.length ? 'Pending Review' : 'Reconciled';
  return {
    status,
    estimate,
    actualGross,
    actualNet,
    variance: money(actualNet - estimate),
    patientLiability,
    sponsorLiability,
    packageAbsorbed,
    chargeCount: charges.length,
    billingFailures
  };
}

const { validateClinicalPayload } = require('../utils/otClinicalValidation');

module.exports = { clinicalClosureCheck, financialReconciliation, validateClinicalPayload };
