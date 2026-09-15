const { operationNow } = require('../utils/operationTimeContext');
const OTReadinessChecklist = require('../models/OTReadinessChecklist');
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

function syncFinancialItem(checklist, otCase, userId) {
  let item = checklist.items.find((row) => row.key === 'financial_clearance');
  if (!item) {
    item = checklist.items.create({
      key: 'financial_clearance',
      label: 'Financial/payer clearance completed or exception approved',
      category: 'Billing',
      required: true,
      status: 'Pending'
    });
    checklist.items.push(item);
  }
  const complete = financialCanProceed(otCase.financialClearanceState, otCase);
  item.status = complete ? 'Complete' : 'Pending';
  item.value = {
    clearanceState: otCase.financialClearanceState,
    selectedBillingMode: otCase.selectedBillingMode,
    requiredNowAmount: Number(otCase.requiredNowAmount || 0)
  };
  item.notes = complete
    ? `Financial clearance: ${otCase.financialClearanceState}`
    : `Financial action required: ${otCase.financialClearanceState || 'PAYMENT_REQUIRED'}`;
  item.completedBy = complete ? userId : undefined;
  item.completedAt = complete ? operationNow() : undefined;
  item.bypassReason = undefined;
  item.bypassApprovedBy = undefined;
  return item;
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
  evaluateReadiness,
  getOrCreateReadiness,
  syncFinancialItem,
  persistReadinessAndCase
};
