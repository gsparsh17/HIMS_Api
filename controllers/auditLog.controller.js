const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Hospital = require('../models/Hospital');

const userSelect = 'name email role';
const hospitalSelect = 'hospitalID hospitalName';

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPagination(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function paginationResponse({ data, total, page, limit }) {
  return {
    data,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function appendCommonFilters(req, filter) {
  if (req.query.method) filter['request.method'] = req.query.method.toUpperCase();
  if (req.query.statusCode) filter['response.statusCode'] = parseInt(req.query.statusCode, 10);
  if (req.query.success !== undefined) filter['response.success'] = req.query.success === 'true';
  if (req.query.userRole) filter['actor.role'] = req.query.userRole;
  if (req.query.userEmail) filter['actor.email'] = new RegExp(escapeRegex(req.query.userEmail), 'i');
  if (req.query.ip) filter['request.ip'] = req.query.ip;
  if (req.query.requestId) filter.requestId = req.query.requestId;
  if (req.query.userId && isValidObjectId(req.query.userId)) filter['actor.userId'] = req.query.userId;

  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }

  if (req.query.path) {
    filter['request.originalUrl'] = new RegExp(escapeRegex(req.query.path), 'i');
  }

  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), 'i');
    filter.$or = [
      { requestId: regex },
      { 'request.originalUrl': regex },
      { 'actor.email': regex },
      { 'actor.name': regex },
      { 'request.ip': regex },
    ];
  }
}

async function resolveHospitalForAdmin(req) {
  const requestedHospitalId = req.query.hospitalId || req.query.hospital_id || req.user?.hospitalId || req.user?.hospitalID;

  if (requestedHospitalId) {
    if (!isValidObjectId(requestedHospitalId)) {
      const error = new Error('Invalid hospital id');
      error.statusCode = 400;
      throw error;
    }

    const hospital = await Hospital.findById(requestedHospitalId).select(`${hospitalSelect} createdBy`);
    if (!hospital) {
      const error = new Error('Hospital not found');
      error.statusCode = 404;
      throw error;
    }

    const isSuperAdmin = req.user?.role === 'mediqliq_super_admin';
    const isOwnerAdmin = hospital.createdBy?.toString() === req.user?._id?.toString();

    if (!isSuperAdmin && !isOwnerAdmin) {
      const error = new Error('Access denied for this hospital audit log');
      error.statusCode = 403;
      throw error;
    }

    return hospital;
  }

  if (req.user?.role === 'mediqliq_super_admin') return null;

  const hospital = await Hospital.findOne({ createdBy: req.user._id }).select(`${hospitalSelect} createdBy`);
  if (!hospital) {
    const error = new Error('Hospital context required');
    error.statusCode = 400;
    throw error;
  }

  return hospital;
}

function mergeHospitalScope(filter, hospital, req) {
  if (!hospital) return filter;

  const scopeOr = [
    { hospitalId: hospital._id },
    { 'actor.userId': req.user._id },
  ];

  // Preserve search OR by wrapping both conditions in an AND.
  if (filter.$or) {
    const searchOr = filter.$or;
    delete filter.$or;
    filter.$and = [{ $or: scopeOr }, { $or: searchOr }];
    return filter;
  }

  filter.$or = scopeOr;
  return filter;
}

exports.listHospitalAuditLogs = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const hospital = await resolveHospitalForAdmin(req);
    const filter = {};

    appendCommonFilters(req, filter);
    mergeHospitalScope(filter, hospital, req);

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate('actor.userId', userSelect)
        .populate('hospitalId', hospitalSelect)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    return res.json({ success: true, ...paginationResponse({ data: logs, total, page, limit }) });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getHospitalAuditLog = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.auditLogId)) {
      return res.status(400).json({ success: false, message: 'Invalid audit log id' });
    }

    const hospital = await resolveHospitalForAdmin(req);
    const filter = { _id: req.params.auditLogId };
    mergeHospitalScope(filter, hospital, req);

    const auditLog = await AuditLog.findOne(filter)
      .populate('actor.userId', userSelect)
      .populate('hospitalId', hospitalSelect);

    if (!auditLog) return res.status(404).json({ success: false, message: 'Audit log not found' });

    return res.json({ success: true, auditLog });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
