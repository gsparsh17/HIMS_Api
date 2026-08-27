'use strict';

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Vital = require('../models/Vital');
const Staff = require('../models/Staff');
const Hospital = require('../models/Hospital');
const Bill = require('../models/Bill');
const { hospitalDateKey, hospitalDayBounds, DEFAULT_HOSPITAL_TIME_ZONE } = require('../utils/hospitalDateTime');

const ACTIVE_ADMISSION_STATUSES = [
  'Admitted', 'Under Treatment', 'Discharge Initiated', 'Discharge Summary Pending',
  'Billing Pending', 'Payment Pending', 'Ready for Discharge'
];
const ACTIVE_APPOINTMENT_STATUSES = ['Scheduled', 'In Progress'];

function asObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.isValidObjectId(value)) {
    const error = new Error('Invalid identifier');
    error.statusCode = 400;
    throw error;
  }
  return new mongoose.Types.ObjectId(String(value));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safePage(value, fallback = 1) {
  return Math.max(1, Number.parseInt(value, 10) || fallback);
}

function safeLimit(value, fallback = 50, max = 200) {
  return Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
}

function patientBaseMatch({ hospitalId, search, sponsorType, outstanding }) {
  const match = { hospitalId: asObjectId(hospitalId), is_active: { $ne: false } };
  const and = [];
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    and.push({
      $or: [
        { first_name: regex }, { last_name: regex }, { phone: regex }, { email: regex },
        { patientId: regex }, { uhid: regex }, { 'abha.number': regex }, { 'abha.address': regex }
      ]
    });
  }
  if (sponsorType && sponsorType !== 'all') match.sponsor_type = sponsorType;
  if (outstanding === 'hasOutstanding') match.pharmacy_outstanding_balance = { $gt: 0 };
  if (outstanding === 'noOutstanding') {
    and.push({ $expr: { $lte: [{ $ifNull: ['$pharmacy_outstanding_balance', 0] }, 0] } });
  }
  if (and.length) match.$and = and;
  return match;
}

function patientCareLookupStages(hospitalObjectId) {
  return [
    {
      $lookup: {
        from: Appointment.collection.name,
        let: { patientId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$patient_id', '$$patientId'] },
                  { $eq: ['$hospital_id', hospitalObjectId] },
                  { $ne: ['$is_active', false] },
                  { $ne: ['$status', 'Cancelled'] }
                ]
              }
            }
          },
          { $sort: { appointment_date: -1, start_time: -1, created_at: -1, createdAt: -1 } },
          {
            $facet: {
              latest: [{ $limit: 1 }, { $project: { _id: 1, status: 1, appointment_date: 1, start_time: 1, created_at: 1, createdAt: 1, doctor_id: 1, department_id: 1 } }],
              active: [{ $match: { status: { $in: ACTIVE_APPOINTMENT_STATUSES } } }, { $limit: 1 }, { $project: { _id: 1 } }],
              count: [{ $count: 'value' }]
            }
          }
        ],
        as: '_appointmentSummary'
      }
    },
    {
      $lookup: {
        from: IPDAdmission.collection.name,
        let: { patientId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$patientId', '$$patientId'] },
                  { $eq: ['$hospitalId', hospitalObjectId] },
                  { $ne: ['$is_active', false] }
                ]
              }
            }
          },
          { $sort: { admissionDate: -1, createdAt: -1, updatedAt: -1 } },
          {
            $facet: {
              latest: [{ $limit: 1 }, { $project: { _id: 1, status: 1, admissionDate: 1, createdAt: 1, updatedAt: 1, primaryDoctorId: 1, departmentId: 1 } }],
              active: [{ $match: { status: { $in: ACTIVE_ADMISSION_STATUSES } } }, { $limit: 1 }, { $project: { _id: 1, status: 1, admissionDate: 1, createdAt: 1, updatedAt: 1, primaryDoctorId: 1, departmentId: 1 } }],
              count: [{ $count: 'value' }]
            }
          }
        ],
        as: '_admissionSummary'
      }
    },
    {
      $set: {
        _appointmentSummary: { $ifNull: [{ $arrayElemAt: ['$_appointmentSummary', 0] }, { latest: [], active: [], count: [] }] },
        _admissionSummary: { $ifNull: [{ $arrayElemAt: ['$_admissionSummary', 0] }, { latest: [], active: [], count: [] }] }
      }
    },
    {
      $set: {
        _latestAppointment: { $arrayElemAt: ['$_appointmentSummary.latest', 0] },
        _selectedAdmission: {
          $ifNull: [
            { $arrayElemAt: ['$_admissionSummary.active', 0] },
            { $arrayElemAt: ['$_admissionSummary.latest', 0] }
          ]
        },
        totalAppointments: { $ifNull: [{ $arrayElemAt: ['$_appointmentSummary.count.value', 0] }, 0] },
        _admissionCount: { $ifNull: [{ $arrayElemAt: ['$_admissionSummary.count.value', 0] }, 0] },
        hasActiveAppointment: { $gt: [{ $size: '$_appointmentSummary.active' }, 0] },
        hasActiveAdmission: { $gt: [{ $size: '$_admissionSummary.active' }, 0] }
      }
    },
    {
      $set: {
        hasOpd: { $gt: ['$totalAppointments', 0] },
        hasIpd: { $gt: ['$_admissionCount', 0] },
        latestCareDate: {
          $max: [
            '$_latestAppointment.appointment_date',
            '$_selectedAdmission.admissionDate',
            { $ifNull: ['$lastVisitDate', '$registered_at'] }
          ]
        }
      }
    },
    {
      $set: {
        careType: {
          $switch: {
            branches: [
              { case: { $and: ['$hasOpd', '$hasIpd'] }, then: 'OPD / IPD' },
              { case: '$hasOpd', then: 'OPD' },
              { case: '$hasIpd', then: 'IPD' }
            ],
            default: 'UNASSIGNED'
          }
        }
      }
    }
  ];
}

