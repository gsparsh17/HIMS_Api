const mongoose = require('mongoose');

// ============================================
// Report Catalog
// ============================================

const REPORT_CATALOG = [
  {
    key: 'executive',
    label: 'Executive Hospital Overview',
    module: 'Executive',
    dimensions: ['day', 'department'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Admissions, discharges, visits, investigations, OT cases and financial activity.'
  },
  {
    key: 'opd-visits',
    label: 'OPD Visits - New / Revisit',
    module: 'OPD Reports',
    dimensions: ['period', 'doctor', 'department', 'visitType'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Daily, monthly or yearly OPD activity split into New and Revisit visits, doctor and department wise.'
  },
  {
    key: 'opd-ipd-followup',
    label: 'OPD & IPD Follow-up',
    module: 'OPD Reports',
    dimensions: ['period', 'careSetting', 'doctor', 'department'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'OPD follow-up appointments and IPD doctor rounds, daily/monthly/yearly with doctor and department grouping.'
  },
  {
    key: 'appointment-status',
    label: 'Appointments - Done / Pending / Cancelled',
    module: 'OPD Reports',
    dimensions: ['period', 'status', 'doctor', 'department'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Appointment status MIS grouped by doctor and department.'
  },
  {
    key: 'opd-cancelled',
    label: 'Cancelled OPD',
    module: 'OPD Reports',
    dimensions: ['period', 'doctor', 'department'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Cancelled OPD appointments by day/month/year, doctor and department.'
  },
  {
    key: 'ipd-admissions',
    label: 'IPD Admissions',
    module: 'IPD Reports',
    dimensions: ['period', 'doctor', 'department'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Admissions daily/monthly/yearly, doctor/department wise or all.'
  },
  {
    key: 'ipd-discharges',
    label: 'IPD Discharges',
    module: 'IPD Reports',
    dimensions: ['period', 'doctor', 'department', 'status'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Discharges daily/monthly/yearly, doctor/department wise or all.'
  },
  {
    key: 'ipd-bed-occupancy',
    label: 'Bed Occupancy - Current',
    module: 'IPD Reports',
    dimensions: ['ward', 'bed'],
    filters: [],
    description: 'Current occupied beds and active IPD census, grouped by ward.'
  },
  {
    key: 'ipd-newborn',
    label: 'New Born',
    module: 'IPD Reports',
    dimensions: ['period'],
    filters: ['grain'],
    description: 'New-born patient registrations in the selected period.'
  },
  {
    key: 'ipd-deaths',
    label: 'IPD Death / Expired',
    module: 'IPD Reports',
    dimensions: ['period', 'doctor', 'department'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Expired/death IPD cases by doctor and department.'
  },
  {
    key: 'ipd-medico-status',
    label: 'Medico Status - LAMA / DOR / Death / Referred',
    module: 'IPD Reports',
    dimensions: ['period', 'medicoStatus', 'doctor', 'department'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'LAMA, discharge-on-request/DAMA, death/expired and referred/transfer disposition.'
  },
  {
    key: 'lab-workload',
    label: 'Pathology Workload & Status',
    module: 'Pathology Reports',
    dimensions: ['period', 'status', 'test', 'doctor', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Laboratory orders, current statuses, completed/released work and test workload.'
  },
  {
    key: 'lab-tat',
    label: 'Pathology Turnaround Time',
    module: 'Pathology Reports',
    dimensions: ['period', 'test', 'doctor', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Reported/released laboratory turnaround time from request to report/release.'
  },
  {
    key: 'radiology-workload',
    label: 'Radiology Workload & Status',
    module: 'Radiology Reports',
    dimensions: ['period', 'status', 'test', 'doctor', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Radiology requests and status distribution by test and referring doctor.'
  },
  {
    key: 'radiology-tat',
    label: 'Radiology Turnaround Time',
    module: 'Radiology Reports',
    dimensions: ['period', 'test', 'doctor', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Radiology turnaround time from request to report.'
  },
  {
    key: 'billing-revenue',
    label: 'Billing - Revenue / Collection / Outstanding',
    module: 'Billing Reports',
    dimensions: ['period', 'invoiceType', 'status', 'doctor', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Gross billing, collections and outstanding balances by day/month/year and invoice type.'
  },
  {
    key: 'billing-refunds',
    label: 'Billing - Refunds / Cancelled',
    module: 'Billing Reports',
    dimensions: ['period', 'status', 'doctor', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Refunded and cancelled invoices/payments in the selected period.'
  },
  {
    key: 'ot-cases',
    label: 'OT Cases & Status',
    module: 'OT Reports',
    dimensions: ['period', 'status', 'surgeon', 'department', 'procedure'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'OT cases requested/scheduled/in-progress/completed/cancelled with surgeon/procedure grouping.'
  },
  {
    key: 'ot-utilisation',
    label: 'OT Utilisation & Duration',
    module: 'OT Reports',
    dimensions: ['period', 'surgeon', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Completed OT cases and average actual surgery duration.'
  },
  {
    key: 'procedure-workload',
    label: 'Procedures - Workload & Status',
    module: 'Procedure Reports',
    dimensions: ['period', 'status', 'procedure', 'doctor', 'department'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Requested, scheduled, completed, cancelled and postponed procedure activity.'
  },
  {
    key: 'pharmacy-activity',
    label: 'Pharmacy Activity',
    module: 'Pharmacy Reports',
    dimensions: ['period', 'status'],
    filters: ['grain'],
    description: 'Prescription/dispensing operational activity for the selected period.'
  },
  {
    key: 'store',
    label: 'Store & Inventory Control',
    module: 'Inventory Reports',
    dimensions: ['item', 'category', 'location'],
    filters: [],
    description: 'Stock value, movements, stock-outs, expiries, reservations, GRNs, returns and variances.'
  },
  {
    key: 'hr',
    label: 'HR & Payroll',
    module: 'HR Reports',
    dimensions: ['department', 'designation'],
    filters: ['departmentId'],
    description: 'Headcount, active staff, leave and payroll.'
  },
  {
    key: 'clinical-quality',
    label: 'Clinical Quality & Documentation',
    module: 'Quality Reports',
    dimensions: ['document', 'department', 'doctor'],
    filters: ['departmentId', 'doctorId'],
    description: 'Consent, assessment, medication, discharge and signed-document completion.'
  },
  // Legacy aliases kept so existing bookmarks/API callers remain valid.
  {
    key: 'opd',
    label: 'OPD & Appointment Activity (Legacy)',
    module: 'OPD Reports',
    dimensions: ['period', 'status'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Compatibility alias for appointment status reporting.'
  },
  {
    key: 'ipd',
    label: 'IPD Census & Clinical Activity (Legacy)',
    module: 'IPD Reports',
    dimensions: ['period', 'status'],
    filters: ['grain', 'departmentId', 'doctorId'],
    description: 'Compatibility alias for IPD admissions/status reporting.'
  },
  {
    key: 'lab',
    label: 'Laboratory TAT & Workload (Legacy)',
    module: 'Pathology Reports',
    dimensions: ['period', 'status'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Compatibility alias for laboratory workload.'
  },
  {
    key: 'radiology',
    label: 'Radiology TAT & Workload (Legacy)',
    module: 'Radiology Reports',
    dimensions: ['period', 'status'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Compatibility alias for radiology workload.'
  },
  {
    key: 'billing',
    label: 'Billing & Collection (Legacy)',
    module: 'Billing Reports',
    dimensions: ['period', 'status'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Compatibility alias for billing revenue.'
  },
  {
    key: 'ot',
    label: 'Operation Theatre Performance (Legacy)',
    module: 'OT Reports',
    dimensions: ['period', 'status'],
    filters: ['grain', 'doctorId', 'departmentId'],
    description: 'Compatibility alias for OT cases.'
  },
  {
    key: 'pharmacy',
    label: 'Pharmacy Activity (Legacy)',
    module: 'Pharmacy Reports',
    dimensions: ['period', 'status'],
    filters: ['grain'],
    description: 'Compatibility alias for pharmacy activity.'
  }
];

// ============================================
// Helpers
// ============================================

function model(name) {
  try {
    return mongoose.model(name);
  } catch (_error) {
    return null;
  }
}

function oid(value) {
  if (!value) return undefined;
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);
}

const IST_OFFSET_MINUTES = 330;

function asDate(value, endOfDay = false) {
  if (!value) return undefined;

  const text = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const utcMillis = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0
    ) - (IST_OFFSET_MINUTES * 60 * 1000);

    return new Date(utcMillis);
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function range(field, filters = {}) {
  const start = asDate(filters.startDate);
  const end = asDate(filters.endDate, true);

  if (!start && !end) {
    return {};
  }

  const condition = {};

  if (start) {
    condition.$gte = start;
  }

  if (end) {
    condition.$lte = end;
  }

  return { [field]: condition };
}

function grain(filters = {}) {
  const value = String(filters.grain || 'day').toLowerCase();
  return ['day', 'month', 'year'].includes(value) ? value : 'day';
}

function periodExpr(field, filters = {}) {
  const format = grain(filters) === 'year'
    ? '%Y'
    : grain(filters) === 'month'
      ? '%Y-%m'
      : '%Y-%m-%d';

  return {
    $dateToString: {
      date: `$${field}`,
      format,
      timezone: 'Asia/Kolkata'
    }
  };
}

function safeMatchId(target, field, value) {
  if (value && mongoose.isValidObjectId(value)) {
    target[field] = oid(value);
  }
}

// ============================================
// Doctor & Department Lookup Stages
// ============================================

function doctorDepartmentStages(doctorPath = '_id.doctorId', departmentPath = '_id.departmentId') {
  const doctorExpr = doctorPath.split('.').reduce((acc, key) => acc ? acc[key] : undefined, {});
  void doctorExpr;

  return [
    {
      $lookup: {
        from: 'doctors',
        localField: doctorPath,
        foreignField: '_id',
        as: '__doctor'
      }
    },
    {
      $lookup: {
        from: 'departments',
        localField: departmentPath,
        foreignField: '_id',
        as: '__department'
      }
    },
    {
      $addFields: {
        doctor: {
          $let: {
            vars: { d: { $arrayElemAt: ['$__doctor', 0] } },
            in: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ['$$d.firstName', ''] },
                    ' ',
                    { $ifNull: ['$$d.lastName', ''] }
                  ]
                }
              }
            }
          }
        },
        department: {
          $ifNull: [{ $arrayElemAt: ['$__department.name', 0] }, 'Unassigned']
        }
      }
    },
    {
      $project: {
        __doctor: 0,
        __department: 0
      }
    }
  ];
}

// ============================================
// Appointment Aggregate
// ============================================

async function appointmentAggregate(hospitalId, filters = {}, mode = 'all') {
  const Appointment = model('Appointment');

  if (!Appointment) {
    return [];
  }

  const match = {
    hospital_id: oid(hospitalId),
    ...range('appointment_date', filters)
  };

  safeMatchId(match, 'doctor_id', filters.doctorId);
  safeMatchId(match, 'department_id', filters.departmentId);

  if (mode === 'cancelled') {
    match.status = 'Cancelled';
  }

  if (mode === 'followup') {
    match.appointment_type = 'follow-up';
  }

  const groupId = {
    period: periodExpr('appointment_date', filters),
    doctorId: '$doctor_id',
    departmentId: '$department_id'
  };

  if (mode === 'visits') {
    groupId.visitType = {
      $cond: [
        { $eq: ['$appointment_type', 'follow-up'] },
        'Revisit',
        'New'
      ]
    };
  }

  if (mode === 'status' || mode === 'all') {
    groupId.status = {
      $switch: {
        branches: [
          { case: { $eq: ['$status', 'Completed'] }, then: 'Done' },
          { case: { $eq: ['$status', 'Cancelled'] }, then: 'Cancelled' }
        ],
        default: 'Pending'
      }
    };
  }

  return Appointment.aggregate([
    { $match: match },
    { $group: { _id: groupId, count: { $sum: 1 } } },
    ...doctorDepartmentStages(),
    {
      $addFields: {
        period: '$_id.period',
        status: '$_id.status',
        visitType: '$_id.visitType'
      }
    },
    {
      $sort: {
        period: 1,
        department: 1,
        doctor: 1,
        status: 1,
        visitType: 1
      }
    }
  ]);
}

// ============================================
// IPD Aggregate
// ============================================

async function ipdAggregate(hospitalId, filters = {}, kind = 'admission') {
  const Admission = model('IPDAdmission');

  if (!Admission) {
    return [];
  }

  const dateField = kind === 'discharge' || kind === 'death' || kind === 'medico'
    ? 'dischargeDate'
    : 'admissionDate';

  const match = {
    hospitalId: oid(hospitalId),
    ...range(dateField, filters)
  };

  safeMatchId(match, 'primaryDoctorId', filters.doctorId);
  safeMatchId(match, 'departmentId', filters.departmentId);

  if (kind === 'discharge') {
    match.status = { $in: ['Discharged', 'LAMA', 'DAMA', 'Expired'] };
  }

  if (kind === 'death') {
    match.status = 'Expired';
  }

  if (kind === 'medico') {
    match.$or = [
      { status: { $in: ['LAMA', 'DAMA', 'Expired'] } },
      { plannedDischargeType: 'TRANSFER' },
      { dischargeReason: { $regex: /(refer|transfer|request|dor)/i } }
    ];
  }

  const medicoExpr = {
    $switch: {
      branches: [
        { case: { $eq: ['$status', 'LAMA'] }, then: 'LAMA' },
        { case: { $eq: ['$status', 'DAMA'] }, then: 'DOR / DAMA' },
        { case: { $eq: ['$status', 'Expired'] }, then: 'Death' },
        {
          case: {
            $or: [
              { $eq: ['$plannedDischargeType', 'TRANSFER'] },
              {
                $regexMatch: {
                  input: { $ifNull: ['$dischargeReason', ''] },
                  regex: /(refer|transfer)/i
                }
              }
            ]
          },
          then: 'Referred'
        },
        {
          case: {
            $regexMatch: {
              input: { $ifNull: ['$dischargeReason', ''] },
              regex: /(request|dor)/i
            }
          },
          then: 'DOR / DAMA'
        }
      ],
      default: 'Other'
    }
  };

  const groupId = {
    period: periodExpr(dateField, filters),
    doctorId: '$primaryDoctorId',
    departmentId: '$departmentId'
  };

  if (kind === 'discharge') {
    groupId.status = '$status';
  }

  if (kind === 'medico') {
    groupId.medicoStatus = medicoExpr;
  }

  return Admission.aggregate([
    { $match: match },
    { $group: { _id: groupId, count: { $sum: 1 } } },
    ...doctorDepartmentStages(),
    {
      $addFields: {
        period: '$_id.period',
        status: '$_id.status',
        medicoStatus: '$_id.medicoStatus'
      }
    },
    { $sort: { period: 1, department: 1, doctor: 1 } }
  ]);
}

// ============================================
// Follow-up Report
// ============================================

async function followupReport(hospitalId, filters = {}) {
  const [opdRows, ipdRows] = await Promise.all([
    appointmentAggregate(hospitalId, filters, 'followup'),
    (async () => {
      const Round = model('IPDRound');

      if (!Round) {
        return [];
      }

      const match = {
        hospitalId: oid(hospitalId),
        ...range('roundDateTime', filters)
      };

      safeMatchId(match, 'doctorId', filters.doctorId);

      const pipeline = [
        { $match: match },
        {
          $lookup: {
            from: 'ipdadmissions',
            localField: 'admissionId',
            foreignField: '_id',
            as: '__admission'
          }
        },
        { $addFields: { __a: { $arrayElemAt: ['$__admission', 0] } } }
      ];

      if (filters.departmentId && mongoose.isValidObjectId(filters.departmentId)) {
        pipeline.push({
          $match: { '__a.departmentId': oid(filters.departmentId) }
        });
      }

      pipeline.push(
        {
          $group: {
            _id: {
              period: periodExpr('roundDateTime', filters),
              doctorId: '$doctorId',
              departmentId: '$__a.departmentId'
            },
            count: { $sum: 1 }
          }
        },
        ...doctorDepartmentStages(),
        {
          $addFields: {
            period: '$_id.period',
            careSetting: 'IPD Follow-up / Round'
          }
        },
        { $sort: { period: 1, department: 1, doctor: 1 } }
      );

      return Round.aggregate(pipeline);
    })()
  ]);

  return [
    ...opdRows.map((row) => ({ ...row, careSetting: 'OPD Follow-up' })),
    ...ipdRows
  ].sort((a, b) => String(a.period).localeCompare(String(b.period)));
}

// ============================================
// Bed Occupancy
// ============================================

async function bedOccupancy(hospitalId) {
  const Admission = model('IPDAdmission');

  if (!Admission) {
    return [];
  }

  const activeStatuses = [
    'Admitted',
    'Under Treatment',
    'Discharge Initiated',
    'Discharge Summary Pending',
    'Billing Pending',
    'Payment Pending',
    'Ready for Discharge'
  ];

  return Admission.aggregate([
    {
      $match: {
        hospitalId: oid(hospitalId),
        status: { $in: activeStatuses },
        bedId: { $ne: null }
      }
    },
    {
      $lookup: {
        from: 'wards',
        localField: 'wardId',
        foreignField: '_id',
        as: '__ward'
      }
    },
    {
      $lookup: {
        from: 'beds',
        localField: 'bedId',
        foreignField: '_id',
        as: '__bed'
      }
    },
    {
      $lookup: {
        from: 'patients',
        localField: 'patientId',
        foreignField: '_id',
        as: '__patient'
      }
    },
    {
      $lookup: {
        from: 'doctors',
        localField: 'primaryDoctorId',
        foreignField: '_id',
        as: '__doctor'
      }
    },
    {
      $project: {
        _id: '$admissionNumber',
        count: { $literal: 1 },
        ward: { $ifNull: [{ $arrayElemAt: ['$__ward.name', 0] }, 'Unassigned'] },
        bed: {
          $ifNull: [
            { $arrayElemAt: ['$__bed.bedNumber', 0] },
            { $ifNull: [{ $arrayElemAt: ['$__bed.bed_number', 0] }, '—'] }
          ]
        },
        patient: {
          $let: {
            vars: { p: { $arrayElemAt: ['$__patient', 0] } },
            in: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ['$$p.first_name', ''] },
                    ' ',
                    { $ifNull: ['$$p.last_name', ''] }
                  ]
                }
              }
            }
          }
        },
        doctor: {
          $let: {
            vars: { d: { $arrayElemAt: ['$__doctor', 0] } },
            in: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ['$$d.firstName', ''] },
                    ' ',
                    { $ifNull: ['$$d.lastName', ''] }
                  ]
                }
              }
            }
          }
        },
        admissionDate: 1
      }
    },
    { $sort: { ward: 1, bed: 1 } }
  ]);
}

// ============================================
// Newborn Report
// ============================================

async function newbornReport(hospitalId, filters = {}) {
  const Patient = model('Patient');

  if (!Patient) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('dob', filters)
  };

  return Patient.aggregate([
    { $match: match },
    {
      $group: {
        _id: { period: periodExpr('dob', filters) },
        count: { $sum: 1 }
      }
    },
    { $addFields: { period: '$_id.period' } },
    { $sort: { period: 1 } }
  ]);
}

// ============================================
// Diagnostic Workload
// ============================================

async function diagnosticWorkload(name, hospitalId, filters = {}, tat = false) {
  const Model = model(name);

  if (!Model) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('requestedDate', filters)
  };

  safeMatchId(match, 'doctorId', filters.doctorId);

  const testField = '$testName';

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'doctors',
        localField: 'doctorId',
        foreignField: '_id',
        as: '__refDoctor'
      }
    },
    {
      $addFields: {
        __doctorRecord: { $arrayElemAt: ['$__refDoctor', 0] }
      }
    }
  ];

  if (filters.departmentId && mongoose.isValidObjectId(filters.departmentId)) {
    pipeline.push({
      $match: { '__doctorRecord.department': oid(filters.departmentId) }
    });
  }

  if (!tat) {
    pipeline.push(
      {
        $group: {
          _id: {
            period: periodExpr('requestedDate', filters),
            status: '$status',
            test: testField,
            doctorId: '$doctorId',
            departmentId: '$__doctorRecord.department'
          },
          count: { $sum: 1 }
        }
      },
      ...doctorDepartmentStages(),
      {
        $addFields: {
          period: '$_id.period',
          status: '$_id.status',
          test: '$_id.test'
        }
      },
      {
        $sort: {
          period: 1,
          department: 1,
          doctor: 1,
          test: 1,
          status: 1
        }
      }
    );

    return Model.aggregate(pipeline);
  }

  const endField = name === 'LabRequest'
    ? { $ifNull: ['$releasedAt', '$reportedAt'] }
    : '$reportedAt';

  pipeline.push(
    {
      $match: {
        $or: [
          { releasedAt: { $ne: null } },
          { reportedAt: { $ne: null } }
        ]
      }
    },
    {
      $project: {
        requestedDate: 1,
        doctorId: 1,
        departmentId: '$__doctorRecord.department',
        test: testField,
        completedAt: endField
      }
    },
    { $match: { completedAt: { $ne: null } } },
    {
      $project: {
        period: periodExpr('requestedDate', filters),
        doctorId: 1,
        departmentId: 1,
        test: 1,
        minutes: {
          $divide: [
            { $subtract: ['$completedAt', '$requestedDate'] },
            60000
          ]
        }
      }
    },
    {
      $group: {
        _id: {
          period: '$period',
          test: '$test',
          doctorId: '$doctorId',
          departmentId: '$departmentId'
        },
        count: { $sum: 1 },
        averageMinutes: { $avg: '$minutes' },
        maxMinutes: { $max: '$minutes' }
      }
    },
    ...doctorDepartmentStages(),
    {
      $addFields: {
        period: '$_id.period',
        test: '$_id.test',
        value: { $round: ['$averageMinutes', 1] }
      }
    },
    {
      $sort: {
        period: 1,
        department: 1,
        doctor: 1,
        test: 1
      }
    }
  );

  return Model.aggregate(pipeline);
}

// ============================================
// Billing Report
// ============================================

async function billingReport(hospitalId, filters = {}, refundsOnly = false) {
  const Invoice = model('Invoice');

  if (!Invoice) {
    return [];
  }

  const match = {
    hospital_id: oid(hospitalId),
    ...range('issue_date', filters)
  };

  if (refundsOnly) {
    match.status = { $in: ['Refunded', 'Cancelled'] };
  }

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'appointments',
        localField: 'appointment_id',
        foreignField: '_id',
        as: '__appointment'
      }
    },
    {
      $lookup: {
        from: 'ipdadmissions',
        localField: 'admission_id',
        foreignField: '_id',
        as: '__admission'
      }
    },
    {
      $addFields: {
        __appointmentRecord: { $arrayElemAt: ['$__appointment', 0] },
        __admissionRecord: { $arrayElemAt: ['$__admission', 0] }
      }
    },
    {
      $addFields: {
        __doctorId: {
          $ifNull: [
            '$__appointmentRecord.doctor_id',
            '$__admissionRecord.primaryDoctorId'
          ]
        },
        __departmentId: {
          $ifNull: [
            '$__appointmentRecord.department_id',
            '$__admissionRecord.departmentId'
          ]
        }
      }
    }
  ];

  if (filters.doctorId && mongoose.isValidObjectId(filters.doctorId)) {
    pipeline.push({
      $match: { __doctorId: oid(filters.doctorId) }
    });
  }

  if (filters.departmentId && mongoose.isValidObjectId(filters.departmentId)) {
    pipeline.push({
      $match: { __departmentId: oid(filters.departmentId) }
    });
  }

  pipeline.push(
    {
      $group: {
        _id: {
          period: periodExpr('issue_date', filters),
          invoiceType: '$invoice_type',
          status: '$status',
          doctorId: '$__doctorId',
          departmentId: '$__departmentId'
        },
        count: { $sum: 1 },
        billed: { $sum: { $ifNull: ['$total', 0] } },
        collected: { $sum: { $ifNull: ['$amount_paid', 0] } },
        outstanding: { $sum: { $ifNull: ['$balance_due', 0] } }
      }
    },
    ...doctorDepartmentStages(),
    {
      $addFields: {
        period: '$_id.period',
        invoiceType: '$_id.invoiceType',
        status: '$_id.status',
        value: '$billed',
        quantity: '$collected',
        outstanding: '$outstanding'
      }
    },
    {
      $sort: {
        period: 1,
        department: 1,
        doctor: 1,
        invoiceType: 1,
        status: 1
      }
    }
  );

  return Invoice.aggregate(pipeline);
}

