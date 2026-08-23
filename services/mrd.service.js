const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const { renderStructuredReportPdf } = require('./clinicalPdf.service');
const { buildReportPresentation } = require('./reportPresentation.service');
const IPDAdmission = require('../models/IPDAdmission');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Bed = require('../models/Bed');
const DischargeSummary = require('../models/DischargeSummary');
const EncounterDocument = require('../models/EncounterDocument');
const EmergencyEncounter = require('../models/EmergencyEncounter');
const MRDFileTracking = require('../models/MRDFileTracking');
const MRDBirthDeathRecord = require('../models/MRDBirthDeathRecord');
const MRDMedicalCertificate = require('../models/MRDMedicalCertificate');
const MRDMedicoLegalRecord = require('../models/MRDMedicoLegalRecord');
const MRDRecordReview = require('../models/MRDRecordReview');
const Hospital = require('../models/Hospital');
const patientFileManifest = require('./patientFileManifest.service');
const { appendDomainEvent } = require('./auditEvent.service');
const { semanticDateRange } = require('../utils/hospitalDateRange');

// ============================================
// Helpers
// ============================================

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dateRange(query = {}, field = 'createdAt') {
  const filter = {};

  if (query.from || query.to) {
    filter[field] = semanticDateRange(query.from, query.to);
  }

  return filter;
}

function pageOptions(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(query.limit || 30)));

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function allowedPatientIds(query = {}) {
  if (!Array.isArray(query.__allowedPatientIds)) return null;
  return query.__allowedPatientIds
    .map((value) => String(value || ''))
    .filter((value) => mongoose.isValidObjectId(value));
}

function patientFilterFor(query = {}, requestedPatientId = null) {
  const allowed = allowedPatientIds(query);
  if (allowed === null) {
    return requestedPatientId && mongoose.isValidObjectId(requestedPatientId)
      ? requestedPatientId
      : undefined;
  }
  if (requestedPatientId && mongoose.isValidObjectId(requestedPatientId)) {
    return allowed.includes(String(requestedPatientId))
      ? requestedPatientId
      : { $in: [] };
  }
  return { $in: allowed };
}

function patientName(patient) {
  return [patient?.salutation, patient?.first_name, patient?.middle_name, patient?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function daysInclusive(start, end) {
  const a = new Date(start);
  const b = new Date(end);

  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return 0;
  }

  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);

  return Math.max(0, Math.floor((b - a) / 86400000) + 1);
}

function disposition(admission) {
  const text = `${admission.status || ''} ${admission.plannedDischargeType || ''} ${admission.dischargeReason || ''}`.toUpperCase();

  if (/LAMA/.test(text)) return 'LAMA';
  if (/DAMA|DOR|REQUEST/.test(text)) return 'DOR/DAMA';
  if (/EXPIRED|DEATH|DIED/.test(text)) return 'Death';
  if (/TRANSFER|REFER/.test(text)) return 'Referred/Transferred';

  return 'Routine/Other';
}

// ============================================
// Paged Query Helper
// ============================================

