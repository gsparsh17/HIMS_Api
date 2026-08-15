const mongoose = require('mongoose');
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
const patientFileManifest = require('./patientFileManifest.service');
const { appendDomainEvent } = require('./auditEvent.service');

// ============================================
// Helpers
// ============================================

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dateRange(query = {}, field = 'createdAt') {
  const filter = {};

  if (query.from || query.to) {
    filter[field] = {};

    if (query.from) {
      filter[field].$gte = new Date(`${query.from}T00:00:00.000`);
    }

    if (query.to) {
      filter[field].$lte = new Date(`${query.to}T23:59:59.999`);
    }
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

  if (query.from || query.to) {
    filter.dischargeDate = {};

    if (query.from) {
      filter.dischargeDate.$gte = new Date(`${query.from}T00:00:00.000`);
    }

    if (query.to) {
      filter.dischargeDate.$lte = new Date(`${query.to}T23:59:59.999`);
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
  const filter = { hospitalId };

  if (query.patientId && mongoose.isValidObjectId(query.patientId)) {
    filter.patientId = query.patientId;
  }

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
// Number Generator
// ============================================

function nextNumber(prefix) {
  return `${prefix}-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`;
}

// ============================================
// File Tracking
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
// Birth / Death Records
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
// Medico-Legal Records
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
// Medical Certificates
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

  const ipd = await IPDAdmission.find({
    hospitalId,
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
    const rows = await MRDBirthDeathRecord.find({
      hospitalId,
      recordType: 'birth',
      eventDateTime: { $gte: from, $lte: to },
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
    })
      .populate('patientId admissionId emergencyEncounterId')
      .sort({ registeredAt: -1 })
      .lean();

    const emergency = await EmergencyEncounter.find({
      hospitalId,
      'medicoLegal.isMlc': true,
      arrivalAt: { $gte: from, $lte: to },
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

module.exports = {
  listIpdRecords,
  listOpdRecords,
  listDischarges,
  listIncompleteRecords,
  listDocuments,
  createFileTracking,
  moveFile,
  createBirthDeath,
  createMlc,
  createCertificate,
  summary,
  report,
  paged,
  models: {
    MRDFileTracking,
    MRDBirthDeathRecord,
    MRDMedicalCertificate,
    MRDMedicoLegalRecord,
    MRDRecordReview,
  },
};