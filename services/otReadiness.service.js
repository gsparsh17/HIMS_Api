const { operationNow } = require('../utils/operationTimeContext');
const OTReadinessChecklist = require('../models/OTReadinessChecklist');
const OTClinicalForm = require('../models/OTClinicalForm');
const OTPreAnaesthesiaAssessment = require('../models/OTPreAnaesthesiaAssessment');
const IPDConsent = require('../models/IPDConsent');
const { financialCanProceed, canonicalStatus } = require('./otWorkflow.service');

const DEFAULT_READINESS_ITEMS = Object.freeze([
  ['identity_verified', 'Patient identity verified', 'Patient'],
  ['procedure_confirmed', 'Procedure and site confirmed', 'Patient'],
  ['general_consent', 'General consent completed', 'Consent'],
  ['procedure_consent', 'Procedure/surgery consent completed', 'Consent'],
  ['anaesthesia_consent', 'Anaesthesia consent completed', 'Consent'],
  ['pac_complete', 'Pre-anaesthesia assessment completed', 'Anaesthesia'],
  ['npo_confirmed', 'NPO/last oral intake confirmed', 'Clinical'],
  ['allergy_reviewed', 'Allergies reviewed', 'Clinical'],
  ['investigations_reviewed', 'Required investigations reviewed', 'Investigation'],
  ['blood_ready', 'Blood requirement and availability confirmed', 'Blood'],
  ['site_marked', 'Surgical site marked where applicable', 'Patient'],
  ['equipment_ready', 'Equipment and implants ready', 'Store'],
  ['financial_clearance', 'Financial/payer clearance completed or exception approved', 'Billing']
].map(([key, label, category]) => ({ key, label, category, required: true, status: 'Pending' })));

const DERIVED_READINESS_KEYS = Object.freeze([
  'general_consent',
  'procedure_consent',
  'anaesthesia_consent',
  'pac_complete',
  'financial_clearance'
]);

const CONSENT_TEMPLATE_BY_KEY = Object.freeze({
  general_consent: 'general_consent',
  procedure_consent: 'surgery_procedure_consent',
  anaesthesia_consent: 'anesthesia_consent'
});

// The same consents can also be captured from the canonical IPD Patient File > Consents tab.
// OT-specific surgery/anaesthesia consents should use the OT case scope when available.
const IPD_CONSENT_TEMPLATE_BY_KEY = Object.freeze({
  general_consent: 'general-consent',
  procedure_consent: 'surgery-consent',
  anaesthesia_consent: 'anaesthesia-consent'
});

function cloneDefaults() {
  return DEFAULT_READINESS_ITEMS.map((row) => ({ ...row }));
}

function evaluateReadiness(checklist) {
  const required = checklist.items.filter((item) => item.required);
  const pending = required.filter((item) => !['Complete', 'Not Applicable', 'Bypassed'].includes(item.status));
  const bypassed = required.some((item) => item.status === 'Bypassed');
  checklist.overallStatus = pending.length ? 'Pending' : bypassed ? 'Ready With Bypass' : 'Ready';
  checklist.evaluatedAt = operationNow();
  checklist.version = Number(checklist.version || 0) + 1;
  return checklist;
}

async function getOrCreateReadiness(otCase, userId, session) {
  const query = OTReadinessChecklist.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id });
  if (session) query.session(session);
  let checklist = await query;
  if (!checklist) {
    const payload = {
      hospitalId: otCase.hospitalId,
      caseId: otCase._id,
      admissionId: otCase.admissionId,
      patientId: otCase.patientId,
      items: cloneDefaults(),
      evaluatedBy: userId
    };
    if (session) {
      const rows = await OTReadinessChecklist.create([payload], { session });
      checklist = rows[0];
    } else {
      checklist = await OTReadinessChecklist.create(payload);
    }
  }
  return checklist;
}

function ensureItem(checklist, key, label, category = 'Derived') {
  let item = checklist.items.find((row) => row.key === key);
  if (!item) {
    item = checklist.items.create({ key, label, category, required: true, status: 'Pending' });
    checklist.items.push(item);
  }
  return item;
}

function applyDerivedState(item, complete, { userId, notes, value } = {}) {
  // A documented bypass remains valid until explicitly changed. Otherwise the
  // source clinical/financial record is authoritative for derived items.
  if (item.status !== 'Bypassed') {
    item.status = complete ? 'Complete' : 'Pending';
    item.completedBy = complete ? userId : undefined;
    item.completedAt = complete ? operationNow() : undefined;
  }
  item.notes = item.status === 'Bypassed' ? item.notes : notes;
  item.value = value;
  return item;
}

function syncFinancialItem(checklist, otCase, userId) {
  const item = ensureItem(checklist, 'financial_clearance', 'Financial/payer clearance completed or exception approved', 'Billing');
  const complete = financialCanProceed(otCase.financialClearanceState, otCase);
  return applyDerivedState(item, complete, {
    userId,
    value: {
      derived: true,
      source: 'central-financial-ledger',
      clearanceState: otCase.financialClearanceState,
      selectedBillingMode: otCase.selectedBillingMode,
      requiredNowAmount: Number(otCase.requiredNowAmount || 0)
    },
    notes: complete
      ? `Automatically cleared from financial state: ${otCase.financialClearanceState}`
      : `Financial action required: ${otCase.financialClearanceState || 'PAYMENT_REQUIRED'}`
  });
}

