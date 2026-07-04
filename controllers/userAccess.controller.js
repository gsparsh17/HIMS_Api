const User = require('../models/User');
const { normalizeFeaturePermissions, toMainFeatureKey, ACCESS_ORDER } = require('../utils/mainFeatureAccess');

const ALLOWED_MODULES = new Set([
  'ipd.patient_file',
  'ipd.vitals',
  'ipd.initial_assessment.doctor',
  'ipd.initial_assessment.nursing',
  'ipd.medication_chart',
  'ipd.rounds',
  'pharmacy.pos',
  'pharmacy.returns',
  'pharmacy.clearance',
  'pharmacy.ledger',
  'masters.medicine',
  'masters.lab',
  'masters.radiology',
  'masters.charges',
  'hr.employees',
  'imports',
  'reports.exports',
  'users.access'
]);

const ALLOWED_ACTIONS = new Set([
  'approve',
  'discount_override',
  'refund',
  'settlement',
  'final_clearance',
  'bulk_import_commit',
  'user_access_manage'
]);

function normalizePermissions(rows, actor) {
  if (!Array.isArray(rows)) {
    throw new Error('modulePermissions must be an array');
  }

  const seen = new Set();
  return rows.map(row => {
    if (!ALLOWED_MODULES.has(row.moduleKey)) {
      throw new Error(`Unknown module: ${row.moduleKey}`);
    }

    if (!['none', 'view', 'edit'].includes(row.access)) {
      throw new Error(`Invalid access for ${row.moduleKey}`);
    }

    if (seen.has(row.moduleKey)) {
      throw new Error(`Duplicate permission for ${row.moduleKey}`);
    }
    seen.add(row.moduleKey);

    // Filter valid actions
    const actions = (row.actions || [])
      .filter(a => ALLOWED_ACTIONS.has(a));

    return {
      moduleKey: row.moduleKey,
      access: row.access,
      actions,
      grantedBy: actor,
      grantedAt: new Date(),
      updatedAt: new Date()
    };
  });
}

exports.getUsers = async (req, res) => {
  try {
    const filter = req.user.role === 'mediqliq_super_admin' 
      ? {} 
      : { hospital_id: req.user.hospital_id };

    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 });

    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, hospital_id, modulePermissions = [] } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ 
        success: false, 
        message: 'name, email, password and role are required' 
      });
    }

    // Check if user already exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'User with this email already exists' 
      });
    }

    // Validate hospital access
    if (req.user.role !== 'mediqliq_super_admin' && 
        hospital_id && 
        String(hospital_id) !== String(req.user.hospital_id)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Cross-hospital user creation denied' 
      });
    }

    // Prevent non-super-admin from creating admin accounts
    if (req.user.role !== 'mediqliq_super_admin' && 
        ['admin', 'mediqliq_super_admin'].includes(role)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Only a MediQliq super-admin can create privileged administrator roles' 
      });
    }

    const permissions = normalizePermissions(modulePermissions, req.user._id);

    const user = await User.create({
      name,
      email,
      password,
      role,
      hospital_id: hospital_id || req.user.hospital_id,
      modulePermissions: permissions,
      is_active: true
    });

    res.status(201).json({ 
      success: true, 
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        hospital_id: user.hospital_id,
        is_active: user.is_active,
        modulePermissions: user.modulePermissions
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ 
        success: false, 
        message: 'User with this email already exists' 
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateUserPermissions = async (req, res) => {
  try {
    const { userId } = req.params;
    const { modulePermissions = [], role, is_active } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check hospital access
    if (req.user.role !== 'mediqliq_super_admin' && 
        String(user.hospital_id) !== String(req.user.hospital_id)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Cross-hospital update denied' 
      });
    }

    // Prevent role escalation
    if (role && req.user.role !== 'mediqliq_super_admin' && 
        ['admin', 'mediqliq_super_admin'].includes(role)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Only a MediQliq super-admin can assign privileged administrator roles' 
      });
    }

    // Normalize and validate permissions
    const permissions = normalizePermissions(modulePermissions, req.user._id);

    // Update user
    if (role) user.role = role;
    if (is_active !== undefined) user.is_active = is_active;
    user.modulePermissions = permissions;
    await user.save();

    res.json({ 
      success: true, 
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        hospital_id: user.hospital_id,
        is_active: user.is_active,
        modulePermissions: user.modulePermissions
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        message: 'Password must be at least 6 characters' 
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check hospital access
    if (req.user.role !== 'mediqliq_super_admin' && 
        String(user.hospital_id) !== String(req.user.hospital_id)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Cross-hospital update denied' 
      });
    }

    user.password = password;
    await user.save();

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};