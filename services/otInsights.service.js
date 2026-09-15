const mongoose = require('mongoose');
const OTRequest = require('../models/OTRequest');
const OTSchedule = require('../models/OTSchedule');
const Room = require('../models/Room');
const DomainEvent = require('../models/DomainEvent');
const OTReadinessChecklist = require('../models/OTReadinessChecklist');
const OTSurgicalSafetyChecklist = require('../models/OTSurgicalSafetyChecklist');
const OTPreAnaesthesiaAssessment = require('../models/OTPreAnaesthesiaAssessment');
const OTAnesthesiaRecord = require('../models/OTAnesthesiaRecord');
const OTOperativeNote = require('../models/OTOperativeNote');
const OTRecoveryRecord = require('../models/OTRecoveryRecord');
const OTCaseInventoryUsage = require('../models/OTCaseInventoryUsage');
const OTSpecimen = require('../models/OTSpecimen');
const OTAdditionalProcedure = require('../models/OTAdditionalProcedure');
const { operationNow } = require('../utils/operationTimeContext');

const CANONICAL = ['Readiness Pending', 'Approved', 'Scheduled', 'Patient Received', 'In Progress', 'Recovery', 'Transferred', 'Closed', 'Postponed', 'Cancelled'];
const ROOM_TYPES = ['Operation Theater', 'Operation Theatre', 'OT'];

function canonicalStatusExpression() {
  return {
    $switch: {
      branches: [
        { case: { $in: ['$status', ['Requested', 'Payment Pending']] }, then: 'Readiness Pending' },
        {
          case: { $eq: ['$status', 'Payment Received'] },
          then: { $cond: [{ $in: ['$readinessStatus', ['Ready', 'Ready With Bypass']] }, 'Approved', 'Readiness Pending'] }
        },
        {
          case: { $eq: ['$status', 'Completed'] },
          then: {
            $cond: [
              { $or: [{ $ne: ['$closedAt', null] }, { $eq: ['$clinicalClosureStatus', 'Closed'] }] }, 'Closed',
              { $cond: [{ $or: [{ $ne: ['$transferredAt', null] }, { $eq: ['$transferred_to_ward', true] }] }, 'Transferred', 'Recovery'] }
            ]
          }
        }
      ],
      default: '$status'
    }
  };
}

