const jwt = require("jsonwebtoken");
const User = require("../models/User");
const {
  ACCESS_ORDER,
  toMainFeatureKey,
  mainFeaturePermission,
  effectiveMainFeaturePermissions,
  hasFeatureAccess,
} = require("../utils/mainFeatureAccess");

const ADMIN_ROLES = new Set(["admin", "mediqliq_super_admin"]);

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

exports.verifyToken = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res
        .status(401)
        .json({ success: false, error: "No token, authorization denied" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res
        .status(401)
        .json({ success: false, error: "User not found" });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: "Account is deactivated. Please contact admin.",
      });
    }

    req.user = user;

    // If permission checks are disabled, set effective permissions to all 'manage'
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

    return next();
  } catch (error) {
    const message =
      error.name === "TokenExpiredError"
        ? "Token expired"
        : error.name === "JsonWebTokenError"
        ? "Invalid token"
        : "Token is not valid";

    return res.status(401).json({ success: false, error: message });
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

  if (ADMIN_ROLES.has(req.user.role) || roles.includes(req.user.role)) {
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

  return ADMIN_ROLES.has(req.user.role)
    ? next()
    : res.status(403).json({ success: false, error: "Admin privileges required." });
};

exports.isMediQliqSuperAdmin = (req, res, next) => {
  // If permission checks are disabled, allow all users as super admin
  if (isPermissionCheckDisabled()) {
    return next();
  }

  return req.user?.role === "mediqliq_super_admin"
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
  if (user.role === 'mediqliq_super_admin' || user.role === 'admin') {
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

    if (req.user.role === 'mediqliq_super_admin' || req.user.role === 'admin') {
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
  if (user.role === 'mediqliq_super_admin' || user.role === 'admin') {
    return true;
  }

  const permission = (user.modulePermissions || []).find(
    p => p.moduleKey === moduleKey
  );

  if (!permission) return false;
  
  const accessLevels = { none: 0, view: 1, edit: 2 };
  return accessLevels[permission.access] >= accessLevels[minimumAccess];
};

/**
 * Get all actions a user has permission for across all modules
 * Useful for building action permission sets
 */
exports.getUserActions = (user) => {
  if (!user) return [];
  
  // Super admin and admin have all actions
  if (user.role === 'mediqliq_super_admin' || user.role === 'admin') {
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
      'preauth_decide',
      'transfer_reserve',
      'transfer_approve',
      'transfer_complete',
      'payroll_publish',
      'biometric_manage',
      'rate_card_approve',
      'pricing_override'
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
    req.user?.role === "mediqliq_super_admin"
      ? null
      : req.user?.hospital_id || null;
  return next();
};

exports.assertHospitalScope = (recordHospitalId) => (req, res, next) => {
  // If permission checks are disabled, skip hospital scope check
  if (isPermissionCheckDisabled()) {
    return next();
  }

  if (req.user?.role === "mediqliq_super_admin" || !req.user?.hospital_id) {
    return next();
  }

  if (recordHospitalId && String(recordHospitalId) !== String(req.user.hospital_id)) {
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
  if (user.role === 'mediqliq_super_admin' || user.role === 'admin') {
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
    ADMIN_ROLES.has(req.user.role) ||
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

  return req.user.role === "patient"
    ? res.status(403).json({ success: false, error: "Staff privileges required" })
    : next();
};

// Export the internal helper for use in other modules
exports._hasActionPermission = hasActionPermission;