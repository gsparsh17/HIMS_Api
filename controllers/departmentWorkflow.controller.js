const { operationNow, operationDateKey } = require('../utils/operationTimeContext');
const LabRequest = require('../models/LabRequest');
const { groupLabRequests } = require('../services/labWorklistGrouping.service');
const LabTest = require('../models/LabTest');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const IPDAdmission = require('../models/IPDAdmission');
const ImagingTest = require('../models/ImagingTest');
const Hospital = require('../models/Hospital');
const { queueNotification } = require('../services/nabhNotification.service');
const RadiologyRequest = require('../models/RadiologyRequest');
const IPDCharge = require('../models/IPDCharge');
const { requireHospitalId } = require('../services/tenantScope.service');
const { hospitalDayBounds, DEFAULT_HOSPITAL_TIME_ZONE } = require('../utils/hospitalDateTime');
const labWorkflow = require('../services/labWorkflow.service');
const radiologyWorkflow = require('../services/radiologyWorkflow.service');
const { quotePricing, pricingSnapshot } = require('../services/pricingEngine.service');
const { recordPackageUtilization } = require('../services/packageAdjudication.service');
const { activeCoverage } = require('../services/coverage.service');
const { replaceCoverageUtilization } = require('../services/coverageUtilization.service');
const {
  finaliseDiagnosticReport,
  notifyDiagnosticRelease
} = require('../services/diagnosticReport.service');

function sendError(res, error) {
  return res.status(error.statusCode || 400).json({
    success: false,
    error: error.message
  });
}

function safeScalarResult(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') {
    const error = new Error('Structured lab results must be submitted as manual_report.observations, not result_value');
    error.statusCode = 400;
    error.code = 'STRUCTURED_RESULT_REQUIRED';
    throw error;
  }
  const text = String(value).trim();
  return text === '[object Object]' ? fallback : text;
}

function pagination(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  return { page, limit, skip: (page - 1) * limit };
}

function requestFilter(req, hospitalId) {
  const filter = { hospitalId };

  if (req.query.status) {
    filter.status = { $in: String(req.query.status).split(',') };
  }

  if (req.query.priority) {
    filter.priority = req.query.priority;
  }

  if (req.query.sourceType) {
    filter.sourceType = req.query.sourceType;
  }

  if (req.query.category) {
    filter.category = req.query.category;
  }

  if (req.query.billing === 'pending') {
    filter.financialClearanceState = { $in: ['PAYMENT_REQUIRED', 'TPA_PENDING', 'AUTHORIZATION_REQUIRED', 'HOLD'] };
  } else if (req.query.billing === 'billed') {
    filter.billingState = 'INVOICED';
  }

  if (req.query.report === 'has_report') {
    filter.$and = [...(filter.$and || []), {
      $or: [
        { report_url: { $exists: true, $nin: [null, ''] } },
        { report_mode: { $in: ['manual', 'uploaded'] } },
        { 'manual_report.sections.0': { $exists: true } },
        { 'manual_report.observations.0': { $exists: true } }
      ]
    }];
  } else if (req.query.report === 'no_report') {
    filter.$and = [...(filter.$and || []), {
      $nor: [
        { report_url: { $exists: true, $nin: [null, ''] } },
        { report_mode: { $in: ['manual', 'uploaded'] } },
        { 'manual_report.sections.0': { $exists: true } },
        { 'manual_report.observations.0': { $exists: true } }
      ]
    }];
  }

  if (req.query.admissionId) {
    filter.admissionId = req.query.admissionId;
  }

  if (req.query.patientId) {
    filter.patientId = req.query.patientId;
  }

  if (req.query.assignedTo) {
    filter.assignedTo = req.query.assignedTo;
  }

  if (req.query.from || req.query.to) {
    const dateField = req.query.dateField === 'scheduled' ? 'scheduledDate' : 'requestedDate';
    filter[dateField] = {};
    if (req.query.from) {
      filter[dateField].$gte = new Date(req.query.from);
    }
    if (req.query.to) {
      const end = new Date(req.query.to);
      end.setHours(23, 59, 59, 999);
      filter[dateField].$lte = end;
    }
  }

  if (req.query.nurse === 'true') {
    filter.is_referred_out = { $ne: true };
    filter.$and = [...(filter.$and || []), {
      $or: [
        { status: { $in: ['Pending', 'Sample Collected', 'Processing'] } },
        {
          status: { $in: ['Completed', 'Reported'] },
          $or: [
            { report_url: { $exists: true, $nin: [null, ''] } },
            { report_mode: 'manual' },
            { 'manual_report.sections.0': { $exists: true } },
            { 'manual_report.observations.0': { $exists: true } }
          ]
        }
      ]
    }];
  }

  if (req.query.q) {
    const regex = new RegExp(escapedSearch(req.query.q), 'i');
    filter.$or = [
      { requestNumber: regex },
      { testName: regex },
      { accessionNumber: regex }
    ];
  }

  return filter;
}