function patientRowEnrichmentStages() {
  return [
    {
      $lookup: {
        from: Doctor.collection.name,
        localField: '_latestAppointment.doctor_id',
        foreignField: '_id',
        pipeline: [{ $project: { firstName: 1, lastName: 1 } }],
        as: '_latestAppointmentDoctor'
      }
    },
    {
      $lookup: {
        from: Department.collection.name,
        localField: '_latestAppointment.department_id',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1 } }],
        as: '_latestAppointmentDepartment'
      }
    },
    {
      $lookup: {
        from: Doctor.collection.name,
        localField: '_selectedAdmission.primaryDoctorId',
        foreignField: '_id',
        pipeline: [{ $project: { firstName: 1, lastName: 1 } }],
        as: '_admissionDoctor'
      }
    },
    {
      $lookup: {
        from: Department.collection.name,
        localField: '_selectedAdmission.departmentId',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1 } }],
        as: '_admissionDepartment'
      }
    },
    {
      $set: {
        _latestAppointmentDoctor: { $arrayElemAt: ['$_latestAppointmentDoctor', 0] },
        _latestAppointmentDepartment: { $arrayElemAt: ['$_latestAppointmentDepartment', 0] },
        _admissionDoctor: { $arrayElemAt: ['$_admissionDoctor', 0] },
        _admissionDepartment: { $arrayElemAt: ['$_admissionDepartment', 0] }
      }
    }
  ];
}

const PATIENT_WORKLIST_PROJECTION = {
  _id: 1, patientId: 1, uhid: 1, salutation: 1, first_name: 1, last_name: 1,
  email: 1, phone: 1, gender: 1, dob: 1, blood_group: 1, patient_image: 1,
  aadhaar_number: 1, address: 1, registered_at: 1, sponsor_type: 1, sponsor_name: 1,
  pharmacy_outstanding_balance: 1, pharmacy_advance_balance: 1, is_walkin: 1,
  abha: 1, lastVisitedDepartment: 1, lastVisitedDoctor: 1, totalCollection: 1,
  hasOpd: 1, hasIpd: 1, hasActiveAppointment: 1, hasActiveAdmission: 1,
  careType: 1, latestCareDate: 1, totalAppointments: 1,
  latestAppointment: {
    _id: '$_latestAppointment._id', status: '$_latestAppointment.status', appointment_date: '$_latestAppointment.appointment_date',
    start_time: '$_latestAppointment.start_time', doctor_id: '$_latestAppointmentDoctor', department_id: '$_latestAppointmentDepartment'
  },
  selectedAdmission: {
    _id: '$_selectedAdmission._id', status: '$_selectedAdmission.status', admissionDate: '$_selectedAdmission.admissionDate',
    primaryDoctorId: '$_admissionDoctor', departmentId: '$_admissionDepartment'
  }
};

async function buildPatientWorklistFilteredPipeline({ hospitalId, query = {} }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const page = safePage(query.page);
  const limit = safeLimit(query.limit || query.pageSize, 50, 200);
  const baseMatch = patientBaseMatch({
    hospitalId,
    search: String(query.search || '').trim(),
    sponsorType: query.sponsorType || query.sponsor_type,
    outstanding: query.outstanding
  });
  const pipeline = [{ $match: baseMatch }, ...patientCareLookupStages(hospitalObjectId)];

  if (query.careType === 'opd') pipeline.push({ $match: { hasOpd: true } });
  if (query.careType === 'ipd') pipeline.push({ $match: { hasIpd: true } });

  if (query.from || query.to) {
    const hospital = await Hospital.findById(hospitalObjectId).select('timezone').lean();
    const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const dateMatch = {};
    try {
      if (query.from) dateMatch.$gte = hospitalDayBounds(query.from, timeZone).start;
      if (query.to) dateMatch.$lt = hospitalDayBounds(query.to, timeZone).end;
    } catch (error) {
      error.statusCode = 400;
      error.message = 'Invalid patient worklist date range';
      throw error;
    }
    pipeline.push({ $match: { latestCareDate: dateMatch } });
  }
  return { pipeline, page, limit };
}

async function patientWorklistMeta({ hospitalId }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const patientMatch = { hospitalId: hospitalObjectId, is_active: { $ne: false } };
  const [all, balancesRows, opdRows, ipdRows] = await Promise.all([
    Patient.countDocuments(patientMatch),
    Patient.aggregate([
      { $match: patientMatch },
      { $group: { _id: null, outstanding: { $sum: { $ifNull: ['$pharmacy_outstanding_balance', 0] } }, advance: { $sum: { $ifNull: ['$pharmacy_advance_balance', 0] } } } }
    ]),
    Appointment.aggregate([
      { $match: { hospital_id: hospitalObjectId, is_active: { $ne: false }, status: { $ne: 'Cancelled' } } },
      { $group: { _id: '$patient_id' } },
      { $lookup: { from: Patient.collection.name, localField: '_id', foreignField: '_id', pipeline: [{ $match: patientMatch }, { $project: { _id: 1 } }], as: '_patient' } },
      { $match: { '_patient.0': { $exists: true } } },
      { $count: 'value' }
    ]),
    IPDAdmission.aggregate([
      { $match: { hospitalId: hospitalObjectId, is_active: { $ne: false } } },
      { $group: { _id: '$patientId' } },
      { $lookup: { from: Patient.collection.name, localField: '_id', foreignField: '_id', pipeline: [{ $match: patientMatch }, { $project: { _id: 1 } }], as: '_patient' } },
      { $match: { '_patient.0': { $exists: true } } },
      { $count: 'value' }
    ])
  ]);
  return {
    careCounts: { all, opd: opdRows?.[0]?.value || 0, ipd: ipdRows?.[0]?.value || 0 },
    balances: balancesRows?.[0] || { outstanding: 0, advance: 0 }
  };
}

