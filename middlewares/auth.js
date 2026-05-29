// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Protect routes (alias for protect - for backward compatibility)
exports.verifyToken = async (req, res, next) => {
  try {
    let token;

    // Check if authorization header exists
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'No token, authorization denied' 
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    const user = await User.findById(decoded.id).select('-password');
    
    if (!user) {
      return res.status(401).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({ 
        success: false,
        error: 'Account is deactivated. Please contact admin.' 
      });
    }

    // Attach user to request object
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid token' 
      });
    }
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false,
        error: 'Token expired' 
      });
    }

    res.status(401).json({ 
      success: false,
      error: 'Token is not valid' 
    });
  }
};

exports.verifyToken1 = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;

    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};

// Protect routes (original function name)
exports.protect = exports.verifyToken;

// Check if user is hospital admin or MediQliq super admin
exports.isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      error: 'User not authenticated' 
    });
  }

  // Check if user has admin role
  if (!['admin', 'mediqliq_super_admin'].includes(req.user.role)) {
    return res.status(403).json({ 
      success: false,
      error: 'Access denied. Admin privileges required.' 
    });
  }

  next();
};


// Check if user is MediQliq product super admin
exports.isMediQliqSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated'
    });
  }

  if (req.user.role !== 'mediqliq_super_admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied. MediQliq super admin privileges required.'
    });
  }

  next();
};

// Role-based access
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // MediQliq super admin can access role-protected product APIs.
    if (req.user.role === 'mediqliq_super_admin') {
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false,
        error: `Access denied. Required role: ${roles.join(' or ')}. Your role: ${req.user.role}` 
      });
    }
    next();
  };
};

// Check if user has specific permission (can be extended based on your permission system)
exports.hasPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // Admin and MediQliq super admin have all permissions
    if (req.user.role === 'admin' || req.user.role === 'mediqliq_super_admin') {
      return next();
    }

    // Define role-based permissions
    const rolePermissions = {
      doctor: ['view_patients', 'create_prescriptions', 'view_appointments'],
      nurse: ['view_patients', 'record_vitals', 'view_appointments'],
      staff: ['view_patients', 'create_appointments'],
      pharmacist: ['view_medicines', 'dispense_medicines'],
      registrar: ['register_patients', 'create_appointments'],
      receptionist: ['view_appointments', 'create_appointments'],
      pathology_staff: ['view_lab_tests', 'record_lab_results'],
      radiology_staff: ['view_radiology_tests', 'record_radiology_results'],
      ot_staff: ['view_ot_cases', 'record_ot_notes'],
      store: ['view_store', 'manage_store_inventory'],
      store_manager: ['view_store', 'manage_store_inventory', 'approve_store_requests'],
      inventory_manager: ['view_store', 'manage_store_inventory'],
      hr: ['view_hr', 'manage_attendance'],
      hr_manager: ['view_hr', 'manage_staff', 'manage_attendance'],
      patient: ['view_own_records']
    };

    const userPermissions = rolePermissions[req.user.role] || [];

    if (!userPermissions.includes(permission)) {
      return res.status(403).json({ 
        success: false,
        error: `Access denied. ${permission} permission required.` 
      });
    }

    next();
  };
};

// Optional: Check if user is accessing their own resource
exports.isOwner = (paramIdField = 'id') => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // Admin and MediQliq super admin can access any resource
    if (req.user.role === 'admin' || req.user.role === 'mediqliq_super_admin') {
      return next();
    }

    const resourceId = req.params[paramIdField];
    
    // Check if the resource ID matches the user ID
    if (resourceId && resourceId === req.user._id.toString()) {
      return next();
    }

    return res.status(403).json({ 
      success: false,
      error: 'Access denied. You can only access your own resources.' 
    });
  };
};

// Optional: Check if user is staff (non-admin, non-doctor, non-patient roles)
exports.isStaff = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      error: 'User not authenticated' 
    });
  }

  const staffRoles = ['nurse', 'staff', 'pharmacist', 'registrar', 'receptionist', 'pathology_staff', 'radiology_staff', 'ot_staff', 'store', 'store_manager', 'inventory_manager', 'hr', 'hr_manager', 'accountant'];
  
  if (req.user.role === 'admin' || req.user.role === 'mediqliq_super_admin' || staffRoles.includes(req.user.role)) {
    return next();
  }

  return res.status(403).json({ 
    success: false,
    error: 'Access denied. Staff privileges required.' 
  });
};