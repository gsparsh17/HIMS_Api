import express from 'express';
import NLEMMedicine from '../models/NLEMMedicine.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validation.js';
import { z } from 'zod';

const router = express.Router();

// Validation schemas
const searchSchema = z.object({
  q: z.string().min(1).max(100).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).default('20'),
  page: z.string().regex(/^\d+$/).transform(Number).default('1'),
  dosage_form: z.string().optional(),
  healthcare_level: z.string().optional(),
  essential: z.string().optional(),
  schedule: z.string().optional()
});

const createSchema = z.object({
  medicine_name: z.string().min(2).max(200),
  nlem_code: z.string().optional(),
  therapeutic_category: z.string().optional(),
  strength: z.string().optional(),
  dosage_form: z.string().optional(),
  route_of_administration: z.string().optional(),
  healthcare_level: z.array(z.string()).optional(),
  generic_name: z.string().optional(),
  brand_names: z.array(z.string()).optional(),
  max_retail_price: z.number().min(0).optional(),
  essential: z.boolean().default(true),
  schedule: z.string().optional(),
  indications: z.array(z.string()).optional(),
  storage_conditions: z.string().optional(),
  notes: z.string().optional()
});

const updateSchema = createSchema.partial();

// Search medicines
router.get('/search', validateRequest(searchSchema, 'query'), async (req, res) => {
  try {
    const { q = '', ...options } = req.query;
    
    const result = await NLEMMedicine.searchMedicines(q, options);
    
    res.json({
      success: true,
      data: result.medicines,
      meta: {
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
        hasMore: result.hasMore
      }
    });
  } catch (error) {
    console.error('Medicine search error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search medicines',
      error: error.message
    });
  }
});

// Get medicine by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
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

// Create new medicine (Admin only)
router.post('/', authenticate, authorize(['admin', 'pharmacist']), validateRequest(createSchema), async (req, res) => {
  try {
    const medicineData = {
      ...req.body,
      created_by: req.user._id,
      last_updated_by: req.user._id
    };
    
    const medicine = await NLEMMedicine.create(medicineData);
    
    res.status(201).json({
      success: true,
      message: 'Medicine created successfully',
      data: medicine
    });
  } catch (error) {
    console.error('Create medicine error:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Medicine with this code or name already exists'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to create medicine',
      error: error.message
    });
  }
});

// Update medicine (Admin only)
router.put('/:id', authenticate, authorize(['admin', 'pharmacist']), validateRequest(updateSchema), async (req, res) => {
  try {
    const medicine = await NLEMMedicine.findById(req.params.id);
    
    if (!medicine) {
      return res.status(404).json({
        success: false,
        message: 'Medicine not found'
      });
    }
    
    // Update fields
    Object.assign(medicine, req.body);
    medicine.last_updated_by = req.user._id;
    
    await medicine.save();
    
    res.json({
      success: true,
      message: 'Medicine updated successfully',
      data: medicine
    });
  } catch (error) {
    console.error('Update medicine error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update medicine',
      error: error.message
    });
  }
});

// Delete/Deactivate medicine (Admin only)
router.delete('/:id', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const medicine = await NLEMMedicine.findById(req.params.id);
    
    if (!medicine) {
      return res.status(404).json({
        success: false,
        message: 'Medicine not found'
      });
    }
    
    // Soft delete by deactivating
    medicine.is_active = false;
    medicine.last_updated_by = req.user._id;
    await medicine.save();
    
    res.json({
      success: true,
      message: 'Medicine deactivated successfully'
    });
  } catch (error) {
    console.error('Delete medicine error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deactivate medicine',
      error: error.message
    });
  }
});

// Bulk upload medicines from CSV/JSON (Admin only)
router.post('/bulk-upload', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const medicinesData = req.body;
    
    if (!Array.isArray(medicinesData) || medicinesData.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid data format. Expected an array of medicines'
      });
    }
    
    const result = await NLEMMedicine.bulkUpload(medicinesData);
    
    res.json({
      success: true,
      message: `Bulk upload completed`,
      data: result
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk upload medicines',
      error: error.message
    });
  }
});

// Get medicine statistics
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    const stats = await NLEMMedicine.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get medicine statistics',
      error: error.message
    });
  }
});

// Get medicines by category
router.get('/category/:category', async (req, res) => {
  try {
    const medicines = await NLEMMedicine.find({
      therapeutic_category: { $regex: new RegExp(req.params.category, 'i') },
      is_active: true
    }).sort({ medicine_name: 1 });
    
    res.json({
      success: true,
      data: medicines
    });
  } catch (error) {
    console.error('Get by category error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get medicines by category',
      error: error.message
    });
  }
});

// Get essential medicines
router.get('/essential/list', async (req, res) => {
  try {
    const medicines = await NLEMMedicine.find({
      essential: true,
      is_active: true
    }).select('medicine_name strength dosage_form route_of_administration')
      .sort({ medicine_name: 1 });
    
    res.json({
      success: true,
      data: medicines
    });
  } catch (error) {
    console.error('Get essential medicines error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get essential medicines',
      error: error.message
    });
  }
});

export default router;