async function listPatientWorklist({ hospitalId, query = {} }) {
  const { pipeline, page, limit } = await buildPatientWorklistFilteredPipeline({ hospitalId, query });
  const includeMeta = String(query.includeMeta ?? 'true').toLowerCase() !== 'false';
  const [result = {}, meta] = await Promise.all([
    Patient.aggregate([
      ...pipeline,
      {
        $facet: {
          rows: [
            { $sort: { latestCareDate: -1, registered_at: -1, _id: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            ...patientRowEnrichmentStages(),
            { $project: PATIENT_WORKLIST_PROJECTION }
          ],
          total: [{ $count: 'value' }]
        }
      }
    ]).allowDiskUse(true),
    includeMeta ? patientWorklistMeta({ hospitalId }) : Promise.resolve(null)
  ]);
  const total = result.total?.[0]?.value || 0;
  return {
    rows: result.rows || [],
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    ...(meta || {})
  };
}

async function patientWorklistCursor({ hospitalId, query = {} }) {
  const { pipeline } = await buildPatientWorklistFilteredPipeline({ hospitalId, query });
  return Patient.aggregate([
    ...pipeline,
    { $sort: { latestCareDate: -1, registered_at: -1, _id: -1 } },
    ...patientRowEnrichmentStages(),
    { $project: PATIENT_WORKLIST_PROJECTION }
  ]).allowDiskUse(true).cursor({ batchSize: 200 }).exec();
}

async function getPatientVisitHistory({ hospitalId, patientId, query = {} }) {
  const patientObjectId = asObjectId(patientId);
  const hospitalObjectId = asObjectId(hospitalId);
  const page = safePage(query.page);
  const limit = safeLimit(query.limit, 20, 100);
  const filter = {
    hospital_id: hospitalObjectId,
    patient_id: patientObjectId,
    is_active: { $ne: false },
    status: { $ne: 'Cancelled' }
  };
  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .select('_id patient_id doctor_id department_id hospital_id appointment_date appointment_date_key start_time end_time serial_number type appointment_type priority notes status cancellationReason referral token created_at createdAt updatedAt')
      .populate('patient_id', 'first_name last_name patientId uhid patient_image phone gender dob')
      .populate('doctor_id', 'firstName lastName specialization doctorId')
      .populate('department_id', 'name')
      .populate('referral.referringDoctorId', 'firstName lastName specialization department doctorId')
      .populate('referral.referredDoctorId', 'firstName lastName specialization department doctorId')
      .populate('referral.departmentId', 'name')
      .sort({ appointment_date: -1, start_time: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Appointment.countDocuments(filter)
  ]);
  return { appointments, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

async function appointmentWorklist({ hospitalId, query = {} }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const upcomingPage = safePage(query.upcomingPage || query.page);
  const historyPage = safePage(query.historyPage || query.page);
  const limit = safeLimit(query.limit, 40, 100);
  const hospital = await Hospital.findById(hospitalObjectId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalDateKey(new Date(), timeZone);
  const now = new Date();
  const effectiveDateKeyExpr = {
    $ifNull: [
      '$appointment_date_key',
      {
        $dateToString: {
          format: '%Y-%m-%d',
          date: { $ifNull: ['$appointment_date', '$start_time'] },
          timezone: timeZone,
          onNull: null
        }
      }
    ]
  };

  const baseMatch = { hospital_id: hospitalObjectId, is_active: { $ne: false } };
  if (query.status && query.status !== 'all') {
    baseMatch.status = query.status;
  } else if (query.statuses) {
    const statuses = String(query.statuses).split(',').map((value) => value.trim()).filter(Boolean).slice(0, 20);
    if (statuses.length) baseMatch.status = { $in: statuses };
  }
  if (query.visit_mode) baseMatch.visit_mode = query.visit_mode;
  if (query.from || query.to) {
    const keyRange = {};
    if (query.from) keyRange.$gte = hospitalDateKey(query.from, timeZone);
    if (query.to) keyRange.$lte = hospitalDateKey(query.to, timeZone);
    const instantRange = {};
    if (query.from) instantRange.$gte = hospitalDayBounds(query.from, timeZone).start;
    if (query.to) instantRange.$lt = hospitalDayBounds(query.to, timeZone).end;
    baseMatch.$or = [{ appointment_date_key: keyRange }, { appointment_date: instantRange }];
  }

  const pipeline = [{ $match: baseMatch }];
  const hasCrossEntitySearch = Boolean(String(query.search || '').trim());

  // Normal worklist loads are by far the common path. Do not join patient,
  // doctor and department for every matching appointment before pagination;
  // paginate the Appointment collection first and bulk-populate only visible rows.
  // Cross-entity search intentionally keeps the joins because patient/doctor/
  // department names are part of the established screen search contract.
  if (hasCrossEntitySearch) {
    pipeline.push(
      {
        $lookup: {
          from: Patient.collection.name,
          localField: 'patient_id',
          foreignField: '_id',
          pipeline: [{ $project: { first_name: 1, last_name: 1, patientId: 1, uhid: 1, patient_image: 1, phone: 1, gender: 1, dob: 1 } }],
          as: 'patient_id'
        }
      },
      { $set: { patient_id: { $arrayElemAt: ['$patient_id', 0] } } },
      {
        $lookup: {
          from: Doctor.collection.name,
          localField: 'doctor_id',
          foreignField: '_id',
          pipeline: [{ $project: { firstName: 1, lastName: 1, specialization: 1, doctorId: 1 } }],
          as: 'doctor_id'
        }
      },
      { $set: { doctor_id: { $arrayElemAt: ['$doctor_id', 0] } } },
      {
        $lookup: {
          from: Department.collection.name,
          localField: 'department_id',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1 } }],
          as: 'department_id'
        }
      },
      { $set: { department_id: { $arrayElemAt: ['$department_id', 0] } } }
    );

    const regex = new RegExp(escapeRegex(query.search), 'i');
    pipeline.push({
      $match: {
        $or: [
          { 'patient_id.first_name': regex }, { 'patient_id.last_name': regex }, { 'patient_id.patientId': regex }, { 'patient_id.uhid': regex },
          { 'doctor_id.firstName': regex }, { 'doctor_id.lastName': regex }, { 'department_id.name': regex }
        ]
      }
    });
  }

  pipeline.push({ $set: { _effectiveAppointmentDateKey: effectiveDateKeyExpr } });

  const upcomingExpr = query.splitMode === 'date'
    ? {
        $and: [
          { $not: [{ $in: ['$status', ['Completed', 'Cancelled']] }] },
          { $gte: ['$_effectiveAppointmentDateKey', todayKey] }
        ]
      }
    : {
        $and: [
          { $not: [{ $in: ['$status', ['Completed', 'Cancelled']] }] },
          {
            $or: [
              { $gt: ['$start_time', now] },
              { $and: [{ $eq: [{ $ifNull: ['$start_time', null] }, null] }, { $gte: ['$_effectiveAppointmentDateKey', todayKey] }] }
            ]
          }
        ]
      };

  const rowProject = {
    _id: 1, patient_id: 1, doctor_id: 1, department_id: 1, appointment_date: 1, appointment_date_key: 1,
    start_time: 1, end_time: 1, serial_number: 1, type: 1, appointment_type: 1, priority: 1,
    notes: 1, status: 1, cancellationReason: 1, referral: 1, token: 1, queuePosition: 1,
    created_at: 1, createdAt: 1, updatedAt: 1
  };

  pipeline.push({
    $facet: {
      upcoming: [
        { $match: { $expr: upcomingExpr } },
        { $sort: { _effectiveAppointmentDateKey: 1, start_time: 1, serial_number: 1 } },
        { $skip: (upcomingPage - 1) * limit }, { $limit: limit }, { $project: rowProject }
      ],
      history: [
        { $match: { $expr: { $not: [upcomingExpr] } } },
        { $sort: { _effectiveAppointmentDateKey: -1, start_time: -1, serial_number: -1 } },
        { $skip: (historyPage - 1) * limit }, { $limit: limit }, { $project: rowProject }
      ],
      counts: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            today: { $sum: { $cond: [{ $eq: ['$_effectiveAppointmentDateKey', todayKey] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'Scheduled'] }, 1, 0] } },
            upcoming: { $sum: { $cond: [upcomingExpr, 1, 0] } },
            completed: { $sum: { $cond: [{ $not: [upcomingExpr] }, 1, 0] } }
          }
        }
      ]
    }
  });

  // These cards are hospital-wide and independent from the active screen filters.
  // Use small count queries so MongoDB can satisfy them from matching indexes instead
  // of grouping every appointment document for each worklist refresh.
  const globalBase = { hospital_id: hospitalObjectId, is_active: { $ne: false } };
  const [[result = {}], globalTotal, globalToday, globalPending] = await Promise.all([
    Appointment.aggregate(pipeline).allowDiskUse(true),
    Appointment.countDocuments(globalBase),
    Appointment.countDocuments({
      ...globalBase,
      $or: [
        { appointment_date_key: todayKey },
        { appointment_date_key: { $exists: false }, appointment_date: { $gte: hospitalDayBounds(todayKey, timeZone).start, $lt: hospitalDayBounds(todayKey, timeZone).end } },
        { appointment_date_key: null, appointment_date: { $gte: hospitalDayBounds(todayKey, timeZone).start, $lt: hospitalDayBounds(todayKey, timeZone).end } }
      ]
    }),
    Appointment.countDocuments({ ...globalBase, status: 'Scheduled' })
  ]);

  const upcomingRows = result.upcoming || [];
  const historyRows = result.history || [];
  const rows = [...upcomingRows, ...historyRows];
  const ids = rows.map((row) => row._id);

  const populatePaths = [
    ...(!hasCrossEntitySearch ? [
      { path: 'patient_id', select: 'first_name last_name patientId uhid patient_image phone gender dob' },
      { path: 'doctor_id', select: 'firstName lastName specialization doctorId' },
      { path: 'department_id', select: 'name' }
    ] : []),
    { path: 'referral.referringDoctorId', select: 'firstName lastName specialization department doctorId' },
    { path: 'referral.referredDoctorId', select: 'firstName lastName specialization department doctorId' },
    { path: 'referral.departmentId', select: 'name' }
  ];

  const [populatedRows, vitals] = await Promise.all([
    rows.length ? Appointment.populate(rows, populatePaths) : Promise.resolve([]),
    ids.length ? Vital.find({ appointment_id: { $in: ids } })
      .select('_id appointment_id bp weight pulse spo2 temperature respiratory_rate random_blood_sugar height createdAt updatedAt')
      .lean() : []
  ]);
  const vitalMap = new Map(vitals.map((vital) => [String(vital.appointment_id), vital]));
  const rowMap = new Map(populatedRows.map((row) => [String(row._id), { ...row, vitals: vitalMap.get(String(row._id)) || null }]));
  const attachRows = (source) => source.map((row) => rowMap.get(String(row._id)) || { ...row, vitals: vitalMap.get(String(row._id)) || null });

  const filteredCounts = result.counts?.[0] || { total: 0, today: 0, pending: 0, upcoming: 0, completed: 0 };
  const counts = {
    total: globalTotal || 0,
    today: globalToday || 0,
    pending: globalPending || 0,
    upcoming: filteredCounts.upcoming || 0,
    completed: filteredCounts.completed || 0
  };

  return {
    upcoming: attachRows(upcomingRows),
    history: attachRows(historyRows),
    stats: counts,
    pagination: {
      upcoming: { page: upcomingPage, limit, total: counts.upcoming, totalPages: Math.max(1, Math.ceil(counts.upcoming / limit)) },
      history: { page: historyPage, limit, total: counts.completed, totalPages: Math.max(1, Math.ceil(counts.completed / limit)) }
    }
  };
}

