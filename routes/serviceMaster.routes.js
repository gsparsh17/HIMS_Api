const express = require('express');
const router = express.Router();
const controller = require('../controllers/serviceMaster.controller');
const { requireModuleAccess } = require('../middlewares/auth');

const view = requireModuleAccess('masters_settings', 'view');

const canonicalTargets = {
  procedures: { api: '/api/procedures', ui: '/dashboard/admin/ot/procedures' },
  'lab-tests': { api: '/api/labtests', ui: '/dashboard/admin/lab-tests' },
  'imaging-tests': { api: '/api/radiology/tests', ui: '/dashboard/admin/imaging-tests' }
};

function retiredWrite(req, res) {
  const target = canonicalTargets[req.params.entity] || null;
  return res.status(410).json({
    success: false,
    code: 'SERVICE_MASTER_WRITE_MOVED',
    error: 'Hospital service masters are managed only from their core clinical modules. The duplicate insurance/configuration write API has been retired.',
    canonicalManagementApi: target?.api || null,
    canonicalUiRoute: target?.ui || null
  });
}

// Read access remains available because tariff mapping/pricing workspaces need to
// search the authoritative hospital masters. All writes go through the core
// Procedure/Lab/Radiology APIs so there is only one management path.
router.get('/summary', view, controller.summary);
router.get('/:entity', view, controller.list);
router.get('/:entity/:id', view, controller.get);
router.post('/:entity', retiredWrite);
router.put('/:entity/:id', retiredWrite);
router.patch('/:entity/:id/archive', retiredWrite);
router.patch('/:entity/:id/restore', retiredWrite);
router.post('/:entity/:id/increment-usage', view, controller.incrementUsage);

module.exports = router;
