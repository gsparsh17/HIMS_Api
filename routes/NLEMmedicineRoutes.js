const express = require('express');
const router = express.Router();

// Load model
const NLEMMedicine = require('../models/NLEMMedicine');
const Procedure = require('../models/Procedure');

// Simple search endpoint
router.get('/search', async (req, res) => {
  try {
    console.log('NLEM Medicine search called:', req.query);
    
    if (!NLEMMedicine) {
      return res.status(500).json({
        success: false,
        message: 'Medicine model not loaded'
      });
    }

    const { q = '', limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = { is_active: true };
    
    if (q && q.trim() !== '') {
      query.$or = [
        { medicine_name: { $regex: q, $options: 'i' } },
        { nlem_code: { $regex: q, $options: 'i' } },
        { dosage_form: { $regex: q, $options: 'i' } },
        { strength: { $regex: q, $options: 'i' } }
      ];
    }

    console.log('Query:', query);

    const medicines = await NLEMMedicine.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ medicine_name: 1 })
      .select('medicine_name nlem_code strength dosage_form healthcare_level')
      .lean();

    const total = await NLEMMedicine.countDocuments(query);

    console.log(`Found ${medicines.length} medicines out of ${total}`);

    res.json({
      success: true,
      data: {
        medicines,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        hasMore: total > (page * limit)
      }
    });

  } catch (error) {
    console.error('Medicine search error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search medicines',
      error: error.message,
      stack: error.stack
    });
  }
});

// Get all medicines (for initial load)
router.get('/', async (req, res) => {
  try {
    if (!NLEMMedicine) {
      return res.status(500).json({
        success: false,
        message: 'Medicine model not loaded'
      });
    }

    const medicines = await NLEMMedicine.find({ is_active: true })
      .limit(50)
      .sort({ medicine_name: 1 })
      .select('medicine_name strength dosage_form')
      .lean();

    res.json({
      success: true,
      data: medicines
    });

  } catch (error) {
    console.error('Get medicines error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get medicines',
      error: error.message
    });
  }
});

// Get medicine by ID
router.get('/:id', async (req, res) => {
  try {
    if (!NLEMMedicine) {
      return res.status(500).json({
        success: false,
        message: 'Medicine model not loaded'
      });
    }

    const medicine = await NLEMMedicine.findById(req.params.id);
    
    if (!medicine) {
      return res.status(404).json({
        success: false,
        message: 'Medicine not found'
      });
    }
    
    res.json({
      success: true,
      data: medicine
    });
  } catch (error) {
    console.error('Get medicine error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get medicine',
      error: error.message
    });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'NLEM Medicines API is running',
    modelLoaded: !!NLEMMedicine,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;