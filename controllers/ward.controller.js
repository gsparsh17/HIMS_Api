const Ward = require('../models/Ward');
const { requireHospitalId } = require('../services/tenantScope.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

exports.createWard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const count = await Ward.countDocuments({ hospitalId });

    const ward = await Ward.create({
      ...req.body,
      hospitalId,
      code: req.body.code || `WRD${String(count + 1).padStart(3, '0')}`,
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Ward created successfully',
      ward
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.getAllWards = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId, isActive: true };

    if (req.query.type) {
      filter.type = req.query.type;
    }

    const wards = await Ward
      .find(filter)
      .populate('departmentId', 'name')
      .sort({ name: 1 });

    res.json({ success: true, wards });
  } catch (e) {
    fail(res, e);
  }
};

exports.getWardById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const ward = await Ward
      .findOne({ _id: req.params.id, hospitalId })
      .populate('departmentId', 'name');

    if (!ward) {
      return res.status(404).json({
        success: false,
        error: 'Ward not found'
      });
    }

    res.json({ success: true, ward });
  } catch (e) {
    fail(res, e);
  }
};

exports.updateWard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const ward = await Ward.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { ...req.body },
      { new: true, runValidators: true }
    );

    if (!ward) {
      return res.status(404).json({
        success: false,
        error: 'Ward not found'
      });
    }

    res.json({
      success: true,
      message: 'Ward updated successfully',
      ward
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.deleteWard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const ward = await Ward.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { $set: { isActive: false } },
      { new: true }
    );

    if (!ward) {
      return res.status(404).json({
        success: false,
        error: 'Ward not found'
      });
    }

    res.json({
      success: true,
      message: 'Ward deactivated successfully'
    });
  } catch (e) {
    fail(res, e);
  }
};