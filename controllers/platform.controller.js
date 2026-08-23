const mongoose = require('mongoose');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const LicenseSnapshot = require('../models/LicenseSnapshot');
const PlatformProvisioningReceipt = require('../models/PlatformProvisioningReceipt');
const { normalizeEntitlements, mergeEntitlements } = require('../utils/entitlements');
const { upsertFromRemotePayload, publicLicense } = require('../services/licenseSnapshot.service');
const { parseOptionalDate, parseDateOrNow } = require('../utils/platformDates');

exports.health = async (_req, res) => {
  const hospital = await Hospital.findOne({ is_active: { $ne: false } }).select('hospitalID tenantCode hospitalName deployment');
  res.json({ success: true, status: 'ok', hospital: hospital ? { hospitalID: hospital.hospitalID, tenantCode: hospital.tenantCode, hospitalName: hospital.hospitalName } : null, timestamp: new Date().toISOString() });
};

exports.provision = async (req, res) => {
  const { provisioningId, version = 1, hospital: hospitalData = {}, administrator = {}, license = {} } = req.body || {};
  if (!provisioningId) return res.status(400).json({ success: false, error: 'provisioningId is required' });

  const existingReceipt = await PlatformProvisioningReceipt.findOne({ provisioningId });
  if (existingReceipt) {
    return res.json({
      success: true,
      idempotent: true,
      hospitalId: String(existingReceipt.hospitalId),
      adminId: String(existingReceipt.adminId),
      provisionVersion: existingReceipt.version
    });
  }

  if (!hospitalData.hospitalID || !hospitalData.tenantCode || !hospitalData.registryNo || !hospitalData.hospitalName) {
    return res.status(400).json({ success: false, error: 'hospital identity fields are incomplete' });
  }
  if (!administrator.name || !administrator.email || !administrator.temporaryPassword) {
    return res.status(400).json({ success: false, error: 'administrator name, email and temporaryPassword are required' });
  }
  if (!license.masterLicenseId || !license.planCode || !license.status) {
    return res.status(400).json({ success: false, error: 'license payload is incomplete' });
  }

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const hospitalObjectId = new mongoose.Types.ObjectId();
      const adminObjectId = new mongoose.Types.ObjectId();

      let hospital = await Hospital.findOne({
        $or: [
          { tenantCode: String(hospitalData.tenantCode).toUpperCase() },
          { hospitalID: String(hospitalData.hospitalID).toUpperCase() },
          ...(hospitalData.masterHospitalId ? [{ masterHospitalId: String(hospitalData.masterHospitalId) }] : [])
        ]
      }).session(session);

      if (!hospital) {
        hospital = new Hospital({
          _id: hospitalObjectId,
          masterHospitalId: hospitalData.masterHospitalId ? String(hospitalData.masterHospitalId) : undefined,
          hospitalID: hospitalData.hospitalID,
          tenantCode: hospitalData.tenantCode,
          registryNo: hospitalData.registryNo,
          hospitalName: hospitalData.hospitalName,
          companyName: hospitalData.companyName,
          licenseNumber: hospitalData.licenseNumber,
          name: hospitalData.name || administrator.name,
          address: hospitalData.address || 'Pending',
          contact: hospitalData.contact || administrator.phone || 'Pending',
          pinCode: hospitalData.pinCode,
          city: hospitalData.city || 'Pending',
          state: hospitalData.state || 'Pending',
          email: hospitalData.email || administrator.email,
          additionalInfo: hospitalData.additionalInfo,
          vitalsEnabled: hospitalData.vitalsEnabled !== false,
          vitalsController: hospitalData.vitalsController || 'nurse',
          deployment: { ...(hospitalData.deployment || {}), status: 'READY', provisionedAt: new Date() },
          onboarding: { ...(hospitalData.onboarding || {}), status: 'ADMIN_PROVISIONED' },
          primaryAdmin: adminObjectId,
          createdBy: adminObjectId
        });
        await hospital.save({ session });
      } else {
        hospital.masterHospitalId = hospitalData.masterHospitalId ? String(hospitalData.masterHospitalId) : hospital.masterHospitalId;
        hospital.tenantCode = hospitalData.tenantCode || hospital.tenantCode;
        hospital.deployment = { ...(hospital.deployment?.toObject?.() || hospital.deployment || {}), ...(hospitalData.deployment || {}), status: 'READY', provisionedAt: new Date() };
        hospital.onboarding = { ...(hospital.onboarding?.toObject?.() || hospital.onboarding || {}), status: 'ADMIN_PROVISIONED' };
      }

      let admin = await User.findOne({ email: String(administrator.email).trim().toLowerCase() }).session(session);
      if (!admin) {
        admin = new User({
          _id: hospital.primaryAdmin || adminObjectId,
          name: administrator.name,
          email: String(administrator.email).trim().toLowerCase(),
          phone: administrator.phone,
          password: administrator.temporaryPassword,
          role: 'admin',
          hospital_id: hospital._id,
          enforceModulePermissions: false,
          mustChangePassword: true,
          is_active: true
        });
        await admin.save({ session });
      } else {
        admin.hospital_id = hospital._id;
        admin.role = 'admin';
        admin.is_active = true;
        await admin.save({ session, validateBeforeSave: false });
      }

      hospital.primaryAdmin = admin._id;
      hospital.createdBy = hospital.createdBy || admin._id;
      await hospital.save({ session });

      const entitlementSnapshot = normalizeEntitlements(license.entitlementSnapshot || license.entitlements || {});
      const entitlementOverrides = license.entitlementOverrides || {};
      const snapshot = await LicenseSnapshot.findOneAndUpdate(
        { hospitalId: hospital._id },
        {
          $set: {
            tenantCode: hospital.tenantCode,
            masterLicenseId: String(license.masterLicenseId),
            key: license.key,
            status: license.status,
            planCode: license.planCode,
            planVersion: Number(license.planVersion || 1),
            startsAt: parseOptionalDate(license.startsAt, 'license.startsAt'),
            expiresAt: parseOptionalDate(license.expiresAt, 'license.expiresAt'),
            entitlementSnapshot,
            entitlementOverrides,
            effectiveEntitlements: mergeEntitlements(entitlementSnapshot, entitlementOverrides),
            limits: license.limits || {},
            licenseVersion: Number(license.licenseVersion || 1),
            checkedAt: new Date(),
            lastSyncStatus: 'PROVISIONED',
            sourceUpdatedAt: parseDateOrNow(license.updatedAt, 'license.updatedAt')
          }
        },
        { upsert: true, new: true, runValidators: true, session }
      );

      const receipt = await PlatformProvisioningReceipt.create([{
        provisioningId,
        version: Number(version || 1),
        tenantCode: hospital.tenantCode,
        hospitalId: hospital._id,
        adminId: admin._id,
        masterHospitalId: hospitalData.masterHospitalId
      }], { session });

      result = { hospital, admin, snapshot, receipt: receipt[0] };
    });
  } catch (error) {
    if (error.code === 11000) {
      const receipt = await PlatformProvisioningReceipt.findOne({ provisioningId });
      if (receipt) {
        return res.json({ success: true, idempotent: true, hospitalId: String(receipt.hospitalId), adminId: String(receipt.adminId), provisionVersion: receipt.version });
      }
    }
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, code: error.code });
  } finally {
    await session.endSession();
  }

  return res.status(201).json({
    success: true,
    hospitalId: String(result.hospital._id),
    adminId: String(result.admin._id),
    provisionVersion: Number(version || 1),
    license: publicLicense(result.snapshot)
  });
};

exports.licenseEvent = async (req, res) => {
  try {
    const snapshot = await upsertFromRemotePayload(req.body, 'PUSHED');
    return res.json({ success: true, license: publicLicense(snapshot) });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
};
