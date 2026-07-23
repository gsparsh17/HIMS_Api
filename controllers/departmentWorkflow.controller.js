const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const IPDCharge = require('../models/IPDCharge');
const { requireHospitalId } = require('../services/tenantScope.service');
const labWorkflow = require('../services/labWorkflow.service');
const radiologyWorkflow = require('../services/radiologyWorkflow.service');
const { quotePricing } = require('../services/pricingEngine.service');

function sendError(res, error) {
  return res.status(error.statusCode || 400).json({
    success: false,
    error: error.message
  });
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
    filter.requestedDate = {};
    if (req.query.from) {
      filter.requestedDate.$gte = new Date(req.query.from);
    }
    if (req.query.to) {
      filter.requestedDate.$lte = new Date(req.query.to);
    }
  }

  if (req.query.q) {
    filter.$or = [
      { requestNumber: new RegExp(req.query.q, 'i') },
      { testName: new RegExp(req.query.q, 'i') },
      { accessionNumber: new RegExp(req.query.q, 'i') }
    ];
  }

  return filter;
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
    const { page, limit, skip } = pagination(req);
    const filter = requestFilter(req, hospitalId);

    const [items, total] = await Promise.all([
      LabRequest.find(filter)
        .populate('patientId', 'first_name last_name patientId uhid gender age')
        .populate('doctorId', 'firstName lastName specialization')
        .populate('admissionId', 'admissionNumber wardId roomId bedId coverageId')
        .populate('labTestId', 'name test_name code category sampleType turnaroundTime')
        .sort({ priority: -1, requestedDate: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LabRequest.countDocuments(filter)
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

exports.collectSpecimen = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);

    request.accessionNumber = req.body.accessionNumber ||
      request.accessionNumber ||
      `ACC-${Date.now()}`;

    request.specimen = {
      ...(request.specimen?.toObject?.() || request.specimen || {}),
      type: req.body.specimenType,
      container: req.body.container,
      barcode: req.body.barcode,
      fastingStatus: req.body.fastingStatus,
      collectedAt: req.body.collectedAt || new Date(),
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

    request.result_value = req.body.result_value ?? request.result_value;
    request.result_interpretation = req.body.result_interpretation ?? request.result_interpretation;
    request.normal_range_used = req.body.normal_range_used ?? request.normal_range_used;
    request.is_abnormal = Boolean(req.body.is_abnormal);
    request.manual_report = req.body.manual_report || request.manual_report;

    request.critical = {
      ...(request.critical?.toObject?.() || request.critical || {}),
      isCritical: Boolean(req.body.isCritical),
      flagReason: req.body.criticalReason
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

    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
};

exports.verifyLab = async (req, res) => {
  try {
    const { request, hospitalId } = await labById(req);

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
      acknowledgedAt: new Date(),
      acknowledgedBy: req.user._id,
      escalationLevel: req.body.escalationLevel || 0,
      note: req.body.note
    });

    if (!request.critical.notifiedAt) {
      request.critical.notifiedAt = new Date();
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

    const data = await labWorkflow.transition({
      req,
      request,
      to: 'Reported',
      note: req.body.note,
      hospitalId
    });

    if (request.admissionId && !request.is_billed) {
      try {
        const pricing = await quotePricing({
          hospitalId,
          admissionId: request.admissionId,
          externalCode: request.testCode,
          internalServiceModel: 'LabTest',
          internalServiceId: request.labTestId,
          serviceType: 'laboratory',
          standardAmount: request.cost || 0,
          serviceDate: request.releasedAt
        });

        await IPDCharge.findOneAndUpdate(
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
              pricingSnapshot: {
                rateCardId: pricing.rateCard?.id,
                rateCardVersion: pricing.rateCard?.version,
                rateCardItemId: pricing.rateCardItemId,
                serviceCode: pricing.serviceCode,
                packageCode: pricing.packageCode,
                inputs: pricing.inputs,
                amounts: pricing.amounts,
                explanation: pricing.explanation,
                ruleTrace: pricing.ruleTrace,
                pricedAt: new Date()
              },
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
    const now = new Date();

    const rows = await LabRequest.aggregate([
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
    ]);

    res.json({
      success: true,
      byStatus: rows,
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

    const data = await radiologyWorkflow.transition({
      req,
      request,
      to: 'Reported',
      hospitalId,
      note: req.body.note
    });

    if (request.admissionId && !request.is_billed) {
      try {
        const pricing = await quotePricing({
          hospitalId,
          admissionId: request.admissionId,
          externalCode: request.testCode,
          internalServiceModel: 'ImagingTest',
          internalServiceId: request.imagingTestId,
          serviceType: 'radiology',
          standardAmount: request.cost || 0,
          serviceDate: request.releasedAt
        });

        await IPDCharge.findOneAndUpdate(
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
              pricingSnapshot: {
                rateCardId: pricing.rateCard?.id,
                rateCardVersion: pricing.rateCard?.version,
                rateCardItemId: pricing.rateCardItemId,
                serviceCode: pricing.serviceCode,
                packageCode: pricing.packageCode,
                inputs: pricing.inputs,
                amounts: pricing.amounts,
                explanation: pricing.explanation,
                ruleTrace: pricing.ruleTrace,
                pricedAt: new Date()
              },
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
    const now = new Date();

    const [byStatus, byModality] = await Promise.all([
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
      ])
    ]);

    res.json({
      success: true,
      byStatus,
      byModality,
      generatedAt: now
    });
  } catch (e) {
    sendError(res, e);
  }
};