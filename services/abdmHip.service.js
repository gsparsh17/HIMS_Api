const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const { hiecmRequest } = require('./abdmHttp.service');

function hipHeaders(facilityId, extra = {}) {
  return {
    'X-HIP-ID': facilityId,
    'X-CM-ID': abdmConfig.cmId,
    ...extra
  };
}

async function generateLinkToken(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/v3/token/generate-token', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function linkCareContext(facilityId, linkToken, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/hip/v3/link/carecontext', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId, { 'X-LINK-TOKEN': linkToken }),
    requestId
  });
  return { requestId, data };
}

async function notifyCareContextUpdate(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/hip/v3/link/context/notify', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function respondDiscovery(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/user-initiated-linking/v3/patient/care-context/on-discover', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function respondLinkInit(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/user-initiated-linking/v3/link/care-context/on-init', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function respondLinkConfirm(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/user-initiated-linking/v3/link/care-context/on-confirm', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function acknowledgeConsent(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/consent/v3/request/hip/on-notify', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function acknowledgeHealthInformationRequest(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/data-flow/v3/health-information/hip/on-request', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function notifyHealthInformation(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/data-flow/v3/health-information/notify', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

async function acknowledgeProfileShare(facilityId, body, requestId = crypto.randomUUID()) {
  const data = await hiecmRequest('/patient-share/v3/on-share', {
    method: 'POST',
    body,
    headers: hipHeaders(facilityId),
    requestId
  });
  return { requestId, data };
}

module.exports = {
  generateLinkToken,
  linkCareContext,
  notifyCareContextUpdate,
  respondDiscovery,
  respondLinkInit,
  respondLinkConfirm,
  acknowledgeConsent,
  acknowledgeHealthInformationRequest,
  notifyHealthInformation,
  acknowledgeProfileShare
};
