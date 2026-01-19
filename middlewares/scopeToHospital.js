/**
 * Simple Hospital Scope Middleware
 * Adds hospital context to requests based on authenticated user
 */

const Hospital = require('../models/Hospital');

exports.scopeToHospital = async (req, res, next) => {
  try {
    // Skip if user is not authenticated (should come after auth middleware)
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // For super admin, no hospital restriction needed
    if (req.user.role === 'super_admin') {
      // Super admin can optionally filter by hospital_id in query
      if (req.query.hospital_id) {
        const hospital = await Hospital.findById(req.query.hospital_id);
        if (!hospital) {
          return res.status(400).json({ error: 'Hospital not found' });
        }
        req.hospital_id = hospital._id;
        req.hospital_ids = [hospital._id];
      }
      // If no hospital_id specified, super admin sees all data
      return next();
    }

    // For non-super users, get their hospital context
    let hospital_id = null;
    let hospital_ids = [];

    // Get primary hospital
    if (req.user.primary_hospital_id) {
      hospital_id = req.user.primary_hospital_id._id || req.user.primary_hospital_id;
      hospital_ids.push(hospital_id);
    }

    // Add other assigned hospitals
    if (req.user.hospital_ids && req.user.hospital_ids.length > 0) {
      req.user.hospital_ids.forEach(h => {
        const hId = h._id || h;
        if (!hospital_ids.some(id => id.toString() === hId.toString())) {
          hospital_ids.push(hId);
        }
      });
    }

    // If no hospitals assigned
    if (hospital_ids.length === 0) {
      return res.status(403).json({ error: 'User not assigned to any hospital' });
    }

    // Handle hospital_id from query/params (for filtering)
    let requested_hospital_id = null;
    
    if (req.query.hospital_id) {
      requested_hospital_id = req.query.hospital_id;
    } else if (req.params.hospitalId) {
      requested_hospital_id = req.params.hospitalId;
    } else if (req.body.hospital_id) {
      requested_hospital_id = req.body.hospital_id;
    }

    // If specific hospital is requested
    if (requested_hospital_id) {
      // Check if user has access to requested hospital
      const hasAccess = hospital_ids.some(id => 
        id.toString() === requested_hospital_id.toString()
      );
      
      if (!hasAccess) {
        return res.status(403).json({ error: 'No access to requested hospital' });
      }
      
      // Use requested hospital as context
      req.hospital_id = requested_hospital_id;
      req.hospital_ids = [requested_hospital_id];
    } else {
      // Use primary hospital as default context
      req.hospital_id = hospital_id;
      req.hospital_ids = hospital_ids;
    }

    // Add convenience properties
    req.user_hospital_id = req.hospital_id;
    req.user_hospital_ids = req.hospital_ids;
    
    next();
  } catch (error) {
    console.error('Hospital scope error:', error);
    res.status(500).json({ error: 'Failed to determine hospital context' });
  }
};

/**
 * Middleware to require hospital context for specific routes
 */
exports.requireHospitalContext = (req, res, next) => {
  if (!req.hospital_id) {
    return res.status(400).json({ error: 'Hospital context required for this operation' });
  }
  next();
};

/**
 * Middleware to check if user can access a specific hospital
 * Use on routes with :hospitalId or :hospital_id param
 */
exports.checkHospitalAccess = (paramName = 'hospitalId') => {
  return (req, res, next) => {
    const hospitalId = req.params[paramName] || req.query.hospital_id;
    
    if (!hospitalId) {
      return next(); // No hospital specified in route
    }
    
    // Super admin can access any hospital
    if (req.user.role === 'super_admin') {
      return next();
    }
    
    // Check if user has access to this hospital
    const hasAccess = req.user_hospital_ids?.some(id => 
      id.toString() === hospitalId.toString()
    );
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'No access to this hospital' });
    }
    
    next();
  };
};