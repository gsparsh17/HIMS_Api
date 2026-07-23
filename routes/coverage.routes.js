const express = require('express');
const router = express.Router();
const controller = require('../controllers/coverage.controller');
const { protect, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

router.use(protect);
router.post('/ipd/admissions/:id/coverage', requireModuleAccess('billing_finance', 'manage'), controller.create);
router.get('/ipd/admissions/:id/coverage', requireModuleAccess('ipd', 'view'), controller.get);
router.post('/ipd/admissions/:id/coverage/verify', requireModuleAccess('billing_finance', 'manage'), controller.verify);
router.post('/ipd/admissions/:id/preauth', requireModuleAccess('billing_finance', 'manage'), controller.preauth);
router.patch('/preauth/:id/status', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('preauth_decide'), controller.updatePreauthById);
module.exports = router;
