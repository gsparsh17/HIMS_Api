const mrd = require('../services/mrd.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { buildReportPresentation } = require('../services/reportPresentation.service');
const { accessiblePatientIds, autoPurpose, assertPatientAccess } = require('../services/patientAccessPolicy.service');

// ============================================
// Helpers
// ============================================

function asyncHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function listFilter(req, extra = {}) {
  return {
    hospitalId: requireHospitalId(req),
    ...extra
  };
}

async function scopedQuery(req, query = req.query) {
  const hospitalId = requireHospitalId(req);
  const ids = await accessiblePatientIds(req.user, hospitalId, autoPurpose(req.user));
  return Array.isArray(ids) ? { ...query, __allowedPatientIds: ids } : { ...query };
}

async function requirePatientContext(req, patientId, purpose = 'AUTO', scope = 'clinical_read') {
  if (!patientId) return null;
  return assertPatientAccess({
    user: req.user,
    patientId,
    hospitalId: requireHospitalId(req),
    purpose,
    scope,
  });
}

async function requireAnyPatientContexts(req, ids = [], purpose = 'AUTO', scope = 'clinical_read') {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  for (const patientId of unique) {
    await requirePatientContext(req, patientId, purpose, scope);
  }
}

// ============================================
// Lookup Endpoints
// ============================================

exports.lookupPatients = asyncHandler(async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const Patient = require('../models/Patient');

  const query = String(req.query.q || '').trim();
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const filter = { hospitalId };
  const allowed = await accessiblePatientIds(req.user, hospitalId, autoPurpose(req.user));
  if (Array.isArray(allowed)) filter._id = { $in: allowed };

  if (query) {
    filter.$or = [
      { first_name: new RegExp(escaped, 'i') },
      { last_name: new RegExp(escaped, 'i') },
      { uhid: new RegExp(escaped, 'i') },
      { patientId: new RegExp(escaped, 'i') },
      { phone: new RegExp(escaped, 'i') }
    ];
  }

  const rows = await Patient
    .find(filter)
    .select('uhid patientId first_name middle_name last_name phone gender dob')
    .sort({ updatedAt: -1 })
    .limit(30)
    .lean();

  res.json({
    success: true,
    data: rows.map((patient) => ({
      ...patient,
      name: [patient.first_name, patient.middle_name, patient.last_name]
        .filter(Boolean)
        .join(' ')
    }))
  });
});

exports.lookupDoctors = asyncHandler(async (req, res) => {
  const Doctor = require('../models/Doctor');

  const rows = await Doctor
    .find({ hospitalId: requireHospitalId(req) })
    .select('doctorId firstName lastName department specialization')
    .populate('department', 'name')
    .sort({ firstName: 1 })
    .lean();

  res.json({
    success: true,
    data: rows.map((doctor) => ({
      ...doctor,
      name: [doctor.firstName, doctor.lastName].filter(Boolean).join(' ')
    }))
  });
});

exports.lookupDepartments = asyncHandler(async (req, res) => {
  const Department = require('../models/Department');

  const rows = await Department
    .find({
      hospitalId: requireHospitalId(req),
      active: { $ne: false }
    })
    .select('code name departmentClass departmentType')
    .sort({ displayOrder: 1, name: 1 })
    .lean();

  res.json({
    success: true,
    data: rows
  });
});

// ============================================
// Summary & Records
// ============================================

exports.summary = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.summary(requireHospitalId(req))
  });
});

exports.ipdRecords = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listIpdRecords(requireHospitalId(req), await scopedQuery(req))
  });
});

exports.opdRecords = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listOpdRecords(requireHospitalId(req), await scopedQuery(req))
  });
});

exports.discharges = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listDischarges(requireHospitalId(req), await scopedQuery(req))
  });
});

// ============================================
// Incomplete Records
// ============================================

exports.incompleteRecords = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listIncompleteRecords(req, requireHospitalId(req), await scopedQuery(req))
  });
});