function escapedSearch(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withoutDirectSearch(filter) {
  const copy = { ...filter };
  delete copy.$or;
  return copy;
}

function labGroupKeyExpression() {
  const nonEmpty = (field) => ({ $ne: [{ $ifNull: [field, ''] }, ''] });
  const asString = (field) => ({ $toString: field });
  const legacyPart = (field, fallback) => ({
    $cond: [
      { $ne: [{ $ifNull: [field, null] }, null] },
      asString(field),
      fallback
    ]
  });
  return {
    $switch: {
      branches: [
        { case: nonEmpty('$requestGroupKey'), then: asString('$requestGroupKey') },
        { case: nonEmpty('$orderNumber'), then: asString('$orderNumber') },
        { case: { $ne: [{ $ifNull: ['$orderGroupId', null] }, null] }, then: asString('$orderGroupId') },
        { case: nonEmpty('$deskCheckoutKey'), then: { $concat: ['CHECKOUT:', asString('$deskCheckoutKey')] } },
        { case: { $ne: [{ $ifNull: ['$prescriptionId', null] }, null] }, then: { $concat: ['RX:', asString('$prescriptionId')] } }
      ],
      default: {
        $concat: [
          'LEGACY:',
          legacyPart('$patientId', 'PATIENT'), ':',
          {
            $cond: [
              { $ne: [{ $ifNull: ['$admissionId', null] }, null] },
              asString('$admissionId'),
              legacyPart('$appointmentId', 'WALKIN')
            ]
          }, ':',
          legacyPart('$doctorId', 'DOCTOR'), ':',
          {
            $dateToString: {
              format: '%Y-%m-%dT%H:%M',
              date: { $ifNull: ['$requestedDate', '$$NOW'] },
              timezone: 'UTC'
            }
          }
        ]
      }
    }
  };
}

async function searchedLabFlatPage({ filter, q, skip, limit }) {
  const regex = new RegExp(escapedSearch(q), 'i');
  const [result = {}] = await LabRequest.aggregate([
    { $match: withoutDirectSearch(filter) },
    { $lookup: { from: Patient.collection.name, localField: 'patientId', foreignField: '_id', pipeline: [{ $project: { first_name: 1, last_name: 1, patientId: 1, uhid: 1, gender: 1, age: 1, phone: 1 } }], as: '_patient' } },
    { $lookup: { from: Doctor.collection.name, localField: 'doctorId', foreignField: '_id', pipeline: [{ $project: { firstName: 1, lastName: 1, specialization: 1 } }], as: '_doctor' } },
    { $lookup: { from: IPDAdmission.collection.name, localField: 'admissionId', foreignField: '_id', pipeline: [{ $project: { admissionNumber: 1, wardId: 1, roomId: 1, bedId: 1, coverageId: 1 } }], as: '_admission' } },
    { $lookup: { from: LabTest.collection.name, localField: 'labTestId', foreignField: '_id', pipeline: [{ $project: { name: 1, code: 1, category: 1, specimen_type: 1, specimen_detail: 1, parameters: 1, normal_range: 1, units: 1 } }], as: '_test' } },
    { $set: { patientId: { $arrayElemAt: ['$_patient', 0] }, doctorId: { $arrayElemAt: ['$_doctor', 0] }, admissionId: { $arrayElemAt: ['$_admission', 0] }, labTestId: { $arrayElemAt: ['$_test', 0] } } },
    { $unset: ['_patient', '_doctor', '_admission', '_test'] },
    { $match: { $or: [
      { requestNumber: regex }, { testName: regex }, { testCode: regex }, { accessionNumber: regex },
      { 'patientId.first_name': regex }, { 'patientId.last_name': regex }, { 'patientId.patientId': regex }, { 'patientId.uhid': regex },
      { 'doctorId.firstName': regex }, { 'doctorId.lastName': regex }
    ] } },
    { $sort: { priority: -1, requestedDate: 1 } },
    { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'value' }] } }
  ]).allowDiskUse(true);
  return { items: result.items || [], total: result.total?.[0]?.value || 0 };
}