async function doctorDashboard({ hospitalId, doctorId, query = {} }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const doctorObjectId = asObjectId(doctorId);
  const hospital = await Hospital.findById(hospitalObjectId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalDateKey(new Date(), timeZone);
  const calendarFrom = query.from || `${todayKey.slice(0, 7)}-01`;
  const calendarTo = query.to || todayKey;
  const fromKey = hospitalDateKey(calendarFrom, timeZone);
  const toKey = hospitalDateKey(calendarTo, timeZone);

  const base = { hospital_id: hospitalObjectId, doctor_id: doctorObjectId, is_active: { $ne: false } };
  const [doctor, summaryRows, todayRows, calendarRows] = await Promise.all([
    Doctor.findOne({ _id: doctorObjectId, hospitalId: hospitalObjectId, is_active: { $ne: false } })
      .select('_id firstName lastName specialization department doctorId').lean(),
    Appointment.aggregate([
      { $match: base },
      {
        $group: {
          _id: null,
          consultations: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
          procedures: { $sum: { $cond: [{ $eq: ['$type', 'Procedure'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
          scheduled: { $sum: { $cond: [{ $eq: ['$status', 'Scheduled'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'Cancelled'] }, 1, 0] } },
          patientIds: { $addToSet: '$patient_id' }
        }
      },
      { $project: { _id: 0, consultations: 1, procedures: 1, completed: 1, scheduled: 1, cancelled: 1, patients: { $size: '$patientIds' } } }
    ]),
    Appointment.find({ ...base, appointment_date_key: todayKey, status: { $ne: 'Cancelled' } })
      .select('_id patient_id doctor_id department_id appointment_date appointment_date_key start_time end_time serial_number type appointment_type status priority')
      .populate('patient_id', 'first_name last_name phone gender dob patient_image patientImage department')
      .populate('doctor_id', 'firstName lastName')
      .populate('department_id', 'name')
      .sort({ start_time: 1, serial_number: 1 }).lean(),
    Appointment.find({ ...base, appointment_date_key: { $gte: fromKey, $lte: toKey }, status: { $ne: 'Cancelled' } })
      .select('_id patient_id appointment_date appointment_date_key start_time end_time type appointment_type status')
      .populate('patient_id', 'first_name last_name patientId')
      .sort({ appointment_date_key: 1, start_time: 1 }).lean()
  ]);

  const todayIds = todayRows.map((row) => row._id);
  const vitals = todayIds.length ? await Vital.find({ appointment_id: { $in: todayIds } }).lean() : [];
  const vitalMap = new Map(vitals.map((row) => [String(row.appointment_id), row]));
  const todayAppointments = todayRows.map((row) => ({ ...row, vitals: vitalMap.get(String(row._id)) || null }));
  const summary = summaryRows[0] || { patients: 0, consultations: 0, procedures: 0, completed: 0, scheduled: 0, cancelled: 0 };
  return {
    doctor,
    stats: { patients: summary.patients, consultations: summary.consultations, procedures: summary.procedures, todayAppointments: todayAppointments.length },
    statusDistribution: { completed: summary.completed, scheduled: summary.scheduled, cancelled: summary.cancelled },
    // The legacy dashboard grouped populated Patient.department, which is not a Patient schema field;
    // all unique patients therefore rendered in the General bucket. Preserve that chart contract.
    patientDemographics: summary.patients ? [{ name: 'General', count: summary.patients }] : [],
    todayAppointments,
    calendarAppointments: calendarRows
  };
}

async function doctorScheduleReadModel({ hospitalId, doctorId, query = {} }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const doctorObjectId = asObjectId(doctorId);
  const hospital = await Hospital.findById(hospitalObjectId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalDateKey(new Date(), timeZone);
  const fromKey = hospitalDateKey(query.from || todayKey, timeZone);
  const toKey = hospitalDateKey(query.to || todayKey, timeZone);
  const now = new Date();
  const fromInstant = hospitalDayBounds(fromKey, timeZone).start;
  const toInstant = hospitalDayBounds(toKey, timeZone).end;
  const todayStart = hospitalDayBounds(todayKey, timeZone).start;
  const base = { hospital_id: hospitalObjectId, doctor_id: doctorObjectId, is_active: { $ne: false } };
  const upcomingMatch = {
    ...base,
    status: { $nin: ['Completed', 'Cancelled'] },
    $or: [
      { start_time: { $gt: now } },
      { start_time: { $exists: false }, appointment_date_key: { $gt: todayKey } },
      { start_time: { $exists: false }, appointment_date_key: { $exists: false }, appointment_date: { $gte: todayStart } },
      { start_time: null, appointment_date_key: { $gt: todayKey } },
      { start_time: null, appointment_date_key: null, appointment_date: { $gte: todayStart } }
    ]
  };
  const calendarMatch = {
    ...base,
    status: { $ne: 'Cancelled' },
    $or: [
      { appointment_date_key: { $gte: fromKey, $lte: toKey } },
      { appointment_date_key: { $exists: false }, appointment_date: { $gte: fromInstant, $lt: toInstant } },
      { appointment_date_key: null, appointment_date: { $gte: fromInstant, $lt: toInstant } }
    ]
  };

  const [calendarAppointments, upcomingAppointments, upcomingTotal] = await Promise.all([
    Appointment.find(calendarMatch)
      .select('_id patient_id appointment_date appointment_date_key start_time end_time duration time_slot type appointment_type status')
      .populate('patient_id', 'first_name last_name patientId')
      .sort({ appointment_date_key: 1, start_time: 1 }).lean(),
    Appointment.find(upcomingMatch)
      .select('_id patient_id appointment_date appointment_date_key start_time end_time duration time_slot type appointment_type status')
      .populate('patient_id', 'first_name last_name patientId')
      .sort({ appointment_date_key: 1, start_time: 1 })
      .limit(safeLimit(query.upcomingLimit, 20, 50)).lean(),
    Appointment.countDocuments(upcomingMatch)
  ]);

  return { calendarAppointments, upcomingAppointments, upcomingTotal };
}

async function nurseDashboard({ hospitalId }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const hospital = await Hospital.findById(hospitalObjectId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalDateKey(new Date(), timeZone);
  const relevantStatuses = ['Scheduled', 'Confirmed', 'In Progress', 'Checked In'];
  const base = { hospital_id: hospitalObjectId, is_active: { $ne: false }, status: { $in: relevantStatuses } };

  // The legacy nurse cards count all active/relevant appointments, not only today.
  // Preserve that semantic while returning only the small rows actually rendered.
  const [count, recentRows, todayRows] = await Promise.all([
    Appointment.countDocuments(base),
    Appointment.find(base)
      .select('_id patient_id doctor_id department_id appointment_date appointment_date_key start_time type appointment_type status')
      .populate('patient_id', 'first_name last_name patient_image patientImage')
      .populate('doctor_id', 'firstName lastName')
      .populate('department_id', 'name')
      .sort({ appointment_date: -1, start_time: -1 }).limit(5).lean(),
    Appointment.find({ ...base, appointment_date_key: todayKey })
      .select('_id patient_id doctor_id department_id appointment_date appointment_date_key start_time type appointment_type status')
      .populate('patient_id', 'first_name last_name patient_image patientImage')
      .populate('doctor_id', 'firstName lastName')
      .populate('department_id', 'name')
      .sort({ start_time: 1 }).limit(5).lean()
  ]);
  const ids = [...new Set([...recentRows, ...todayRows].map((row) => String(row._id)))];
  const vitals = ids.length ? await Vital.find({ appointment_id: { $in: ids } }).lean() : [];
  const vitalMap = new Map(vitals.map((row) => [String(row.appointment_id), row]));
  const attach = (row) => ({ ...row, vitals: vitalMap.get(String(row._id)) || null });

  // Count recorded vitals in MongoDB without transferring every active appointment id to Node.
  const [vitalCountRow] = await Appointment.aggregate([
    { $match: base },
    {
      $lookup: {
        from: Vital.collection.name,
        let: { appointmentId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$appointment_id', '$$appointmentId'] },
                  {
                    $or: ['bp', 'weight', 'pulse', 'spo2', 'temperature', 'respiratory_rate', 'height'].map((field) => ({
                      $and: [
                        { $ne: [{ $ifNull: [`$${field}`, null] }, null] },
                        { $ne: [{ $toString: { $ifNull: [`$${field}`, ''] } }, ''] }
                      ]
                    }))
                  }
                ]
              }
            }
          },
          { $limit: 1 },
          { $project: { _id: 1 } }
        ],
        as: '_vital'
      }
    },
    { $match: { '_vital.0': { $exists: true } } },
    { $count: 'value' }
  ]);
  const completedVitals = vitalCountRow?.value || 0;
  return {
    stats: { pendingVitals: Math.max(0, count - completedVitals), completedVitals, todayAppointments: count },
    recentAppointments: recentRows.map(attach),
    todayQueue: todayRows.map(attach)
  };
}

async function adminOverview({ hospitalId }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const hospital = await Hospital.findById(hospitalObjectId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalDateKey(new Date(), timeZone);
  const nursingDepartments = await Department.find({ hospitalId: hospitalObjectId, name: /^nursing$/i, is_active: { $ne: false } }).select('_id').lean();
  const nursingDepartmentIds = nursingDepartments.map((row) => row._id);

  const [patientCount, staffCount, nursingStaffCount, doctorCount, todayAppointments, completedToday, pendingAppointments, recentPatients, recentAppointments] = await Promise.all([
    Patient.countDocuments({ hospitalId: hospitalObjectId, is_active: { $ne: false } }),
    Staff.countDocuments({ hospitalId: hospitalObjectId, is_active: { $ne: false } }),
    nursingDepartmentIds.length ? Staff.countDocuments({ hospitalId: hospitalObjectId, department: { $in: nursingDepartmentIds }, is_active: { $ne: false } }) : 0,
    Doctor.countDocuments({ hospitalId: hospitalObjectId, is_active: { $ne: false } }),
    Appointment.countDocuments({ hospital_id: hospitalObjectId, appointment_date_key: todayKey, is_active: { $ne: false } }),
    Appointment.countDocuments({ hospital_id: hospitalObjectId, appointment_date_key: todayKey, status: 'Completed', is_active: { $ne: false } }),
    Appointment.countDocuments({ hospital_id: hospitalObjectId, status: 'Scheduled', is_active: { $ne: false } }),
    Patient.find({ hospitalId: hospitalObjectId, is_active: { $ne: false } }).select('_id first_name registered_at createdAt').sort({ registered_at: -1 }).limit(3).lean(),
    Appointment.find({ hospital_id: hospitalObjectId, is_active: { $ne: false } })
      .select('_id patient_id doctor_id appointment_date start_time type status updatedAt')
      .populate('patient_id', 'first_name patient_image patientImage')
      .populate('doctor_id', 'firstName')
      .sort({ appointment_date: -1, start_time: -1 }).limit(5).lean()
  ]);

  return {
    counts: { patientCount, staffCount, nursingStaffCount, doctorCount, activeDoctorCount: 0, todayAppointments, completedToday, pendingAppointments },
    recentPatients,
    recentAppointments
  };
}


async function staffDashboardOverview({ hospitalId }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const hospital = await Hospital.findById(hospitalObjectId)
    .select('_id name address phone email logo timezone')
    .lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalDateKey(new Date(), timeZone);
  const { start, end } = hospitalDayBounds(todayKey, timeZone);

  const patientScope = { hospitalId: hospitalObjectId, is_active: { $ne: false } };
  const appointmentScope = { hospital_id: hospitalObjectId, is_active: { $ne: false } };
  const billScope = {
    hospital_id: hospitalObjectId,
    generated_at: { $gte: start, $lt: end },
    status: { $in: ['Paid', 'Pending'] }
  };

  const [todayPatients, totalPatients, todayAppointments, recentPatients, recentAppointments, financeRows] = await Promise.all([
    Patient.countDocuments({ ...patientScope, registered_at: { $gte: start, $lt: end } }),
    Patient.countDocuments(patientScope),
    Appointment.countDocuments({
      ...appointmentScope,
      $or: [
        { appointment_date_key: todayKey },
        { appointment_date_key: { $exists: false }, appointment_date: { $gte: start, $lt: end } },
        { appointment_date_key: null, appointment_date: { $gte: start, $lt: end } }
      ]
    }),
    Patient.find(patientScope)
      .select('_id patientId uhid salutation first_name last_name phone gender dob blood_group patient_image registered_at')
      .sort({ registered_at: -1, _id: -1 })
      .limit(20)
      .lean(),
    Appointment.find(appointmentScope)
      .select('_id patient_id doctor_id department_id appointment_date appointment_date_key start_time end_time duration type appointment_type status priority serial_number')
      .populate('patient_id', 'first_name last_name patientId uhid patient_image phone gender dob')
      .populate('doctor_id', 'firstName lastName specialization doctorId')
      .populate('department_id', 'name')
      .sort({ appointment_date: -1, start_time: -1, _id: -1 })
      .limit(6)
      .lean(),
    Bill.aggregate([
      { $match: billScope },
      { $group: { _id: '$status', amount: { $sum: { $ifNull: ['$total_amount', 0] } } } }
    ])
  ]);

  const finance = { paid: 0, pending: 0 };
  for (const row of financeRows) {
    if (row._id === 'Paid') finance.paid = Number(row.amount || 0);
    if (row._id === 'Pending') finance.pending = Number(row.amount || 0);
  }

  return {
    hospital,
    counts: { todayPatients, totalPatients, todayAppointments },
    finance,
    recentPatients,
    recentAppointments
  };
}

async function patientRegistrationTrend({ hospitalId, range = 'weekly' }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const normalizedRange = ['weekly', 'monthly', 'yearly'].includes(String(range)) ? String(range) : 'weekly';
  const now = new Date();
  let currentStart;
  let previousStart;
  let dateFormat;

  if (normalizedRange === 'weekly') {
    currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    previousStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    dateFormat = '%Y-%m-%d';
  } else if (normalizedRange === 'monthly') {
    currentStart = new Date(now);
    currentStart.setMonth(currentStart.getMonth() - 1);
    previousStart = new Date(now);
    previousStart.setMonth(previousStart.getMonth() - 2);
    dateFormat = '%Y-%m-%d';
  } else {
    currentStart = new Date(now);
    currentStart.setFullYear(currentStart.getFullYear() - 1);
    previousStart = new Date(now);
    previousStart.setFullYear(previousStart.getFullYear() - 2);
    dateFormat = '%Y-%m';
  }

  const [rows = {}] = await Patient.aggregate([
    {
      $match: {
        hospitalId: hospitalObjectId,
        is_active: { $ne: false },
        registered_at: { $gte: previousStart }
      }
    },
    {
      $facet: {
        currentCount: [
          { $match: { registered_at: { $gte: currentStart } } },
          { $count: 'value' }
        ],
        previousCount: [
          { $match: { registered_at: { $gte: previousStart, $lt: currentStart } } },
          { $count: 'value' }
        ],
        series: [
          { $match: { registered_at: { $gte: currentStart } } },
          {
            $group: {
              _id: { $dateToString: { format: dateFormat, date: '$registered_at' } },
              value: { $sum: 1 },
              firstDate: { $min: '$registered_at' }
            }
          },
          { $sort: { firstDate: 1 } },
          { $project: { _id: 0, key: '$_id', value: 1, firstDate: 1 } }
        ]
      }
    }
  ]);

  const current = rows.currentCount?.[0]?.value || 0;
  const previous = rows.previousCount?.[0]?.value || 0;
  const change = previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : 0;
  return { range: normalizedRange, total: current, previous, change, series: rows.series || [] };
}

async function staffAppointmentCalendar({ hospitalId, query = {} }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const hospital = await Hospital.findById(hospitalObjectId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalDateKey(new Date(), timeZone);
  const fromKey = hospitalDateKey(query.from || `${todayKey.slice(0, 7)}-01`, timeZone);
  const toKey = hospitalDateKey(query.to || todayKey, timeZone);
  if (fromKey > toKey) {
    const error = new Error('Invalid appointment calendar range');
    error.statusCode = 400;
    throw error;
  }

  const fromInstant = hospitalDayBounds(fromKey, timeZone).start;
  const toInstant = hospitalDayBounds(toKey, timeZone).end;
  return Appointment.find({
    hospital_id: hospitalObjectId,
    is_active: { $ne: false },
    $or: [
      { appointment_date_key: { $gte: fromKey, $lte: toKey } },
      { appointment_date_key: { $exists: false }, appointment_date: { $gte: fromInstant, $lt: toInstant } },
      { appointment_date_key: null, appointment_date: { $gte: fromInstant, $lt: toInstant } }
    ]
  })
    .select('_id patient_id doctor_id department_id appointment_date appointment_date_key start_time end_time duration type appointment_type status priority serial_number')
    .populate('patient_id', 'first_name last_name patientId uhid')
    .populate('doctor_id', 'firstName lastName')
    .populate('department_id', 'name')
    .sort({ appointment_date_key: 1, start_time: 1, serial_number: 1 })
    .lean();
}

async function doctorPatientWorklist({ hospitalId, doctorId, query = {} }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const doctorObjectId = asObjectId(doctorId);
  const page = safePage(query.page);
  const limit = safeLimit(query.limit, 30, 100);
  const tab = ['opd', 'ipd'].includes(String(query.type || query.careType || '').toLowerCase())
    ? String(query.type || query.careType).toLowerCase()
    : 'all';
  const search = String(query.search || '').trim();

  const doctorExists = await Doctor.exists({ _id: doctorObjectId, hospitalId: hospitalObjectId, is_active: { $ne: false } });
  if (!doctorExists) return { rows: [], counts: { all: 0, opd: 0, ipd: 0 }, pagination: { page, limit, total: 0, totalPages: 1 } };

  const activeAdmissionStatuses = ACTIVE_ADMISSION_STATUSES;
  const basePipeline = [
    {
      $match: {
        hospital_id: hospitalObjectId,
        doctor_id: doctorObjectId,
        is_active: { $ne: false },
        status: { $ne: 'Cancelled' }
      }
    },
    {
      $project: {
        patientId: '$patient_id',
        hasOpd: { $literal: 1 },
        hasIpd: { $literal: 0 },
        lastVisitDate: { $ifNull: ['$appointment_date', { $ifNull: ['$start_time', '$createdAt'] }] }
      }
    },
    {
      $unionWith: {
        coll: IPDAdmission.collection.name,
        pipeline: [
          {
            $match: {
              hospitalId: hospitalObjectId,
              primaryDoctorId: doctorObjectId,
              is_active: { $ne: false }
            }
          },
          {
            $project: {
              patientId: '$patientId',
              hasOpd: { $literal: 0 },
              hasIpd: { $literal: 1 },
              lastVisitDate: { $ifNull: ['$admissionDate', { $ifNull: ['$createdAt', '$updatedAt'] }] }
            }
          }
        ]
      }
    },
    {
      $group: {
        _id: '$patientId',
        hasOpd: { $max: '$hasOpd' },
        hasIpd: { $max: '$hasIpd' },
        lastVisitDate: { $max: '$lastVisitDate' }
      }
    },
    {
      $lookup: {
        from: Patient.collection.name,
        localField: '_id',
        foreignField: '_id',
        pipeline: [
          { $match: { hospitalId: hospitalObjectId, is_active: { $ne: false } } },
          { $project: { _id: 1, patientId: 1, uhid: 1, salutation: 1, first_name: 1, last_name: 1, dob: 1, gender: 1, blood_group: 1, phone: 1, patient_image: 1, profile_image: 1 } }
        ],
        as: 'patient'
      }
    },
    { $set: { patient: { $arrayElemAt: ['$patient', 0] } } },
    { $match: { patient: { $ne: null } } }
  ];

  const filters = [];
  if (tab === 'opd') filters.push({ $match: { hasOpd: 1 } });
  if (tab === 'ipd') filters.push({ $match: { hasIpd: 1 } });
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filters.push({
      $match: {
        $or: [
          { 'patient.first_name': regex }, { 'patient.last_name': regex }, { 'patient.patientId': regex },
          { 'patient.uhid': regex }, { 'patient.phone': regex }, { 'patient.gender': regex }, { 'patient.blood_group': regex }
        ]
      }
    });
  }

  const [result = {}] = await Appointment.aggregate([
    ...basePipeline,
    {
      $facet: {
        meta: [
          {
            $group: {
              _id: null,
              all: { $sum: 1 },
              opd: { $sum: { $cond: [{ $eq: ['$hasOpd', 1] }, 1, 0] } },
              ipd: { $sum: { $cond: [{ $eq: ['$hasIpd', 1] }, 1, 0] } }
            }
          }
        ],
        total: [...filters, { $count: 'value' }],
        rows: [
          ...filters,
          { $sort: { lastVisitDate: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: Appointment.collection.name,
              let: { patientId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$patient_id', '$$patientId'] },
                        { $eq: ['$hospital_id', hospitalObjectId] },
                        { $eq: ['$doctor_id', doctorObjectId] },
                        { $ne: ['$is_active', false] },
                        { $ne: ['$status', 'Cancelled'] }
                      ]
                    }
                  }
                },
                { $sort: { appointment_date: -1, start_time: -1, createdAt: -1 } },
                { $limit: 1 },
                { $project: { _id: 1, appointment_date: 1, appointment_date_key: 1, start_time: 1, status: 1, type: 1, appointment_type: 1 } }
              ],
              as: 'latestAppointment'
            }
          },
          {
            $lookup: {
              from: IPDAdmission.collection.name,
              let: { patientId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$patientId', '$$patientId'] },
                        { $eq: ['$hospitalId', hospitalObjectId] },
                        { $eq: ['$primaryDoctorId', doctorObjectId] },
                        { $ne: ['$is_active', false] }
                      ]
                    }
                  }
                },
                { $set: { _activeRank: { $cond: [{ $in: ['$status', activeAdmissionStatuses] }, 1, 0] } } },
                { $sort: { _activeRank: -1, admissionDate: -1, createdAt: -1, updatedAt: -1 } },
                { $limit: 1 },
                { $project: { _id: 1, admissionNumber: 1, shipNumber: 1, admissionDate: 1, status: 1 } }
              ],
              as: 'selectedAdmission'
            }
          },
          {
            $project: {
              _id: 0,
              mongoId: '$patient._id',
              patientId: { $ifNull: ['$patient.patientId', '$patient.uhid'] },
              uhid: '$patient.uhid',
              salutation: '$patient.salutation',
              first_name: '$patient.first_name',
              last_name: '$patient.last_name',
              dob: '$patient.dob',
              gender: '$patient.gender',
              blood_group: '$patient.blood_group',
              phone: '$patient.phone',
              patient_image: '$patient.patient_image',
              profile_image: '$patient.profile_image',
              hasOpd: { $eq: ['$hasOpd', 1] },
              hasIpd: { $eq: ['$hasIpd', 1] },
              lastVisitDate: 1,
              latestAppointment: { $arrayElemAt: ['$latestAppointment', 0] },
              selectedAdmission: { $arrayElemAt: ['$selectedAdmission', 0] }
            }
          }
        ]
      }
    }
  ]).allowDiskUse(true);

  const counts = result.meta?.[0] || { all: 0, opd: 0, ipd: 0 };
  const total = result.total?.[0]?.value || 0;
  return {
    rows: result.rows || [],
    counts,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  };
}

