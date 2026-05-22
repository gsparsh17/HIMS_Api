const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const License = require('../models/License');
const AuditLog = require('../models/AuditLog');
const generateToken = require('../utils/generateToken');

const SUPER_ADMIN_ROLE = 'mediqliq_super_admin';

const userSelect = '-password -resetPasswordToken -resetPasswordExpire';

const allowedUserRoles = [
  SUPER_ADMIN_ROLE,
  'admin',
  'doctor',
  'nurse',
  'staff',
  'patient',
  'pharmacy',
  'registrar',
  'receptionist',
  'pathology_staff',
  'ot_staff',
  'demo',
];

const hospitalFields = [
  'hospitalID',
  'registryNo',
  'hospitalName',
  'logo',
  'companyName',
  'licenseNumber',
  'name',
  'address',
  'contact',
  'pinCode',
  'city',
  'state',
  'email',
  'fireNOC',
  'policyDetails',
  'healthBima',
  'additionalInfo',
  'vitalsEnabled',
  'vitalsController',
];

function pick(body, fields) {
  const data = {};
  fields.forEach((field) => {
    if (body[field] !== undefined) data[field] = body[field];
  });
  return data;
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPagination(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function paginationResponse({ data, total, page, limit }) {
  return {
    data,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

async function generateUniqueHospitalId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let value = '';
    for (let i = 0; i < 2; i += 1) value += letters[Math.floor(Math.random() * letters.length)];
    for (let i = 0; i < 4; i += 1) value += digits[Math.floor(Math.random() * digits.length)];

    // eslint-disable-next-line no-await-in-loop
    const exists = await Hospital.exists({ hospitalID: value });
    if (!exists) return value;
  }

  throw new Error('Unable to generate a unique hospital ID');
}

function generateLicenseKey() {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `MEDIQLIQ-${part()}-${part()}-${part()}`;
}

async function generateUniqueLicenseKey() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const key = generateLicenseKey();
    // eslint-disable-next-line no-await-in-loop
    const exists = await License.exists({ key });
    if (!exists) return key;
  }
  throw new Error('Unable to generate a unique license key');
}