// ============================================
// OT Report
// ============================================

async function otReport(hospitalId, filters = {}, utilisation = false) {
  const OT = model('OTRequest');

  if (!OT) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('requestedDate', filters)
  };

  if (filters.doctorId && mongoose.isValidObjectId(filters.doctorId)) {
    const doctorObjectId = oid(filters.doctorId);
    match.$or = [
      { primarySurgeonId: doctorObjectId },
      { primarySurgeonId: null, doctorId: doctorObjectId }
    ];
  }

  if (utilisation) {
    match.completedAt = { $ne: null };
  }

  const pipeline = [
    { $match: match },
    {
      $addFields: {
        __surgeonId: {
          $ifNull: ['$primarySurgeonId', '$doctorId']
        }
      }
    },
    {
      $lookup: {
        from: 'doctors',
        localField: '__surgeonId',
        foreignField: '_id',
        as: '__surgeonRecord'
      }
    },
    {
      $addFields: {
        __surgeon: { $arrayElemAt: ['$__surgeonRecord', 0] }
      }
    }
  ];

  if (filters.departmentId && mongoose.isValidObjectId(filters.departmentId)) {
    pipeline.push({
      $match: { '__surgeon.department': oid(filters.departmentId) }
    });
  }

  if (utilisation) {
    pipeline.push(
      {
        $project: {
          requestedDate: 1,
          surgeonId: '$__surgeonId',
          departmentId: '$__surgeon.department',
          minutes: {
            $cond: [
              { $and: ['$startedAt', '$completedAt'] },
              {
                $divide: [
                  { $subtract: ['$completedAt', '$startedAt'] },
                  60000
                ]
              },
              null
            ]
          }
        }
      },
      {
        $group: {
          _id: {
            period: periodExpr('requestedDate', filters),
            doctorId: '$surgeonId',
            departmentId: '$departmentId'
          },
          count: { $sum: 1 },
          averageMinutes: { $avg: '$minutes' }
        }
      },
      ...doctorDepartmentStages(),
      {
        $addFields: {
          period: '$_id.period',
          surgeon: '$doctor',
          value: { $round: ['$averageMinutes', 1] }
        }
      },
      { $sort: { period: 1, department: 1, surgeon: 1 } }
    );
  } else {
    pipeline.push(
      {
        $group: {
          _id: {
            period: periodExpr('requestedDate', filters),
            status: '$status',
            doctorId: '$__surgeonId',
            departmentId: '$__surgeon.department',
            procedure: {
              $ifNull: ['$procedureName', '$procedure_performed']
            }
          },
          count: { $sum: 1 }
        }
      },
      ...doctorDepartmentStages(),
      {
        $addFields: {
          period: '$_id.period',
          status: '$_id.status',
          procedure: '$_id.procedure',
          surgeon: '$doctor'
        }
      },
      {
        $sort: {
          period: 1,
          department: 1,
          surgeon: 1,
          procedure: 1,
          status: 1
        }
      }
    );
  }

  return OT.aggregate(pipeline);
}

