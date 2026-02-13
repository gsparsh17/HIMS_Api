const express = require('express');
const router = express.Router();

// Load model
const NLEMMedicine = require('../models/NLEMMedicine');
const Procedure = require('../models/Procedure');

// Search procedures
router.get('/search', async (req, res) => {
  try {
    console.log('Procedure search called:', req.query);
    
    if (!Procedure) {
      return res.status(500).json({
        success: false,
        message: 'Procedure model not loaded'
      });
    }

    const { q = '', limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = { is_active: true };
    
    if (q && q.trim() !== '') {
      query.$or = [
        { name: { $regex: q, $options: 'i' } },
        { code: { $regex: q, $options: 'i' } },
        { category: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } }
      ];
    }

    console.log('Query:', query);

    const procedures = await Procedure.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ name: 1 })
      .select('code name category description duration_minutes base_price')
      .lean();

    const total = await Procedure.countDocuments(query);

    console.log(`Found ${procedures.length} procedures out of ${total}`);

    res.json({
      success: true,
      data: {
        procedures,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        hasMore: total > (page * limit)
      }
    });

  } catch (error) {
    console.error('Procedure search error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search procedures',
      error: error.message,
      stack: error.stack
    });
  }
});

// Get all procedures (for initial load)
router.get('/', async (req, res) => {
  try {
    if (!Procedure) {
      return res.status(500).json({
        success: false,
        message: 'Procedure model not loaded'
      });
    }

    const procedures = await Procedure.find({ is_active: true })
      .sort({ name: 1 })
      .lean();

    res.json({
      success: true,
      data: procedures
    });

  } catch (error) {
    console.error('Get procedures error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get procedures',
      error: error.message
    });
  }
});

// Get popular procedures
router.get('/popular', async (req, res) => {
  try {
    if (!Procedure) {
      return res.status(500).json({
        success: false,
        message: 'Procedure model not loaded'
      });
    }

    const { limit = 10 } = req.query;
    
    const procedures = await Procedure.find({ 
      is_active: true,
      usage_count: { $gt: 0 }
    })
      .sort({ usage_count: -1, name: 1 })
      .limit(parseInt(limit))
      .select('code name category usage_count duration_minutes base_price')
      .lean();

    res.json({
      success: true,
      data: procedures
    });

  } catch (error) {
    console.error('Get popular procedures error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get popular procedures',
      error: error.message
    });
  }
});

// Helper function to extract procedure code from various formats
function extractProcedureCode(input) {
  if (!input) return '';
  
  // If it matches a procedure code pattern (like D2161)
  const codePattern = /^[A-Z]\d+$/i;
  if (codePattern.test(input)) {
    return input.toUpperCase();
  }
  
  // Try to extract from formatted string like "D2161 - Amalgam – four surfaces (₹2290)"
  const match = input.match(/^([A-Z]\d+)/i);
  if (match) {
    return match[1].toUpperCase();
  }
  
  return input.toUpperCase();
}

