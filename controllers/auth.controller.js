const User = require('../models/User');
const Hospital = require('../models/Hospital');
const generateToken = require('../utils/generateToken');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const Doctor = require('../models/Doctor');
const Staff = require('../models/Staff');
const Pharmacy = require('../models/Pharmacy');
const Department = require('../models/Department');
const fileStorage = require('../services/fileStorage.service');
const fs = require('fs');
const PathologyStaff = require('../models/PathologyStaff');
const OTStaff = require('../models/OTStaff'); // Add OT Staff model
const HRStaffProfile = require('../models/HRStaffProfile');
const jwt = require('jsonwebtoken');
const { effectiveMainFeaturePermissions } = require('../utils/mainFeatureAccess');
const NabhSetting = require('../models/NabhSetting');
const { getOrCreateNabhSetting } = require('../services/nabhSetting.service');
const {
  generateTotpSecret,
  verifyTotp,
  passwordPolicyErrors,
  createMfaChallenge,
  verifyMfaChallenge,
  verifySsoAssertion
} = require('../services/nabhSecurity.service');

const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'hims_access_token';


function dashboardForRole(role) {
  const normalized = String(role || '').toLowerCase();
  if (['store', 'store_manager', 'inventory_manager'].includes(normalized)) return 'store';
  if (['hr', 'hr_manager'].includes(normalized)) return 'hr';
  if (['accountant', 'insurance_desk'].includes(normalized)) return 'finance';
  // Equipment management is implemented inside Store Operations; there is no
  // standalone /dashboard/equipment page in the current frontend.
  if (normalized === 'equipment_manager') return 'store';
  return null;
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });
}



exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    // Return the same response for existing and unknown accounts to avoid
    // exposing the hospital user directory through password recovery.
    if (!user) {
      return res.status(200).json({
        message: 'If an account exists for that email, a reset link has been sent.'
      });
    }

    const resetToken = crypto.randomBytes(20).toString('hex');

    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpire = Date.now() + 15 * 60 * 1000;

    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    const message = `You (or someone else) requested to reset your password. Click the link below to reset it:\n\n${resetUrl}`;

    await sendEmail({
      to: user.email,
      subject: 'Password Reset Request',
      text: message
    });

    res.status(200).json({ message: 'If an account exists for that email, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot Password Error:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.demoLogin = async (req, res) => {
  try {
    if (String(process.env.ENABLE_DEMO_LOGIN || 'false').toLowerCase() !== 'true') {
      return res.status(404).json({ error: 'Route not found' });
    }
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required - Invalid authorization header format' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required - Token missing' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      console.error('JWT Verification Error:', jwtError);
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token format' });
      }
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      throw jwtError;
    }

    if (!decoded || !decoded.id) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    const demoUser = await User.findById(decoded.id);
    if (!demoUser) {
      return res.status(403).json({ error: 'User not found' });
    }
    if (demoUser.role !== 'demo') {
      return res.status(403).json({ error: 'Demo impersonation is restricted to the demo account' });
    }

    const targetUser = await User.findOne({ email });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hospital = await Hospital.findOne({});

    const newToken = generateToken(targetUser._id, targetUser.role);

    let response = {
      _id: targetUser._id,
      name: targetUser.name,
      email: targetUser.email,
      role: targetUser.role,
      token: newToken,
      hospital_id: hospital?._id,
      hospitalId: hospital?._id,
      hospitalID: hospital?._id,
      isDemoLogin: true,
      originalDemoUser: {
        id: demoUser._id,
        name: demoUser.name,
        email: demoUser.email
      }
    };

    try {
      if (targetUser.role === "doctor") {
        const doctor = await Doctor.findOne({ email: targetUser.email });
        response.doctorId = doctor?._id;
      }
      else if (["staff", "registrar", "receptionist"].includes(targetUser.role)) {
        const staff = await Staff.findOne({ email: targetUser.email });
        response.staffId = staff?._id;
      }
      else if (targetUser.role === "nurse") {
        const nurse = await Staff.findOne({ email: targetUser.email });
        response.staffId = nurse?._id;
      }
      else if (["hr", "hr_manager", "store", "store_manager", "inventory_manager", "accountant", "equipment_manager"].includes(targetUser.role)) {
        const hrProfile = await HRStaffProfile.findOne({ email: targetUser.email });
        response.employeeId = hrProfile?._id;
        response.employeeCode = hrProfile?.employee_code;
        response.dashboard = dashboardForRole(targetUser.role);
      }
      else if (targetUser.role === "pharmacy") {
        const pharmacy = await Pharmacy.findOne({ email: targetUser.email });
        response.pharmacyId = pharmacy?._id;
      }
      else if (targetUser.role === "pathology_staff") {
        const pathologyStaff = await PathologyStaff.findOne({ email: targetUser.email });
        response.pathologyStaffId = pathologyStaff?._id;
      }
      else if (targetUser.role === "ot_staff") {
        const otStaff = await OTStaff.findOne({ userId: targetUser._id });
        response.otStaffId = otStaff?._id;
      }
    } catch (roleError) {
      console.error('Error fetching role-specific data:', roleError);
    }

    setAuthCookie(res, newToken);
    res.json(response);

  } catch (err) {
    console.error('Demo Login error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.resetPassword = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });

    const setting = user.hospital_id
      ? await getOrCreateNabhSetting(user.hospital_id, user._id)
      : null;
    const policy = setting?.security?.passwordPolicy || {};
    const policyErrors = passwordPolicyErrors(password, policy);
    if (policyErrors.length) {
      return res.status(400).json({
        message: 'Password does not meet the configured policy',
        errors: policyErrors
      });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;

    await user.save();

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    const status = Number(err.statusCode) || 500;
    res.status(status).json({
      message: err.message,
      ...(Array.isArray(err.details) ? { errors: err.details } : {})
    });
  }
};

exports.registerUser = async (req, res) => {
  try {
    if (String(process.env.ALLOW_PUBLIC_HOSPITAL_REGISTRATION || 'false').toLowerCase() !== 'true') {
      return res.status(403).json({
        message: 'Hospital self-registration is disabled. New hospitals are provisioned by MediQliq Super Admin.'
      });
    }
    const {
      name, email, password, role, registryNo, address, contact,
      policyDetails, healthBima, additionalInfo,
      fireNOC, hospitalName, companyName, licenseNumber, state, city, pincode
    } = req.body;

    let logoUrl = null;
    if (req.file) {
      try {
        const result = await fileStorage.upload(req.file, req, { folder: 'hospital-logos', visibility: 'public' });
        logoUrl = result.secure_url;
        fs.unlinkSync(req.file.path);
      } catch (uploadErr) {
        console.error('Logo Upload Error:', uploadErr);
      }
    }

    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    const user = await User.create({ name, email, password, role });

    if (role === 'admin') {
      try {
        const hospital = new Hospital({
          registryNo,
          hospitalName,
          companyName,
          licenseNumber,
          state,
          city,
          pinCode: pincode,
          name,
          address,
          contact,
          email,
          fireNOC,
          policyDetails,
          healthBima,
          additionalInfo,
          logo: logoUrl,
          createdBy: user._id
        });

        await hospital.save({ validateBeforeSave: false });

        user.hospital_id = hospital._id;
        await user.save({ validateBeforeSave: false });

        await Department.create({ hospitalId: hospital._id, name: "Administration" });
        await Department.create({ hospitalId: hospital._id, name: "Emergency Department" });

      } catch (hospitalErr) {
        console.error('Hospital Creation Error:', hospitalErr);
        await User.deleteOne({ _id: user._id }).catch((cleanupError) => {
          console.error('User cleanup after hospital creation failure:', cleanupError);
        });
        return res.status(400).json({ message: 'Hospital creation failed', error: hospitalErr.message });
      }
    }

    const token = generateToken(user._id, user.role);
    setAuthCookie(res, token);
    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token
    });
  } catch (err) {
    console.error('🔴 Registration Error:', err);
    const status = Number(err.statusCode) || (err?.code === 11000 ? 409 : 500);
    return res.status(status).json({
      message: status < 500 ? err.message : 'Unable to complete registration',
      ...(Array.isArray(err.details) ? { errors: err.details } : {}),
      ...(err.code ? { code: err.code } : {})
    });
  }
};

// UPDATED LOGIN FUNCTION WITH OT STAFF SUPPORT - FIXED
function loginBase(user, hospital, tokenClaims = {}) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    token: generateToken(user._id, user.role, tokenClaims),
    hospital_id: user.hospital_id || hospital?._id,
    hospitalId: user.hospital_id || hospital?._id,
    hospitalID: user.hospital_id || hospital?._id,
    // Main role-oriented feature list used by navigation and guarded API routes.
    modulePermissions: effectiveMainFeaturePermissions(user)
  };
}