// ============================================
// Procedure Report
// ============================================

async function procedureReport(hospitalId, filters = {}) {
  const Procedure = model('ProcedureRequest');

  if (!Procedure) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('requestedDate', filters)
  };

  safeMatchId(match, 'doctorId', filters.doctorId);

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'doctors',
        localField: 'doctorId',
        foreignField: '_id',
        as: '__doctorRecordList'
      }
    },
    {
      $addFields: {
        __doctorRecord: { $arrayElemAt: ['$__doctorRecordList', 0] }
      }
    }
  ];

  if (filters.departmentId && mongoose.isValidObjectId(filters.departmentId)) {
    pipeline.push({
      $match: { '__doctorRecord.department': oid(filters.departmentId) }
    });
  }

  pipeline.push(
    {
      $group: {
        _id: {
          period: periodExpr('requestedDate', filters),
          status: '$status',
          doctorId: '$doctorId',
          departmentId: '$__doctorRecord.department',
          procedure: '$procedureName'
        },
        count: { $sum: 1 },
        value: { $sum: { $ifNull: ['$cost', 0] } }
      }
    },
    ...doctorDepartmentStages(),
    {
      $addFields: {
        period: '$_id.period',
        status: '$_id.status',
        procedure: '$_id.procedure'
      }
    },
    {
      $sort: {
        period: 1,
        department: 1,
        doctor: 1,
        procedure: 1,
        status: 1
      }
    }
  );

  return Procedure.aggregate(pipeline);
}