async function searchedRadiologyFlatPage({ filter, q, skip, limit }) {
  const regex = new RegExp(escapedSearch(q), 'i');
  const [result = {}] = await RadiologyRequest.aggregate([
    { $match: withoutDirectSearch(filter) },
    { $lookup: { from: Patient.collection.name, localField: 'patientId', foreignField: '_id', pipeline: [{ $project: { first_name: 1, last_name: 1, patientId: 1, uhid: 1, gender: 1, age: 1, phone: 1 } }], as: '_patient' } },
    { $lookup: { from: Doctor.collection.name, localField: 'doctorId', foreignField: '_id', pipeline: [{ $project: { firstName: 1, lastName: 1, specialization: 1 } }], as: '_doctor' } },
    { $lookup: { from: IPDAdmission.collection.name, localField: 'admissionId', foreignField: '_id', pipeline: [{ $project: { admissionNumber: 1, wardId: 1, roomId: 1, bedId: 1, coverageId: 1 } }], as: '_admission' } },
    { $lookup: { from: ImagingTest.collection.name, localField: 'imagingTestId', foreignField: '_id', pipeline: [{ $project: { name: 1, test_name: 1, code: 1, category: 1, modality: 1 } }], as: '_test' } },
    { $set: { patientId: { $arrayElemAt: ['$_patient', 0] }, doctorId: { $arrayElemAt: ['$_doctor', 0] }, admissionId: { $arrayElemAt: ['$_admission', 0] }, imagingTestId: { $arrayElemAt: ['$_test', 0] } } },
    { $unset: ['_patient', '_doctor', '_admission', '_test'] },
    { $match: { $or: [
      { requestNumber: regex }, { testName: regex }, { testCode: regex }, { accessionNumber: regex },
      { 'patientId.first_name': regex }, { 'patientId.last_name': regex }, { 'patientId.patientId': regex }, { 'patientId.uhid': regex },
      { 'doctorId.firstName': regex }, { 'doctorId.lastName': regex }
    ] } },
    { $sort: { scheduledStart: 1, priority: -1, requestedDate: 1 } },
    { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'value' }] } }
  ]).allowDiskUse(true);
  return { items: result.items || [], total: result.total?.[0]?.value || 0 };
}

async function labById(req) {
  const hospitalId = requireHospitalId(req);
  const request = await LabRequest.findOne({
    _id: req.params.id,
    hospitalId
  });

  if (!request) {
    const e = new Error('Lab request not found');
    e.statusCode = 404;
    throw e;
  }

  return { request, hospitalId };
}

async function radiologyById(req) {
  const hospitalId = requireHospitalId(req);
  const request = await RadiologyRequest.findOne({
    _id: req.params.id,
    hospitalId
  });

  if (!request) {
    const e = new Error('Radiology request not found');
    e.statusCode = 404;
    throw e;
  }

  return { request, hospitalId };
}

