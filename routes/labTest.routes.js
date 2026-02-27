const express = require('express');
const router = express.Router();

const LabTest = require('../models/LabTest');

// Helper to extract lab test code from various formats
function extractLabTestCode(input) {
  if (!input) return '';

  // Accept alphanumerics like "CBC", "LFT01", "TSH", etc.
  const codePattern = /^[A-Z0-9_-]{2,20}$/i;
  if (codePattern.test(input)) {
    return input.toUpperCase();
  }

  // Extract from formatted string like "CBC - Complete Blood Count (₹350)"
  const match = input.match(/^([A-Z0-9_-]{2,20})/i);
  if (match) {
    return match[1].toUpperCase();
  }

  return String(input).trim().toUpperCase();
}

// Health check (keep above /:id)
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'LabTests API is running',
    modelLoaded: !!LabTest,
    timestamp: new Date().toISOString()
  });
});

// Create new lab test
router.post('/', async (req, res) => {
  try {
    const {
      code,
      name,
      category,
      description,
      specimen_type,
      fasting_required,
      turnaround_time_hours,
      base_price,
      insurance_coverage,
      is_active
    } = req.body;

    // Validate required fields
    if (!code || !name || !category) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        errors: {
          ...(!code && { code: 'Test code is required' }),
          ...(!name && { name: 'Test name is required' }),
          ...(!category && { category: 'Category is required' })
        }
      });
    }

    // Check if test with same code already exists
    const existingTest = await LabTest.findOne({ 
      code: code.toUpperCase() 
    });
    
    if (existingTest) {
      return res.status(400).json({
        success: false,
        message: 'Lab test with this code already exists',
        errors: {
          code: 'Test code must be unique'
        }
      });
    }

    // Create new lab test
    const labTest = new LabTest({
      code: code.toUpperCase(),
      name: name.trim(),
      category,
      description: description?.trim() || '',
      specimen_type: specimen_type?.trim() || '',
      fasting_required: fasting_required || false,
      turnaround_time_hours: Number(turnaround_time_hours) || 24,
      base_price: Number(base_price) || 0,
      insurance_coverage: insurance_coverage || 'Partial',
      is_active: is_active !== undefined ? is_active : true,
      usage_count: 0
    });

    await labTest.save();

    res.status(201).json({
      success: true,
      message: 'Lab test created successfully',
      data: labTest
    });
  } catch (error) {
    console.error('Create lab test error:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach(key => {
        errors[key] = error.errors[key].message;
      });
      
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors
      });
    }

    // Handle duplicate key error (if code index is unique)
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Lab test with this code already exists',
        errors: {
          code: 'Test code must be unique'
        }
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create lab test',
      error: error.message
    });
  }
});

// Search lab tests
router.get('/search', async (req, res) => {
  try {
    const { q = '', limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = { is_active: true };

    if (q && q.trim() !== '') {
      query.$or = [
        { name: { $regex: q, $options: 'i' } },
        { code: { $regex: q, $options: 'i' } },
        { category: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { specimen_type: { $regex: q, $options: 'i' } }
      ];
    }

    const labTests = await LabTest.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ name: 1 })
      .select('code name category description specimen_type fasting_required turnaround_time_hours base_price')
      .lean();

    const total = await LabTest.countDocuments(query);

    res.json({
      success: true,
      data: {
        labTests,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        hasMore: total > (page * limit)
      }
    });
  } catch (error) {
    console.error('LabTest search error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search lab tests',
      error: error.message
    });
  }
});

// Get all active lab tests (for initial load)
router.get('/', async (req, res) => {
  try {
    const labTests = await LabTest.find({ is_active: true })
      .sort({ name: 1 })
      .lean();

    res.json({
      success: true,
      data: labTests
    });
  } catch (error) {
    console.error('Get lab tests error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get lab tests',
      error: error.message
    });
  }
});