// Update procedure by ID
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      base_price, 
      is_active, 
      category, 
      duration_minutes,
      description,
      last_updated_by 
    } = req.body;

    let procedure;
    let updateResult;

    // Check if the ID is a valid MongoDB ObjectId (24 hex characters)
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    
    if (isValidObjectId) {
      // If it's a valid ObjectId, update by _id
      updateResult = await Procedure.findByIdAndUpdate(
        id,
        {
          $set: {
            ...(base_price !== undefined && { base_price: Number(base_price) }),
            ...(is_active !== undefined && { is_active }),
            ...(category !== undefined && { category }),
            ...(duration_minutes !== undefined && { duration_minutes: Number(duration_minutes) }),
            ...(description !== undefined && { description }),
            ...(last_updated_by !== undefined && { last_updated_by }),
            updated_at: new Date()
          }
        },
        { new: true, runValidators: true }
      );
    } else {
      // For invalid ObjectId, try to find by code instead
      // Note: This assumes the ID might be a procedure code
      const procedureCode = id.toUpperCase();
      
      // First find the procedure by code to get its _id
      procedure = await Procedure.findOne({ code: procedureCode });
      
      if (!procedure) {
        return res.status(404).json({
          success: false,
          message: 'Procedure not found with the provided code'
        });
      }
      
      // Then update using the _id
      updateResult = await Procedure.findByIdAndUpdate(
        procedure._id,
        {
          $set: {
            ...(base_price !== undefined && { base_price: Number(base_price) }),
            ...(is_active !== undefined && { is_active }),
            ...(category !== undefined && { category }),
            ...(duration_minutes !== undefined && { duration_minutes: Number(duration_minutes) }),
            ...(description !== undefined && { description }),
            ...(last_updated_by !== undefined && { last_updated_by }),
            updated_at: new Date()
          }
        },
        { new: true, runValidators: true }
      );
    }
    
    if (!updateResult) {
      return res.status(404).json({
        success: false,
        message: 'Procedure not found'
      });
    }

    res.json({
      success: true,
      message: 'Procedure updated successfully',
      data: updateResult
    });
  } catch (error) {
    console.error('Update procedure error:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors
      });
    }
    
    // Handle CastError (invalid ID format)
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid procedure ID format',
        error: 'The provided ID is not a valid MongoDB ObjectId'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to update procedure',
      error: error.message
    });
  }
});

// Get all procedures (for admin management - includes inactive)
router.get('/all', async (req, res) => {
  try {
    if (!Procedure) {
      return res.status(500).json({
        success: false,
        message: 'Procedure model not loaded'
      });
    }

    const { 
      page = 1, 
      limit = 100,
      category,
      status 
    } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = {};
    
    // Filter by category if provided
    if (category && category !== 'all') {
      query.category = category;
    }
    
    // Filter by status if provided
    if (status === 'active') {
      query.is_active = true;
    } else if (status === 'inactive') {
      query.is_active = false;
    }

    const procedures = await Procedure.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ name: 1 })
      .select('code name category description duration_minutes base_price is_active usage_count')
      .lean();

    const total = await Procedure.countDocuments(query);

    res.json({
      success: true,
      data: procedures,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
      hasMore: total > (page * limit)
    });

  } catch (error) {
    console.error('Get all procedures error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get procedures',
      error: error.message
    });
  }
});

// Update your GET /procedures/:id route
router.get('/:id', async (req, res) => {
  try {
    if (!Procedure) {
      return res.status(500).json({
        success: false,
        message: 'Procedure model not loaded'
      });
    }

    const { id } = req.params;
    let procedure;

    // Check if the ID is a valid ObjectId (24 hex characters)
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    
    if (isValidObjectId) {
      // If it's a valid ObjectId, search by _id
      procedure = await Procedure.findById(id);
    } else {
      // Otherwise, search by procedure code (extract code from full string if needed)
      const code = extractProcedureCode(id); // Use a helper function
      procedure = await Procedure.findOne({ code: code.toUpperCase() });
    }
    
    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Procedure not found'
      });
    }
    
    // REMOVE THE CONSOLE.LOG - This was causing the error
    // console.log(res.json({ ... }));
    
    res.json({
      success: true,
      data: procedure
    });
  } catch (error) {
    console.error('Get procedure error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get procedure',
      error: error.message
    });
  }
});

// Also update the increment-usage endpoint if you have one
router.post('/:id/increment-usage', async (req, res) => {
  try {
    const { id } = req.params;
    let procedure;

    // Check if the ID is a valid ObjectId
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    
    if (isValidObjectId) {
      procedure = await Procedure.findById(id);
    } else {
      procedure = await Procedure.findOne({ code: id.toUpperCase() });
    }
    
    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Procedure not found'
      });
    }

    await procedure.incrementUsage();
    
    res.json({
      success: true,
      message: 'Usage count incremented',
      data: {
        code: procedure.code,
        name: procedure.name,
        usage_count: procedure.usage_count
      }
    });
  } catch (error) {
    console.error('Increment usage error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to increment usage count',
      error: error.message
    });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Procedures API is running',
    modelLoaded: !!Procedure,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;