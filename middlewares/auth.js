const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { userHospitalId, isPlatformAdmin } = require('../utils/hospitalScope');
const {
  ACCESS_ORDER,
  toMainFeatureKey,
  mainFeaturePermission,
  effectiveMainFeaturePermissions,
  hasFeatureAccess,
} = require("../utils/mainFeatureAccess");

const ADMIN_ROLES = new Set(["admin", "mediqliq_super_admin"]);

function normalizedRole(userOrRole) {
  const value = typeof userOrRole === 'object' ? userOrRole?.role : userOrRole;
  return String(value || '').trim().toLowerCase();
}

function isAdminRole(user) {
  return ADMIN_ROLES.has(normalizedRole(user));
}

// Permission checks are enabled by default. Set DISABLE_PERMISSION_CHECKS=true only for
// controlled local troubleshooting; never use that setting in production.
const isPermissionCheckDisabled = () =>
  String(process.env.DISABLE_PERMISSION_CHECKS || 'false').toLowerCase() === 'true';

function accessForRequestedModule(user, moduleKey) {
  // If permission checks are disabled, return 'manage' access for all modules
  if (isPermissionCheckDisabled()) {
    const mainModuleKey = toMainFeatureKey(moduleKey);
    return {
      moduleKey,
      mainModuleKey,
      access: "manage",
    };
  }

  const mainModuleKey = toMainFeatureKey(moduleKey);
  const permission = mainFeaturePermission(user, mainModuleKey);
  return {
    moduleKey,
    mainModuleKey,
    access: permission.access,
  };
}

function cookieValue(req, name) {
  const cookieHeader = String(req.headers?.cookie || '');
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function requestToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return cookieValue(req, process.env.AUTH_COOKIE_NAME || 'hims_access_token');
}

async function authenticateRequest(req, { optional = false } = {}) {
  const token = requestToken(req);
  if (!token) {
    if (optional) return null;
    const error = new Error("No token, authorization denied");
    error.statusCode = 401;
    throw error;
  }

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id).select("-password");
  if (!user) {
    const error = new Error("User not found");
    error.statusCode = 401;
    throw error;
  }
  if (!user.is_active) {
    const error = new Error("Account is deactivated. Please contact admin.");
    error.statusCode = 403;
    throw error;
  }
  return user;
}

function attachEffectivePermissions(req, user) {
  req.user = user;
  const hospitalId = userHospitalId(user);
  if (hospitalId) {
    req.hospital_id = req.hospital_id || hospitalId;
    req.hospitalId = req.hospitalId || hospitalId;
  }
  if (isPermissionCheckDisabled()) {
    const { MAIN_FEATURES } = require("../utils/mainFeatureAccess");
    req.effectiveModulePermissions = MAIN_FEATURES.map(({ key, label, description }) => ({
      moduleKey: key,
      label,
      description,
      access: "manage",
    }));
  } else {
    req.effectiveModulePermissions = effectiveMainFeaturePermissions(user);
  }
}

exports.verifyToken = async (req, res, next) => {
  try {
    const user = await authenticateRequest(req);
    attachEffectivePermissions(req, user);
    return next();
  } catch (error) {
    const message =
      error.name === "TokenExpiredError"
        ? "Token expired"
        : error.name === "JsonWebTokenError"
        ? "Invalid token"
        : error.message || "Token is not valid";
    return res.status(error.statusCode || 401).json({ success: false, error: message });
  }
};

exports.optionalAuth = async (req, res, next) => {
  try {
    const user = await authenticateRequest(req, { optional: true });
    if (user) attachEffectivePermissions(req, user);
    return next();
  } catch (_error) {
    // Invalid credentials are treated as anonymous here. The controller still
    // rejects private files, while public assets remain accessible.
    return next();
  }
};

exports.protect = exports.verifyToken;
exports.verifyToken1 = exports.verifyToken;

exports.authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res
      .status(401)
      .json({ success: false, error: "User not authenticated" });
  }

  // If permission checks are disabled, allow all roles
  if (isPermissionCheckDisabled()) {
    return next();
  }

  const role = normalizedRole(req.user);
  const allowedRoles = roles.map(normalizedRole);
  if (isAdminRole(req.user) || allowedRoles.includes(role)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    error: `Access denied. Required role: ${roles.join(" or ")}`,
  });
};

exports.isAdmin = (req, res, next) => {
  if (!req.user) {
    return res
      .status(401)
      .json({ success: false, error: "User not authenticated" });
  }

  // If permission checks are disabled, allow all users as admin
  if (isPermissionCheckDisabled()) {
    return next();
  }

  return isAdminRole(req.user)
    ? next()
    : res.status(403).json({ success: false, error: "Admin privileges required." });
};