async function loadDerivedEvidence(otCase, session) {
  const formQuery = OTClinicalForm.find({
    hospitalId: otCase.hospitalId,
    caseId: otCase._id,
    templateId: { $in: Object.values(CONSENT_TEMPLATE_BY_KEY) }
  }).select('templateId status updatedAt completedAt signedAt');
  const pacQuery = OTPreAnaesthesiaAssessment.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id })
    .select('status fitnessStatus assessedAt signedAt updatedAt');
  const ipdConsentQuery = IPDConsent.find({
    hospitalId: otCase.hospitalId,
    admissionId: otCase.admissionId,
    templateId: { $in: Object.values(IPD_CONSENT_TEMPLATE_BY_KEY) },
    status: { $in: ['Completed', 'Signed', 'Amended'] },
    $or: [
      { relatedOTCaseId: otCase._id },
      { scopeKey: `ot:${otCase._id}` },
      { templateId: 'general-consent', scopeKey: 'admission' }
    ]
  }).select('templateId status relatedOTCaseId scopeKey completedAt finalizedAt updatedAt');
  if (session) { formQuery.session(session); pacQuery.session(session); ipdConsentQuery.session(session); }
  const [forms, pac, ipdConsents] = await Promise.all([formQuery.lean(), pacQuery.lean(), ipdConsentQuery.lean()]);
  return {
    forms: new Map(forms.map((row) => [row.templateId, row])),
    ipdConsents: new Map(ipdConsents.map((row) => [row.templateId, row])),
    pac
  };
}

async function reconcileOtReadiness({ otCase, userId, session, autoApprove = true, saveCase = true }) {
  const checklist = await getOrCreateReadiness(otCase, userId, session);
  const evidence = await loadDerivedEvidence(otCase, session);

  for (const [key, templateId] of Object.entries(CONSENT_TEMPLATE_BY_KEY)) {
    const item = ensureItem(checklist, key, DEFAULT_READINESS_ITEMS.find((row) => row.key === key)?.label || key, 'Consent');
    const form = evidence.forms.get(templateId);
    const ipdTemplateId = IPD_CONSENT_TEMPLATE_BY_KEY[key];
    const ipdConsent = ipdTemplateId ? evidence.ipdConsents.get(ipdTemplateId) : null;
    const complete = Boolean((form && ['Completed', 'Signed', 'Amended'].includes(form.status)) || ipdConsent);
    const source = form ? { type: 'OTClinicalForm', id: form._id, status: form.status, templateId }
      : ipdConsent ? { type: 'IPDConsent', id: ipdConsent._id, status: ipdConsent.status, templateId: ipdTemplateId, scopeKey: ipdConsent.scopeKey }
        : null;
    applyDerivedState(item, complete, {
      userId,
      notes: complete ? `Automatically derived from ${source.type} ${source.templateId} (${source.status})` : `Awaiting ${templateId} / ${ipdTemplateId}`,
      value: { derived: true, source: source?.type || null, templateId: source?.templateId || templateId, sourceStatus: source?.status || null, sourceId: source?.id || null, scopeKey: source?.scopeKey }
    });
  }

  const pacItem = ensureItem(checklist, 'pac_complete', 'Pre-anaesthesia assessment completed', 'Anaesthesia');
  const pacComplete = Boolean(evidence.pac && ['Completed', 'Signed'].includes(evidence.pac.status));
  applyDerivedState(pacItem, pacComplete, {
    userId,
    notes: pacComplete ? `Automatically derived from PAC (${evidence.pac.status})` : 'Awaiting completed PAC',
    value: {
      derived: true,
      source: 'OTPreAnaesthesiaAssessment',
      sourceStatus: evidence.pac?.status || null,
      fitnessStatus: evidence.pac?.fitnessStatus || null,
      sourceId: evidence.pac?._id || null
    }
  });

  syncFinancialItem(checklist, otCase, userId);
  await persistReadinessAndCase({ checklist, otCase, userId, session, autoApprove });
  if (saveCase) await otCase.save(session ? { session } : undefined);
  return checklist;
}

async function persistReadinessAndCase({ checklist, otCase, userId, session, autoApprove = true }) {
  checklist.evaluatedBy = userId;
  evaluateReadiness(checklist);
  await checklist.save(session ? { session } : undefined);
  otCase.readinessStatus = checklist.overallStatus;
  const status = canonicalStatus(otCase.status, otCase);
  if (autoApprove && status === 'Readiness Pending' && checklist.overallStatus !== 'Pending') {
    otCase.status = 'Approved';
    otCase.approvedBy = userId;
    otCase.approvedAt = operationNow();
  }
  return { checklist, otCase };
}

module.exports = {
  DEFAULT_READINESS_ITEMS,
  DERIVED_READINESS_KEYS,
  CONSENT_TEMPLATE_BY_KEY,
  IPD_CONSENT_TEMPLATE_BY_KEY,
  evaluateReadiness,
  getOrCreateReadiness,
  syncFinancialItem,
  reconcileOtReadiness,
  persistReadinessAndCase
};
