async function sendPortalOtp({ mobile, otp }) {
  const testMode = String(process.env.PATIENT_PORTAL_OTP_TEST_MODE || 'false').toLowerCase() === 'true';
  if (testMode) {
    console.warn(`[PATIENT PORTAL OTP TEST MODE] ${mobile}: ${otp}`);
    return { provider: 'test' };
  }
  const url = String(process.env.PATIENT_PORTAL_SMS_PROVIDER_URL || '').trim();
  if (!url) {
    const error = new Error('Patient portal SMS provider is not configured');
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.PATIENT_PORTAL_SMS_PROVIDER_TOKEN ? { authorization: `Bearer ${process.env.PATIENT_PORTAL_SMS_PROVIDER_TOKEN}` } : {})
    },
    body: JSON.stringify({ mobile, otp, template: process.env.PATIENT_PORTAL_SMS_TEMPLATE_ID || 'PATIENT_LOGIN_OTP' })
  });
  if (!response.ok) {
    const error = new Error(`Patient portal SMS provider returned HTTP ${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return { provider: 'http' };
}
module.exports = { sendPortalOtp };
