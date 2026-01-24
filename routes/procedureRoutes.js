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
      .limit(50)
      .sort({ name: 1 })
      .select('code name category base_price')
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

// Get procedure by ID
router.get('/:id', async (req, res) => {
  try {
    if (!Procedure) {
      return res.status(500).json({
        success: false,
        message: 'Procedure model not loaded'
      });
    }

    const procedure = await Procedure.findById(req.params.id);
    
    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Procedure not found'
      });
    }
    
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