async function paged(model, filter, query, populate = []) {
  const { page, limit, skip } = pageOptions(query);

  let cursor = model
    .find(filter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit);

  populate.forEach((field) => {
    cursor = cursor.populate(field);
  });

  const [rows, total] = await Promise.all([
    cursor.lean(),
    model.countDocuments(filter),
  ]);

  return {
    rows,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ============================================
// List IPD Records
// ============================================

async function listIpdRecords(hospitalId, query = {}) {
  const filter = {
    hospitalId,
    ...dateRange(query, 'admissionDate'),
  };

  const patientScope = patientFilterFor(query);
  if (patientScope !== undefined) filter.patientId = patientScope;

  if (query.status) {
    filter.status = query.status;
  }

  if (query.departmentId && mongoose.isValidObjectId(query.departmentId)) {
    filter.departmentId = query.departmentId;
  }

  if (query.doctorId && mongoose.isValidObjectId(query.doctorId)) {
    filter.primaryDoctorId = query.doctorId;
  }

  const result = await paged(IPDAdmission, filter, query, [
    'patientId',
    'primaryDoctorId',
    'departmentId',
    'wardId',
    'roomId',
    'bedId',
  ]);

  result.rows = result.rows.map((row) => ({
    ...row,
    patientName: patientName(row.patientId),
    uhid: row.patientId?.uhid || row.patientId?.patientId,
  }));

  return result;
}

// ============================================
// List OPD Records
// ============================================

async function listOpdRecords(hospitalId, query = {}) {
  const filter = {
    hospital_id: hospitalId,
    ...dateRange(query, 'appointment_date'),
  };

  const allowed = allowedPatientIds(query);
  if (allowed !== null) filter.patient_id = { $in: allowed };

  if (query.status) {
    filter.status = query.status;
  }

  if (query.departmentId && mongoose.isValidObjectId(query.departmentId)) {
    filter.department_id = query.departmentId;
  }

  if (query.doctorId && mongoose.isValidObjectId(query.doctorId)) {
    filter.doctor_id = query.doctorId;
  }

  if (query.q) {
    const patients = await Patient.find({
      hospitalId,
      ...(allowed !== null ? { _id: { $in: allowed } } : {}),
      $or: [
        { first_name: new RegExp(escapeRegex(query.q), 'i') },
        { last_name: new RegExp(escapeRegex(query.q), 'i') },
        { uhid: new RegExp(escapeRegex(query.q), 'i') },
        { patientId: new RegExp(escapeRegex(query.q), 'i') },
      ],
    })
      .select('_id')
      .limit(200)
      .lean();

    filter.patient_id = { $in: patients.map((patient) => patient._id) };
  }

  const result = await paged(Appointment, filter, query, [
    'patient_id',
    'doctor_id',
    'department_id',
  ]);

  result.rows = result.rows.map((row) => ({
    ...row,
    patientName: patientName(row.patient_id),
    uhid: row.patient_id?.uhid || row.patient_id?.patientId,
  }));

  return result;
}

// ============================================
// List Discharges
// ============================================

async function listDischarges(hospitalId, query = {}) {
  const filter = {
    hospitalId,
    $or: [
      { dischargeDate: { $ne: null } },
      { status: { $in: ['Discharged', 'LAMA', 'DAMA', 'Expired'] } },
    ],
  };
  const patientScope = patientFilterFor(query);
  if (patientScope !== undefined) filter.patientId = patientScope;

  if (query.from || query.to) {
    filter.dischargeDate = {};

    if (query.from) {
      Object.assign(filter.dischargeDate, semanticDateRange(query.from, null));
    }

    if (query.to) {
      Object.assign(filter.dischargeDate, semanticDateRange(null, query.to));
    }

    delete filter.$or;
  }

  if (query.departmentId && mongoose.isValidObjectId(query.departmentId)) {
    filter.departmentId = query.departmentId;
  }

  if (query.doctorId && mongoose.isValidObjectId(query.doctorId)) {
    filter.primaryDoctorId = query.doctorId;
  }

  const result = await paged(IPDAdmission, filter, query, [
    'patientId',
    'primaryDoctorId',
    'departmentId',
    'wardId',
    'roomId',
    'bedId',
  ]);

  const ids = result.rows.map((row) => row._id);

  const summaries = await DischargeSummary.find({
    hospitalId,
    admissionId: { $in: ids },
  }).lean();

  const byAdmission = new Map(
    summaries.map((summary) => [String(summary.admissionId), summary])
  );

  result.rows = result.rows.map((row) => ({
    ...row,
    patientName: patientName(row.patientId),
    uhid: row.patientId?.uhid || row.patientId?.patientId,
    dischargeSummary: byAdmission.get(String(row._id)) || null,
    disposition: disposition(row),
  }));

  return result;
}

// ============================================
// Sync Incomplete Record
// ============================================

async function syncIncompleteRecord(req, admission) {
  const manifest = await patientFileManifest.buildManifest(req, admission._id, {});

  const missing = manifest.documents.filter(
    (document) =>
      document.required &&
      !['Completed/Unsigned', 'Final/Signed'].includes(document.status)
  );

  let review = await MRDRecordReview.findOne({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
  });

  if (!review) {
    review = new MRDRecordReview({
      hospitalId: admission.hospitalId,
      admissionId: admission._id,
      patientId: admission.patientId,
    });
  }

  const prior = new Map(
    (review.deficiencies || []).map((deficiency) => [deficiency.key, deficiency])
  );

  review.deficiencies = missing.map((document) => {
    const old = prior.get(document.key);

    return {
      key: document.key,
      title: document.title,
      category: document.category,
      documentType: document.documentType,
      status: old?.status === 'waived' ? 'waived' : 'open',
      detectedAt: old?.detectedAt || new Date(),
      note: old?.note,
    };
  });

  review.lastScannedAt = new Date();

  const openDeficiencies = review.deficiencies.filter(
    (deficiency) => deficiency.status === 'open'
  );

  review.reviewStatus = openDeficiencies.length
    ? (review.reviewStatus === 'complete' ? 'pending' : review.reviewStatus)
    : 'complete';

  await review.save();

  return { review, manifest };
}

// ============================================
// List Incomplete Records
// ============================================

async function listIncompleteRecords(req, hospitalId, query = {}) {
  const base = {
    hospitalId,
    status: {
      $in: [
        'Discharged',
        'Discharge Summary Pending',
        'Billing Pending',
        'Payment Pending',
        'Ready for Discharge',
        'LAMA',
        'DAMA',
        'Expired',
      ],
    },
    ...dateRange(query, 'admissionDate'),
  };
  const patientScope = patientFilterFor(query);
  if (patientScope !== undefined) base.patientId = patientScope;

  const { page, limit, skip } = pageOptions(query);

  const admissions = await IPDAdmission
    .find(base)
    .sort({ dischargeDate: -1, admissionDate: -1 })
    .skip(skip)
    .limit(limit)
    .populate('patientId')
    .populate('primaryDoctorId')
    .populate('departmentId')
    .lean();

  const total = await IPDAdmission.countDocuments(base);
  const rows = [];

  for (const admission of admissions) {
    const synced = await syncIncompleteRecord(req, admission);
    const open = synced.review.deficiencies.filter(
      (deficiency) => deficiency.status === 'open'
    );

    if (!query.onlyIncomplete || open.length) {
      rows.push({
        admissionId: admission._id,
        admissionNumber: admission.admissionNumber,
        dischargeDate: admission.dischargeDate,
        patientId: admission.patientId?._id,
        patientName: patientName(admission.patientId),
        uhid: admission.patientId?.uhid || admission.patientId?.patientId,
        doctor: admission.primaryDoctorId,
        department: admission.departmentId,
        reviewStatus: synced.review.reviewStatus,
        missingCount: open.length,
        deficiencies: synced.review.deficiencies,
        lastScannedAt: synced.review.lastScannedAt,
      });
    }
  }

  return {
    rows,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ============================================
// List Documents
// ============================================

async function listDocuments(hospitalId, query = {}) {
  const filter = {
    hospitalId,
    ...dateRange(query, 'documentDate'),
  };

  const patientScope = patientFilterFor(query, query.patientId);
  if (patientScope !== undefined) filter.patientId = patientScope;

  if (query.admissionId && mongoose.isValidObjectId(query.admissionId)) {
    filter.admissionId = query.admissionId;
  }

  if (query.category) {
    filter.category = query.category;
  }

  if (query.documentType) {
    filter.documentType = query.documentType;
  }

  if (query.scanned === 'true') {
    filter.category = 'scanned_document';
  }

  return paged(EncounterDocument, filter, query, [
    'patientId',
    'admissionId',
    'authorUserId',
  ]);
}

// ============================================
// File Tracking
// ============================================

async function listFileTracking(hospitalId, query = {}) {
  const filter = {
    hospitalId,
    ...dateRange(query, 'updatedAt'),
  };

  if (query.status) {
    filter.status = query.status;
  }

  const patientScope = patientFilterFor(query, query.patientId);
  if (patientScope !== undefined) filter.patientId = patientScope;

  if (query.overdue === 'true') {
    filter.status = 'issued';
    filter.dueAt = { $lt: new Date() };
  }

  return paged(MRDFileTracking, filter, query, [
    'patientId',
    'admissionId',
    'appointmentId',
    'currentHolderUserId',
    'currentHolderDepartmentId',
  ]);
}

// ============================================
// Birth / Death Records
// ============================================

async function listBirthDeath(hospitalId, query = {}) {
  const filter = {
    hospitalId,
    ...dateRange(query, 'eventDateTime'),
  };

  if (query.recordType) {
    filter.recordType = query.recordType;
  }
  const allowed = allowedPatientIds(query);
  if (allowed !== null) {
    filter.$or = [
      { patientId: { $in: allowed } },
      { motherPatientId: { $in: allowed } },
      { babyPatientId: { $in: allowed } },
    ];
  }

  return paged(MRDBirthDeathRecord, filter, query, [
    'patientId',
    'motherPatientId',
    'babyPatientId',
    'admissionId',
    'attendingDoctorId',
    'departmentId',
    'wardId',
    'bedId',
  ]);
}

// ============================================
// Medico-Legal Records
// ============================================

async function listMlc(hospitalId, query = {}) {
  const filter = {
    hospitalId,
    ...dateRange(query, 'registeredAt'),
  };

  if (query.status) {
    filter.status = query.status;
  }
  const patientScope = patientFilterFor(query, query.patientId);
  if (patientScope !== undefined) filter.patientId = patientScope;

  return paged(MRDMedicoLegalRecord, filter, query, [
    'patientId',
    'admissionId',
    'emergencyEncounterId',
  ]);
}

// ============================================
// Medical Certificates
// ============================================

async function listCertificates(hospitalId, query = {}) {
  const filter = {
    hospitalId,
    ...dateRange(query, 'issueDate'),
  };

  if (query.status) {
    filter.status = query.status;
  }

  if (query.certificateType) {
    filter.certificateType = query.certificateType;
  }
  const patientScope = patientFilterFor(query, query.patientId);
  if (patientScope !== undefined) filter.patientId = patientScope;

  return paged(MRDMedicalCertificate, filter, query, [
    'patientId',
    'admissionId',
    'appointmentId',
    'authorizedByDoctorId',
    'authorizedByUserId',
  ]);
}

// ============================================
// Number Generator
// ============================================

function nextNumber(prefix) {
  return `${prefix}-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`;
}

// ============================================
// Create File Tracking
// ============================================

async function createFileTracking(req, hospitalId, body) {
  const row = await MRDFileTracking.create({
    ...body,
    hospitalId,
    fileNumber: body.fileNumber || nextNumber('MRD'),
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  await appendDomainEvent({
    req,
    eventType: 'mrd.file.created',
    entityType: 'MRDFileTracking',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId,
    afterSummary: {
      fileNumber: row.fileNumber,
      recordType: row.recordType,
    },
  });

  return row;
}

// ============================================
// Move File
// ============================================

async function moveFile(req, hospitalId, id, body) {
  const row = await MRDFileTracking.findOne({ _id: id, hospitalId });

  if (!row) {
    return null;
  }

  const action = body.action;
  const before = {
    status: row.status,
    holderType: row.currentHolderType,
    holderName: row.currentHolderName,
  };

  if (action === 'return') {
    row.currentHolderType = 'MRD';
    row.currentHolderName = 'MRD';
    row.currentHolderUserId = undefined;
    row.currentHolderDepartmentId = undefined;
    row.status = 'in_registry';
    row.lastReturnedAt = new Date();
    row.dueAt = undefined;

    row.movements.push({
      action: 'returned',
      fromHolderType: before.holderType,
      fromHolderName: before.holderName,
      toHolderType: 'MRD',
      toHolderName: 'MRD',
      performedBy: req.user._id,
      note: body.note,
    });
  } else if (action === 'lost') {
    row.status = 'lost';

    row.movements.push({
      action: 'marked_lost',
      fromHolderType: row.currentHolderType,
      fromHolderName: row.currentHolderName,
      performedBy: req.user._id,
      note: body.note,
    });
  } else if (action === 'archive') {
    row.status = 'archived';
    row.currentHolderType = 'MRD';
    row.currentHolderName = 'MRD Archive';

    row.movements.push({
      action: 'archived',
      performedBy: req.user._id,
      note: body.note,
    });
  } else {
    row.currentHolderType = body.toHolderType || 'Other';
    row.currentHolderName = body.toHolderName || body.toHolderType || 'Other';
    row.currentHolderUserId = body.toUserId || undefined;
    row.currentHolderDepartmentId = body.toDepartmentId || undefined;
    row.status = 'issued';
    row.lastIssuedAt = new Date();
    row.dueAt = body.dueAt ? new Date(body.dueAt) : undefined;

    row.movements.push({
      action: row.movements.length ? 'transferred' : 'issued',
      fromHolderType: before.holderType,
      fromHolderName: before.holderName,
      toHolderType: row.currentHolderType,
      toHolderName: row.currentHolderName,
      toUserId: row.currentHolderUserId,
      toDepartmentId: row.currentHolderDepartmentId,
      purpose: body.purpose,
      dueAt: row.dueAt,
      performedBy: req.user._id,
      note: body.note,
    });
  }

  row.updatedBy = req.user._id;
  await row.save();

  await appendDomainEvent({
    req,
    eventType: `mrd.file.${action || 'issued'}`,
    entityType: 'MRDFileTracking',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId,
    beforeSummary: before,
    afterSummary: {
      status: row.status,
      holderType: row.currentHolderType,
      holderName: row.currentHolderName,
      dueAt: row.dueAt,
    },
  });

  return row;
}

// ============================================
// Create Birth / Death
// ============================================

async function createBirthDeath(req, hospitalId, body) {
  const prefix = body.recordType === 'death' ? 'DTH' : 'BTH';

  const row = await MRDBirthDeathRecord.create({
    ...body,
    hospitalId,
    recordNumber: body.recordNumber || nextNumber(prefix),
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  await appendDomainEvent({
    req,
    eventType: `mrd.${body.recordType}.registered`,
    entityType: 'MRDBirthDeathRecord',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId || row.babyPatientId || row.motherPatientId,
    afterSummary: {
      recordNumber: row.recordNumber,
      eventDateTime: row.eventDateTime,
    },
  });

  return row;
}

// ============================================
// Create MLC
// ============================================

async function createMlc(req, hospitalId, body) {
  const row = await MRDMedicoLegalRecord.create({
    ...body,
    hospitalId,
    caseNumber: body.caseNumber || nextNumber('MLC'),
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  await appendDomainEvent({
    req,
    eventType: 'mrd.mlc.created',
    entityType: 'MRDMedicoLegalRecord',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId,
    afterSummary: {
      caseNumber: row.caseNumber,
      caseType: row.caseType,
    },
  });

  return row;
}

// ============================================
// Create Certificate
// ============================================

async function createCertificate(req, hospitalId, body) {
  const row = await MRDMedicalCertificate.create({
    ...body,
    hospitalId,
    certificateNumber: body.certificateNumber || nextNumber('CERT'),
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  await appendDomainEvent({
    req,
    eventType: 'mrd.certificate.created',
    entityType: 'MRDMedicalCertificate',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId,
    afterSummary: {
      certificateNumber: row.certificateNumber,
      certificateType: row.certificateType,
    },
  });

  return row;
}

// ============================================
// Summary
// ============================================

async function summary(hospitalId) {
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    ipd,
    opd,
    discharged,
    incomplete,
    filesIssued,
    filesOverdue,
    births,
    deaths,
    mlcOpen,
    certificates,
    scans,
  ] = await Promise.all([
    IPDAdmission.countDocuments({ hospitalId, status: { $nin: ['Cancelled'] } }),
    Appointment.countDocuments({ hospital_id: hospitalId }),
    IPDAdmission.countDocuments({ hospitalId, dischargeDate: { $ne: null } }),
    MRDRecordReview.countDocuments({ hospitalId, reviewStatus: { $ne: 'complete' } }),
    MRDFileTracking.countDocuments({ hospitalId, status: 'issued' }),
    MRDFileTracking.countDocuments({ hospitalId, status: 'issued', dueAt: { $lt: now } }),
    MRDBirthDeathRecord.countDocuments({
      hospitalId,
      recordType: 'birth',
      eventDateTime: { $gte: month },
    }),
    MRDBirthDeathRecord.countDocuments({
      hospitalId,
      recordType: 'death',
      eventDateTime: { $gte: month },
    }),
    MRDMedicoLegalRecord.countDocuments({ hospitalId, status: { $ne: 'closed' } }),
    MRDMedicalCertificate.countDocuments({
      hospitalId,
      issueDate: { $gte: month },
    }),
    EncounterDocument.countDocuments({ hospitalId, category: 'scanned_document' }),
  ]);

  return {
    ipdRecords: ipd,
    opdRecords: opd,
    dischargeRecords: discharged,
    incompleteRecords: incomplete,
    filesIssued,
    filesOverdue,
    birthsThisMonth: births,
    deathsThisMonth: deaths,
    openMlc: mlcOpen,
    certificatesThisMonth: certificates,
    scannedDocuments: scans,
  };
}

// ============================================
// Report Helpers
// ============================================

function periodKey(date, grain) {
  const d = new Date(date);

  if (grain === 'yearly') return `${d.getFullYear()}`;
  if (grain === 'daily') return d.toISOString().slice(0, 10);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodSeries(rows, dateField, grain = 'monthly') {
  const map = new Map();

  rows.forEach((row) => {
    const key = periodKey(row[dateField], grain);
    map.set(key, (map.get(key) || 0) + 1);
  });

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, count]) => ({ period, count }));
}

// ============================================
// Reports
// ============================================

async function report(hospitalId, key, query = {}) {
  const grain = ['daily', 'monthly', 'yearly'].includes(query.grain)
    ? query.grain
    : 'monthly';

  const from = query.from
    ? new Date(`${query.from}T00:00:00`)
    : new Date(new Date().getFullYear(), 0, 1);

  const to = query.to
    ? new Date(`${query.to}T23:59:59`)
    : new Date();

  const reportPatientScope = patientFilterFor(query);
  const ipd = await IPDAdmission.find({
    hospitalId,
    ...(reportPatientScope !== undefined ? { patientId: reportPatientScope } : {}),
    $or: [
      { admissionDate: { $lte: to }, dischargeDate: { $gte: from } },
      { admissionDate: { $lte: to }, dischargeDate: null },
    ],
  })
    .populate('patientId')
    .populate('primaryDoctorId')
    .populate('departmentId')
    .lean();

  const discharged = ipd.filter(
    (row) =>
      row.dischargeDate &&
      new Date(row.dischargeDate) >= from &&
      new Date(row.dischargeDate) <= to
  );

  // Admission Rate
  if (key === 'admission-rate') {
    const rows = ipd.filter(
      (row) =>
        new Date(row.admissionDate) >= from &&
        new Date(row.admissionDate) <= to
    );

    return {
      key,
      grain,
      rows: periodSeries(rows, 'admissionDate', grain),
      total: rows.length,
    };
  }

  // Discharge Rate
  if (key === 'discharge-rate') {
    return {
      key,
      grain,
      rows: periodSeries(discharged, 'dischargeDate', grain),
      total: discharged.length,
    };
  }

  // Admission-Discharge Average
  if (key === 'admission-discharge-average') {
    const admittedRows = ipd.filter(
      (row) =>
        new Date(row.admissionDate) >= from &&
        new Date(row.admissionDate) <= to
    );

    const periods = new Map();

    const touch = (period) => {
      if (!periods.has(period)) {
        periods.set(period, { period, admissions: 0, discharges: 0 });
      }
      return periods.get(period);
    };

    admittedRows.forEach((row) => {
      touch(periodKey(row.admissionDate, grain)).admissions++;
    });

    discharged.forEach((row) => {
      touch(periodKey(row.dischargeDate, grain)).discharges++;
    });

    const rows = [...periods.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((row) => ({
        ...row,
        admissionDischargeRatio: row.discharges
          ? Number((row.admissions / row.discharges).toFixed(2))
          : null,
      }));

    return {
      key,
      grain,
      rows,
      admissions: admittedRows.length,
      discharges: discharged.length,
      overallAdmissionDischargeRatio: discharged.length
        ? Number((admittedRows.length / discharged.length).toFixed(2))
        : null,
    };
  }

  // Average Length of Stay
  if (key === 'average-length-of-stay') {
    const stays = discharged
      .map((row) => daysInclusive(row.admissionDate, row.dischargeDate))
      .filter(Boolean);

    return {
      key,
      rows: discharged.map((row) => ({
        admissionNumber: row.admissionNumber,
        patient: patientName(row.patientId),
        uhid: row.patientId?.uhid || row.patientId?.patientId,
        admitted: row.admissionDate,
        discharged: row.dischargeDate,
        days: daysInclusive(row.admissionDate, row.dischargeDate),
      })),
      averageLengthOfStayDays: stays.length
        ? Number((stays.reduce((a, b) => a + b, 0) / stays.length).toFixed(2))
        : 0,
    };
  }

  // Bed Occupancy Rate
  if (key === 'bed-occupancy-rate') {
    const totalBeds = await Bed.countDocuments({ hospitalId, isActive: true });
    const days = Math.max(1, daysInclusive(from, to));

    let occupiedBedDays = 0;

    ipd.forEach((row) => {
      const start = new Date(
        Math.max(new Date(row.admissionDate).getTime(), from.getTime())
      );

      const end = new Date(
        Math.min(
          new Date(row.dischargeDate || to).getTime(),
          to.getTime()
        )
      );

      if (end >= start) {
        occupiedBedDays += daysInclusive(start, end);
      }
    });

    const availableBedDays = totalBeds * days;

    return {
      key,
      rows: [{
        totalBeds,
        days,
        occupiedBedDays,
        availableBedDays,
        occupancyRate: availableBedDays
          ? Number(((occupiedBedDays / availableBedDays) * 100).toFixed(2))
          : 0,
      }],
    };
  }

  // Missing Discharge Summary
  if (key === 'missing-discharge-summary') {
    const ids = discharged.map((row) => row._id);

    const summaries = await DischargeSummary.find({
      hospitalId,
      admissionId: { $in: ids },
    })
      .select('admissionId')
      .lean();

    const present = new Set(summaries.map((summary) => String(summary.admissionId)));

    const rows = discharged
      .filter((row) => !present.has(String(row._id)))
      .map((row) => ({
        admissionId: row._id,
        admissionNumber: row.admissionNumber,
        patient: patientName(row.patientId),
        uhid: row.patientId?.uhid || row.patientId?.patientId,
        dischargeDate: row.dischargeDate,
        doctor: [row.primaryDoctorId?.firstName, row.primaryDoctorId?.lastName]
          .filter(Boolean)
          .join(' '),
        department: row.departmentId?.name,
      }));

    return {
      key,
      rows,
      total: rows.length,
    };
  }

  // Mortality Rate
  if (key === 'mortality-rate') {
    const groups = new Map();

    discharged.forEach((row) => {
      const period = periodKey(row.dischargeDate, grain);

      if (!groups.has(period)) {
        groups.set(period, { period, discharges: 0, deaths: 0 });
      }

      const group = groups.get(period);
      group.discharges++;

      if (disposition(row) === 'Death') {
        group.deaths++;
      }
    });

    const rows = [...groups.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((group) => ({
        ...group,
        mortalityRate: group.discharges
          ? Number(((group.deaths / group.discharges) * 100).toFixed(2))
          : 0,
      }));

    const deaths = rows.reduce((sum, row) => sum + row.deaths, 0);

    return {
      key,
      grain,
      rows,
      deaths,
      discharges: discharged.length,
      mortalityRate: discharged.length
        ? Number(((deaths / discharged.length) * 100).toFixed(2))
        : 0,
    };
  }

  // Birth Reports
  if (key === 'birth-reports') {
    const allowed = allowedPatientIds(query);
    const rows = await MRDBirthDeathRecord.find({
      hospitalId,
      recordType: 'birth',
      eventDateTime: { $gte: from, $lte: to },
      ...(allowed !== null ? {
        $or: [
          { patientId: { $in: allowed } },
          { motherPatientId: { $in: allowed } },
          { babyPatientId: { $in: allowed } },
        ],
      } : {}),
    })
      .populate('motherPatientId babyPatientId attendingDoctorId departmentId')
      .sort({ eventDateTime: -1 })
      .lean();

    return {
      key,
      rows,
      total: rows.length,
    };
  }

  // MLC Reports
  if (key === 'mlc-reports') {
    const explicit = await MRDMedicoLegalRecord.find({
      hospitalId,
      registeredAt: { $gte: from, $lte: to },
      ...(reportPatientScope !== undefined ? { patientId: reportPatientScope } : {}),
    })
      .populate('patientId admissionId emergencyEncounterId')
      .sort({ registeredAt: -1 })
      .lean();

    const emergency = await EmergencyEncounter.find({
      hospitalId,
      'medicoLegal.isMlc': true,
      arrivalAt: { $gte: from, $lte: to },
      ...(reportPatientScope !== undefined ? { patientId: reportPatientScope } : {}),
    })
      .populate('patientId')
      .lean();

    const knownEmergencyIds = new Set(
      explicit.map((row) => String(row.emergencyEncounterId?._id || row.emergencyEncounterId || ''))
    );

    const derived = emergency
      .filter((row) => !knownEmergencyIds.has(String(row._id)))
      .map((row) => ({
        source: 'EmergencyEncounter',
        patientId: row.patientId,
        caseNumber: row.medicoLegal?.caseNumber,
        policeStation: row.medicoLegal?.policeStation,
        policeInformedAt: row.medicoLegal?.policeInformedAt,
        registeredAt: row.arrivalAt,
        status: 'open',
        notes: row.medicoLegal?.notes,
      }));

    return {
      key,
      rows: [...explicit, ...derived],
      total: explicit.length + derived.length,
    };
  }

  // Medico Report
  if (key === 'medico-report') {
    const groups = discharged.reduce((acc, row) => {
      const status = disposition(row);
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    return {
      key,
      rows: Object.entries(groups).map(([status, count]) => ({ status, count })),
      total: discharged.length,
    };
  }

  // Medical File Tracking
  if (key === 'medical-file-tracking') {
    const rows = await MRDFileTracking.find({
      hospitalId,
      ...dateRange(query, 'updatedAt'),
      ...(reportPatientScope !== undefined ? { patientId: reportPatientScope } : {}),
    })
      .populate('patientId currentHolderDepartmentId')
      .sort({ updatedAt: -1 })
      .lean();

    return {
      key,
      rows,
      total: rows.length,
      overdue: rows.filter(
        (row) => row.status === 'issued' && row.dueAt && new Date(row.dueAt) < new Date()
      ).length,
    };
  }

  throw Object.assign(new Error('Unknown MRD report'), { statusCode: 404 });
}

// ============================================
// Export Helpers
// ============================================

const MRD_EXPORT_TITLES = {
  'ipd-records': 'IPD Medical Record',
  'opd-records': 'OPD Record',
  discharges: 'Discharge Record',
  'file-tracking': 'Medical File Tracking',
  incomplete: 'Incomplete Record Management',
  documents: 'Document Management',
  'birth-death': 'Birth & Death Register',
  mortality: 'Mortality Record',
  mlc: 'MLC / Medico-Legal Record',
  certificates: 'Medical Certificate Management',
  archive: 'Record Scanning & Digital Archive',
  reports: 'MRD Report',
};

const MRD_REPORT_TITLES = {
  'admission-rate': 'Admission Rate',
  'discharge-rate': 'Discharge Rate',
  'admission-discharge-average': 'Admission / Discharge Average',
  'average-length-of-stay': 'Average Length of Stay',
  'bed-occupancy-rate': 'Bed Occupancy Rate',
  'missing-discharge-summary': 'Missing Discharge Summary Details',
  'mortality-rate': 'Mortality Rate',
  'birth-reports': 'Birth Reports',
  'mlc-reports': 'MLC Reports',
  'medico-report': 'Medico Report',
  'medical-file-tracking': 'Medical File Tracking Report',
};

function personLabel(value) {
  if (!value) return '—';

  return value.name ||
    [value.salutation, value.first_name, value.middle_name, value.last_name, value.firstName, value.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    '—';
}

function referenceLabel(value) {
  if (!value) return '—';

  if (typeof value !== 'object') {
    return String(value);
  }

  return value.name ||
    value.wardName ||
    value.roomNumber ||
    value.bedNumber ||
    value.code ||
    value._id?.toString?.() ||
    '—';
}

function formatExportDate(value, withTime = false) {
  if (!value) return '—';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return withTime
    ? date.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : date.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
      });
}

function scalarExportValue(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (value instanceof Date) {
    return formatExportDate(value, true);
  }

  if (typeof value === 'object') {
    const label = personLabel(value);

    if (label !== '—') {
      return label;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function humanizeKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function collectAll(loader, query = {}, maxRows = 10000) {
  const rows = [];
  let page = 1;
  let total = Infinity;

  while (rows.length < total && rows.length < maxRows) {
    const result = await loader({ ...query, page, limit: 200 });
    const batch = result?.rows || [];

    rows.push(...batch);
    total = Number(result?.total ?? rows.length);

    if (!batch.length || page * 200 >= total) {
      break;
    }

    page += 1;
  }

  return rows.slice(0, maxRows);
}

function normalizeRecordRows(section, rows) {
  if (section === 'ipd-records' || section === 'discharges') {
    return rows.map((row) => ({
      'IP No.': row.admissionNumber || '—',
      UHID: row.uhid || row.patientId?.uhid || row.patientId?.patientId || '—',
      Patient: row.patientName || personLabel(row.patientId),
      'Admission Date': formatExportDate(row.admissionDate),
      'Discharge Date': formatExportDate(row.dischargeDate),
      Doctor: personLabel(row.primaryDoctorId),
      Department: referenceLabel(row.departmentId),
      Ward: referenceLabel(row.wardId),
      Room: referenceLabel(row.roomId),
      Bed: referenceLabel(row.bedId),
      Status: row.status || '—',
      ...(section === 'discharges' ? { Disposition: row.disposition || disposition(row) } : {}),
    }));
  }

  if (section === 'opd-records') {
    return rows.map((row) => ({
      'OP / Token': row.token || row.serial_number || '—',
      UHID: row.uhid || row.patient_id?.uhid || row.patient_id?.patientId || '—',
      Patient: row.patientName || personLabel(row.patient_id),
      'Visit Date': formatExportDate(row.appointment_date),
      Doctor: personLabel(row.doctor_id),
      Department: referenceLabel(row.department_id),
      'Visit Type': row.appointment_type || '—',
      Status: row.status || '—',
    }));
  }

  if (section === 'incomplete') {
    return rows.map((row) => ({
      'IP No.': row.admissionNumber || '—',
      UHID: row.uhid || '—',
      Patient: row.patientName || '—',
      'Discharge Date': formatExportDate(row.dischargeDate),
      Doctor: personLabel(row.doctor),
      Department: referenceLabel(row.department),
      'Review Status': row.reviewStatus || '—',
      'Open Deficiencies': row.missingCount ?? 0,
      'Deficiency Details': (row.deficiencies || [])
        .filter((d) => d.status === 'open')
        .map((d) => `${d.title}${d.category ? ` (${d.category})` : ''}`)
        .join('; ') || 'None',
    }));
  }

  if (section === 'documents' || section === 'archive') {
    return rows.map((row) => ({
      Date: formatExportDate(row.documentDate || row.createdAt, true),
      UHID: row.patientId?.uhid || row.patientId?.patientId || '—',
      Patient: personLabel(row.patientId),
      Document: row.title || '—',
      Category: row.category || '—',
      Type: row.documentType || '—',
      Status: row.status || '—',
      Author: row.authorName || personLabel(row.authorUserId),
      File: row.fileUrl || '—',
    }));
  }

  if (section === 'file-tracking') {
    return rows.map((row) => ({
      'MRD File No.': row.fileNumber || '—',
      UHID: row.patientId?.uhid || row.patientId?.patientId || '—',
      Patient: personLabel(row.patientId),
      Type: row.recordType || '—',
      'Current Holder': `${row.currentHolderType || ''}${row.currentHolderName ? ` - ${row.currentHolderName}` : ''}` || '—',
      Status: row.status || '—',
      Due: formatExportDate(row.dueAt),
      'Last Updated': formatExportDate(row.updatedAt, true),
    }));
  }

  if (section === 'birth-death' || section === 'mortality') {
    return rows.map((row) => ({
      'Record No.': row.recordNumber || '—',
      Type: row.recordType || '—',
      'Event Date / Time': formatExportDate(row.eventDateTime, true),
      UHID: (row.patientId || row.babyPatientId || row.motherPatientId)?.uhid ||
        (row.patientId || row.babyPatientId || row.motherPatientId)?.patientId || '—',
      Patient: personLabel(row.patientId || row.babyPatientId || row.motherPatientId),
      Gender: row.gender || '—',
      'Cause of Death': row.causeOfDeath || '—',
      Certificate: row.certificateNumber || '—',
      Status: row.registrationStatus || '—',
    }));
  }

  if (section === 'mlc') {
    return rows.map((row) => ({
      'MLC No.': row.caseNumber || '—',
      UHID: row.patientId?.uhid || row.patientId?.patientId || '—',
      Patient: personLabel(row.patientId),
      'Case Type': row.caseType || '—',
      Registered: formatExportDate(row.registeredAt, true),
      'Police Station': row.policeStation || '—',
      FIR: row.firNumber || '—',
      Status: row.status || '—',
    }));
  }

  if (section === 'certificates') {
    return rows.map((row) => ({
      'Certificate No.': row.certificateNumber || '—',
      UHID: row.patientId?.uhid || row.patientId?.patientId || '—',
      Patient: personLabel(row.patientId),
      Type: row.certificateType || '—',
      'Issue Date': formatExportDate(row.issueDate),
      'Valid From': formatExportDate(row.validFrom),
      'Valid To': formatExportDate(row.validTo),
      'Authorized Doctor': personLabel(row.authorizedByDoctorId),
      Status: row.status || '—',
    }));
  }

  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row || {})
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, value]) => [humanizeKey(key), scalarExportValue(value)])
    )
  );
}

// ============================================
// Build Export Dataset
// ============================================

async function buildExportDataset(req, hospitalId, section, query = {}) {
  if (!MRD_EXPORT_TITLES[section]) {
    throw Object.assign(new Error('Unsupported MRD export section'), { statusCode: 400 });
  }

  let rows = [];
  let metrics = {};
  let title = MRD_EXPORT_TITLES[section];

  if (section === 'ipd-records') {
    rows = await collectAll((q) => listIpdRecords(hospitalId, q), query);
  } else if (section === 'opd-records') {
    rows = await collectAll((q) => listOpdRecords(hospitalId, q), query);
  } else if (section === 'discharges') {
    rows = await collectAll((q) => listDischarges(hospitalId, q), query);
  } else if (section === 'incomplete') {
    rows = await collectAll(
      (q) => listIncompleteRecords(req, hospitalId, { ...q, onlyIncomplete: true }),
      query
    );
  } else if (section === 'documents') {
    rows = await collectAll((q) => listDocuments(hospitalId, q), query);
  } else if (section === 'archive') {
    rows = await collectAll((q) => listDocuments(hospitalId, { ...q, scanned: true }), query);
  } else if (section === 'file-tracking') {
    rows = await collectAll((q) => listFileTracking(hospitalId, q), query);
  } else if (section === 'birth-death') {
    rows = await collectAll((q) => listBirthDeath(hospitalId, q), query);
  } else if (section === 'mortality') {
    rows = await collectAll(
      (q) => listBirthDeath(hospitalId, { ...q, recordType: 'death' }),
      query
    );
  } else if (section === 'mlc') {
    rows = await collectAll((q) => listMlc(hospitalId, q), query);
  } else if (section === 'certificates') {
    rows = await collectAll((q) => listCertificates(hospitalId, q), query);
  } else if (section === 'reports') {
    if (!query.reportKey || !MRD_REPORT_TITLES[query.reportKey]) {
      throw Object.assign(new Error('reportKey is required for MRD report export'), {
        statusCode: 400,
      });
    }

    const result = await report(hospitalId, query.reportKey, query);
    rows = result.rows || [];

    metrics = Object.fromEntries(
      Object.entries(result)
        .filter(
          ([key, value]) =>
            !['key', 'rows', 'grain'].includes(key) &&
            ['string', 'number', 'boolean'].includes(typeof value)
        )
        .map(([key, value]) => [humanizeKey(key), value])
    );

    title = MRD_REPORT_TITLES[query.reportKey];
  }

  const normalized = section === 'reports'
    ? normalizeRecordRows('reports', rows)
    : normalizeRecordRows(section, rows);

  const presentation = buildReportPresentation({
    context: 'mrd',
    section: section === 'reports' ? 'reports' : section,
    key: query.reportKey || section,
    rows: normalized,
  });

  return {
    section,
    title,
    rows: normalized,
    presentation,
    metrics: {
      'Total Records': normalized.length,
      ...metrics,
    },
    filters: {
      from: query.from || '',
      to: query.to || '',
      period: query.grain || '',
    },
  };
}

// ============================================
// Export Rendering
// ============================================

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportFilename(title, format) {
  const safe = String(title || 'mrd-report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `${safe || 'mrd-report'}-${new Date().toISOString().slice(0, 10)}.${format}`;
}

async function renderExport(dataset, format, hospitalId) {
  const hospital = await Hospital.findById(hospitalId)
    .select('name hospitalName address city state pinCode contact phone phoneNumber email logo')
    .lean();

  const hospitalName = hospital?.hospitalName || hospital?.name || 'Hospital';
  const exportRows = dataset.presentation?.rows || dataset.rows || [];
  const exportColumns = dataset.presentation?.columns ||
    [...new Set(exportRows.flatMap((row) => Object.keys(row || {})))]
      .map((key) => ({ key, label: key }));

  const columns = exportColumns.map((column) => column.label || column.key);
  const metaRows = [
    [hospitalName],
    [dataset.title],
    [`Period: ${dataset.filters.from || 'All'} to ${dataset.filters.to || 'All'}${dataset.filters.period ? ` | ${dataset.filters.period}` : ''}`],
    [`Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`],
    ...Object.entries(dataset.metrics || {}).map(([key, value]) => [`${key}: ${value}`]),
    [],
  ];

  const dataRows = [
    columns,
    ...exportRows.map((row) =>
      exportColumns.map((column) => scalarExportValue(row[column.key || column]))
    ),
  ];

  if (format === 'csv') {
    const lines = [...metaRows, ...dataRows].map((row) => row.map(csvEscape).join(','));

    return {
      output: Buffer.from(`\ufeff${lines.join('\r\n')}`, 'utf8'),
      filename: exportFilename(dataset.title, 'csv'),
      mimeType: 'text/csv; charset=utf-8',
      rowCount: dataset.rows.length,
    };
  }

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MediQliq HMS';

    const sheet = workbook.addWorksheet('MRD Report', {
      views: [{ state: 'frozen', ySplit: metaRows.length + 1 }],
    });

    metaRows.forEach((row) => sheet.addRow(row));

    const headerRow = sheet.addRow(columns);
    headerRow.font = { bold: true };

    exportRows.forEach((row) =>
      sheet.addRow(exportColumns.map((column) => scalarExportValue(row[column.key || column])))
    );

    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.getRow(2).font = { bold: true, size: 12 };

    sheet.columns.forEach((column) => {
      column.width = Math.min(
        45,
        Math.max(
          12,
          ...(column.values || []).map((value) => String(value ?? '').length + 2)
        )
      );
    });

    if (columns.length) {
      sheet.autoFilter = {
        from: { row: metaRows.length + 1, column: 1 },
        to: { row: metaRows.length + 1, column: columns.length },
      };
    }

    const output = Buffer.from(await workbook.xlsx.writeBuffer());

    return {
      output,
      filename: exportFilename(dataset.title, 'xlsx'),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      rowCount: dataset.rows.length,
    };
  }

  // PDF
  const output = await renderStructuredReportPdf({
    hospital: hospital || {},
    title: dataset.title,
    subtitle: 'Medical Records Department',
    filters: dataset.filters || {},
    metrics: Object.entries(dataset.metrics || {}).map(([label, value]) => ({
      label,
      value,
    })),
    rows: exportRows,
    columns: exportColumns,
    generatedAt: new Date(),
    footerLabel: 'MediQliq HMS · Medical Records Department report',
    preparedBy: 'MRD Desk',
  });

  return {
    output,
    filename: exportFilename(dataset.title, 'pdf'),
    mimeType: 'application/pdf',
    rowCount: dataset.rows.length,
  };
}

async function exportSection(req, hospitalId, section, format, query = {}) {
  const dataset = await buildExportDataset(req, hospitalId, section, query);
  return renderExport(dataset, format, hospitalId);
}

module.exports = {
  listIpdRecords,
  listOpdRecords,
  listDischarges,
  listIncompleteRecords,
  listDocuments,
  listFileTracking,
  listBirthDeath,
  listMlc,
  listCertificates,
  createFileTracking,
  moveFile,
  createBirthDeath,
  createMlc,
  createCertificate,
  summary,
  report,
  paged,
  exportSection,
  buildExportDataset,
  models: {
    MRDFileTracking,
    MRDBirthDeathRecord,
    MRDMedicalCertificate,
    MRDMedicoLegalRecord,
    MRDRecordReview,
  },
};