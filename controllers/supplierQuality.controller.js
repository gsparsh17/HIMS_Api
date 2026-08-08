'use strict';

const SupplierQualityIssue = require('../models/SupplierQualityIssue');
const Supplier = require('../models/Supplier');
const { hospitalId, required, ref, sendError } = require('../utils/functionalDomain');

exports.create = async (req, res) => {
  try {
    required(req.body, ['itemDescription', 'issueDetails']);

    const supplierId = req.params.supplierId || req.body.supplierId;
    const supplier = await Supplier.findById(supplierId);

    if (!supplier) {
      return res.status(404).json({
        error: 'Supplier not found'
      });
    }

    const row = await SupplierQualityIssue.create({
      hospitalId: hospitalId(req),
      issueNumber: req.body.issueNumber || ref('SQI'),
      supplierId: supplier._id,
      itemDescription: req.body.itemDescription,
      issueDetails: req.body.issueDetails,
      severity: req.body.severity || 'moderate',
      status: 'open',
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.update = async (req, res) => {
  try {
    const row = await SupplierQualityIssue.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Quality issue not found'
      });
    }

    const updatableFields = ['status', 'correctiveAction', 'severity', 'issueDetails'];

    for (const key of updatableFields) {
      if (req.body[key] !== undefined) {
        row[key] = req.body[key];
      }
    }

    if (row.status === 'closed') {
      row.closedAt = new Date();
    }

    row.updatedBy = req.user._id;
    await row.save();

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.list = async (req, res) => {
  const filter = {
    hospitalId: hospitalId(req)
  };

  if (req.query.supplierId) {
    filter.supplierId = req.query.supplierId;
  }

  if (req.query.status) {
    filter.status = req.query.status;
  }

  const data = await SupplierQualityIssue
    .find(filter)
    .populate('supplierId', 'name companyName email phone')
    .sort({ createdAt: -1 })
    .lean();

  return res.json({
    success: true,
    data
  });
};