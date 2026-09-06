'use strict';

const fs = require('fs');
const path = require('path');
const Hospital = require('../models/Hospital');
const fileStorage = require('./fileStorage.service');

function statusError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  if (code) error.code = code;
  return error;
}

function value(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function fullAddress(hospital = {}) {
  return [hospital.address, hospital.city, hospital.state, hospital.pinCode || hospital.pincode]
    .map(value)
    .filter(Boolean)
    .join(', ');
}

function normalizeHospitalPrintIdentity(hospital = {}) {
  const plain = typeof hospital?.toObject === 'function' ? hospital.toObject() : { ...hospital };
  const hospitalName = value(plain.hospitalName || plain.name);
  const hospitalAddress = fullAddress(plain);
  const contact = value(plain.contact || plain.phone || plain.mobile);
  const email = value(plain.email);
  const logo = value(plain.logo || plain.logoUrl || plain.hospitalLogo);

  return {
    ...plain,
    hospitalName,
    name: hospitalName || value(plain.name),
    hospitalAddress,
    hospitalContact: [contact, email].filter(Boolean).join(' | '),
    contact,
    email,
    logo
  };
}

function assertHospitalPrintIdentity(identity, { requireLogo = true } = {}) {
  const missing = [];
  if (!value(identity?.hospitalName)) missing.push('hospital name');
  if (!value(identity?.hospitalAddress)) missing.push('hospital address');
  if (requireLogo && !value(identity?.logo)) missing.push('hospital logo');

  if (missing.length) {
    throw statusError(
      409,
      `Hospital print profile is incomplete. Configure ${missing.join(', ')} before printing.`,
      'HOSPITAL_PRINT_PROFILE_INCOMPLETE'
    );
  }
  return identity;
}

/**
 * This HIMS deployment has one Hospital document per installation/database.
 * Print branding therefore comes from the singleton Hospital record and never
 * from admission/invoice/prescription hospital references, which may be absent
 * on historical data.
 */
async function getHospitalPrintIdentity(options = {}) {
  const hospital = await Hospital.findOne({ is_active: { $ne: false } })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  if (!hospital) {
    throw statusError(503, 'Hospital profile is not configured.', 'HOSPITAL_PRINT_PROFILE_MISSING');
  }

  const identity = normalizeHospitalPrintIdentity(hospital);
  assertHospitalPrintIdentity(identity, options);

  if (options.includeLogoBuffer) {
    const logoBuffer = await getHospitalLogoBuffer(identity);
    if (!logoBuffer && options.requireLogo !== false) {
      throw statusError(
        409,
        'Hospital logo is configured but cannot be read. Re-upload the hospital logo before printing.',
        'HOSPITAL_PRINT_LOGO_UNREADABLE'
      );
    }
    identity.logoBuffer = logoBuffer || null;
    identity._logoBuffer = logoBuffer || null;
  }

  return identity;
}

function dataUriBuffer(source) {
  const match = String(source || '').match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  return match ? Buffer.from(match[1], 'base64') : null;
}

async function getHospitalLogoBuffer(hospitalOrIdentity) {
  const identity = normalizeHospitalPrintIdentity(hospitalOrIdentity || {});
  const source = identity.logo;
  if (!source) return null;

  const embedded = dataUriBuffer(source);
  if (embedded) return embedded;

  try {
    if (source.includes('/api/files/')) {
      const stored = await fileStorage.findByUrl(source);
      if (stored) return fileStorage.readBuffer(stored);
    }

    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      return null;
    }

    // Handles storage keys and local file paths managed by fileStorage.
    try {
      return await fileStorage.readStoragePath(source, { hospitalId: identity._id });
    } catch (_) {
      // Backward-compatible support for legacy logo paths inside the application.
      const candidates = [
        path.resolve(process.cwd(), source.replace(/^[/\\]+/, '')),
        path.resolve(__dirname, '..', source.replace(/^[/\\]+/, ''))
      ];
      const local = candidates.find((candidate) => {
        try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch (_) { return false; }
      });
      return local ? fs.promises.readFile(local) : null;
    }
  } catch (_) {
    return null;
  }
}

module.exports = {
  normalizeHospitalPrintIdentity,
  assertHospitalPrintIdentity,
  getHospitalPrintIdentity,
  getHospitalLogoBuffer
};
