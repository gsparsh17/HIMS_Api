const LAB_TRANSITIONS = Object.freeze({
  Pending: ['Approved', 'Cancelled'],
  Approved: ['Sample Collected', 'Cancelled'],
  'Sample Collected': ['Received', 'Rejected', 'Cancelled'],
  Received: ['Processing', 'Rejected'],
  Processing: ['Result Entered', 'Referred Out', 'Cancelled'],
  'Result Entered': ['Verified', 'Processing'],
  Verified: ['Reported', 'Result Entered'],
  Reported: ['Amended'],
  Amended: ['Verified', 'Reported'],
  Rejected: ['Approved', 'Cancelled'],
  'Referred Out': ['Result Entered', 'Reported'],
  Cancelled: []
});

const RADIOLOGY_TRANSITIONS = Object.freeze({
  Pending: ['Approved', 'Scheduled', 'Cancelled'],
  Approved: ['Scheduled', 'In Progress', 'Cancelled'],
  Scheduled: ['In Progress', 'Cancelled'],
  'In Progress': ['Result Entered', 'Cancelled'],
  'Result Entered': ['Verified', 'In Progress'],
  Verified: ['Reported', 'Result Entered'],
  Reported: ['Amended'],
  Amended: ['Verified', 'Reported'],
  Cancelled: []
});

function ensureWorkflowTransition(name, transitions, from, to) {
  if (!transitions[from]?.includes(to)) {
    const error = new Error(`Invalid ${name} transition: ${from} -> ${to}`);
    error.statusCode = 409;
    throw error;
  }
}

module.exports = {
  LAB_TRANSITIONS,
  RADIOLOGY_TRANSITIONS,
  ensureWorkflowTransition
};