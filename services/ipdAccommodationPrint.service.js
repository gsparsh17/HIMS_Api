const IPDBedTransfer = require('../models/IPDBedTransfer');
const IPDAccommodationSegment = require('../models/IPDAccommodationSegment');
const IPDAdmission = require('../models/IPDAdmission');
const { stayDuration } = require('./accommodationMath.service');

// ============================================
// Helpers
// ============================================

function label(entity, keys) {
  if (!entity) return '—';

  for (const key of keys) {
    if (entity[key]) return entity[key];
  }

  return String(entity._id || entity);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function duration(start, end) {
  return stayDuration(start, end);
}

function location(ward, room, bed) {
  return {
    ward: label(ward, ['wardName', 'name', 'code']),
    room: label(room, ['roomNumber', 'room_number', 'name']),
    bed: label(bed, ['bedNumber', 'bed_number', 'name']),
    bedType: bed?.bedType || bed?.type || null,
  };
}

// ============================================
// Build Accommodation Print Data
// ============================================

async function buildAccommodationPrintData({
  hospitalId,
  admissionId,
  financial = false
}) {
  const [admission, transfers, segments] = await Promise.all([
    IPDAdmission.findOne({ _id: admissionId, hospitalId })
      .populate('wardId', 'name wardName code')
      .populate('roomId', 'name roomNumber room_number')
      .populate('bedId', 'name bedNumber bed_number bedType')
      .lean(),

    IPDBedTransfer.find({
      hospitalId,
      admissionId,
      status: { $in: ['Completed', 'Cancelled', 'Rejected'] }
    })
      .populate('from.wardId', 'name wardName code')
      .populate('from.roomId', 'name roomNumber room_number')
      .populate('from.bedId', 'name bedNumber bed_number bedType')
      .populate('to.wardId', 'name wardName code')
      .populate('to.roomId', 'name roomNumber room_number')
      .populate('to.bedId', 'name bedNumber bed_number bedType')
      .populate(
        'people.requestedBy people.approvedBy people.receivedBy people.completedBy',
        'name first_name last_name role'
      )
      .sort({ actualEffectiveAt: 1, createdAt: 1 })
      .lean(),

    IPDAccommodationSegment.find({
      hospitalId,
      admissionId,
      status: { $ne: 'voided' }
    })
      .populate('wardId', 'name wardName code')
      .populate('roomId', 'name roomNumber room_number')
      .populate('bedId', 'name bedNumber bed_number bedType')
      .sort({ startedAt: 1 })
      .lean()
  ]);

  if (!admission) {
    const error = new Error('Admission not found');
    error.statusCode = 404;
    throw error;
  }

  const activeSegment = segments.find((segment) => segment.status === 'active');
  const effectiveFrom = iso(activeSegment?.startedAt || admission.admissionDate);

  const currentLocation = {
    ...location(admission.wardId, admission.roomId, admission.bedId),
    effectiveFrom
  };

  const timeline = transfers.map((transfer) => ({
    transferNumber: transfer.transferNumber,
    source: transfer.source,
    status: transfer.status,
    from: location(
      transfer.from?.wardId,
      transfer.from?.roomId,
      transfer.from?.bedId
    ),
    to: location(
      transfer.to?.wardId,
      transfer.to?.roomId,
      transfer.to?.bedId
    ),
    requestedAt: iso(transfer.createdAt),
    completedAt: iso(transfer.actualEffectiveAt),
    reason: transfer.clinical?.reason,
    priority: transfer.clinical?.priority,
    patientCondition: transfer.clinical?.patientCondition,
    handoverNote: transfer.handover?.note,
    conditionOnArrival: transfer.handover?.conditionOnArrival,
    requestedBy: label(transfer.people?.requestedBy, ['name', 'first_name']),
    approvedBy: label(transfer.people?.approvedBy, ['name', 'first_name']),
    receivedBy: label(transfer.people?.receivedBy, ['name', 'first_name']),
    completedBy: label(transfer.people?.completedBy, ['name', 'first_name'])
  }));

  const staySegments = segments.map((segment) => ({
    location: location(segment.wardId, segment.roomId, segment.bedId),
    startedAt: iso(segment.startedAt),
    endedAt: iso(segment.endedAt),
    duration: duration(segment.startedAt, segment.endedAt),
    ...(financial ? {
      dailyRate: Number(segment.dailyRate || 0),
      pricingSnapshot: segment.pricingSnapshot || null
    } : {})
  }));

  return {
    currentLocation,
    transferTimeline: timeline,
    lengthOfStaySegments: staySegments
  };
}

// ============================================
// Constants
// ============================================

const ACTIVE_ADMISSION_STATUSES = [
  'Admitted',
  'Under Treatment',
  'Discharge Initiated',
  'Discharge Summary Pending',
  'Billing Pending',
  'Payment Pending',
  'Ready for Discharge'
];

// ============================================
// Name Helpers
// ============================================

function patientName(patient = {}) {
  return [
    patient.salutation,
    patient.first_name,
    patient.middle_name,
    patient.last_name
  ]
    .filter(Boolean)
    .join(' ')
    || patient.name
    || '—';
}

function doctorName(doctor = {}) {
  const name = [
    doctor.firstName || doctor.first_name,
    doctor.lastName || doctor.last_name
  ]
    .filter(Boolean)
    .join(' ')
    || doctor.name;

  return name ? `Dr. ${name}` : '—';
}

// ============================================
// Bed Occupancy Data
// ============================================

async function bedOccupancyData({ hospitalId, asOn = new Date() }) {
  const cutoff = new Date(asOn);

  if (Number.isNaN(cutoff.getTime())) {
    const error = new Error('Invalid bed occupancy report date');
    error.statusCode = 400;
    throw error;
  }

  // Include the whole selected day instead of treating YYYY-MM-DD as midnight.
  if (typeof asOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOn)) {
    cutoff.setHours(23, 59, 59, 999);
  }

  const admissions = await IPDAdmission.find({
    hospitalId,
    status: { $in: ACTIVE_ADMISSION_STATUSES },
    admissionDate: { $lte: cutoff }
  })
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid address city state')
    .populate('primaryDoctorId', 'firstName lastName first_name last_name name')
    .populate('wardId', 'name wardName type floor')
    .populate('roomId', 'roomNumber room_number name floor')
    .populate('bedId', 'bedNumber bed_number name bedType')
    .sort({ admissionDate: 1 })
    .lean();

  const rows = admissions.map((admission) => ({
    admissionId: admission._id,
    wardType: admission.bedId?.bedType || admission.wardId?.type || 'Other',
    ward: admission.wardId?.name || admission.wardId?.wardName || '—',
    bedNumber: admission.bedId?.bedNumber || admission.bedId?.bed_number || admission.bedId?.name || '—',
    floor: admission.wardId?.floor || admission.roomId?.floor || '—',
    uhid: admission.patientId?.uhid || admission.patientId?.patientId || '—',
    ipNumber: admission.admissionNumber || admission.shipNumber || '—',
    patientName: patientName(admission.patientId),
    doctor: doctorName(admission.primaryDoctorId),
    address: [
      admission.patientId?.address,
      admission.patientId?.city,
      admission.patientId?.state
    ]
      .filter(Boolean)
      .join(', '),
    admissionDate: admission.admissionDate
  }));

  rows.sort((left, right) =>
    `${left.wardType}|${left.ward}|${left.bedNumber}`
      .localeCompare(`${right.wardType}|${right.ward}|${right.bedNumber}`)
  );

  const grouped = rows.reduce((acc, row) => {
    (acc[row.wardType] ||= []).push(row);
    return acc;
  }, {});

  return {
    asOn: cutoff,
    generatedAt: new Date(),
    totalAdmittedPatients: rows.length,
    grouped,
    rows
  };
}

module.exports = {
  buildAccommodationPrintData,
  duration,
  location,
  bedOccupancyData,
  ACTIVE_ADMISSION_STATUSES
};