exports.labWorklist = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { page, limit } = pagination(req);
    const filter = requestFilter(req, hospitalId);

    // Flat mode remains available for backward compatibility. The default is
    // patient/request-centric and groups individual tests under one lab order.
    const flat = req.query.flat === 'true';
    if (flat) {
      const skip = (page - 1) * limit;
      if (req.query.q) {
        const { items, total } = await searchedLabFlatPage({ filter, q: req.query.q, skip, limit });
        return res.json({ success: true, grouped: false, items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
      }

      const [items, total] = await Promise.all([
        LabRequest.find(filter)
          .populate('patientId', 'first_name last_name patientId uhid gender age phone')
          .populate('doctorId', 'firstName lastName specialization')
          .populate('admissionId', 'admissionNumber wardId roomId bedId coverageId')
          .populate('labTestId', 'name code category specimen_type specimen_detail parameters normal_range units')
          .sort({ priority: -1, requestedDate: 1 }).skip(skip).limit(limit).lean(),
        LabRequest.countDocuments(filter)
      ]);
      return res.json({ success: true, grouped: false, items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    }

    // Determine only the requested group page inside MongoDB. Hydrate the
    // requests belonging to those groups afterwards and pass them through the
    // existing grouping service so group/status semantics stay byte-for-byte
    // compatible with the legacy implementation.
    const skip = (page - 1) * limit;
    const [groupPage = {}] = await LabRequest.aggregate([
      { $match: filter },
      { $set: { _worklistGroupKey: labGroupKeyExpression() } },
      {
        $group: {
          _id: '$_worklistGroupKey',
          requestedDate: { $min: '$requestedDate' },
          requestIds: { $push: '$_id' }
        }
      },
      { $sort: { requestedDate: 1, _id: 1 } },
      {
        $facet: {
          groups: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'value' }]
        }
      }
    ]).allowDiskUse(true);

    const pageGroups = groupPage.groups || [];
    const requestIds = pageGroups.flatMap((group) => group.requestIds || []);
    const hydratedRows = requestIds.length
      ? await LabRequest.find({ _id: { $in: requestIds }, hospitalId })
        .populate('patientId', 'first_name last_name patientId uhid gender age phone')
        .populate('doctorId', 'firstName lastName specialization')
        .populate('admissionId', 'admissionNumber wardId roomId bedId coverageId')
        .populate('labTestId', 'name code category specimen_type specimen_detail parameters normal_range units')
        .lean()
      : [];

    const hydratedGroups = groupLabRequests(hydratedRows);
    const groupMap = new Map(hydratedGroups.map((group) => [String(group.groupId), group]));
    const items = pageGroups
      .map((group) => groupMap.get(String(group._id)))
      .filter(Boolean);
    const total = groupPage.total?.[0]?.value || 0;

    return res.json({ success: true, grouped: true, items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (e) {
    sendError(res, e);
  }
};

exports.collectSpecimen = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);

    if (['Sample Collected', 'Received', 'Processing', 'Result Entered', 'Completed', 'Verified', 'Reported', 'Amended'].includes(request.status)) {
      return res.status(200).json({ success: true, alreadyCollected: true, message: 'Specimen was already collected for this request', data: request });
    }
    const requestedCollectionKey = String(req.body.collectionEventKey || req.body.barcode || req.body.accessionNumber || '').trim();
    if (requestedCollectionKey && request.collectionEventKey === requestedCollectionKey) {
      return res.status(200).json({ success: true, alreadyCollected: true, message: 'Duplicate collection event ignored', data: request });
    }

    // Collection is a normal operational entry point for newly ordered tests.
    // Preserve the formal NABH workflow by recording the required approval
    // transition before moving a Pending request to Sample Collected.
    if (request.status === 'Pending') {
      await labWorkflow.transition({
        req,
        request,
        to: 'Approved',
        note: 'Approved during specimen collection',
        hospitalId
      });
    }

    request.accessionNumber = req.body.accessionNumber ||
      request.accessionNumber ||
      `ACC-${Date.now()}`;
    request.collectionEventKey = requestedCollectionKey || `COLLECT:${hospitalId}:${request._id}:${request.accessionNumber}`;

    request.specimen = {
      ...(request.specimen?.toObject?.() || request.specimen || {}),
      type: req.body.specimenType,
      container: req.body.container,
      barcode: req.body.barcode,
      fastingStatus: req.body.fastingStatus,
      collectedAt: req.body.collectedAt || operationNow(),
      collectedBy: req.user._id,
      condition: req.body.condition
    };

    const data = await labWorkflow.transition({
      req,
      request,
      to: 'Sample Collected',
      note: req.body.note,
      hospitalId,
      patch: { sample_notes: req.body.note }
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.accessionSpecimen = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);

    const data = await labWorkflow.transition({
      req,
      request,
      to: 'Received',
      note: req.body.note,
      hospitalId,
      patch: {
        assignedBench: req.body.assignedBench,
        assignedTo: req.body.assignedTo
      }
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.updateLabStatus = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);
    if (request.reportFinalisation?.isFinal && req.body.status !== 'Reported') {
      return res.status(409).json({ success: false, error: 'Final reports are immutable. Use controlled amendment.' });
    }

    const data = await labWorkflow.transition({
      req,
      request,
      to: req.body.status,
      note: req.body.note,
      hospitalId,
      patch: req.body.patch || {}
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.enterLabResults = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);
    if (request.reportFinalisation?.isFinal) {
      return res.status(409).json({ success: false, error: 'Final reports are immutable. Use controlled amendment.' });
    }

    if (req.body.result_value !== undefined) {
      request.result_value = safeScalarResult(req.body.result_value, request.result_value || '');
    }
    if (req.body.result_interpretation !== undefined) {
      request.result_interpretation = safeScalarResult(req.body.result_interpretation, request.result_interpretation || '');
    }
    if (req.body.normal_range_used !== undefined) {
      request.normal_range_used = safeScalarResult(req.body.normal_range_used, request.normal_range_used || '');
    }
    request.is_abnormal = Boolean(req.body.is_abnormal);
    request.manual_report = req.body.manual_report || request.manual_report;

    const labTest = await LabTest.findOne({ _id: request.labTestId, hospitalId }).lean();
    const numericResult = Number(String(request.result_value ?? '').replace(/[^0-9.+-]/g, ''));
    const lowText = String(labTest?.critical_low ?? '').trim();
    const highText = String(labTest?.critical_high ?? '').trim();
    const low = Number(lowText); const high = Number(highText);
    const lowConfigured = lowText !== '' && Number.isFinite(low);
    const highConfigured = highText !== '' && Number.isFinite(high);
    const thresholdCritical = Number.isFinite(numericResult) && ((lowConfigured && numericResult <= low) || (highConfigured && numericResult >= high));
    const isCritical = thresholdCritical || Boolean(req.body.isCritical);
    let criticalReason = req.body.criticalReason;
    if (!criticalReason && thresholdCritical) {
      criticalReason = lowConfigured && numericResult <= low
        ? `Result ${numericResult} is at/below critical low ${low}${labTest?.units ? ` ${labTest.units}` : ''}`
        : `Result ${numericResult} is at/above critical high ${high}${labTest?.units ? ` ${labTest.units}` : ''}`;
    }
    request.critical = {
      ...(request.critical?.toObject?.() || request.critical || {}),
      isCritical,
      flagReason: criticalReason
    };

    const target = ['Processing', 'Referred Out'].includes(request.status)
      ? 'Result Entered'
      : request.status === 'Result Entered'
        ? 'Result Entered'
        : null;

    if (!target) {
      const e = new Error('Results can be entered only for a processing/referred request');
      e.statusCode = 409;
      throw e;
    }

    const data = target === request.status
      ? await request.save()
      : await labWorkflow.transition({
        req,
        request,
        to: target,
        note: req.body.note,
        hospitalId
      });

    let criticalNotification = null;
    if (request.critical?.isCritical && !request.critical?.notifiedAt) {
      criticalNotification = await queueNotification({
        hospitalId,
        eventType: 'critical_lab_result',
        correlationId: request.requestNumber || String(request._id),
        recipientType: 'staff',
        requestedChannels: ['portal'],
        priority: 'critical',
        subject: `Critical laboratory result: ${request.testName}`,
        body: request.critical.flagReason || `Critical result entered for ${request.testName}`,
        patientId: request.patientId,
        payload: { labRequestId: request._id, result: request.result_value, reason: request.critical.flagReason },
        createdBy: req.user._id
      });
      request.critical.notifiedAt = operationNow(); request.critical.notifiedBy = req.user._id; await request.save();
    }
    res.json({ success: true, data, criticalNotification });
  } catch (e) {
    sendError(res, e);
  }
};

exports.verifyLab = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);
    if (request.reportFinalisation?.isFinal) {
      return res.status(409).json({ success: false, error: 'Final reports are immutable. Use controlled amendment.' });
    }

    const data = await labWorkflow.transition({
      req,
      request,
      to: 'Verified',
      note: req.body.note,
      hospitalId,
      patch: { pathologist_notes: req.body.pathologistNotes }
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.criticalAck = async (req, res) => {
  try {
    const { request } = await labById(req);

    if (!request.critical?.isCritical) {
      return res.status(409).json({
        success: false,
        error: 'Request is not marked critical'
      });
    }

    request.critical.acknowledgements = request.critical.acknowledgements || [];
    request.critical.acknowledgements.push({
      recipientName: req.body.recipientName,
      recipientRole: req.body.recipientRole,
      channel: req.body.channel,
      acknowledgedAt: operationNow(),
      acknowledgedBy: req.user._id,
      escalationLevel: req.body.escalationLevel || 0,
      note: req.body.note
    });

    if (!request.critical.notifiedAt) {
      request.critical.notifiedAt = operationNow();
      request.critical.notifiedBy = req.user._id;
    }

    await request.save();

    res.json({ success: true, data: request });
  } catch (e) {
    sendError(res, e);
  }
};

exports.releaseLab = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);
    if (request.reportFinalisation?.isFinal) {
      return res.status(409).json({ success: false, error: 'Report is already final' });
    }

    const data = await labWorkflow.transition({
      req,
      request,
      to: 'Reported',
      note: req.body.note,
      hospitalId
    });
    finaliseDiagnosticReport(request, req.user._id);
    await request.save();
    try {
      const populated = await LabRequest.findById(request._id)
        .populate('patientId', 'first_name last_name full_name phone email')
        .populate('doctorId', 'firstName lastName phone email');
      const deliveries = await notifyDiagnosticRelease({
        request: populated,
        hospitalId,
        type: 'lab',
        userId: req.user._id,
        critical: Boolean(request.critical?.isCritical)
      });
      request.notificationDeliveryIds = [
        ...(request.notificationDeliveryIds || []),
        ...deliveries.map((row) => row._id)
      ];
      await request.save();
    } catch (notificationError) {
      data.notificationWarning = notificationError.message;
    }

    if (request.admissionId && !request.is_billed) {
      try {
        const pricing = await quotePricing({
          hospitalId,
          admissionId: request.admissionId,
          internalCode: request.testCode,
          internalServiceModel: 'LabTest',
          internalServiceId: request.labTestId,
          serviceType: 'laboratory',
          standardAmount: request.cost || 0,
          serviceDate: request.releasedAt
        });

        const postedCharge = await IPDCharge.findOneAndUpdate(
          {
            hospitalId,
            sourceModule: 'Lab',
            sourceId: request._id
          },
          {
            $setOnInsert: {
              admissionId: request.admissionId,
              patientId: request.patientId,
              chargeType: 'Lab Test',
              description: request.testName,
              quantity: 1,
              rate: pricing.amounts.contracted,
              amount: pricing.amounts.contracted,
              netAmount: pricing.amounts.contracted,
              sourceModule: 'Lab',
              sourceId: request._id,
              sourceReference: {
                module: 'Lab',
                documentId: request._id,
                lineKey: request.testCode
              },
              chargeDate: request.releasedAt,
              addedBy: req.user._id
            },
            $set: {
              pricingSnapshot: pricingSnapshot(pricing, {
                internalServiceModel: 'LabTest',
                internalServiceId: request.labTestId
              }),
              patientLiability: pricing.amounts.patientLiability,
              sponsorLiability: pricing.amounts.sponsorLiability,
              nonAdmissibleAmount: pricing.amounts.nonAdmissible,
              rateCardId: pricing.rateCard?.id,
              rateCardVersion: pricing.rateCard?.version,
              packageCode: pricing.packageCode
            }
          },
          {
            upsert: true,
            new: true,
            runValidators: true
          }
        );
        const coverage = await activeCoverage(hospitalId, request.admissionId);
        await replaceCoverageUtilization({
          coverage,
          quote: pricing,
          hospitalId,
          encounterType: 'IPD',
          admissionId: request.admissionId,
          patientId: request.patientId,
          sourceType: 'IPDCharge',
          sourceId: postedCharge._id,
          internalServiceModel: 'LabTest',
          internalServiceId: request.labTestId,
          userId: req.user._id
        });
        if (pricing.packageAdjudication) {
          await recordPackageUtilization({
            decision: pricing.packageAdjudication,
            input: { serviceType: 'laboratory', internalServiceModel: 'LabTest', internalServiceId: request.labTestId, internalCode: request.testCode, description: request.testName, quantity: 1 },
            quote: pricing, sourceType: 'IPDCharge', sourceId: postedCharge._id
          });
        }
      } catch (pricingError) {
        data.billingWarning = pricingError.message;
      }
    }

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.labStats = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const now = operationNow();
    const hospital = await Hospital.findById(hospitalId).select('timezone').lean();
    const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const todayKey = operationDateKey(timeZone);
    const { start: todayStart, end: todayEnd } = hospitalDayBounds(todayKey, timeZone);

    const [rows, summaryRows] = await Promise.all([
      LabRequest.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            avgTurnaroundMs: {
              $avg: {
                $cond: [
                  { $and: ['$releasedAt', '$requestedDate'] },
                  { $subtract: ['$releasedAt', '$requestedDate'] },
                  null
                ]
              }
            },
            overdue: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $lt: ['$turnaroundDueAt', now] },
                      { $not: { $in: ['$status', ['Reported', 'Cancelled']] } }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            rejected: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'Rejected'] },
                  1,
                  0
                ]
              }
            },
            criticalOpen: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      '$critical.isCritical',
                      { $eq: [{ $size: { $ifNull: ['$critical.acknowledgements', []] } }, 0] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),
      LabRequest.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            totalPending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
            totalApproved: { $sum: { $cond: [{ $eq: ['$status', 'Approved'] }, 1, 0] } },
            samplesCollected: { $sum: { $cond: [{ $eq: ['$status', 'Sample Collected'] }, 1, 0] } },
            processing: { $sum: { $cond: [{ $eq: ['$status', 'Processing'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
            referredOut: { $sum: { $cond: [{ $eq: ['$status', 'Referred Out'] }, 1, 0] } },
            todayRequests: {
              $sum: { $cond: [{ $and: [{ $gte: ['$scheduledDate', todayStart] }, { $lte: ['$scheduledDate', todayEnd] }] }, 1, 0] }
            },
            completedToday: {
              $sum: { $cond: [{ $and: [{ $gte: ['$processing_completed_at', todayStart] }, { $lte: ['$processing_completed_at', todayEnd] }] }, 1, 0] }
            },
            todayCollected: {
              $sum: { $cond: [{ $and: [{ $gte: ['$sample_collected_at', todayStart] }, { $lte: ['$sample_collected_at', todayEnd] }] }, 1, 0] }
            },
            pendingBilling: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$financialClearanceState', ['PAYMENT_REQUIRED', 'TPA_PENDING', 'AUTHORIZATION_REQUIRED', 'HOLD']] },
                      { $not: { $in: ['$status', ['Cancelled', 'Referred Out']] } }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            billedOperationalValue: {
              $sum: {
                $cond: [
                  { $eq: ['$billingState', 'INVOICED'] },
                  { $ifNull: ['$pricingSnapshot.amounts.contracted', { $ifNull: ['$pricingSnapshot.contractedAmount', 0] }] },
                  0
                ]
              }
            }
          }
        }
      ])
    ]);

    const summary = summaryRows[0] || {
      total: 0,
      totalPending: 0,
      totalApproved: 0,
      samplesCollected: 0,
      processing: 0,
      completed: 0,
      referredOut: 0,
      todayRequests: 0,
      completedToday: 0,
      todayCollected: 0,
      pendingBilling: 0,
      billedOperationalValue: 0
    };
    delete summary._id;
    summary.readyForCollection = summary.totalPending;

    res.json({
      success: true,
      byStatus: rows,
      summary,
      generatedAt: now
    });
  } catch (e) {
    sendError(res, e);
  }
};

