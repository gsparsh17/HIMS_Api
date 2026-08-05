const express = require('express');
const router = express.Router();
const controller = require('../controllers/serviceMaster.controller');
const { requireModuleAccess } = require('../middlewares/auth');

function withEntity(handler, mutate) {
  return (req, res, next) => {
    req.params.entity = 'procedures';
    if (mutate) mutate(req);
    return handler(req, res, next);
  };
}
const manage = requireModuleAccess('masters_settings', 'manage');

// These compatibility read routes are used by OPD, IPD and OT workspaces.
// Authentication is already enforced globally in app.js; master editing remains restricted.
router.get('/search', withEntity(controller.list, (req) => { req.query.orderableOnly = 'true'; }));
router.get('/popular', withEntity(controller.list, (req) => { req.query.orderableOnly = 'true'; }));
router.get('/all', manage, withEntity(controller.list, (req) => { req.query.includeInactive = 'true'; }));
router.get('/', withEntity(controller.list, (req) => { req.query.orderableOnly = 'true'; }));
router.post('/', manage, withEntity(controller.create));
router.get('/:id', withEntity(controller.get));
router.put('/:id', manage, withEntity(controller.update));
router.delete('/:id', manage, withEntity(controller.archive));
router.post('/:id/increment-usage', withEntity(controller.incrementUsage));

module.exports = router;
