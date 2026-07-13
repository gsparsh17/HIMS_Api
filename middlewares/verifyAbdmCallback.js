const { verifyCallbackToken, getBearer } = require('../services/abdmCallbackAuth.service');

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '';
}

module.exports = async function verifyAbdmCallback(req, res, next) {
  try {
    const allowedIps = String(process.env.ABDM_CALLBACK_ALLOWED_IPS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (allowedIps.length && !allowedIps.includes(getClientIp(req))) {
      return res.status(403).json({ error: 'Callback source IP is not allow-listed' });
    }

    const verifyJwt = String(process.env.ABDM_VERIFY_CALLBACK_JWT || 'false').toLowerCase() === 'true';
    if (!verifyJwt) return next();

    const token = getBearer(req.headers.authorization);
    if (!token) return res.status(401).json({ error: 'Missing ABDM callback authorization token' });
    req.abdmCallbackClaims = await verifyCallbackToken(token);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid ABDM callback authorization', details: error.message });
  }
};
