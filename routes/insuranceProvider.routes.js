const express = require('express');
const router = express.Router();
const Payer = require('../models/Payer');
const { requireHospitalId } = require('../services/tenantScope.service');
const { requireModuleAccess } = require('../middlewares/auth');

const manage = requireModuleAccess('masters_settings', 'manage');

function compatible(provider) {
  return {
    value: provider._id,
    _id: provider._id,
    code: provider.code,
    name: provider.name,
    type: provider.type,
    category: provider.type,
    coverage_percentage: Math.max(0, 100 - Number(provider.pricingPolicy?.defaultCoPayPercentage || 0)),
    is_active: provider.isActive,
    is_approved: ['active', 'not_required'].includes(provider.empanelment?.status),
    empanelment: provider.empanelment,
    pricingPolicy: provider.pricingPolicy
  };
}

// Compatibility facade for older registration screens. Payer is the only
// authoritative sponsor/insurance master; the legacy InsuranceProvider model
// is no longer written by application routes.
router.get('/active', async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const providers = await Payer.find({
      hospitalId,
      isActive: true,
      is_active: { $ne: false },
      type: { $ne: 'self' },
      'empanelment.status': { $in: ['active', 'not_required'] }
    }).sort({ name: 1 });
    res.json({ success: true, providers: providers.map(compatible) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const provider = await Payer.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req) });
    if (!provider) return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    return res.json({ success: true, provider: compatible(provider) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

router.post('/', manage, async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const provider = await Payer.create({
      hospitalId,
      code: req.body.code,
      name: req.body.name,
      type: req.body.type || 'private_insurer',
      empanelment: req.body.empanelment || { status: 'pending' },
      pricingPolicy: {
        ...(req.body.pricingPolicy || {}),
        defaultCoPayPercentage: req.body.coverage_percentage == null
          ? Number(req.body.pricingPolicy?.defaultCoPayPercentage || 0)
          : Math.max(0, 100 - Number(req.body.coverage_percentage))
      },
      contacts: req.body.contacts || [],
      settlementTerms: req.body.settlementTerms,
      isActive: req.body.isActive !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    return res.status(201).json({ success: true, provider: compatible(provider) });
  } catch (error) {
    return res.status(error.code === 11000 ? 409 : error.statusCode || 400).json({ success: false, error: error.code === 11000 ? 'Provider code already exists' : error.message });
  }
});

router.put('/:id', manage, async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const patch = { ...req.body, updatedBy: req.user._id };
    delete patch.hospitalId;
    delete patch._id;
    if (patch.coverage_percentage != null) {
      patch['pricingPolicy.defaultCoPayPercentage'] = Math.max(0, 100 - Number(patch.coverage_percentage));
      delete patch.coverage_percentage;
    }
    const provider = await Payer.findOneAndUpdate({ _id: req.params.id, hospitalId }, { $set: patch }, { new: true, runValidators: true });
    if (!provider) return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    return res.json({ success: true, provider: compatible(provider) });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message });
  }
});

router.patch('/:id/toggle-status', manage, async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const provider = await Payer.findOne({ _id: req.params.id, hospitalId });
    if (!provider) return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    provider.isActive = !provider.isActive;
    provider.is_active = provider.isActive;
    if (provider.isActive) {
      provider.deleted_at = null;
      provider.deleted_by = null;
      provider.deletion_reason = '';
    } else {
      provider.deleted_at = new Date();
      provider.deleted_by = req.user._id;
      provider.deletion_reason = 'Insurance provider deactivated by user';
    }
    provider.updatedBy = req.user._id;
    await provider.save();
    return res.json({ success: true, is_active: provider.isActive });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message });
  }
});

router.delete('/:id', manage, async (req, res) => {
  try {
    const provider = await Payer.findOneAndUpdate(
      { _id: req.params.id, hospitalId: requireHospitalId(req) },
      { $set: { isActive: false, is_active: false, updatedBy: req.user._id, deleted_at: new Date(), deleted_by: req.user._id, deletion_reason: String(req.body?.reason || 'Insurance provider deactivated by user').trim() } },
      { new: true }
    );
    if (!provider) return res.status(404).json({ success: false, error: 'Insurance provider not found' });
    return res.json({ success: true, message: 'Insurance provider deactivated' });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message });
  }
});

module.exports = router;