// ============================================
// Pharmacy Report
// ============================================

async function pharmacyReport(hospitalId, filters = {}) {
  const Prescription = model('Prescription');

  if (!Prescription) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('issue_date', filters)
  };

  return Prescription.aggregate([
    { $match: match },
    {
      $project: {
        issue_date: 1,
        status: 1,
        source_type: 1,
        itemCount: { $size: { $ifNull: ['$items', []] } },
        dispensedCount: {
          $size: {
            $filter: {
              input: { $ifNull: ['$items', []] },
              as: 'item',
              cond: { $eq: ['$$item.is_dispensed', true] }
            }
          }
        }
      }
    },
    {
      $group: {
        _id: {
          period: periodExpr('issue_date', filters),
          status: '$status',
          sourceType: '$source_type'
        },
        count: { $sum: 1 },
        quantity: { $sum: '$itemCount' },
        dispensedItems: { $sum: '$dispensedCount' }
      }
    },
    {
      $addFields: {
        period: '$_id.period',
        status: '$_id.status',
        sourceType: '$_id.sourceType',
        value: '$dispensedItems'
      }
    },
    { $sort: { period: 1, sourceType: 1, status: 1 } }
  ]);
}

// ============================================
// Detail Limit
// ============================================

const DETAIL_LIMIT = 5000;