exports.isMediQliqSuperAdmin = (req, res, next) => {
  // If permission checks are disabled, allow all users as super admin
  if (isPermissionCheckDisabled()) {
    return next();
  }

  return isPlatformAdmin(req.user)
    ? next()
    : res.status(req.user ? 403 : 401).json({
        success: false,
        error: "MediQliq super admin privileges required.",
      });
};

/**
 * Accepts the old detailed route key but resolves it to one main feature.
 * Examples: ipd.vitals -> ipd, masters.medicine -> pharmacy,
 * hr.employees -> hr_staff.
 */
exports.requireModuleAccess = (moduleKey, minimumAccess = "view") => (
  req,
  res,
  next
) => {
  if (!req.user) {
    return res
      .status(401)
      .json({ success: false, error: "User not authenticated" });
  }

  // If permission checks are disabled, allow all access
  if (isPermissionCheckDisabled()) {
    req.modulePermission = {
      moduleKey,
      mainModuleKey: toMainFeatureKey(moduleKey),
      access: "manage",
    };
    return next();
  }

  const permission = accessForRequestedModule(req.user, moduleKey);
  const required = minimumAccess === "edit" ? "manage" : minimumAccess;

  if (ACCESS_ORDER[permission.access] >= ACCESS_ORDER[required]) {
    req.modulePermission = permission;
    return next();
  }

  return res.status(403).json({
    success: false,
    error: `${required} access required for ${permission.mainModuleKey}`,
    moduleKey: permission.mainModuleKey,
    required,
  });
};

// ===================================================================
// NEW: Action-based permission functions for the frontend user access
// management system
// ===================================================================

/**
 * Check if a user has a specific sensitive action permission
 * Super admins and admins have all action permissions
 */
const hasActionPermission = (user, action) => {
  if (!user) return false;
  
  // Super admin and admin have all actions
  if (isAdminRole(user)) {
    return true;
  }

  // Check module permissions for actions
  const permissions = user.modulePermissions || [];
  for (const permission of permissions) {
    if (permission.actions && Array.isArray(permission.actions) && 
        permission.actions.includes(action)) {
      return true;
    }
  }
  return false;
};

/**
 * Middleware to require a specific sensitive action permission
 * Used for routes that require special privileges like refund, settlement, etc.
 */
exports.requireActionPermission = (action) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        error: 'User not authenticated' 
      });
    }

    // If permission checks are disabled, allow all actions
    if (isPermissionCheckDisabled()) {
      return next();
    }

    if (isAdminRole(req.user)) {
      return next();
    }

    const hasAction = hasActionPermission(req.user, action);
    if (!hasAction) {
      return res.status(403).json({
        success: false,
        error: `Action "${action}" is not permitted for this user`
      });
    }

    next();
  };
};

/**
 * Require at least one sensitive action permission. This is useful while
 * migrating legacy permissions (for example final_clearance) to a clearer
 * billing-specific action (billing_finalize).
 */
exports.requireAnyActionPermission = (actions = []) => {
  const expected = Array.isArray(actions) ? actions.filter(Boolean) : [actions].filter(Boolean);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }
    if (isPermissionCheckDisabled() || isAdminRole(req.user)) return next();
    if (expected.some((action) => hasActionPermission(req.user, action))) return next();
    return res.status(403).json({
      success: false,
      error: `One of these actions is required: ${expected.join(', ')}`
    });
  };
};

/**
 * Get user's effective module permissions with actions
 * Returns the full modulePermissions array with all details
 */
exports.getEffectivePermissions = (user) => {
  if (!user) return [];
  return user.modulePermissions || [];
};

/**
 * Check if a user has access to a specific module with minimum access level
 * Used for UI rendering and route protection
 */
exports.hasModuleAccess = (user, moduleKey, minimumAccess = 'view') => {
  if (!user) return false;
  
  // Super admin and admin have all module access
  if (isAdminRole(user)) {
    return true;
  }

  const permission = (user.modulePermissions || []).find(
    p => p.moduleKey === moduleKey
  );

  if (!permission) return false;
  
  const accessLevels = { none: 0, view: 1, edit: 2, manage: 2 };
  const required = minimumAccess === 'edit' ? 'manage' : minimumAccess;
  return (accessLevels[permission.access] || 0) >= (accessLevels[required] || 0);
};

/**
 * Get all actions a user has permission for across all modules
 * Useful for building action permission sets
 */