function dayBounds(base = operationNow()) {
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function monthBounds(base = operationNow()) {
  return {
    start: new Date(base.getFullYear(), base.getMonth(), 1),
    end: new Date(base.getFullYear(), base.getMonth() + 1, 1),
  };
}

function rangeBounds(start, end) {
  const toDate = (value, fallback) => {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  };
  const now = operationNow();
  const fallbackEnd = new Date(now);
  fallbackEnd.setHours(23, 59, 59, 999);
  const fallbackStart = new Date(now);
  fallbackStart.setMonth(fallbackStart.getMonth() - 6);
  fallbackStart.setHours(0, 0, 0, 0);
  const from = toDate(start, fallbackStart);
  from.setHours(0, 0, 0, 0);
  const to = toDate(end, fallbackEnd);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

async function buildDashboard(hospitalId) {
  const hospitalObjectId = new mongoose.Types.ObjectId(hospitalId);
  const { start: todayStart, end: todayEnd } = dayBounds();
  const { start: monthStart, end: monthEnd } = monthBounds();
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);

  const [aggregate, todaySchedule, weeklySchedule, rooms, recent, financialActionCases] = await Promise.all([
    OTRequest.aggregate([
      { $match: { hospitalId: hospitalObjectId } },
      { $addFields: { canonicalStatus: canonicalStatusExpression(), completionDate: { $ifNull: ['$closedAt', '$completedAt'] } } },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$canonicalStatus', count: { $sum: 1 } } }],
          byUrgency: [{ $group: { _id: '$urgency', count: { $sum: 1 } } }],
          byFinancial: [{ $group: { _id: '$financialClearanceState', count: { $sum: 1 } } }],
          closedToday: [{ $match: { canonicalStatus: 'Closed', completionDate: { $gte: todayStart, $lt: todayEnd } } }, { $count: 'count' }],
          monthlyFinancial: [
            { $match: { canonicalStatus: 'Closed', completionDate: { $gte: monthStart, $lt: monthEnd } } },
            { $group: { _id: null, actualNet: { $sum: { $ifNull: ['$financialReconciliationSummary.actualNet', 0] } }, estimate: { $sum: { $ifNull: ['$financialReconciliationSummary.estimate', '$estimated_cost'] } }, patientLiability: { $sum: { $ifNull: ['$financialReconciliationSummary.patientLiability', 0] } }, sponsorLiability: { $sum: { $ifNull: ['$financialReconciliationSummary.sponsorLiability', 0] } } } }
          ],
          total: [{ $count: 'count' }]
        }
      }
    ]),
    OTRequest.find({ hospitalId, scheduledStart: { $gte: todayStart, $lt: todayEnd }, status: { $nin: ['Cancelled'] } })
      .populate('patientId', 'first_name last_name patientId uhid')
      .populate('primarySurgeonId', 'firstName lastName')
      .populate('otRoomId', 'room_number roomNumber status')
      .sort({ scheduledStart: 1 })
      .limit(20)
      .lean(),
    OTSchedule.aggregate([
      { $match: { hospitalId: hospitalObjectId, scheduledStart: { $gte: weekStart, $lt: todayEnd }, status: { $nin: ['Cancelled', 'Rescheduled'] } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$scheduledStart' } }, surgeries: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } } } },
      { $sort: { _id: 1 } }
    ]),
    Room.find({ hospitalId, type: { $in: ROOM_TYPES }, is_active: { $ne: false } }).select('status room_number roomNumber').lean(),
    OTRequest.find({ hospitalId })
      .populate('patientId', 'first_name last_name patientId uhid')
      .populate('doctorId primarySurgeonId', 'firstName lastName')
      .populate('otRoomId', 'room_number roomNumber status')
      .sort({ requestedDate: -1 })
      .limit(10)
      .lean(),
    OTRequest.find({ hospitalId, financialClearanceState: { $in: ['PAYMENT_REQUIRED', 'AUTHORIZATION_REQUIRED', 'TPA_PENDING', 'HOLD'] }, status: { $nin: ['Closed', 'Cancelled'] } })
      .populate('patientId', 'first_name last_name patientId uhid')
      .sort({ requestedDate: -1 })
      .limit(10)
      .lean()
  ]);

  const facet = aggregate[0] || {};
  const statusCounts = Object.fromEntries((facet.byStatus || []).map((row) => [row._id, row.count]));
  const urgencyCounts = Object.fromEntries((facet.byUrgency || []).map((row) => [row._id || 'Unknown', row.count]));
  const financialCounts = Object.fromEntries((facet.byFinancial || []).map((row) => [row._id || 'NOT_ASSESSED', row.count]));
  const roomCounts = rooms.reduce((acc, room) => {
    const key = room.status || 'Unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const monthly = facet.monthlyFinancial?.[0] || {};

  const weeklyMap = new Map(weeklySchedule.map((row) => [row._id, row]));
  const weekly = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date(todayStart);
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    const row = weeklyMap.get(key) || {};
    weekly.push({ date: key, day: date.toLocaleDateString('en-US', { weekday: 'short' }), surgeries: row.surgeries || 0, completed: row.completed || 0 });
  }

  return {
    generatedAt: operationNow(),
    stats: {
      totalRequests: facet.total?.[0]?.count || 0,
      awaitingReadiness: statusCounts['Readiness Pending'] || 0,
      approvedUnscheduled: statusCounts.Approved || 0,
      todayScheduled: todaySchedule.filter((row) => ['Scheduled', 'Patient Received'].includes(row.status)).length,
      patientReceived: statusCounts['Patient Received'] || 0,
      inProgress: statusCounts['In Progress'] || 0,
      recovery: statusCounts.Recovery || 0,
      transferred: statusCounts.Transferred || 0,
      closedToday: facet.closedToday?.[0]?.count || 0,
      postponed: statusCounts.Postponed || 0,
      cancelled: statusCounts.Cancelled || 0,
      financialHold: (financialCounts.HOLD || 0) + (financialCounts.PAYMENT_REQUIRED || 0) + (financialCounts.AUTHORIZATION_REQUIRED || 0),
      emergency: urgencyCounts.Emergency || 0,
      urgent: urgencyCounts.Urgent || 0,
      elective: urgencyCounts.Elective || 0,
      availableRooms: roomCounts.Available || 0,
      totalRooms: rooms.length,
      monthlyActualRevenue: Number(monthly.actualNet || 0),
      monthlyEstimate: Number(monthly.estimate || 0),
      monthlyPatientLiability: Number(monthly.patientLiability || 0),
      monthlySponsorLiability: Number(monthly.sponsorLiability || 0),
    },
    statusCounts,
    financialCounts,
    roomUtilization: roomCounts,
    weekly,
    todaySchedule,
    recentCases: recent,
    financialActionCases,
  };
}

async function buildReports(hospitalId, { start, end } = {}) {
  const hospitalObjectId = new mongoose.Types.ObjectId(hospitalId);
  const { from, to } = rangeBounds(start, end);
  const base = [
    { $match: { hospitalId: hospitalObjectId } },
    { $addFields: { canonicalStatus: canonicalStatusExpression(), completionDate: { $ifNull: ['$closedAt', '$completedAt'] }, actualRevenue: { $ifNull: ['$financialReconciliationSummary.actualNet', '$total_cost'] } } },
    { $match: { canonicalStatus: 'Closed', completionDate: { $gte: from, $lte: to } } }
  ];

  const [monthly, procedures, surgeons, financial, cancellations] = await Promise.all([
    OTRequest.aggregate([...base,
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$completionDate' } }, surgeries: { $sum: 1 }, revenue: { $sum: '$actualRevenue' } } },
      { $project: { _id: 0, month: '$_id', surgeries: 1, revenue: 1 } },
      { $sort: { month: 1 } }
    ]),
    OTRequest.aggregate([...base,
      { $group: { _id: { id: '$procedureId', name: '$procedureName', code: '$procedureCode' }, count: { $sum: 1 }, revenue: { $sum: '$actualRevenue' } } },
      { $project: { _id: 0, procedureId: '$_id.id', name: '$_id.name', code: '$_id.code', count: 1, revenue: 1 } },
      { $sort: { count: -1 } }
    ]),
    OTRequest.aggregate([...base,
      { $lookup: { from: 'doctors', localField: 'primarySurgeonId', foreignField: '_id', as: 'surgeon' } },
      { $unwind: { path: '$surgeon', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$primarySurgeonId', name: { $first: { $trim: { input: { $concat: [{ $ifNull: ['$surgeon.firstName', ''] }, ' ', { $ifNull: ['$surgeon.lastName', ''] }] } } } }, count: { $sum: 1 }, revenue: { $sum: '$actualRevenue' } } },
      { $project: { _id: 0, surgeonId: '$_id', name: 1, count: 1, revenue: 1 } },
      { $sort: { count: -1 } }
    ]),
    OTRequest.aggregate([...base,
      { $group: { _id: null, surgeries: { $sum: 1 }, estimated: { $sum: { $ifNull: ['$financialReconciliationSummary.estimate', '$estimated_cost'] } }, actual: { $sum: '$actualRevenue' }, patientLiability: { $sum: { $ifNull: ['$financialReconciliationSummary.patientLiability', 0] } }, sponsorLiability: { $sum: { $ifNull: ['$financialReconciliationSummary.sponsorLiability', 0] } }, packageAbsorbed: { $sum: { $ifNull: ['$financialReconciliationSummary.packageAbsorbed', 0] } } } }
    ]),
    OTRequest.aggregate([
      { $match: { hospitalId: hospitalObjectId, status: { $in: ['Cancelled', 'Postponed'] }, updatedAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ])
  ]);

  return {
    range: { start: from, end: to },
    monthly,
    procedures,
    surgeons,
    financial: financial[0] || { surgeries: 0, estimated: 0, actual: 0, patientLiability: 0, sponsorLiability: 0, packageAbsorbed: 0 },
    cancellations: Object.fromEntries(cancellations.map((row) => [row._id, row.count])),
  };
}

async function buildAuditTimeline(otCase) {
  const filter = { hospitalId: otCase.hospitalId, caseId: otCase._id };
  const children = await Promise.all([
    OTReadinessChecklist.findOne(filter).select('_id').lean(),
    OTSurgicalSafetyChecklist.findOne(filter).select('_id').lean(),
    OTPreAnaesthesiaAssessment.findOne(filter).select('_id').lean(),
    OTAnesthesiaRecord.findOne(filter).select('_id').lean(),
    OTOperativeNote.findOne(filter).select('_id').lean(),
    OTRecoveryRecord.findOne(filter).select('_id').lean(),
    OTCaseInventoryUsage.findOne(filter).select('_id').lean(),
    OTSchedule.findOne({ hospitalId: otCase.hospitalId, requestId: otCase._id }).select('_id').lean(),
    OTSpecimen.find(filter).select('_id').lean(),
    OTAdditionalProcedure.find(filter).select('_id').lean(),
  ]);
  const ids = [otCase._id];
  children.flatMap((row) => Array.isArray(row) ? row : row ? [row] : []).forEach((row) => ids.push(row._id));
  return DomainEvent.find({ hospitalId: otCase.hospitalId, entityId: { $in: ids }, eventType: /^ot\./ })
    .populate('actorUserId', 'name firstName lastName email role')
    .sort({ occurredAt: -1 })
    .limit(250)
    .lean();
}

module.exports = { CANONICAL, canonicalStatusExpression, buildDashboard, buildReports, buildAuditTimeline, rangeBounds };