// ============================================
// Person/Patient Helpers
// ============================================

function personName(person) {
  if (!person) return '—';

  if (typeof person === 'string') return person;

  return person.name ||
    person.fullName ||
    [
      person.salutation,
      person.first_name || person.firstName,
      person.middle_name || person.middleName,
      person.last_name || person.lastName
    ].filter(Boolean).join(' ').trim() ||
    '—';
}

function patientUhid(patient) {
  return patient?.uhid || patient?.patientId || '—';
}

function departmentName(department) {
  return department?.name || department?.departmentName || 'Unassigned';
}

function formatAgeGender(patient) {
  let age = '';

  if (patient?.dob) {
    const dob = new Date(patient.dob);

    if (!Number.isNaN(dob.getTime())) {
      const now = new Date();
      let years = now.getFullYear() - dob.getFullYear();
      const month = now.getMonth() - dob.getMonth();

      if (month < 0 || (month === 0 && now.getDate() < dob.getDate())) {
        years -= 1;
      }

      age = `${Math.max(0, years)} Y`;
    }
  }

  return [age, patient?.gender].filter(Boolean).join(' / ') || '—';
}

function normalizeAppointmentStatus(status) {
  if (status === 'Completed') return 'Done';
  if (status === 'Cancelled') return 'Cancelled';
  return 'Pending';
}

// ============================================
// Appointment Details
// ============================================