exports.radiologyWorklist = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { page, limit, skip } = pagination(req);
    const filter = requestFilter(req, hospitalId);

    if (req.query.modality) {
      filter.modality = req.query.modality;
    }

    if (req.query.q) {
      const { items, total } = await searchedRadiologyFlatPage({ filter, q: req.query.q, skip, limit });
      return res.json({
        success: true,
        items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
      });
    }

    const [items, total] = await Promise.all([
      RadiologyRequest.find(filter)
        .populate('patientId', 'first_name last_name patientId uhid gender age')
        .populate('doctorId', 'firstName lastName specialization')
        .populate('admissionId', 'admissionNumber wardId roomId bedId coverageId')
        .populate('imagingTestId', 'name test_name code category modality')
        .sort({ scheduledStart: 1, priority: -1, requestedDate: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RadiologyRequest.countDocuments(filter)
    ]);

    res.json({
      success: true,
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    sendError(res, e);
  }
};

exports.scheduleRadiology = async (req, res) => {
  try {
    const { request, hospitalId } = await radiologyById(req);

    const target = request.status === 'Pending' ? 'Approved' : request.status;

    if (target === 'Approved' && request.status === 'Pending') {
      await radiologyWorkflow.transition({
        req,
        request,
        to: 'Approved',
        hospitalId,
        note: 'Approved during scheduling'
      });
    }

    const data = await radiologyWorkflow.transition({
      req,
      request,
      to: 'Scheduled',
      hospitalId,
      note: req.body.note,
      patch: {
        modality: req.body.modality,
        scheduledStart: req.body.scheduledStart,
        scheduledEnd: req.body.scheduledEnd,
        assignedTechnician: req.body.assignedTechnician,
        assignedRadiologist: req.body.assignedRadiologist,
        contrastRequired: req.body.contrastRequired,
        patientPreparation: req.body.patientPreparation
      }
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.startRadiology = async (req, res) => {
  try {
    const { request, hospitalId } = await radiologyById(req);

    const data = await radiologyWorkflow.transition({
      req,
      request,
      to: 'In Progress',
      hospitalId,
      note: req.body.note,
      patch: { safetyChecklist: req.body.safetyChecklist }
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.enterRadiologyResult = async (req, res) => {
  try {
    const { request, hospitalId } = await radiologyById(req);
    if (request.reportFinalisation?.isFinal) {
      return res.status(409).json({ success: false, error: 'Final reports are immutable. Use controlled amendment.' });
    }

    request.findings = req.body.findings ?? request.findings;
    request.impression = req.body.impression ?? request.impression;
    request.manual_report = req.body.manual_report || request.manual_report;

    const data = await radiologyWorkflow.transition({
      req,
      request,
      to: 'Result Entered',
      hospitalId,
      note: req.body.note
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.verifyRadiology = async (req, res) => {
  try {
    const { request, hospitalId } = await radiologyById(req);
    if (request.reportFinalisation?.isFinal) {
      return res.status(409).json({ success: false, error: 'Final reports are immutable. Use controlled amendment.' });
    }

    const data = await radiologyWorkflow.transition({
      req,
      request,
      to: 'Verified',
      hospitalId,
      note: req.body.note,
      patch: { radiologist_notes: req.body.radiologistNotes }
    });

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.releaseRadiology = async (req, res) => {
  try {
    const { request, hospitalId } = await radiologyById(req);
    if (request.reportFinalisation?.isFinal) {
      return res.status(409).json({ success: false, error: 'Report is already final' });
    }

    const data = await radiologyWorkflow.transition({
      req,
      request,
      to: 'Reported',
      hospitalId,
      note: req.body.note
    });
    finaliseDiagnosticReport(request, req.user._id);
    await request.save();
    try {
      const populated = await RadiologyRequest.findById(request._id)
        .populate('patientId', 'first_name last_name full_name phone email')
        .populate('doctorId', 'firstName lastName phone email');
      const deliveries = await notifyDiagnosticRelease({
        request: populated,
        hospitalId,
        type: 'radiology',
        userId: req.user._id,
        critical: false
      });
      request.notificationDeliveryIds = [
        ...(request.notificationDeliveryIds || []),
        ...deliveries.map((row) => row._id)
      ];
      await request.save();
    } catch (notificationError) {
      data.notificationWarning = notificationError.message;
    }

    if (request.admissionId && !request.is_billed) {
      try {
        const pricing = await quotePricing({
          hospitalId,
          admissionId: request.admissionId,
          internalCode: request.testCode,
          internalServiceModel: 'ImagingTest',
          internalServiceId: request.imagingTestId,
          serviceType: 'radiology',
          standardAmount: request.cost || 0,
          serviceDate: request.releasedAt
        });

        const postedCharge = await IPDCharge.findOneAndUpdate(
          {
            hospitalId,
            sourceModule: 'Radiology',
            sourceId: request._id
          },
          {
            $setOnInsert: {
              admissionId: request.admissionId,
              patientId: request.patientId,
              chargeType: 'Radiology',
              description: request.testName,
              quantity: 1,
              rate: pricing.amounts.contracted,
              amount: pricing.amounts.contracted,
              netAmount: pricing.amounts.contracted,
              sourceModule: 'Radiology',
              sourceId: request._id,
              sourceReference: {
                module: 'Radiology',
                documentId: request._id,
                lineKey: request.testCode
              },
              chargeDate: request.releasedAt,
              addedBy: req.user._id
            },
            $set: {
              pricingSnapshot: pricingSnapshot(pricing, {
                internalServiceModel: 'ImagingTest',
                internalServiceId: request.imagingTestId
              }),
              patientLiability: pricing.amounts.patientLiability,
              sponsorLiability: pricing.amounts.sponsorLiability,
              nonAdmissibleAmount: pricing.amounts.nonAdmissible
            }
          },
          {
            upsert: true,
            new: true,
            runValidators: true
          }
        );
        const coverage = await activeCoverage(hospitalId, request.admissionId);
        await replaceCoverageUtilization({
          coverage,
          quote: pricing,
          hospitalId,
          encounterType: 'IPD',
          admissionId: request.admissionId,
          patientId: request.patientId,
          sourceType: 'IPDCharge',
          sourceId: postedCharge._id,
          internalServiceModel: 'ImagingTest',
          internalServiceId: request.imagingTestId,
          userId: req.user._id
        });
        if (pricing.packageAdjudication) {
          await recordPackageUtilization({
            decision: pricing.packageAdjudication,
            input: { serviceType: 'radiology', internalServiceModel: 'ImagingTest', internalServiceId: request.imagingTestId, internalCode: request.testCode, description: request.testName, quantity: 1 },
            quote: pricing, sourceType: 'IPDCharge', sourceId: postedCharge._id
          });
        }
      } catch (pricingError) {
        data.billingWarning = pricingError.message;
      }
    }

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.radiologyStats = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const now = operationNow();

    const [byStatus, byModality, summaryRows] = await Promise.all([
      RadiologyRequest.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            overdue: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $lt: ['$turnaroundDueAt', now] },
                      { $not: [{ $in: ['$status', ['Reported', 'Cancelled']] }] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            avgTurnaroundMs: {
              $avg: {
                $cond: [
                  { $and: [{ $ne: ['$releasedAt', null] }, { $ne: ['$requestedDate', null] }] },
                  { $subtract: ['$releasedAt', '$requestedDate'] },
                  null
                ]
              }
            }
          }
        }
      ]),
      RadiologyRequest.aggregate([
        {
          $match: {
            hospitalId,
            status: { $nin: ['Reported', 'Cancelled'] }
          }
        },
        {
          $group: {
            _id: { $ifNull: ['$modality', 'Unassigned'] },
            count: { $sum: 1 }
          }
        }
      ]),
      RadiologyRequest.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
            scheduled: { $sum: { $cond: [{ $eq: ['$status', 'Scheduled'] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ['$status', 'In Progress'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
            reported: { $sum: { $cond: [{ $eq: ['$status', 'Reported'] }, 1, 0] } },
            pendingBilling: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$financialClearanceState', ['PAYMENT_REQUIRED', 'TPA_PENDING', 'AUTHORIZATION_REQUIRED', 'HOLD']] },
                      { $ne: ['$status', 'Cancelled'] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            revenue: {
              $sum: {
                $cond: [
                  { $eq: ['$billingState', 'INVOICED'] },
                  { $ifNull: ['$pricingSnapshot.amounts.contracted', { $ifNull: ['$pricingSnapshot.contractedAmount', 0] }] },
                  0
                ]
              }
            }
          }
        }
      ])
    ]);

    const summary = summaryRows[0] || { total: 0, pending: 0, scheduled: 0, inProgress: 0, completed: 0, reported: 0, pendingBilling: 0, revenue: 0 };
    delete summary._id;

    res.json({
      success: true,
      byStatus,
      byModality,
      summary,
      generatedAt: now
    });
  } catch (e) {
    sendError(res, e);
  }
};