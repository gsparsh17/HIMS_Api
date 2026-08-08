'use strict';

const { getOrCreateNabhSetting } = require('../services/nabhSetting.service');
const { hospitalId, sendError } = require('../utils/functionalDomain');

const allowedSections = new Set([
  'notifications',
  'clinical',
  'medication',
  'operations',
  'interoperability'
]);

exports.get = async (req, res) => {
  try {
    const setting = await getOrCreateNabhSetting(
      hospitalId(req),
      req.user._id
    );

    return res.json({
      success: true,
      data: {
        notifications: setting.notifications,
        clinical: setting.clinical,
        medication: setting.medication,
        operations: setting.operations,
        interoperability: setting.interoperability
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.update = async (req, res) => {
  try {
    const setting = await getOrCreateNabhSetting(
      hospitalId(req),
      req.user._id
    );

    for (const section of allowedSections) {
      if (req.body[section] && typeof req.body[section] === 'object') {
        for (const [key, value] of Object.entries(req.body[section])) {
          setting.set(`${section}.${key}`, value);
        }
      }
    }

    setting.updatedBy = req.user._id;
    setting.version = Number(setting.version || 0) + 1;
    await setting.save();

    return res.json({
      success: true,
      data: setting
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.evaluateClassification = async (req, res) => {
  try {
    const setting = await getOrCreateNabhSetting(
      hospitalId(req),
      req.user._id
    );

    const dataClass = String(req.body.dataClass || 'clinical');
    const role = String(req.body.role || req.user.role || '');

    const rows = setting.operations?.dataClassification || [];
    const policy = rows.find(x => x.dataClass === dataClass);

    if (!policy) {
      return res.status(404).json({
        error: 'Data classification policy not found'
      });
    }

    const allowed = (policy.allowedRoles || []).includes(role);

    return res.status(allowed ? 200 : 403).json({
      success: allowed,
      dataClass,
      role,
      allowed
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.clientSupport = async (req, res) => {
  try {
    const setting = await getOrCreateNabhSetting(
      hospitalId(req),
      req.user._id
    );

    return res.json({
      success: true,
      data: setting.operations?.clientSupport || {}
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};