exports.updateIncompleteReview = asyncHandler(async (req, res) => {
  const hospitalId = requireHospitalId(req);

  const row = await mrd.models.MRDRecordReview.findOne({
    hospitalId,
    admissionId: req.params.admissionId
  });

  if (!row) {
    return res.status(404).json({
      success: false,
      error: 'MRD review not found. Open/refresh the incomplete-record queue first.'
    });
  }

  await requirePatientContext(req, row.patientId);

  const { key, status, note, reviewStatus, reviewNote } = req.body || {};

  if (key) {
    const deficiency = row.deficiencies.find((deficiency) => deficiency.key === key);

    if (!deficiency) {
      return res.status(404).json({
        success: false,
        error: 'Deficiency not found'
      });
    }

    if (['resolved', 'waived', 'open'].includes(status)) {
      deficiency.status = status;
    }

    deficiency.note = note !== undefined ? note : deficiency.note;

    if (status === 'resolved' || status === 'waived') {
      deficiency.resolvedAt = new Date();
      deficiency.resolvedBy = req.user._id;
    }

    if (status === 'open') {
      deficiency.resolvedAt = undefined;
      deficiency.resolvedBy = undefined;
    }
  }

  if (['pending', 'in_review', 'complete'].includes(reviewStatus)) {
    row.reviewStatus = reviewStatus;
  }

  if (reviewNote !== undefined) {
    row.reviewNote = reviewNote;
  }

  row.reviewedBy = req.user._id;
  row.reviewedAt = new Date();

  if (!row.deficiencies.some((deficiency) => deficiency.status === 'open')) {
    row.reviewStatus = 'complete';
  }

  await row.save();

  await appendDomainEvent({
    req,
    eventType: 'mrd.incomplete_record.reviewed',
    entityType: 'MRDRecordReview',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId,
    encounterId: row.admissionId,
    afterSummary: {
      reviewStatus: row.reviewStatus,
      openDeficiencies: row.deficiencies.filter((deficiency) => deficiency.status === 'open').length
    }
  });

  res.json({
    success: true,
    data: row
  });
});

// ============================================
// Documents
// ============================================

exports.documents = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listDocuments(requireHospitalId(req), await scopedQuery(req))
  });
});

// ============================================
// File Tracking
// ============================================

exports.fileTrackingList = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listFileTracking(requireHospitalId(req), await scopedQuery(req))
  });
});

exports.fileTrackingCreate = asyncHandler(async (req, res) => {
  if (!req.body?.patientId) {
    return res.status(400).json({
      success: false,
      error: 'patientId is required'
    });
  }

  await requirePatientContext(req, req.body.patientId);
  const row = await mrd.createFileTracking(req, requireHospitalId(req), req.body);

  res.status(201).json({
    success: true,
    data: row
  });
});

exports.fileTrackingMove = asyncHandler(async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const existing = await mrd.models.MRDFileTracking.findOne({ _id: req.params.id, hospitalId }).select('patientId').lean();
  if (existing?.patientId) await requirePatientContext(req, existing.patientId);
  const row = await mrd.moveFile(req, hospitalId, req.params.id, req.body || {});

  if (!row) {
    return res.status(404).json({
      success: false,
      error: 'Medical file not found'
    });
  }

  res.json({
    success: true,
    data: row
  });
});

// ============================================
// Birth / Death Records
// ============================================

exports.birthDeathList = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listBirthDeath(requireHospitalId(req), await scopedQuery(req))
  });
});

exports.birthDeathCreate = asyncHandler(async (req, res) => {
  if (!['birth', 'death'].includes(req.body?.recordType)) {
    return res.status(400).json({
      success: false,
      error: 'recordType must be birth or death'
    });
  }

  if (!req.body?.eventDateTime) {
    return res.status(400).json({
      success: false,
      error: 'eventDateTime is required'
    });
  }

  await requireAnyPatientContexts(req, [req.body.patientId, req.body.motherPatientId, req.body.babyPatientId]);
  const row = await mrd.createBirthDeath(req, requireHospitalId(req), req.body);

  res.status(201).json({
    success: true,
    data: row
  });
});

