const express = require('express');
const router = express.Router();
const controller = require('../controllers/serviceMaster.controller');
const { requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

const view = requireModuleAccess('masters_settings', 'view');
const manage = requireModuleAccess('masters_settings', 'manage');

router.get('/summary', view, controller.summary);
router.get('/:entity', view, controller.list);
router.get('/:entity/:id', view, controller.get);
router.post('/:entity', manage, controller.create);
router.put('/:entity/:id', manage, controller.update);
router.patch('/:entity/:id/archive', manage, controller.archive);
router.patch('/:entity/:id/restore', manage, controller.restore);
router.post('/:entity/:id/increment-usage', requireModuleAccess('masters_settings', 'view'), controller.incrementUsage);

module.exports = router;
