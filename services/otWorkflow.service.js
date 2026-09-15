const { operationNow } = require('../utils/operationTimeContext');

const OT_WORKFLOW_POLICY_VERSION = 'ot-v2';

const CANONICAL_OT_STATUSES = Object.freeze([
  'Readiness Pending',
  'Approved',
  'Scheduled',
  'Patient Received',
  'In Progress',
  'Recovery',
  'Transferred',
  'Closed',
  'Postponed',
  'Cancelled'
]);

const LEGACY_OT_STATUSES = Object.freeze([
  'Requested',
  'Payment Pending',
  'Payment Received',
  'Completed'
]);

const FINANCIAL_PROCEED_STATES = Object.freeze([
  'CLEARED',
  'POSTPAID_ALLOWED',
  'EXCEPTION_APPROVED'
]);

const FINANCIAL_BLOCKING_STATES = Object.freeze([
  'PAYMENT_REQUIRED',
  'TPA_PENDING',
  'AUTHORIZATION_REQUIRED',
  'HOLD'
]);

function canonicalStatus(status, doc = {}) {
  if (!status) return 'Readiness Pending';
  if (CANONICAL_OT_STATUSES.includes(status)) return status;
  if (status === 'Requested' || status === 'Payment Pending') return 'Readiness Pending';
  if (status === 'Payment Received') {
    return ['Ready', 'Ready With Bypass'].includes(doc.readinessStatus) ? 'Approved' : 'Readiness Pending';
  }
  if (status === 'Completed') {
    if (doc.closedAt || doc.clinicalClosureStatus === 'Closed') return 'Closed';
    if (doc.transferredAt || doc.transferred_at || doc.transferred_to_ward) return 'Transferred';
    return 'Recovery';
  }
  return status;
}

function financialCanProceed(state, doc = {}) {
  return FINANCIAL_PROCEED_STATES.includes(state) || Boolean(doc?.emergencyOverride?.enabled);
}

function readinessCanProceed(doc = {}) {
  return ['Ready', 'Ready With Bypass'].includes(doc.readinessStatus)
    || doc.urgency === 'Emergency'
    || Boolean(doc?.emergencyOverride?.enabled);
}

function allowedActions(doc = {}) {
  const status = canonicalStatus(doc.status, doc);
  const financeReady = financialCanProceed(doc.financialClearanceState, doc);
  const readinessReady = readinessCanProceed(doc);
  const emergency = doc.urgency === 'Emergency' || Boolean(doc?.emergencyOverride?.enabled);

  return {
    approve: status === 'Readiness Pending' && (readinessReady || emergency),
    schedule: ['Approved', 'Postponed', 'Scheduled'].includes(status) && financeReady && readinessReady,
    reschedule: status === 'Scheduled' && financeReady && readinessReady,
    receive: status === 'Scheduled' && readinessReady,
    start: status === 'Patient Received',
    recover: status === 'In Progress',
    transfer: status === 'Recovery',
    close: status === 'Transferred',
    postpone: ['Approved', 'Scheduled', 'Patient Received'].includes(status),
    cancel: ['Readiness Pending', 'Approved', 'Scheduled', 'Patient Received', 'Postponed'].includes(status),
    refreshFinancial: !['Closed', 'Cancelled'].includes(status)
  };
}

function workflowView(doc = {}) {
  const status = canonicalStatus(doc.status, doc);
  return {
    policyVersion: OT_WORKFLOW_POLICY_VERSION,
    canonicalStatus: status,
    storedStatus: doc.status || status,
    isLegacyStatus: status !== doc.status,
    readinessStatus: doc.readinessStatus || 'Not Evaluated',
    financialClearanceState: doc.financialClearanceState || 'PAYMENT_REQUIRED',
    financialCanProceed: financialCanProceed(doc.financialClearanceState, doc),
    allowedActions: allowedActions(doc)
  };
}

