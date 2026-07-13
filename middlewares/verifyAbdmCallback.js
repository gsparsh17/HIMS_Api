const abdmConfig = require('../config/abdm.config');
const { verifyCallbackToken, getBearer } = require('../services/abdmCallbackAuth.service');

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '';
}

module.exports = async function verifyAbdmCallback(req, res, next) {
  try {
    abdmConfig.assertSecureCallbackConfiguration();

    if (abdmConfig.callbackAllowedIps.length && !abdmConfig.callbackAllowedIps.includes(getClientIp(req))) {
      return res.status(403).json({ error: 'Callback source IP is not allow-listed' });
    }

    if (!abdmConfig.verifyCallbackJwt) return next();

    const token = getBearer(req.headers.authorization);
    if (!token) return res.status(401).json({ error: 'Missing ABDM callback authorization token' });
    req.abdmCallbackClaims = await verifyCallbackToken(token);
    return next();
  } catch (error) {
    const status = error.message?.includes('Production ABDM callbacks') ? 503 : 401;
    return res.status(status).json({ error: 'Invalid or unsafe ABDM callback configuration', details: error.message });
  }
};