async function appointmentDetails(hospitalId, filters = {}, mode = 'all') {
  const Appointment = model('Appointment');

  if (!Appointment) {
    return [];
  }

  const match = {
    hospital_id: oid(hospitalId),
    ...range('appointment_date', filters)
  };

  safeMatchId(match, 'doctor_id', filters.doctorId);
  safeMatchId(match, 'department_id', filters.departmentId);

  if (mode === 'cancelled') {
    match.status = 'Cancelled';
  }

  if (mode === 'followup') {
    match.appointment_type = 'follow-up';
  }

  const docs = await Appointment.find(match)
    .populate('patient_id', 'uhid patientId salutation first_name middle_name last_name phone gender dob')
    .populate('doctor_id', 'doctorId firstName lastName')
    .populate('department_id', 'name code')
    .sort({ appointment_date: 1, start_time: 1, serial_number: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs.map((row) => ({
    appointmentDate: row.appointment_date,
    token: row.token || row.serial_number || '—',
    uhid: patientUhid(row.patient_id),
    patient: personName(row.patient_id),
    mobile: row.patient_id?.phone || '—',
    ageGender: formatAgeGender(row.patient_id),
    visitType: row.appointment_type === 'follow-up' ? 'Revisit' : (row.appointment_type || 'New'),
    visitMode: row.visit_mode || row.type || '—',
    status: mode === 'visits' ? row.status : normalizeAppointmentStatus(row.status),
    priority: row.priority || '—',
    doctor: personName(row.doctor_id),
    department: departmentName(row.department_id),
    startTime: row.start_time,
    endTime: row.end_time,
    source: row.submissionSource || '—',
    cancellationReason: row.cancellationReason || '—'
  }));
}

// ============================================
// IPD Details
// ============================================

async function ipdDetails(hospitalId, filters = {}, kind = 'admission') {
  const Admission = model('IPDAdmission');

  if (!Admission) {
    return [];
  }

  const dateField = kind === 'discharge' || kind === 'death' || kind === 'medico'
    ? 'dischargeDate'
    : 'admissionDate';

  const match = {
    hospitalId: oid(hospitalId),
    ...range(dateField, filters)
  };

  safeMatchId(match, 'primaryDoctorId', filters.doctorId);
  safeMatchId(match, 'departmentId', filters.departmentId);

  if (kind === 'discharge') {
    match.status = { $in: ['Discharged', 'LAMA', 'DAMA', 'Expired'] };
  }

  if (kind === 'death') {
    match.status = 'Expired';
  }

  if (kind === 'medico') {
    match.$or = [
      { status: { $in: ['LAMA', 'DAMA', 'Expired'] } },
      { plannedDischargeType: 'TRANSFER' },
      { dischargeReason: { $regex: /(refer|transfer|request|dor)/i } }
    ];
  }

  const docs = await Admission.find(match)
    .populate('patientId', 'uhid patientId salutation first_name middle_name last_name phone gender dob address city state')
    .populate('primaryDoctorId', 'doctorId firstName lastName')
    .populate('departmentId', 'name code')
    .populate('wardId', 'name wardType type')
    .populate('bedId', 'bedNumber bed_number')
    .sort({ [dateField]: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs.map((row) => {
    const stayEnd = row.dischargeDate ? new Date(row.dischargeDate) : new Date();
    const stayStart = row.admissionDate ? new Date(row.admissionDate) : null;

    const lengthOfStay = stayStart && !Number.isNaN(stayStart.getTime()) && !Number.isNaN(stayEnd.getTime())
      ? Math.max(1, Math.ceil((stayEnd - stayStart) / 86400000))
      : '—';

    const medicoStatus = (() => {
      const text = `${row.status || ''} ${row.plannedDischargeType || ''} ${row.dischargeReason || ''}`.toUpperCase();

      if (text.includes('LAMA')) return 'LAMA';
      if (/DAMA|DOR|REQUEST/.test(text)) return 'DOR / DAMA';
      if (/EXPIRED|DEATH/.test(text)) return 'Death';
      if (/TRANSFER|REFER/.test(text)) return 'Referred';

      return '—';
    })();

    return {
      admissionNumber: row.admissionNumber || '—',
      uhid: patientUhid(row.patientId),
      patient: personName(row.patientId),
      mobile: row.patientId?.phone || '—',
      ageGender: formatAgeGender(row.patientId),
      admissionDate: row.admissionDate,
      dischargeDate: row.dischargeDate,
      status: row.status || '—',
      medicoStatus: kind === 'medico' ? medicoStatus : undefined,
      doctor: personName(row.primaryDoctorId),
      department: departmentName(row.departmentId),
      ward: row.wardId?.name || '—',
      bed: row.bedId?.bedNumber || row.bedId?.bed_number || '—',
      patientType: row.patientType || row.patient_type || '—',
      lengthOfStay,
      dischargeReason: row.dischargeReason || '—'
    };
  });
}

// ============================================
// Diagnostic Details
// ============================================

async function diagnosticDetails(name, hospitalId, filters = {}, tat = false) {
  const Model = model(name);

  if (!Model) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('requestedDate', filters)
  };

  safeMatchId(match, 'doctorId', filters.doctorId);

  const docs = await Model.find(match)
    .populate('patientId', 'uhid patientId salutation first_name middle_name last_name phone gender dob')
    .populate({
      path: 'doctorId',
      select: 'doctorId firstName lastName department',
      populate: {
        path: 'department',
        select: 'name code'
      }
    })
    .sort({ requestedDate: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs
    .filter((row) => {
      if (!filters.departmentId) return true;
      return String(row.doctorId?.department?._id || row.doctorId?.department || '') === String(filters.departmentId);
    })
    .filter((row) => !tat || row.releasedAt || row.reportedAt)
    .map((row) => {
      const completedAt = row.releasedAt || row.reportedAt;

      const turnaroundMinutes = completedAt && row.requestedDate
        ? Math.max(0, Math.round((new Date(completedAt) - new Date(row.requestedDate)) / 60000))
        : '—';

      return {
        requestNumber: row.requestNumber || row.orderNumber || row.accessionNumber || '—',
        uhid: patientUhid(row.patientId),
        patient: personName(row.patientId),
        requestedDate: row.requestedDate,
        test: row.testName || row.serviceName || '—',
        specimen: row.specimenType || row.specimen_type || row.sampleType || '—',
        status: row.status || '—',
        priority: row.priority || '—',
        doctor: personName(row.doctorId),
        department: departmentName(row.doctorId?.department),
        sampleCollectedAt: row.sampleCollectedAt || row.collectedAt,
        reportedAt: row.reportedAt,
        releasedAt: row.releasedAt,
        turnaroundMinutes
      };
    });
}

// ============================================
// Billing Details
// ============================================

async function billingDetails(hospitalId, filters = {}, refundsOnly = false) {
  const Invoice = model('Invoice');

  if (!Invoice) {
    return [];
  }

  const match = {
    hospital_id: oid(hospitalId),
    ...range('issue_date', filters)
  };

  if (refundsOnly) {
    match.status = { $in: ['Refunded', 'Cancelled'] };
  }

  const docs = await Invoice.find(match)
    .populate('patient_id', 'uhid patientId salutation first_name middle_name last_name phone gender dob')
    .populate({
      path: 'appointment_id',
      select: 'token doctor_id department_id appointment_date',
      populate: [
        { path: 'doctor_id', select: 'doctorId firstName lastName' },
        { path: 'department_id', select: 'name code' }
      ]
    })
    .populate({
      path: 'admission_id',
      select: 'admissionNumber primaryDoctorId departmentId admissionDate',
      populate: [
        { path: 'primaryDoctorId', select: 'doctorId firstName lastName' },
        { path: 'departmentId', select: 'name code' }
      ]
    })
    .sort({ issue_date: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs
    .filter((row) => {
      const doctor = row.appointment_id?.doctor_id || row.admission_id?.primaryDoctorId;
      const department = row.appointment_id?.department_id || row.admission_id?.departmentId;

      if (filters.doctorId && String(doctor?._id || doctor || '') !== String(filters.doctorId)) {
        return false;
      }

      if (filters.departmentId && String(department?._id || department || '') !== String(filters.departmentId)) {
        return false;
      }

      return true;
    })
    .map((row) => {
      const doctor = row.appointment_id?.doctor_id || row.admission_id?.primaryDoctorId;
      const department = row.appointment_id?.department_id || row.admission_id?.departmentId;

      return {
        issueDate: row.issue_date,
        invoiceNumber: row.invoice_number || row.bill_number || '—',
        encounterNumber: row.appointment_id?.token || row.admission_id?.admissionNumber || '—',
        uhid: patientUhid(row.patient_id),
        patient: personName(row.patient_id),
        mobile: row.patient_id?.phone || '—',
        invoiceType: row.invoice_type || '—',
        status: row.status || '—',
        total: Number(row.total || 0),
        amountPaid: Number(row.amount_paid || 0),
        balanceDue: Number(row.balance_due || 0),
        discount: Number(row.discount || row.bill_discount_total || 0),
        doctor: personName(doctor),
        department: departmentName(department),
        dueDate: row.due_date
      };
    });
}

// ============================================
// OT Details
// ============================================

async function otDetails(hospitalId, filters = {}, utilisation = false) {
  const OT = model('OTRequest');

  if (!OT) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('requestedDate', filters)
  };

  if (utilisation) {
    match.completedAt = { $ne: null };
  }

  const docs = await OT.find(match)
    .populate('patientId', 'uhid patientId salutation first_name middle_name last_name phone gender dob')
    .populate({
      path: 'doctorId',
      select: 'doctorId firstName lastName department',
      populate: {
        path: 'department',
        select: 'name code'
      }
    })
    .populate({
      path: 'primarySurgeonId',
      select: 'doctorId firstName lastName department',
      populate: {
        path: 'department',
        select: 'name code'
      }
    })
    .populate('otRoomId', 'name roomName roomNumber')
    .sort({ requestedDate: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs
    .filter((row) => {
      const surgeon = row.primarySurgeonId || row.doctorId;
      const department = surgeon?.department;

      if (filters.doctorId && String(surgeon?._id || surgeon || '') !== String(filters.doctorId)) {
        return false;
      }

      if (filters.departmentId && String(department?._id || department || '') !== String(filters.departmentId)) {
        return false;
      }

      return true;
    })
    .map((row) => {
      const surgeon = row.primarySurgeonId || row.doctorId;
      const department = surgeon?.department;

      const duration = row.startedAt && row.completedAt
        ? Math.max(0, Math.round((new Date(row.completedAt) - new Date(row.startedAt)) / 60000))
        : '—';

      return {
        requestNumber: row.requestNumber || '—',
        uhid: patientUhid(row.patientId),
        patient: personName(row.patientId),
        requestedDate: row.requestedDate,
        scheduledDate: row.scheduledDate || row.scheduledStart,
        procedure: row.procedureName || row.procedure_performed || '—',
        surgeon: personName(surgeon),
        department: departmentName(department),
        otRoom: row.otRoomId?.name || row.otRoomId?.roomName || row.otRoomId?.roomNumber || '—',
        status: row.status || '—',
        paymentStatus: row.paymentStatus || '—',
        total: Number(row.total_cost || 0),
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        durationMinutes: duration
      };
    });
}

// ============================================
// Procedure Details
// ============================================

async function procedureDetails(hospitalId, filters = {}) {
  const Procedure = model('ProcedureRequest');

  if (!Procedure) {
    return [];
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('requestedDate', filters)
  };

  safeMatchId(match, 'doctorId', filters.doctorId);

  const docs = await Procedure.find(match)
    .populate('patientId', 'uhid patientId salutation first_name middle_name last_name phone gender dob')
    .populate({
      path: 'doctorId',
      select: 'doctorId firstName lastName department',
      populate: {
        path: 'department',
        select: 'name code'
      }
    })
    .sort({ requestedDate: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs
    .filter((row) => {
      if (!filters.departmentId) return true;
      return String(row.doctorId?.department?._id || row.doctorId?.department || '') === String(filters.departmentId);
    })
    .map((row) => ({
      requestNumber: row.requestNumber || '—',
      uhid: patientUhid(row.patientId),
      patient: personName(row.patientId),
      requestedDate: row.requestedDate,
      scheduledDate: row.scheduledDate,
      procedure: row.procedureName || '—',
      status: row.status || '—',
      doctor: personName(row.doctorId),
      department: departmentName(row.doctorId?.department),
      priority: row.priority || '—',
      total: Number(row.cost || row.total_cost || 0)
    }));
}

// ============================================
// Pharmacy Details
// ============================================

async function pharmacyDetails(hospitalId, filters = {}) {
  const Prescription = model('Prescription');

  if (!Prescription) {
    return [];
  }

  const docs = await Prescription.find({
    hospitalId: oid(hospitalId),
    ...range('issue_date', filters)
  })
    .populate('patient_id', 'uhid patientId salutation first_name middle_name last_name phone gender dob')
    .populate('doctor_id', 'doctorId firstName lastName')
    .sort({ issue_date: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs.map((row) => ({
    issueDate: row.issue_date,
    prescriptionNumber: row.prescription_number || '—',
    uhid: patientUhid(row.patient_id),
    patient: personName(row.patient_id),
    doctor: personName(row.doctor_id),
    sourceType: row.source_type || '—',
    status: row.status || '—',
    itemCount: Array.isArray(row.items) ? row.items.length : 0,
    dispensedItems: Array.isArray(row.items)
      ? row.items.filter((item) => item.is_dispensed).length
      : 0
  }));
}

// ============================================
// Follow-up Details
// ============================================

async function followupDetails(hospitalId, filters = {}) {
  const opd = (await appointmentDetails(hospitalId, filters, 'followup'))
    .map((row) => ({ ...row, careSetting: 'OPD Follow-up' }));

  const Round = model('IPDRound');

  if (!Round) {
    return opd;
  }

  const match = {
    hospitalId: oid(hospitalId),
    ...range('roundDateTime', filters)
  };

  safeMatchId(match, 'doctorId', filters.doctorId);

  const rounds = await Round.find(match)
    .populate('doctorId', 'doctorId firstName lastName')
    .populate({
      path: 'admissionId',
      select: 'admissionNumber patientId departmentId wardId bedId',
      populate: [
        { path: 'patientId', select: 'uhid patientId salutation first_name middle_name last_name phone gender dob' },
        { path: 'departmentId', select: 'name code' },
        { path: 'wardId', select: 'name' },
        { path: 'bedId', select: 'bedNumber bed_number' }
      ]
    })
    .sort({ roundDateTime: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  const ipd = rounds
    .filter((row) => {
      if (!filters.departmentId) return true;
      return String(row.admissionId?.departmentId?._id || row.admissionId?.departmentId || '') === String(filters.departmentId);
    })
    .map((row) => ({
      appointmentDate: row.roundDateTime,
      token: row.admissionId?.admissionNumber || '—',
      uhid: patientUhid(row.admissionId?.patientId),
      patient: personName(row.admissionId?.patientId),
      careSetting: 'IPD Follow-up / Round',
      status: row.status || 'Completed',
      doctor: personName(row.doctorId),
      department: departmentName(row.admissionId?.departmentId),
      ward: row.admissionId?.wardId?.name || '—',
      bed: row.admissionId?.bedId?.bedNumber || row.admissionId?.bedId?.bed_number || '—'
    }));

  return [...opd, ...ipd].sort((a, b) =>
    new Date(a.appointmentDate || 0) - new Date(b.appointmentDate || 0)
  );
}

// ============================================
// Newborn Details
// ============================================

async function newbornDetails(hospitalId, filters = {}) {
  const Patient = model('Patient');

  if (!Patient) {
    return [];
  }

  const docs = await Patient.find({
    hospitalId: oid(hospitalId),
    ...range('dob', filters)
  })
    .select('uhid patientId salutation first_name middle_name last_name phone gender dob address city state createdAt')
    .sort({ dob: 1, createdAt: 1 })
    .limit(DETAIL_LIMIT)
    .lean();

  return docs.map((row) => ({
    dateOfBirth: row.dob,
    uhid: patientUhid(row),
    patient: personName(row),
    gender: row.gender || '—',
    mobile: row.phone || '—',
    address: [row.address, row.city, row.state].filter(Boolean).join(', ') || '—',
    registeredAt: row.createdAt
  }));
}

// ============================================
// Detail Rows for Report
// ============================================

async function detailRowsForReport(key, hospitalId, filters = {}) {
  if (key === 'opd-visits') {
    return appointmentDetails(hospitalId, filters, 'visits');
  }

  if (key === 'opd-ipd-followup') {
    return followupDetails(hospitalId, filters);
  }

  if (key === 'appointment-status' || key === 'opd') {
    return appointmentDetails(hospitalId, filters, 'status');
  }

  if (key === 'opd-cancelled') {
    return appointmentDetails(hospitalId, filters, 'cancelled');
  }

  if (key === 'ipd-admissions' || key === 'ipd') {
    return ipdDetails(hospitalId, filters, 'admission');
  }

  if (key === 'ipd-discharges') {
    return ipdDetails(hospitalId, filters, 'discharge');
  }

  if (key === 'ipd-bed-occupancy') {
    return bedOccupancy(hospitalId);
  }

  if (key === 'ipd-newborn') {
    return newbornDetails(hospitalId, filters);
  }

  if (key === 'ipd-deaths') {
    return ipdDetails(hospitalId, filters, 'death');
  }

  if (key === 'ipd-medico-status') {
    return ipdDetails(hospitalId, filters, 'medico');
  }

  if (key === 'lab-workload' || key === 'lab') {
    return diagnosticDetails('LabRequest', hospitalId, filters, false);
  }

  if (key === 'lab-tat') {
    return diagnosticDetails('LabRequest', hospitalId, filters, true);
  }

  if (key === 'radiology-workload' || key === 'radiology') {
    return diagnosticDetails('RadiologyRequest', hospitalId, filters, false);
  }

  if (key === 'radiology-tat') {
    return diagnosticDetails('RadiologyRequest', hospitalId, filters, true);
  }

  if (key === 'billing-revenue' || key === 'billing') {
    return billingDetails(hospitalId, filters, false);
  }

  if (key === 'billing-refunds') {
    return billingDetails(hospitalId, filters, true);
  }

  if (key === 'ot-cases' || key === 'ot') {
    return otDetails(hospitalId, filters, false);
  }

  if (key === 'ot-utilisation') {
    return otDetails(hospitalId, filters, true);
  }

  if (key === 'procedure-workload') {
    return procedureDetails(hospitalId, filters);
  }

  if (key === 'pharmacy-activity' || key === 'pharmacy') {
    return pharmacyDetails(hospitalId, filters);
  }

  return [];
}

// ============================================
// Cards Helper
// ============================================

function cardsFromRows(rows, type) {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);

  if (type === 'billing') {
    return [
      { label: 'Invoices', value: total },
      {
        label: 'Gross billed',
        value: rows.reduce((sum, row) => sum + Number(row.billed || row.value || 0), 0)
      },
      {
        label: 'Collected',
        value: rows.reduce((sum, row) => sum + Number(row.collected || row.quantity || 0), 0)
      },
      {
        label: 'Outstanding',
        value: rows.reduce((sum, row) => sum + Number(row.outstanding || 0), 0)
      }
    ];
  }

  if (type === 'tat') {
    return [
      { label: 'Completed reports', value: total },
      {
        label: 'Average TAT (minutes)',
        value: rows.length
          ? Math.round(rows.reduce((sum, row) => sum + Number(row.averageMinutes || 0), 0) / rows.length)
          : 0
      }
    ];
  }

  if (type === 'occupancy') {
    return [
      { label: 'Occupied beds / admitted patients', value: total }
    ];
  }

  return [
    { label: 'Total records', value: total }
  ];
}

// ============================================
// Build Operational Report
// ============================================

async function buildOperationalReport(key, hospitalId, filters = {}) {
  let rows = [];
  let cardType = 'default';

  if (key === 'opd-visits') {
    rows = await appointmentAggregate(hospitalId, filters, 'visits');
  } else if (key === 'opd-ipd-followup') {
    rows = await followupReport(hospitalId, filters);
  } else if (key === 'appointment-status' || key === 'opd') {
    rows = await appointmentAggregate(hospitalId, filters, 'status');
  } else if (key === 'opd-cancelled') {
    rows = await appointmentAggregate(hospitalId, filters, 'cancelled');
  } else if (key === 'ipd-admissions' || key === 'ipd') {
    rows = await ipdAggregate(hospitalId, filters, 'admission');
  } else if (key === 'ipd-discharges') {
    rows = await ipdAggregate(hospitalId, filters, 'discharge');
  } else if (key === 'ipd-bed-occupancy') {
    rows = await bedOccupancy(hospitalId);
    cardType = 'occupancy';
  } else if (key === 'ipd-newborn') {
    rows = await newbornReport(hospitalId, filters);
  } else if (key === 'ipd-deaths') {
    rows = await ipdAggregate(hospitalId, filters, 'death');
  } else if (key === 'ipd-medico-status') {
    rows = await ipdAggregate(hospitalId, filters, 'medico');
  } else if (key === 'lab-workload' || key === 'lab') {
    rows = await diagnosticWorkload('LabRequest', hospitalId, filters, false);
  } else if (key === 'lab-tat') {
    rows = await diagnosticWorkload('LabRequest', hospitalId, filters, true);
    cardType = 'tat';
  } else if (key === 'radiology-workload' || key === 'radiology') {
    rows = await diagnosticWorkload('RadiologyRequest', hospitalId, filters, false);
  } else if (key === 'radiology-tat') {
    rows = await diagnosticWorkload('RadiologyRequest', hospitalId, filters, true);
    cardType = 'tat';
  } else if (key === 'billing-revenue' || key === 'billing') {
    rows = await billingReport(hospitalId, filters, false);
    cardType = 'billing';
  } else if (key === 'billing-refunds') {
    rows = await billingReport(hospitalId, filters, true);
    cardType = 'billing';
  } else if (key === 'ot-cases' || key === 'ot') {
    rows = await otReport(hospitalId, filters, false);
  } else if (key === 'ot-utilisation') {
    rows = await otReport(hospitalId, filters, true);
    cardType = 'tat';
  } else if (key === 'procedure-workload') {
    rows = await procedureReport(hospitalId, filters);
  } else if (key === 'pharmacy-activity' || key === 'pharmacy') {
    rows = await pharmacyReport(hospitalId, filters);
  } else {
    return null;
  }

  const summaryRows = rows;
  let detailRows = [];

  try {
    detailRows = await detailRowsForReport(key, hospitalId, filters);
  } catch (error) {
    // Do not make an otherwise valid MIS summary fail because an optional detail
    // projection encountered legacy data. The summary remains available and the
    // API exposes the detail warning for support/audit visibility.
    return {
      cards: cardsFromRows(summaryRows, cardType),
      rows: summaryRows,
      summaryRows,
      detailWarning: error.message,
      series: { summary: summaryRows }
    };
  }

  return {
    cards: cardsFromRows(summaryRows, cardType),
    rows: detailRows.length ? detailRows : summaryRows,
    summaryRows,
    series: { summary: summaryRows }
  };
}

module.exports = {
  REPORT_CATALOG,
  buildOperationalReport,
  range,
  grain
};