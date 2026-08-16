const { abdmGet } = require('./abdm.service');
const { extractTokenPayload } = require('./abdmCredential.service');

function getAbhaAddress(profile = {}) {
  if (Array.isArray(profile.phrAddress) && profile.phrAddress.length) {
    return profile.phrAddress[0];
  }
  if (Array.isArray(profile.abhaAddress) && profile.abhaAddress.length) {
    return profile.abhaAddress[0];
  }
  return (
    profile.preferredAbhaAddress ||
    profile.ABHAAddress ||
    profile.abhaAddress ||
    undefined
  );
}

function extractProfile(data = {}) {
  return data.ABHAProfile || data.abhaProfile || data.profile || data;
}

function hasAbhaIdentity(profile = {}) {
  return Boolean(
    profile.ABHANumber ||
    profile.abhaNumber ||
    getAbhaAddress(profile)
  );
}

function responseShape(data = {}) {
  const keys = (value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
      : [];
  const accounts = Array.isArray(data.accounts)
    ? data.accounts
    : Array.isArray(data.ABHA)
      ? data.ABHA
      : [];

  return {
    topLevelKeys: keys(data),
    tokenKeys: keys(data.tokens),
    accountCount: accounts.length,
    hasTopLevelToken: typeof data.token === 'string' && Boolean(data.token),
    hasTopLevelRefreshToken:
      typeof data.refreshToken === 'string' && Boolean(data.refreshToken),
    hasNestedToken: Boolean(data.tokens?.token || data.tokens?.accessToken),
    hasNestedRefreshToken: Boolean(
      data.tokens?.refreshToken || data.tokens?.refresh_token
    ),
    authResult: data.authResult,
    txnId: data.txnId
  };
}

function assertSuccessfulM1Verification(data = {}) {
  if (
    data.authResult &&
    String(data.authResult).trim().toLowerCase() !== 'success'
  ) {
    const error = new Error(data.message || 'ABHA authentication failed');
    error.statusCode = 400;
    error.code = 'ABDM_M1_AUTH_FAILED';
    error.details = responseShape(data);
    throw error;
  }
}

function requireFinalM1TokenSet(data = {}) {
  const tokens = extractTokenPayload(data) || {};
  const accessToken =
    tokens.token || tokens.accessToken || tokens.xToken || tokens.access_token;
  const refreshToken = tokens.refreshToken || tokens.refresh_token;

  // The documented M1 selected-account login response returns the patient
  // access token together with the refresh token (for example the successful
  // Find-ABHA Face Auth response). A lone short-lived token is not promoted to
  // an X-token here because that would mix M1 with the PHR T-token contract.
  if (!accessToken || !refreshToken) {
    const error = new Error(
      'ABDM M1 verification did not return the final X-token/R-token pair required for ABHA Profile access'
    );
    error.statusCode = 502;
    error.code = 'ABDM_M1_FINAL_SESSION_MISSING';
    error.details = responseShape(data);
    throw error;
  }

  return tokens;
}

async function resolveVerifiedM1Profile(data, options = {}) {
  assertSuccessfulM1Verification(data);
  const tokens = requireFinalM1TokenSet(data);
  const accessToken =
    tokens.token || tokens.accessToken || tokens.xToken || tokens.access_token;
  const fetchProfile = options.fetchProfile || (async (token) =>
    abdmGet('/v3/profile/account', {
      'X-token': `Bearer ${token}`
    })
  );

  const profileResponse = await fetchProfile(accessToken);
  const profile = extractProfile(profileResponse);
  if (!hasAbhaIdentity(profile)) {
    const error = new Error(
      'ABDM M1 profile response did not contain ABHA identity'
    );
    error.statusCode = 502;
    error.code = 'ABDM_M1_PROFILE_INVALID';
    error.details = {
      loginVerify: responseShape(data),
      profileKeys:
        profile && typeof profile === 'object' && !Array.isArray(profile)
          ? Object.keys(profile)
          : []
    };
    throw error;
  }

  return { profile, tokens, profileResponse };
}

module.exports = {
  responseShape,
  requireFinalM1TokenSet,
  resolveVerifiedM1Profile
};
