import express from 'express';
import Procedure from '../models/Procedure.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validation.js';
import { z } from 'zod';

const router = express.Router();

// Validation schemas
const searchSchema = z.object({
  q: z.string().min(1).max(100).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).default('20'),
  page: z.string().regex(/^\d+$/).transform(Number).default('1'),
  category: z.string().optional(),
  department_id: z.string().optional(),
  specialty_id: z.string().optional(),
  facility_level: z.string().optional(),
  min_price: z.string().optional(),
  max_price: z.string().optional()
});

const createSchema = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(3).max(200),
  category: z.string(),
  subcategory: z.string().optional(),
  description: z.string().optional(),
  duration_minutes: z.number().min(1).default(30),
  base_price: z.number().min(0).default(0),
  insurance_coverage: z.string().optional(),
  cpt_code: z.string().optional(),
  equipment_required: z.array(z.string()).optional(),
  facility_level: z.array(z.string()).optional(),
  consent_required: z.boolean().default(true),
  department_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional()
});

const updateSchema = createSchema.partial();

// Search procedures
router.get('/search', validateRequest(searchSchema, 'query'), async (req, res) => {
  try {
    const { q = '', ...options } = req.query;
    
    const result = await Procedure.searchProcedures(q, options);
    
    res.json({
      success: true,
      data: result.procedures,
      meta: {
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
        hasMore: result.hasMore
      }
    });
  } catch (error) {
    console.error('Procedure search error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search procedures',
      error: error.message
    });
  }
});

// Get popular procedures
router.get('/popular', async (req, res) => {
  try {
    const { limit = 10, department_id } = req.query;
    
    const procedures = await Procedure.getPopularProcedures(
      parseInt(limit),
      department_id
    );
    
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
router.get('/:id', authenticate, async (req, res) => {
  try {
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

// Create new procedure (Admin/Doctor only)
router.post('/', authenticate, authorize(['admin', 'doctor']), validateRequest(createSchema), async (req, res) => {
  try {
    const procedureData = {
      ...req.body,
      created_by: req.user._id,
      last_updated_by: req.user._id
    };
    
    const procedure = await Procedure.create(procedureData);
    
    res.status(201).json({
      success: true,
      message: 'Procedure created successfully',
      data: procedure
    });
  } catch (error) {
    console.error('Create procedure error:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Procedure with this code already exists'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to create procedure',
      error: error.message
    });
  }
});

// Update procedure (Admin/Doctor only)
router.put('/:id', authenticate, authorize(['admin', 'doctor']), validateRequest(updateSchema), async (req, res) => {
  try {
    const procedure = await Procedure.findById(req.params.id);
    
    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Procedure not found'
      });
    }
    
    // Update fields
    Object.assign(procedure, req.body);
    procedure.last_updated_by = req.user._id;
    
    await procedure.save();
    
    res.json({
      success: true,
      message: 'Procedure updated successfully',
      data: procedure
    });
  } catch (error) {
    console.error('Update procedure error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update procedure',
      error: error.message
    });
  }
});

// Delete/Deactivate procedure (Admin only)
router.delete('/:id', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const procedure = await Procedure.findById(req.params.id);
    
    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Procedure not found'
      });
    }
    
    // Soft delete by deactivating
    procedure.is_active = false;
    procedure.last_updated_by = req.user._id;
    await procedure.save();
    
    res.json({
      success: true,
      message: 'Procedure deactivated successfully'
    });
  } catch (error) {
    console.error('Delete procedure error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deactivate procedure',
      error: error.message
    });
  }
});

// Increment usage count (when procedure is prescribed)
router.post('/:id/increment-usage', authenticate, authorize(['doctor']), async (req, res) => {
  try {
    const procedure = await Procedure.findById(req.params.id);
    
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
      data: { usage_count: procedure.usage_count }
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

// Bulk upload procedures from CSV/JSON (Admin only)
router.post('/bulk-upload', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const proceduresData = req.body;
    
    if (!Array.isArray(proceduresData) || proceduresData.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid data format. Expected an array of procedures'
      });
    }
    
    const result = await Procedure.bulkUpload(proceduresData);
    
    res.json({
      success: true,
      message: `Bulk upload completed`,
      data: result
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk upload procedures',
      error: error.message
    });
  }
});

// Get procedure statistics
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    const stats = await Procedure.getProcedureStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get procedure statistics',
      error: error.message
    });
  }
});

// Get procedures by category
router.get('/category/:category', async (req, res) => {
  try {
    const procedures = await Procedure.find({
      category: req.params.category,
      is_active: true
    }).select('code name description duration_minutes base_price')
      .sort({ name: 1 });
    
    res.json({
      success: true,
      data: procedures
    });
  } catch (error) {
    console.error('Get by category error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get procedures by category',
      error: error.message
    });
  }
});

// Get procedures by department
router.get('/department/:departmentId', async (req, res) => {
  try {
    const procedures = await Procedure.find({
      department_id: req.params.departmentId,
      is_active: true
    }).select('code name category duration_minutes base_price usage_count')
      .sort({ usage_count: -1 });
    
    res.json({
      success: true,
      data: procedures
    });
  } catch (error) {
    console.error('Get by department error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get procedures by department',
      error: error.message
    });
  }
});

export default router;