exports.birthDeathUpdate = asyncHandler(async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const existing = await mrd.models.MRDBirthDeathRecord.findOne({ _id: req.params.id, hospitalId })
    .select('patientId motherPatientId babyPatientId')
    .lean();
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Birth/death record not found' });
  }
  await requireAnyPatientContexts(req, [
    existing.patientId, existing.motherPatientId, existing.babyPatientId,
    req.body?.patientId, req.body?.motherPatientId, req.body?.babyPatientId,
  ]);

  const body = {
    ...req.body,
    updatedBy: req.user._id
  };

  delete body.hospitalId;
  delete body.recordNumber;
  delete body.createdBy;

  const row = await mrd.models.MRDBirthDeathRecord.findOneAndUpdate(
    { _id: req.params.id, hospitalId },
    { $set: body },
    { new: true, runValidators: true }
  );

  if (!row) {
    return res.status(404).json({
      success: false,
      error: 'Birth/death record not found'
    });
  }

  await appendDomainEvent({
    req,
    eventType: `mrd.${row.recordType}.updated`,
    entityType: 'MRDBirthDeathRecord',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId || row.babyPatientId || row.motherPatientId,
    afterSummary: {
      recordNumber: row.recordNumber,
      registrationStatus: row.registrationStatus
    }
  });

  res.json({
    success: true,
    data: row
  });
});

// ============================================
// Medico-Legal Cases
// ============================================

exports.mlcList = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listMlc(requireHospitalId(req), await scopedQuery(req))
  });
});

exports.mlcCreate = asyncHandler(async (req, res) => {
  if (!req.body?.patientId) {
    return res.status(400).json({
      success: false,
      error: 'patientId is required'
    });
  }

  await requirePatientContext(req, req.body.patientId);
  const row = await mrd.createMlc(req, requireHospitalId(req), req.body);

  res.status(201).json({
    success: true,
    data: row
  });
});

exports.mlcUpdate = asyncHandler(async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const existing = await mrd.models.MRDMedicoLegalRecord.findOne({ _id: req.params.id, hospitalId })
    .select('patientId')
    .lean();
  if (!existing) return res.status(404).json({ success: false, error: 'MLC record not found' });
  await requireAnyPatientContexts(req, [existing.patientId, req.body?.patientId]);

  const body = {
    ...req.body,
    updatedBy: req.user._id
  };

  delete body.hospitalId;
  delete body.caseNumber;

  const row = await mrd.models.MRDMedicoLegalRecord.findOneAndUpdate(
    { _id: req.params.id, hospitalId },
    { $set: body },
    { new: true, runValidators: true }
  );

  if (!row) {
    return res.status(404).json({
      success: false,
      error: 'MLC record not found'
    });
  }

  res.json({
    success: true,
    data: row
  });
});

// ============================================
// Medical Certificates
// ============================================

exports.certificateList = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await mrd.listCertificates(requireHospitalId(req), await scopedQuery(req))
  });
});

exports.certificateCreate = asyncHandler(async (req, res) => {
  if (!req.body?.patientId || !req.body?.certificateType) {
    return res.status(400).json({
      success: false,
      error: 'patientId and certificateType are required'
    });
  }

  await requirePatientContext(req, req.body.patientId);
  const row = await mrd.createCertificate(req, requireHospitalId(req), req.body);

  res.status(201).json({
    success: true,
    data: row
  });
});

exports.certificateUpdate = asyncHandler(async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const existing = await mrd.models.MRDMedicalCertificate.findOne({ _id: req.params.id, hospitalId })
    .select('patientId')
    .lean();
  if (!existing) return res.status(404).json({ success: false, error: 'Medical certificate not found' });
  await requireAnyPatientContexts(req, [existing.patientId, req.body?.patientId]);

  const body = {
    ...req.body,
    updatedBy: req.user._id
  };

  delete body.hospitalId;
  delete body.certificateNumber;

  if (body.status === 'revoked') {
    body.revokedAt = new Date();
    body.revokedBy = req.user._id;
  }

  const row = await mrd.models.MRDMedicalCertificate.findOneAndUpdate(
    { _id: req.params.id, hospitalId },
    { $set: body },
    { new: true, runValidators: true }
  );

  if (!row) {
    return res.status(404).json({
      success: false,
      error: 'Medical certificate not found'
    });
  }

  await appendDomainEvent({
    req,
    eventType: `mrd.certificate.${row.status}`,
    entityType: 'MRDMedicalCertificate',
    entityId: row._id,
    hospitalId,
    patientId: row.patientId,
    afterSummary: {
      certificateNumber: row.certificateNumber,
      status: row.status
    }
  });

  res.json({
    success: true,
    data: row
  });
});