async function searchPatientsCompact({ hospitalId, query = {} }) {
  const hospitalObjectId = asObjectId(hospitalId);
  const q = String(query.q || query.search || '').trim();
  const limit = safeLimit(query.limit, 20, 50);
  if (q.length < 2) return { patients: [] };

  const searchFields = ['patientId', 'uhid', 'first_name', 'middle_name', 'last_name', 'phone', 'normalizedPhone', 'email', 'abha.number', 'abha.address'];
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const tokenClauses = tokens.map((token) => {
    const regex = new RegExp(escapeRegex(token), 'i');
    return { $or: searchFields.map((field) => ({ [field]: regex })) };
  });
  const patients = await Patient.find({
    hospitalId: hospitalObjectId,
    is_active: { $ne: false },
    ...(tokenClauses.length === 1 ? tokenClauses[0] : { $and: tokenClauses })
  })
    .select('_id patientId uhid salutation first_name middle_name last_name dob gender blood_group phone email address patient_image sponsor_type sponsor_name abha pharmacy_outstanding_balance pharmacy_advance_balance registered_at is_walkin')
    .sort({ registered_at: -1, _id: -1 })
    .limit(limit)
    .lean();

  if (!patients.length) return { patients: [] };

  const ids = patients.map((patient) => patient._id);
  const admissions = await IPDAdmission.find({
    hospitalId: hospitalObjectId,
    patientId: { $in: ids },
    is_active: { $ne: false },
    status: { $in: ACTIVE_ADMISSION_STATUSES }
  })
    .select('_id patientId admissionNumber shipNumber status admissionDate wardId bedId roomId primaryDoctorId departmentId')
    .sort({ admissionDate: -1, createdAt: -1 })
    .lean();

  const activeByPatient = new Map();
  for (const admission of admissions) {
    const key = String(admission.patientId);
    if (!activeByPatient.has(key)) activeByPatient.set(key, admission);
  }

  return {
    patients: patients.map((patient) => ({
      ...patient,
      activeAdmission: activeByPatient.get(String(patient._id)) || null
    }))
  };
}

module.exports = {
  listPatientWorklist,
  patientWorklistCursor,
  getPatientVisitHistory,
  appointmentWorklist,
  doctorDashboard,
  doctorScheduleReadModel,
  nurseDashboard,
  adminOverview,
  staffDashboardOverview,
  patientRegistrationTrend,
  staffAppointmentCalendar,
  doctorPatientWorklist,
  searchPatientsCompact,
  ACTIVE_ADMISSION_STATUSES,
  ACTIVE_APPOINTMENT_STATUSES
};
