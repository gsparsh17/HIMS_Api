const reconciliation = require('../services/financialReconciliation.service');
const featureFlags = require('../services/financeFeatureFlag.service');
const { requestHospitalId } = require('../utils/hospitalScope');

const sendError = (res, error) => res.status(error.statusCode || 500).json({ success: false, error: error.message });

exports.run = async (req, res) => {
  try {
    const result = await reconciliation.runScan(requestHospitalId(req), { persist: req.body?.persist !== false });
    res.json({ success: true, ...result });
  } catch (error) { sendError(res, error); }
};

exports.list = async (req, res) => {
  try {
    const result = await reconciliation.listIssues(requestHospitalId(req), req.query);
    res.json({ success: true, ...result });
  } catch (error) { sendError(res, error); }
};

exports.update = async (req, res) => {
  try {
    const issue = await reconciliation.updateIssue(requestHospitalId(req), req.params.issueId, req.body, req.user?._id || req.user?.id);
    res.json({ success: true, issue });
  } catch (error) { sendError(res, error); }
};

exports.getFlags = async (req, res) => {
  try { res.json({ success: true, flags: await featureFlags.getFlags(requestHospitalId(req)) }); }
  catch (error) { sendError(res, error); }
};

exports.updateFlags = async (req, res) => {
  try {
    const flags = await featureFlags.updateFlags(requestHospitalId(req), req.body?.flags, req.user?._id || req.user?.id);
    res.json({ success: true, flags });
  } catch (error) { sendError(res, error); }
};
