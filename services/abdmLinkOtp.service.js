const crypto = require('crypto');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function createOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(otp, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(String(otp), salt, 32).toString('hex')
  };
}

function verifyOtp(otp, salt, expectedHash) {
  const actual = crypto.scryptSync(String(otp), salt, 32);
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function sendLinkOtp({ phone, otp, facilityId, patientReference, linkRefNumber }) {
  const testMode = String(process.env.ABDM_LINK_OTP_TEST_MODE || 'false').toLowerCase() === 'true';
  if (testMode) {
    // Sandbox-only. Never enable in production; this intentionally avoids returning OTP to ABDM/PHR.
    console.warn(`[ABDM SANDBOX OTP] ${linkRefNumber} -> ${phone}: ${otp}`);
    return { provider: 'SANDBOX_LOG', accepted: true };
  }

  const providerUrl = process.env.ABDM_SMS_PROVIDER_URL;
  if (!providerUrl) {
    const error = new Error(
      'ABDM user-initiated linking requires an SMS provider. Configure ABDM_SMS_PROVIDER_URL or enable ABDM_LINK_OTP_TEST_MODE only in sandbox.'
    );
    error.code = 'SMS_PROVIDER_NOT_CONFIGURED';
    throw error;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ABDM_SMS_PROVIDER_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.ABDM_SMS_PROVIDER_BEARER_TOKEN}`;
  }
  const response = await fetchFn(providerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      to: phone,
      template: process.env.ABDM_SMS_TEMPLATE_ID || 'ABDM_LINK_OTP',
      variables: {
        otp,
        facilityId,
        patientReference,
        linkRefNumber,
        expiryMinutes: 10
      }
    }),
    signal: AbortSignal.timeout(Number(process.env.ABDM_SMS_TIMEOUT_MS || 10000))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || `SMS provider rejected request: ${response.status}`);
    error.details = data;
    throw error;
  }
  return { provider: 'WEBHOOK', accepted: true, data };
}

module.exports = { createOtp, hashOtp, verifyOtp, sendLinkOtp };