function setAuditActor(req, user) {
  req.auditActor = {
    userId: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

exports.bootstrapSuperAdmin = async (req, res) => {
  try {
    const existingSuperAdmin = await User.exists({ role: SUPER_ADMIN_ROLE });
    if (existingSuperAdmin) {
      return res.status(409).json({
        success: false,
        message: 'MediQliq super admin already exists. Use login or create users from the super admin panel.',
      });
    }

    const envSecret = process.env.MEDIQLIQ_BOOTSTRAP_SECRET;
    if (envSecret && req.body.bootstrapSecret !== envSecret) {
      return res.status(403).json({
        success: false,
        message: 'Invalid bootstrap secret',
      });
    }

    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'name, email and password are required',
      });
    }

    const duplicateEmail = await User.exists({ email: email.toLowerCase() });
    if (duplicateEmail) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      role: SUPER_ADMIN_ROLE,
      is_active: true,
    });

    setAuditActor(req, user);

    return res.status(201).json({
      success: true,
      message: 'MediQliq super admin created successfully',
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        is_active: user.is_active,
      },
      token: generateToken(user._id, user.role),
    });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.loginSuperAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase(), role: SUPER_ADMIN_ROLE });
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    setAuditActor(req, user);

    return res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        is_active: user.is_active,
      },
      token: generateToken(user._id, user.role),
    });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMe = async (req, res) => {
  const user = await User.findById(req.user._id).select(userSelect);
  return res.json({ success: true, user });
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'currentPassword and newPassword are required' });
    }

    const user = await User.findById(req.user._id);
    if (!user || !(await user.matchPassword(currentPassword))) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const since24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalHospitals,
      totalUsers,
      activeUsers,
      licenseStatusCounts,
      totalAuditLogs24h,
      failedApiCalls24h,
      recentHospitals,
      recentAuditLogs,
    ] = await Promise.all([
      Hospital.countDocuments(),
      User.countDocuments(),
      User.countDocuments({ is_active: true }),
      License.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      AuditLog.countDocuments({ createdAt: { $gte: since24Hours } }),
      AuditLog.countDocuments({ createdAt: { $gte: since24Hours }, 'response.success': false }),
      Hospital.find().sort({ createdAt: -1 }).limit(5),
      AuditLog.find().sort({ createdAt: -1 }).limit(10),
    ]);

    const licenses = licenseStatusCounts.reduce((acc, item) => {
      acc[item._id || 'unknown'] = item.count;
      return acc;
    }, { active: 0, blocked: 0, expired: 0 });

    return res.json({
      success: true,
      stats: {
        hospitals: { total: totalHospitals },
        users: { total: totalUsers, active: activeUsers, inactive: totalUsers - activeUsers },
        licenses,
        api: { callsLast24Hours: totalAuditLogs24h, failedCallsLast24Hours: failedApiCalls24h },
      },
      recentHospitals,
      recentAuditLogs,
    });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.role) filter.role = req.query.role;
    if (req.query.is_active !== undefined) filter.is_active = req.query.is_active === 'true';
    if (req.query.search) {
      const regex = new RegExp(escapeRegex(req.query.search), 'i');
      filter.$or = [{ name: regex }, { email: regex }, { role: regex }];
    }

    const [users, total] = await Promise.all([
      User.find(filter).select(userSelect).sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);

    return res.json({ success: true, ...paginationResponse({ data: users, total, page, limit }) });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, is_active } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ success: false, message: 'name, email, password and role are required' });
    }

    if (!allowedUserRoles.includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role' });
    }

    const duplicateEmail = await User.exists({ email: email.toLowerCase() });
    if (duplicateEmail) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      role,
      is_active: is_active !== undefined ? Boolean(is_active) : true,
    });

    req.auditResource = { type: 'User', id: user._id.toString() };

    const safeUser = await User.findById(user._id).select(userSelect);
    return res.status(201).json({ success: true, user: safeUser });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { name, email, password, role, is_active } = req.body;

    if (role !== undefined) {
      if (!allowedUserRoles.includes(role)) {
        return res.status(400).json({ success: false, message: 'Invalid role' });
      }
      user.role = role;
    }

    if (email !== undefined) user.email = email.toLowerCase();
    if (name !== undefined) user.name = name;
    if (password !== undefined) user.password = password;
    if (is_active !== undefined) user.is_active = Boolean(is_active);

    await user.save();
    req.auditResource = { type: 'User', id: user._id.toString() };

    const safeUser = await User.findById(user._id).select(userSelect);
    return res.json({ success: true, user: safeUser });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    if (req.params.userId === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own super admin account' });
    }

    const user = await User.findByIdAndDelete(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    req.auditResource = { type: 'User', id: user._id.toString() };
    return res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listHospitals = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.search) {
      const regex = new RegExp(escapeRegex(req.query.search), 'i');
      filter.$or = [
        { hospitalID: regex },
        { hospitalName: regex },
        { companyName: regex },
        { email: regex },
        { city: regex },
        { state: regex },
      ];
    }

    const [hospitals, total] = await Promise.all([
      Hospital.find(filter).populate('createdBy', 'name email role').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Hospital.countDocuments(filter),
    ]);

    return res.json({ success: true, ...paginationResponse({ data: hospitals, total, page, limit }) });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createHospital = async (req, res) => {
  try {
    const requiredFields = ['registryNo', 'hospitalName', 'name', 'address', 'contact', 'city', 'state', 'email'];
    const missing = requiredFields.filter((field) => !req.body[field]);
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    }

    const data = pick(req.body, hospitalFields);
    if (req.body.pincode && !data.pinCode) data.pinCode = req.body.pincode;
    if (!data.hospitalID) data.hospitalID = await generateUniqueHospitalId();
    data.createdBy = req.user._id;

    const hospital = await Hospital.create(data);
    req.auditResource = { type: 'Hospital', id: hospital._id.toString() };

    return res.status(201).json({ success: true, hospital });
  } catch (error) {
    req.auditError = { message: error.message };
    const status = error.code === 11000 ? 409 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

exports.getHospital = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.hospitalId)) {
      return res.status(400).json({ success: false, message: 'Invalid hospital id' });
    }

    const hospital = await Hospital.findById(req.params.hospitalId).populate('createdBy', 'name email role');
    if (!hospital) return res.status(404).json({ success: false, message: 'Hospital not found' });

    return res.json({ success: true, hospital });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateHospital = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.hospitalId)) {
      return res.status(400).json({ success: false, message: 'Invalid hospital id' });
    }

    const data = pick(req.body, hospitalFields);
    if (req.body.pincode && !data.pinCode) data.pinCode = req.body.pincode;

    if (data.vitalsController && !['doctor', 'nurse', 'registrar'].includes(data.vitalsController)) {
      return res.status(400).json({ success: false, message: 'Invalid vitalsController' });
    }

    const hospital = await Hospital.findByIdAndUpdate(req.params.hospitalId, data, {
      new: true,
      runValidators: true,
    });

    if (!hospital) return res.status(404).json({ success: false, message: 'Hospital not found' });

    req.auditResource = { type: 'Hospital', id: hospital._id.toString() };
    return res.json({ success: true, hospital });
  } catch (error) {
    req.auditError = { message: error.message };
    const status = error.code === 11000 ? 409 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

exports.deleteHospital = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.hospitalId)) {
      return res.status(400).json({ success: false, message: 'Invalid hospital id' });
    }

    const hospital = await Hospital.findByIdAndDelete(req.params.hospitalId);
    if (!hospital) return res.status(404).json({ success: false, message: 'Hospital not found' });

    req.auditResource = { type: 'Hospital', id: hospital._id.toString() };
    return res.json({ success: true, message: 'Hospital deleted successfully' });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listLicenses = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.plan) filter.plan = req.query.plan;
    if (req.query.hospitalId && isValidObjectId(req.query.hospitalId)) filter.hospital = req.query.hospitalId;
    if (req.query.search) {
      const regex = new RegExp(escapeRegex(req.query.search), 'i');
      filter.$or = [{ key: regex }, { plan: regex }, { issuedTo: regex }];
    }

    const [licenses, total] = await Promise.all([
      License.find(filter)
        .populate('hospital', 'hospitalID hospitalName email city state')
        .populate('createdBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      License.countDocuments(filter),
    ]);

    return res.json({ success: true, ...paginationResponse({ data: licenses, total, page, limit }) });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createLicense = async (req, res) => {
  try {
    const data = pick(req.body, [
      'key',
      'plan',
      'maxActivations',
      'status',
      'expiryDate',
      'hospital',
      'issuedTo',
      'notes',
      'features',
      'metadata',
    ]);

    if (!data.key) data.key = await generateUniqueLicenseKey();
    data.createdBy = req.user._id;

    if (data.hospital && !isValidObjectId(data.hospital)) {
      return res.status(400).json({ success: false, message: 'Invalid hospital id' });
    }

    const license = await License.create(data);
    req.auditResource = { type: 'License', id: license._id.toString() };

    return res.status(201).json({ success: true, license });
  } catch (error) {
    req.auditError = { message: error.message };
    const status = error.code === 11000 ? 409 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

exports.getLicense = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.licenseId)) {
      return res.status(400).json({ success: false, message: 'Invalid license id' });
    }

    const license = await License.findById(req.params.licenseId)
      .populate('hospital', 'hospitalID hospitalName email city state')
      .populate('createdBy updatedBy', 'name email role');

    if (!license) return res.status(404).json({ success: false, message: 'License not found' });

    return res.json({ success: true, license });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateLicense = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.licenseId)) {
      return res.status(400).json({ success: false, message: 'Invalid license id' });
    }

    const data = pick(req.body, [
      'key',
      'plan',
      'maxActivations',
      'status',
      'expiryDate',
      'hospital',
      'issuedTo',
      'notes',
      'features',
      'metadata',
    ]);
    data.updatedBy = req.user._id;
    data.updatedAt = new Date();

    if (data.hospital && !isValidObjectId(data.hospital)) {
      return res.status(400).json({ success: false, message: 'Invalid hospital id' });
    }

    const license = await License.findByIdAndUpdate(req.params.licenseId, data, {
      new: true,
      runValidators: true,
    });

    if (!license) return res.status(404).json({ success: false, message: 'License not found' });

    req.auditResource = { type: 'License', id: license._id.toString() };
    return res.json({ success: true, license });
  } catch (error) {
    req.auditError = { message: error.message };
    const status = error.code === 11000 ? 409 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

exports.deleteLicense = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.licenseId)) {
      return res.status(400).json({ success: false, message: 'Invalid license id' });
    }

    const license = await License.findByIdAndDelete(req.params.licenseId);
    if (!license) return res.status(404).json({ success: false, message: 'License not found' });

    req.auditResource = { type: 'License', id: license._id.toString() };
    return res.json({ success: true, message: 'License deleted successfully' });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.resetLicenseActivations = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.licenseId)) {
      return res.status(400).json({ success: false, message: 'Invalid license id' });
    }

    const license = await License.findById(req.params.licenseId);
    if (!license) return res.status(404).json({ success: false, message: 'License not found' });

    license.activations = [];
    license.updatedBy = req.user._id;
    license.updatedAt = new Date();
    await license.save();

    req.auditResource = { type: 'License', id: license._id.toString() };
    return res.json({ success: true, message: 'License activations reset successfully', license });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.removeLicenseActivation = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.licenseId)) {
      return res.status(400).json({ success: false, message: 'Invalid license id' });
    }

    const license = await License.findById(req.params.licenseId);
    if (!license) return res.status(404).json({ success: false, message: 'License not found' });

    license.activations = license.activations.filter((activation) => {
      const activationId = activation._id?.toString();
      return activationId !== req.params.activationId && activation.deviceId !== req.params.activationId;
    });
    license.updatedBy = req.user._id;
    license.updatedAt = new Date();
    await license.save();

    req.auditResource = { type: 'LicenseActivation', id: req.params.activationId };
    return res.json({ success: true, message: 'License activation removed successfully', license });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listAuditLogs = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.method) filter['request.method'] = req.query.method.toUpperCase();
    if (req.query.statusCode) filter['response.statusCode'] = parseInt(req.query.statusCode, 10);
    if (req.query.success !== undefined) filter['response.success'] = req.query.success === 'true';
    if (req.query.userRole) filter['actor.role'] = req.query.userRole;
    if (req.query.userEmail) filter['actor.email'] = new RegExp(escapeRegex(req.query.userEmail), 'i');
    if (req.query.ip) filter['request.ip'] = req.query.ip;
    if (req.query.requestId) filter.requestId = req.query.requestId;
    if (req.query.userId && isValidObjectId(req.query.userId)) filter['actor.userId'] = req.query.userId;
    if (req.query.hospitalId && isValidObjectId(req.query.hospitalId)) filter.hospitalId = req.query.hospitalId;

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    if (req.query.path) {
      filter['request.originalUrl'] = new RegExp(escapeRegex(req.query.path), 'i');
    }

    if (req.query.search) {
      const regex = new RegExp(escapeRegex(req.query.search), 'i');
      filter.$or = [
        { requestId: regex },
        { 'request.originalUrl': regex },
        { 'actor.email': regex },
        { 'actor.name': regex },
        { 'request.ip': regex },
      ];
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate('actor.userId', 'name email role')
        .populate('hospitalId', 'hospitalID hospitalName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    return res.json({ success: true, ...paginationResponse({ data: logs, total, page, limit }) });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getAuditLog = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.auditLogId)) {
      return res.status(400).json({ success: false, message: 'Invalid audit log id' });
    }

    const auditLog = await AuditLog.findById(req.params.auditLogId)
      .populate('actor.userId', 'name email role')
      .populate('hospitalId', 'hospitalID hospitalName');

    if (!auditLog) return res.status(404).json({ success: false, message: 'Audit log not found' });

    return res.json({ success: true, auditLog });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.pruneAuditLogs = async (req, res) => {
  try {
    const days = Math.max(parseInt(req.query.days, 10) || 90, 1);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await AuditLog.deleteMany({ createdAt: { $lt: cutoff } });

    req.auditResource = { type: 'AuditLogRetention', id: `${days}-days` };
    return res.json({
      success: true,
      message: `Audit logs older than ${days} days deleted`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};