async function enrichLoginResponse(user, hospital, tokenClaims = {}) {
  const response = loginBase(user, hospital, tokenClaims);
  if (user.role === 'doctor') {
    const doctor = await Doctor.findOne({ $or: [{ user_id: user._id }, { email: user.email }] });
    response.doctorId = doctor?._id;
  } else if (['staff', 'registrar', 'receptionist', 'nurse'].includes(user.role)) {
    const staff = await Staff.findOne({ $or: [{ user_id: user._id }, { email: user.email }] });
    response.staffId = staff?._id;
  } else if (['hr', 'hr_manager', 'store', 'store_manager', 'inventory_manager', 'accountant', 'equipment_manager'].includes(user.role)) {
    const profile = await HRStaffProfile.findOne({ email: user.email });
    response.employeeId = profile?._id;
    response.employeeCode = profile?.employee_code;
    response.dashboard = dashboardForRole(user.role);
  } else if (user.role === 'pharmacy') {
    const pharmacy = await Pharmacy.findOne({ email: user.email });
    response.pharmacyId = pharmacy?._id;
  } else if (user.role === 'pathology_staff') {
    const pathologyStaff = await PathologyStaff.findOne({ $or: [{ user_id: user._id }, { email: user.email }] });
    response.pathologyStaffId = pathologyStaff?._id;
  } else if (user.role === 'ot_staff') {
    const otStaff = await OTStaff.findOne({ userId: user._id });
    response.otStaffId = otStaff?._id || null;
    response.otStaffDesignation = otStaff?.designation || 'OT Staff';
  }
  return response;
}

function mfaRequiredByPolicy(user, setting) {
  const mode = setting?.security?.mfaMode || 'optional';

  if (mode === 'required') return true;

  if (mode === 'required_for_admins') {
    return ['admin', 'mediqliq_super_admin'].includes(user.role);
  }

  return false;
}

function mfaRequiredForUser(user, setting) {
  return mfaRequiredByPolicy(user, setting) || Boolean(user.mfa?.enabled);
}

async function completeSuccessfulLogin(user, hospital, req, res, securityOverrides = {}) {
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;
  user.lastLoginAt = new Date();
  user.lastLoginIp = req.ip;
  await user.save({ validateBeforeSave: false });
  const tokenClaims = securityOverrides.mfaSetupRequired
    ? { mfaSetupRequired: true }
    : {};
  const response = await enrichLoginResponse(user, hospital, tokenClaims);
  const setting = user.hospital_id ? await getOrCreateNabhSetting(user.hospital_id, user._id) : null;
  response.security = {
    mfaEnabled: Boolean(user.mfa?.enabled),
    idleLockMinutes: Number(setting?.security?.idleLockMinutes || 15),
    passwordExpiryDays: Number(setting?.security?.passwordPolicy?.expiryDays || 90),
    ...securityOverrides
  };
  setAuthCookie(res, response.token);
  return res.json(response);
}

exports.getCurrentUser = async (req, res) => {
  const setting = req.user.hospital_id
    ? await getOrCreateNabhSetting(req.user.hospital_id, req.user._id)
    : null;
  return res.json({
    success: true,
    user: {
      _id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      hospital_id: req.user.hospital_id,
      hospitalId: req.user.hospital_id,
      hospitalID: req.user.hospital_id,
      modulePermissions: effectiveMainFeaturePermissions(req.user),
      security: {
        mfaEnabled: Boolean(req.user.mfa?.enabled),
        mfaMode: setting?.security?.mfaMode || 'optional',
        mfaSetupRequired: Boolean(
          mfaRequiredForUser(req.user, setting) && !req.user.mfa?.enabled
        ),
        idleLockMinutes: Number(setting?.security?.idleLockMinutes || 15),
        passwordPolicy: setting?.security?.passwordPolicy
      }
    }
  });
};

exports.loginUser = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({
        error: 'Email and password are required',
        code: 'LOGIN_FIELDS_REQUIRED'
      });
    }
    const user = await User.findOne({ email }).select('+mfa.secret +mfa.pendingSecret +mfa.recoveryCodes');
    const hospital = user?.hospital_id ? await Hospital.findById(user.hospital_id) : await Hospital.findOne({});
    const setting = user?.hospital_id ? await getOrCreateNabhSetting(user.hospital_id, user._id) : null;

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(423).json({
        error: 'Account is temporarily locked',
        code: 'ACCOUNT_LOCKED',
        lockedUntil: user.lockedUntil
      });
    }

    if (!user || !(await user.matchPassword(password))) {
      if (user && setting?.security?.failedLoginTracking !== false) {
        user.failedLoginAttempts = Number(user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= Number(setting.security.maxFailedAttempts || 5)) {
          user.lockedUntil = new Date(Date.now() + Number(setting.security.lockoutMinutes || 15) * 60 * 1000);
        }
        await user.save({ validateBeforeSave: false });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated. Please contact admin.' });

    const expiryDays = Number(setting?.security?.passwordPolicy?.expiryDays ?? 90);
    if (expiryDays > 0 && user.passwordChangedAt) {
      const expiresAt = new Date(user.passwordChangedAt).getTime() + expiryDays * 86400000;
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return res.status(403).json({
          error: 'Password has expired. Use password recovery to set a new password.',
          code: 'PASSWORD_EXPIRED'
        });
      }
    }

    const mfaRequired = mfaRequiredForUser(user, setting);
    if (mfaRequired && !user.mfa?.enabled) {
      // Permit one normal authenticated session so the user can enrol a TOTP
      // device. The response explicitly requires setup and the UI directs the
      // user to security settings immediately.
      return completeSuccessfulLogin(user, hospital, req, res, {
        mfaSetupRequired: true,
        mfaMode: setting?.security?.mfaMode || 'required'
      });
    }
    if (mfaRequired) {
      return res.json({
        mfaRequired: true,
        challengeToken: createMfaChallenge(user),
        user: { _id: user._id, email: user.email, role: user.role }
      });
    }

    return completeSuccessfulLogin(user, hospital, req, res);
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Unable to complete login' });
  }
};

