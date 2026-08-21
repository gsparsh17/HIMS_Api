const { publicLicense, getSnapshot, refreshLicense } = require('../services/licenseSnapshot.service');

exports.status = async (req, res) => {
  const { snapshot } = await getSnapshot(req.user?.hospital_id);
  if (!snapshot) return res.status(404).json({ success: false, code: 'LICENSE_NOT_PROVISIONED', message: 'License snapshot not found' });
  return res.json({ success: true, license: publicLicense(snapshot) });
};

exports.refresh = async (req, res) => {
  try {
    const snapshot = await refreshLicense({ hospitalId: req.user?.hospital_id });
    return res.json({ success: true, license: publicLicense(snapshot) });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code || 'LICENSE_REFRESH_FAILED', message: error.message });
  }
};
