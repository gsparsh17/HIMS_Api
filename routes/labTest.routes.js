const express = require('express');
const router = express.Router();
const controller = require('../controllers/serviceMaster.controller');
const { requireModuleAccess } = require('../middlewares/auth');

function withEntity(handler, mutate) {
  return (req, res, next) => {
    req.params.entity = 'lab-tests';
    if (mutate) mutate(req);
    return handler(req, res, next);
  };
}
const view = requireModuleAccess('laboratory', 'view');
const manage = requireModuleAccess('laboratory', 'manage');

router.get('/search', view, withEntity(controller.list, (req) => { req.query.orderableOnly = 'true'; }));
router.get('/popular', view, withEntity(controller.list, (req) => { req.query.orderableOnly = 'true'; }));
router.get('/all', manage, withEntity(controller.list, (req) => { req.query.includeInactive = 'true'; }));
router.get('/', view, withEntity(controller.list, (req) => { req.query.orderableOnly = req.query.includeInactive === 'true' ? 'false' : 'true'; }));
router.post('/', manage, withEntity(controller.create));
router.get('/:id', view, withEntity(controller.get));
router.put('/:id', manage, withEntity(controller.update));
router.delete('/:id', manage, withEntity(controller.archive));
router.post('/:id/increment-usage', view, withEntity(controller.incrementUsage));

module.exports = router;