// ============================================
// Export Section
// ============================================

exports.exportSection = asyncHandler(async (req, res) => {
  const format = String(req.query.format || '').toLowerCase();

  if (!['csv', 'xlsx', 'pdf', 'json'].includes(format)) {
    return res.status(400).json({
      success: false,
      error: 'format must be csv, xlsx, pdf or json'
    });
  }

  const hospitalId = requireHospitalId(req);

  if (format === 'json') {
    const Hospital = require('../models/Hospital');

    const [dataset, hospital] = await Promise.all([
      mrd.buildExportDataset(req, hospitalId, req.params.section, await scopedQuery(req)),
      Hospital.findById(hospitalId)
        .select('name hospitalName address city state pinCode contact phone phoneNumber email logo')
        .lean()
    ]);

    return res.json({
      success: true,
      data: {
        ...dataset,
        hospital: hospital || {},
        generatedAt: new Date().toISOString()
      }
    });
  }

  const rendered = await mrd.exportSection(
    req,
    hospitalId,
    req.params.section,
    format,
    await scopedQuery(req)
  );

  res.setHeader('Content-Type', rendered.mimeType);
  res.setHeader(
    'Content-Disposition',
    `${format === 'pdf' ? 'inline' : 'attachment'}; filename="${rendered.filename}"`
  );
  res.setHeader('X-MRD-Row-Count', String(rendered.rowCount || 0));

  res.send(rendered.output);
});

// ============================================
// Reports
// ============================================

exports.report = asyncHandler(async (req, res) => {
  const result = await mrd.report(requireHospitalId(req), req.params.key, await scopedQuery(req));

  const presentation = buildReportPresentation({
    context: 'mrd',
    section: 'reports',
    key: req.params.key,
    rows: result.rows || []
  });

  res.json({
    success: true,
    data: {
      ...result,
      presentation
    }
  });
});

exports.reportCatalog = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: [
      { key: 'admission-rate', label: 'Admission Rate' },
      { key: 'discharge-rate', label: 'Discharge Rate' },
      { key: 'admission-discharge-average', label: 'Admission / Discharge Average' },
      { key: 'average-length-of-stay', label: 'Average Length of Stay' },
      { key: 'bed-occupancy-rate', label: 'Bed Occupancy Rate' },
      { key: 'missing-discharge-summary', label: 'Missing Discharge Summary Details' },
      { key: 'mortality-rate', label: 'Mortality Rate' },
      { key: 'birth-reports', label: 'Birth Reports' },
      { key: 'mlc-reports', label: 'MLC Reports' },
      { key: 'medico-report', label: 'Medico Report' },
      { key: 'medical-file-tracking', label: 'Medical File Tracking Report' }
    ]
  });
});

// ============================================
// PDF Generation
// ============================================

exports.birthDeathPdf = asyncHandler(async (req, res) => {
  const pdf = require('../services/mrdDocumentPdf.service');
  const hospitalId = requireHospitalId(req);
  const row = await mrd.models.MRDBirthDeathRecord.findOne({ _id: req.params.id, hospitalId })
    .select('patientId motherPatientId babyPatientId')
    .lean();
  if (!row) return res.status(404).json({ success: false, error: 'Birth/death record not found' });
  await requireAnyPatientContexts(req, [row.patientId, row.motherPatientId, row.babyPatientId]);

  await pdf.birthDeathPdf({
    res,
    hospitalId,
    id: req.params.id
  });
});

exports.certificatePdf = asyncHandler(async (req, res) => {
  const pdf = require('../services/mrdDocumentPdf.service');
  const hospitalId = requireHospitalId(req);
  const row = await mrd.models.MRDMedicalCertificate.findOne({ _id: req.params.id, hospitalId })
    .select('patientId')
    .lean();
  if (!row) return res.status(404).json({ success: false, error: 'Medical certificate not found' });
  await requirePatientContext(req, row.patientId);

  await pdf.certificatePdf({
    res,
    hospitalId,
    id: req.params.id
  });
});