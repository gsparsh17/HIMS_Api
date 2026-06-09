// routes/insuranceProvider.routes.js
const express = require('express');
const router = express.Router();
const InsuranceProvider = require('../models/InsuranceProvider');

// Get all active insurance providers (for dropdown) - Public access
router.get('/active', async (req, res) => {
  try {
    const providers = await InsuranceProvider.find({ is_active: true, is_approved: true })
      .select('code name type category coverage_percentage')
      .sort({ name: 1 });
    
    res.json({
      success: true,
      providers: providers.map(p => ({
        value: p._id,
        code: p.code,
        name: p.name,
        type: p.type,
        category: p.category,
        coverage_percentage: p.coverage_percentage
      }))
    });
  } catch (error) {
    console.error('Error fetching insurance providers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get provider by ID - Public access
router.get('/:id', async (req, res) => {
  try {
    const provider = await InsuranceProvider.findById(req.params.id);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    }
    res.json({ success: true, provider });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create insurance provider - Public access (for quick add during patient registration)
router.post('/', async (req, res) => {
  try {
    // Check if provider with same code already exists
    const existingProvider = await InsuranceProvider.findOne({ 
      code: req.body.code?.toUpperCase() 
    });
    
    if (existingProvider) {
      return res.status(400).json({ 
        success: false, 
        error: 'Provider code already exists. Please use a different code.' 
      });
    }

    // Check if provider with same name already exists
    const existingByName = await InsuranceProvider.findOne({ 
      name: { $regex: new RegExp(`^${req.body.name}$`, 'i') } 
    });
    
    if (existingByName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Provider with this name already exists.' 
      });
    }

    const provider = new InsuranceProvider({
      code: req.body.code?.toUpperCase(),
      name: req.body.name,
      type: req.body.type || 'private',
      category: req.body.category || 'health_insurance',
      coverage_percentage: req.body.coverage_percentage || 100,
      contact_person: req.body.contact_person || '',
      contact_phone: req.body.contact_phone || '',
      contact_email: req.body.contact_email || '',
      address: req.body.address || '',
      is_active: true,
      is_approved: true,
      approval_date: new Date(),
      created_by: null  // No user reference needed
    });
    
    await provider.save();
    
    res.status(201).json({ 
      success: true, 
      provider: {
        value: provider._id,
        code: provider.code,
        name: provider.name,
        type: provider.type,
        category: provider.category,
        coverage_percentage: provider.coverage_percentage
      },
      message: 'Insurance provider added successfully'
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Provider code already exists' });
    }
    console.error('Error creating insurance provider:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin routes (require authentication) - keep for admin panel
router.put('/:id', async (req, res) => {
  try {
    const provider = await InsuranceProvider.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updated_at: new Date() },
      { new: true, runValidators: true }
    );
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    }
    res.json({ success: true, provider });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/:id/toggle-status', async (req, res) => {
  try {
    const provider = await InsuranceProvider.findById(req.params.id);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    }
    provider.is_active = !provider.is_active;
    await provider.save();
    res.json({ success: true, is_active: provider.is_active });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const provider = await InsuranceProvider.findByIdAndUpdate(
      req.params.id,
      { is_active: false },
      { new: true }
    );
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    }
    res.json({ success: true, message: 'Insurance provider deactivated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;