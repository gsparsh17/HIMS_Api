const abdmConfig = require('../config/abdm.config');
const { safeEqual } = require('../utils/internalSignature');

module.exports = function masterAdminAuth(req, res, next) {
  const configured = abdmConfig.masterAdminKey;
  const provided = req.headers['x-master-admin-key'];
  if (!configured) {
    return res.status(503).json({ error: 'ABDM_MASTER_ADMIN_KEY is not configured' });
  }
  if (!provided || !safeEqual(configured, provided)) {
    return res.status(401).json({ error: 'Invalid master admin key' });
  }
  next();
};