exports.completeMfaLogin = async (req, res) => {
  try {
    const decoded = verifyMfaChallenge(req.body.challengeToken);
    const user = await User.findById(decoded.id).select('+mfa.secret +mfa.recoveryCodes');
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid MFA challenge' });
    if (!user.mfa?.enabled || !verifyTotp(user.mfa.secret, req.body.code)) {
      return res.status(401).json({ error: 'Invalid authentication code', code: 'INVALID_MFA_CODE' });
    }
    const hospital = user.hospital_id ? await Hospital.findById(user.hospital_id) : await Hospital.findOne({});
    return completeSuccessfulLogin(user, hospital, req, res);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired MFA challenge', code: 'INVALID_MFA_CHALLENGE' });
  }
};

exports.beginMfaSetup = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+mfa.pendingSecret');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const secret = generateTotpSecret();
    user.mfa.pendingSecret = secret;
    await user.save({ validateBeforeSave: false });
    const label = encodeURIComponent(`${process.env.APP_NAME || 'MediQliq HIMS'}:${user.email}`);
    const issuer = encodeURIComponent(process.env.APP_NAME || 'MediQliq HIMS');
    return res.json({
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

exports.verifyMfaSetup = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+mfa.pendingSecret +mfa.secret');
    if (!user?.mfa?.pendingSecret) return res.status(400).json({ error: 'Start MFA setup first' });
    if (!verifyTotp(user.mfa.pendingSecret, req.body.code)) {
      return res.status(400).json({ error: 'Invalid authentication code' });
    }
    user.mfa.secret = user.mfa.pendingSecret;
    user.mfa.pendingSecret = undefined;
    user.mfa.enabled = true;
    user.mfa.enabledAt = new Date();
    await user.save({ validateBeforeSave: false });
    return res.json({ success: true, message: 'Multi-factor authentication enabled' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

exports.disableMfa = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+mfa.secret');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const setting = user.hospital_id
      ? await getOrCreateNabhSetting(user.hospital_id, user._id)
      : null;
    if (mfaRequiredByPolicy(user, setting)) {
      return res.status(403).json({
        error: 'Multi-factor authentication is required by hospital security policy and cannot be disabled.'
      });
    }
    if (!user.mfa?.enabled || !verifyTotp(user.mfa.secret, req.body.code)) {
      return res.status(400).json({ error: 'A valid MFA code is required' });
    }
    user.mfa.enabled = false;
    user.mfa.secret = undefined;
    user.mfa.pendingSecret = undefined;
    user.mfa.enabledAt = undefined;
    await user.save({ validateBeforeSave: false });
    return res.json({ success: true, message: 'Multi-factor authentication disabled' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

exports.ssoAssertionLogin = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user?.hospital_id) return res.status(401).json({ error: 'SSO account not found' });
    const setting = await NabhSetting.findOne({ hospitalId: user.hospital_id })
      .select('+security.sso.assertionSecret');
    if (!setting?.security?.sso?.enabled) return res.status(403).json({ error: 'SSO is not enabled' });
    const verification = verifySsoAssertion(req.body, setting);
    if (!verification.valid) return res.status(401).json({ error: verification.reason });
    if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated' });
    const hospital = await Hospital.findById(user.hospital_id);
    return completeSuccessfulLogin(user, hospital, req, res);
  } catch (error) {
    return res.status(401).json({ error: 'Unable to validate SSO assertion' });
  }
};

exports.logoutUser = async (_req, res) => {
  clearAuthCookie(res);
  return res.json({ success: true, message: 'Logged out' });
};
