const IPDBedTransfer = require('../models/IPDBedTransfer');
const IPDAccommodationSegment = require('../models/IPDAccommodationSegment');
const Bed = require('../models/Bed');
const { requireHospitalId } = require('../services/tenantScope.service');
const transferService = require('../services/ipdTransfer.service');
const { buildAccommodationPrintData } = require('../services/ipdAccommodationPrint.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

const tx = (work) => transferService.transaction(work);

exports.listAdmissionTransfers = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await IPDBedTransfer
      .find({ hospitalId, admissionId: req.params.id })
      .populate('from.wardId from.roomId from.bedId to.wardId to.roomId to.bedId')
      .populate('people.requestedBy people.approvedBy people.receivedBy people.completedBy', 'name role')
      .sort({ createdAt: 1 });

    const segments = await IPDAccommodationSegment
      .find({ hospitalId, admissionId: req.params.id })
      .populate('wardId roomId bedId')
      .sort({ startedAt: 1 });

    res.json({ success: true, data, accommodationSegments: segments });
  } catch (e) {
    fail(res, e);
  }
};

exports.create = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await tx((session) =>
      transferService.createTransfer({
        req,
        hospitalId,
        admissionId: req.params.id,
        payload: req.body,
        session
      })
    );

    res.status(201).json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.reserve = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await tx((session) =>
      transferService.reserveTransfer({
        req,
        hospitalId,
        transferId: req.params.id,
        expiresInMinutes: req.body.expiresInMinutes,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.approve = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await tx((session) =>
      transferService.approveTransfer({
        req,
        hospitalId,
        transferId: req.params.id,
        note: req.body.note,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.start = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await tx((session) =>
      transferService.startTransfer({
        req,
        hospitalId,
        transferId: req.params.id,
        handover: req.body.handover || req.body,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.complete = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await tx((session) =>
      transferService.completeTransfer({
        req,
        hospitalId,
        transferId: req.params.id,
        payload: req.body,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.cancel = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await tx((session) =>
      transferService.cancelTransfer({
        req,
        hospitalId,
        transferId: req.params.id,
        reason: req.body.reason,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.board = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const status = req.query.status
      ? String(req.query.status).split(',')
      : ['Requested', 'Reserved', 'Approved', 'In Transfer'];

    const data = await IPDBedTransfer
      .find({ hospitalId, status: { $in: status } })
      .populate({
        path: 'admissionId',
        select: 'admissionNumber patientId wardId roomId bedId',
        populate: {
          path: 'patientId',
          select: 'first_name last_name patientId uhid gender'
        }
      })
      .populate('from.wardId from.roomId from.bedId to.wardId to.roomId to.bedId')
      .sort({ 'clinical.priority': -1, createdAt: 1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.availableBeds = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const filter = {
      hospitalId,
      status: 'Available',
      isActive: true
    };

    if (req.query.wardId) {
      filter.wardId = req.query.wardId;
    }

    if (req.query.bedType) {
      filter.bedType = req.query.bedType;
    }

    if (req.query.isolation === 'true') {
      filter.isolationCapable = true;
    }

    if (req.query.gender) {
      filter.genderPolicy = { $in: ['any', req.query.gender] };
    }

    if (req.query.features) {
      filter.$and = String(req.query.features)
        .split(',')
        .map((feature) => ({
          $or: [
            { features: feature },
            { equipmentFeatures: feature }
          ]
        }));
    }

    const data = await Bed
      .find(filter)
      .populate('wardId roomId')
      .sort({ dailyCharge: 1, bedNumber: 1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.releaseCleaning = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await tx((session) =>
      transferService.releaseBedAfterCleaning({
        req,
        hospitalId,
        bedId: req.params.id,
        note: req.body.note,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.printData = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const financeRoles = new Set([
      'admin',
      'mediqliq_super_admin',
      'accountant',
      'insurance_desk'
    ]);

    const financial = financeRoles.has(req.user.role) ||
      req.modulePermission?.mainModuleKey === 'billing_finance';

    const data = await buildAccommodationPrintData({
      hospitalId,
      admissionId: req.params.id,
      financial
    });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};