function decorateCase(doc) {
  if (!doc) return doc;
  const raw = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  const workflow = workflowView(raw);
  return {
    ...raw,
    status: workflow.canonicalStatus,
    ...(workflow.isLegacyStatus ? { storedStatus: workflow.storedStatus } : {}),
    workflow
  };
}

function queryStatusesForCanonical(values = []) {
  const output = new Set();
  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value) continue;
    output.add(value);
    if (value === 'Readiness Pending') {
      output.add('Requested');
      output.add('Payment Pending');
    } else if (value === 'Approved') {
      output.add('Payment Received');
    } else if (value === 'Recovery' || value === 'Transferred' || value === 'Closed') {
      // Legacy Completed cannot be classified perfectly without inspecting the case.
      // Include it for compatibility until the migration is applied.
      output.add('Completed');
    }
  }
  return [...output];
}

function legacyActionForStatus(status) {
  const mapping = {
    Approved: 'approve',
    'Patient Received': 'receive',
    'In Progress': 'start',
    Recovery: 'recover',
    Completed: 'recover',
    Transferred: 'transfer',
    Closed: 'close',
    Postponed: 'postpone',
    Cancelled: 'cancel'
  };
  return Object.prototype.hasOwnProperty.call(mapping, status) ? mapping[status] : undefined;
}

function buildTransitionDefinitions({ closeGuard }) {
  return {
    approve: {
      from: ['Requested', 'Readiness Pending', 'Payment Pending', 'Payment Received'],
      to: 'Approved',
      eventType: 'ot.case.approved',
      guard: (doc) => readinessCanProceed(doc),
      update: (_doc, req) => ({ approvedBy: req.user._id, approvedAt: operationNow(), workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    },
    receive: {
      from: ['Scheduled'],
      to: 'Patient Received',
      eventType: 'ot.case.patient_received',
      guard: (doc) => readinessCanProceed(doc),
      update: () => ({ patientReceivedAt: operationNow(), workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    },
    start: {
      from: ['Patient Received'],
      to: 'In Progress',
      eventType: 'ot.case.started',
      update: () => ({ startedAt: operationNow(), workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    },
    recover: {
      from: ['In Progress'],
      to: 'Recovery',
      eventType: 'ot.case.recovery_started',
      update: () => ({ recoveryStartedAt: operationNow(), completedAt: operationNow(), workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    },
    transfer: {
      from: ['Recovery'],
      to: 'Transferred',
      eventType: 'ot.case.transferred',
      update: () => ({ transferredAt: operationNow(), transferred_to_ward: true, workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    },
    close: {
      from: ['Transferred'],
      to: 'Closed',
      eventType: 'ot.case.closed',
      guard: closeGuard,
      update: () => ({ closedAt: operationNow(), clinicalClosureStatus: 'Closed', inventoryClosureStatus: 'Reconciled', workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    },
    postpone: {
      from: ['Approved', 'Scheduled', 'Patient Received'],
      to: 'Postponed',
      eventType: 'ot.case.postponed',
      update: () => ({ postponedAt: operationNow(), workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    },
    cancel: {
      from: ['Requested', 'Readiness Pending', 'Payment Pending', 'Payment Received', 'Approved', 'Scheduled', 'Patient Received', 'Postponed'],
      to: 'Cancelled',
      eventType: 'ot.case.cancelled',
      update: (_doc, req) => ({ cancelledAt: operationNow(), cancelledBy: req.user._id, workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION })
    }
  };
}

module.exports = {
  OT_WORKFLOW_POLICY_VERSION,
  CANONICAL_OT_STATUSES,
  LEGACY_OT_STATUSES,
  FINANCIAL_PROCEED_STATES,
  FINANCIAL_BLOCKING_STATES,
  canonicalStatus,
  financialCanProceed,
  readinessCanProceed,
  allowedActions,
  workflowView,
  decorateCase,
  queryStatusesForCanonical,
  legacyActionForStatus,
  buildTransitionDefinitions
};
