const crypto = require('crypto');
const platformController = require('./platform.controller');
const localConfig = require('../services/localPlatformConfig.service');

const fetchFn = (...args) => {
  return typeof fetch === 'function'
    ? fetch(...args)
    : import('node-fetch').then(({ default: fetchModule }) => fetchModule(...args));
};

// ============================================
// Status Endpoint
// ============================================

exports.status = async (_req, res) => {
  const Hospital = require('../models/Hospital');

  const hospital = await Hospital.findOne({ is_active: { $ne: false } })
    .select('hospitalID tenantCode hospitalName');

  const config = await localConfig.load().catch(() => null);

  res.json({
    success: true,
    provisioned: Boolean(hospital),
    hospital: hospital || null,
    enrolled: Boolean(config),
    masterConfirmed: Boolean(config?.masterConfirmedAt),
    masterUrl: config?.masterUrl || process.env.PLATFORM_MASTER_URL || ''
  });
};

// ============================================
// Activate Endpoint
// ============================================

exports.activate = async (req, res) => {
  try {
    const enrollmentCode = String(req.body?.enrollmentCode || '').trim();
    const masterUrl = String(req.body?.masterUrl || process.env.PLATFORM_MASTER_URL || '')
      .replace(/\/+$/, '');

    if (!enrollmentCode || !masterUrl) {
      return res.status(400).json({
        success: false,
        message: 'masterUrl and enrollmentCode are required'
      });
    }

    if (process.env.NODE_ENV === 'production' && !masterUrl.startsWith('https://')) {
      return res.status(400).json({
        success: false,
        message: 'Master URL must use HTTPS in production'
      });
    }

    const existingConfig = await localConfig.load().catch(() => null);

    const installationId = String(
      req.body?.installationId ||
      existingConfig?.installationId ||
      crypto.randomUUID()
    );

    // ============================================
    // Redeem enrollment code
    // ============================================

    const response = await fetchFn(`${masterUrl}/api/electron-enrollment/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentCode,
        installationId
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw Object.assign(
        new Error(data.message || data.error || `Enrollment failed: ${response.status}`),
        { statusCode: response.status }
      );
    }

    const bundle = data.provisioning;

    // ============================================
    // Save local configuration
    // ============================================

    await localConfig.save({
      ...bundle.connector,
      masterUrl: bundle.connector.masterUrl || masterUrl,
      installationId,
      enrollmentId: data.enrollmentId
    });

    // ============================================
    // Provision locally
    // ============================================

    let localResult;
    let statusCode = 201;

    const fakeResponse = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        localResult = value;
        return value;
      }
    };

    await platformController.provision({ body: bundle }, fakeResponse);

    if (!localResult?.success) {
      throw Object.assign(
        new Error(localResult?.error || 'Local provisioning failed'),
        { statusCode }
      );
    }

    // ============================================
    // Complete enrollment
    // ============================================

    const completeResponse = await fetchFn(`${masterUrl}/api/electron-enrollment/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: data.enrollmentId,
        installationId,
        hospitalId: localResult.hospitalId,
        adminId: localResult.adminId
      }),
      signal: AbortSignal.timeout(15000)
    });

    const completeData = await completeResponse.json().catch(() => ({}));

    if (!completeResponse.ok) {
      throw Object.assign(
        new Error(completeData.message || completeData.error || 'Master completion failed'),
        { statusCode: completeResponse.status }
      );
    }

    // ============================================
    // Mark confirmed
    // ============================================

    await localConfig.markConfirmed();

    return res.status(201).json({
      success: true,
      hospitalId: localResult.hospitalId,
      adminId: localResult.adminId,
      tenantCode: bundle.hospital.tenantCode,
      hospitalName: bundle.hospital.hospitalName
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message
    });
  }
};