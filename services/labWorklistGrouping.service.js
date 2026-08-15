'use strict';

// ============================================
// Constants
// ============================================

const STATUS_ORDER = [
  'Pending',
  'Approved',
  'Sample Collected',
  'Received',
  'Processing',
  'Result Entered',
  'Completed',
  'Verified',
  'Reported',
  'Amended',
  'Cancelled'
];

// ============================================
// Helpers
// ============================================

function isoMinute(value) {
  const date = new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  return date.toISOString().slice(0, 16);
}

// ============================================
// Request Group Key
// ============================================

function requestGroupKey(row) {
  // Explicit group key
  if (row.requestGroupKey) {
    return String(row.requestGroupKey);
  }

  // Order-based grouping
  if (row.orderNumber) {
    return String(row.orderNumber);
  }

  if (row.orderGroupId) {
    return String(row.orderGroupId);
  }

  // Desk checkout grouping
  if (row.deskCheckoutKey) {
    return `CHECKOUT:${row.deskCheckoutKey}`;
  }

  // Prescription-based grouping
  if (row.prescriptionId) {
    return `RX:${row.prescriptionId?._id || row.prescriptionId}`;
  }

  // Legacy grouping
  const encounter = row.admissionId?._id ||
    row.admissionId ||
    row.appointmentId?._id ||
    row.appointmentId ||
    'WALKIN';

  const patient = row.patientId?._id ||
    row.patientId ||
    'PATIENT';

  const doctor = row.doctorId?._id ||
    row.doctorId ||
    'DOCTOR';

  return `LEGACY:${patient}:${encounter}:${doctor}:${isoMinute(row.requestedDate)}`;
}

// ============================================
// Aggregate Status
// ============================================

function aggregateStatus(rows) {
  if (!rows.length) {
    return 'Pending';
  }

  // All reports are final
  if (rows.every((row) => ['Reported', 'Amended'].includes(row.status))) {
    return 'Reported';
  }

  // All are verified or beyond
  if (rows.every((row) => ['Verified', 'Reported', 'Amended'].includes(row.status))) {
    return 'Verified';
  }

  // Any in progress
  if (rows.some((row) => row.status === 'Processing')) {
    return 'Processing';
  }

  // Any results entered
  if (rows.some((row) => row.status === 'Result Entered' || row.status === 'Completed')) {
    return 'Result Entered';
  }

  // Any samples collected
  if (rows.some((row) => row.status === 'Sample Collected' || row.status === 'Received')) {
    return 'Sample Collected';
  }

  // All cancelled
  if (rows.every((row) => row.status === 'Cancelled')) {
    return 'Cancelled';
  }

  // Fallback: earliest status by order
  const sorted = rows.slice().sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
  );

  return sorted[0]?.status || 'Pending';
}

// ============================================
// Group Lab Requests
// ============================================

function groupLabRequests(rows = []) {
  const groups = new Map();

  // Group by request key
  for (const row of rows) {
    const key = requestGroupKey(row);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(row);
  }

  // Transform groups
  return [...groups.entries()].map(([groupId, tests]) => {
    const first = tests[0];

    const sorted = tests.slice().sort(
      (a, b) => new Date(a.requestedDate || 0) - new Date(b.requestedDate || 0)
    );

    return {
      groupId,
      orderNumber: first.orderNumber || first.requestGroupKey || null,
      patientId: first.patientId,
      doctorId: first.doctorId,
      admissionId: first.admissionId,
      appointmentId: first.appointmentId,
      prescriptionId: first.prescriptionId,
      sourceType: first.sourceType,
      priority: tests.some((test) => String(test.priority).toLowerCase() === 'urgent')
        ? 'Urgent'
        : first.priority,
      status: aggregateStatus(tests),
      requestedDate: sorted[0]?.requestedDate || first.requestedDate,
      testCount: tests.length,
      requestIds: tests.map((test) => test._id),
      tests: tests.map((test) => ({
        _id: test._id,
        requestNumber: test.requestNumber,
        accessionNumber: test.accessionNumber,
        labTestId: test.labTestId,
        testCode: test.testCode,
        testName: test.testName,
        category: test.category,
        status: test.status,
        specimen: test.specimen,
        requestedDate: test.requestedDate,
        reportFinalisation: test.reportFinalisation,
        report_mode: test.report_mode
      }))
    };
  }).sort(
    (a, b) => new Date(a.requestedDate || 0) - new Date(b.requestedDate || 0)
  );
}

module.exports = {
  requestGroupKey,
  aggregateStatus,
  groupLabRequests
};