exports.getUserActions = (user) => {
  if (!user) return [];
  
  // Super admin and admin have all actions
  if (isAdminRole(user)) {
    return [
      'approve',
      'discount_override',
      'refund',
      'settlement',
      'final_clearance',
      'bulk_import_commit',
      'user_access_manage',
      'ot_approve',
      'ot_emergency_bypass',
      'stock_adjustment',
      'document_sign',
      'print_identity_verify',
      'mis_export',
      'claim_submit',
      'claim_manage',
      'claim_export',
      'preauth_decide',
      'rate_card_activate',
      'tariff_mapping_approve',
      'coverage_reprice',
      'coverage_reprice_commit',
      'transfer_reserve',
      'transfer_approve',
      'transfer_complete',
      'payroll_publish',
      'biometric_manage',
      'rate_card_approve',
      'pricing_override',
      'billing_create',
      'billing_edit',
      'billing_delete_charge',
      'billing_apply_discount',
      'billing_finalize'
    ];
  }

  const actions = new Set();
  const permissions = user.modulePermissions || [];
  for (const permission of permissions) {
    if (permission.actions && Array.isArray(permission.actions)) {
      permission.actions.forEach(action => actions.add(action));
    }
  }
  return Array.from(actions);
};

/**
 * Check if user has any of the specified actions
 */
exports.hasAnyAction = (user, actions) => {
  if (!user || !actions || !Array.isArray(actions)) return false;
  const userActions = exports.getUserActions(user);
  return actions.some(action => userActions.includes(action));
};

/**
 * Check if user has all of the specified actions
 */
exports.hasAllActions = (user, actions) => {
  if (!user || !actions || !Array.isArray(actions)) return false;
  const userActions = exports.getUserActions(user);
  return actions.every(action => userActions.includes(action));
};

// ===================================================================
// END OF NEW ACTION-BASED PERMISSION FUNCTIONS
// ===================================================================

exports.attachHospitalScope = (req, res, next) => {
  // If permission checks are disabled, allow access to all hospitals
  if (isPermissionCheckDisabled()) {
    req.hospitalScope = null;
    return next();
  }

  req.hospitalScope =
    isPlatformAdmin(req.user)
      ? null
      : userHospitalId(req.user);
  return next();
};

exports.assertHospitalScope = (recordHospitalId) => (req, res, next) => {
  // If permission checks are disabled, skip hospital scope check
  if (isPermissionCheckDisabled()) {
    return next();
  }

  const hospitalId = userHospitalId(req.user);
  if (isPlatformAdmin(req.user) || !hospitalId) {
    return next();
  }

  if (recordHospitalId && String(recordHospitalId) !== String(hospitalId)) {
    return res
      .status(403)
      .json({ success: false, error: "Cross-hospital access denied" });
  }

  return next();
};

exports.getPermission = (user, moduleKey) => {
  // If permission checks are disabled, return 'manage' access
  if (isPermissionCheckDisabled()) {
    const mainModuleKey = toMainFeatureKey(moduleKey);
    return {
      moduleKey,
      mainModuleKey,
      access: "manage",
    };
  }
  return accessForRequestedModule(user, moduleKey);
};

exports.hasPermission = (feature) => {
  // If permission checks are disabled, always return true
  if (isPermissionCheckDisabled()) {
    return true;
  }
  return exports.requireModuleAccess(feature, "manage");
};

exports.hasFeatureAccess = (user, moduleKey, minimumAccess = "view") => {
  // If permission checks are disabled, always return true
  if (isPermissionCheckDisabled()) {
    return true;
  }
  return hasFeatureAccess(user, moduleKey, minimumAccess);
};

/**
 * Helper function to check if user has module access (for use in controllers)
 * Returns boolean without throwing errors
 */
exports.checkModuleAccess = (user, moduleKey, minimumAccess = "view") => {
  if (!user) return false;
  
  // If permission checks are disabled, allow all access
  if (isPermissionCheckDisabled()) {
    return true;
  }

  // Super admin and admin have all access
  if (isAdminRole(user)) {
    return true;
  }

  const permission = accessForRequestedModule(user, moduleKey);
  const required = minimumAccess === "edit" ? "manage" : minimumAccess;
  return ACCESS_ORDER[permission.access] >= ACCESS_ORDER[required];
};

exports.isOwner = (param = "id") => (req, res, next) => {
  if (!req.user) {
    return res
      .status(401)
      .json({ success: false, error: "User not authenticated" });
  }

  // If permission checks are disabled, allow all ownership checks
  if (isPermissionCheckDisabled()) {
    return next();
  }

  if (
    isAdminRole(req.user) ||
    String(req.params[param]) === String(req.user._id)
  ) {
    return next();
  }

  return res.status(403).json({ success: false, error: "Access denied" });
};

exports.isStaff = (req, res, next) => {
  if (!req.user) {
    return res
      .status(401)
      .json({ success: false, error: "User not authenticated" });
  }

  // If permission checks are disabled, allow all staff checks
  if (isPermissionCheckDisabled()) {
    return next();
  }

  return normalizedRole(req.user) === "patient"
    ? res.status(403).json({ success: false, error: "Staff privileges required" })
    : next();
};

// Export the internal helper for use in other modules
exports._hasActionPermission = hasActionPermission;