// Get popular lab tests
router.get('/popular', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const labTests = await LabTest.find({
      is_active: true,
      usage_count: { $gt: 0 }
    })
      .sort({ usage_count: -1, name: 1 })
      .limit(parseInt(limit))
      .select('code name category usage_count specimen_type turnaround_time_hours base_price')
      .lean();

    res.json({
      success: true,
      data: labTests
    });
  } catch (error) {
    console.error('Get popular lab tests error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get popular lab tests',
      error: error.message
    });
  }
});

// Get all lab tests (admin management - includes inactive)
router.get('/all', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 100,
      category,
      status
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = {};

    if (category && category !== 'all') {
      query.category = category;
    }

    if (status === 'active') {
      query.is_active = true;
    } else if (status === 'inactive') {
      query.is_active = false;
    }

    const labTests = await LabTest.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ name: 1 })
      .select('code name category description specimen_type fasting_required turnaround_time_hours base_price is_active usage_count')
      .lean();

    const total = await LabTest.countDocuments(query);

    res.json({
      success: true,
      data: labTests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
      hasMore: total > (page * limit)
    });
  } catch (error) {
    console.error('Get all lab tests error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get lab tests',
      error: error.message
    });
  }
});

// Get lab test by ID (ObjectId) or code
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let labTest;

    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);

    if (isValidObjectId) {
      labTest = await LabTest.findById(id);
    } else {
      const code = extractLabTestCode(id);
      labTest = await LabTest.findOne({ code: code.toUpperCase() });
    }

    if (!labTest) {
      return res.status(404).json({
        success: false,
        message: 'Lab test not found'
      });
    }

    res.json({
      success: true,
      data: labTest
    });
  } catch (error) {
    console.error('Get lab test error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get lab test',
      error: error.message
    });
  }
});

// Update lab test by ID (ObjectId) or code
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      base_price,
      is_active,
      category,
      description,
      specimen_type,
      fasting_required,
      turnaround_time_hours
    } = req.body;

    let targetId = id;
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);

    if (!isValidObjectId) {
      const code = extractLabTestCode(id);
      const found = await LabTest.findOne({ code: code.toUpperCase() });
      if (!found) {
        return res.status(404).json({
          success: false,
          message: 'Lab test not found with the provided code'
        });
      }
      targetId = found._id;
    }

    const updated = await LabTest.findByIdAndUpdate(
      targetId,
      {
        $set: {
          ...(base_price !== undefined && { base_price: Number(base_price) }),
          ...(is_active !== undefined && { is_active }),
          ...(category !== undefined && { category }),
          ...(description !== undefined && { description }),
          ...(specimen_type !== undefined && { specimen_type }),
          ...(fasting_required !== undefined && { fasting_required: !!fasting_required }),
          ...(turnaround_time_hours !== undefined && { turnaround_time_hours: Number(turnaround_time_hours) })
        }
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Lab test not found'
      });
    }

    res.json({
      success: true,
      message: 'Lab test updated successfully',
      data: updated
    });
  } catch (error) {
    console.error('Update lab test error:', error);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors
      });
    }
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid lab test ID format'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update lab test',
      error: error.message
    });
  }
});

// Increment usage
router.post('/:id/increment-usage', async (req, res) => {
  try {
    const { id } = req.params;
    let labTest;

    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);

    if (isValidObjectId) {
      labTest = await LabTest.findById(id);
    } else {
      labTest = await LabTest.findOne({ code: extractLabTestCode(id) });
    }

    if (!labTest) {
      return res.status(404).json({
        success: false,
        message: 'Lab test not found'
      });
    }

    await labTest.incrementUsage();

    res.json({
      success: true,
      message: 'Usage count incremented',
      data: {
        code: labTest.code,
        name: labTest.name,
        usage_count: labTest.usage_count
      }
    });
  } catch (error) {
    console.error('Increment lab test usage error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to increment usage count',
      error: error.message
    });
  }
});

module.exports = router;
