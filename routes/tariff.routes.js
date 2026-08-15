const express = require('express');
const multer = require('multer');
const router = express.Router();
const controller = require('../controllers/tariff.controller');
const { requireModuleAccess, requireAnyModuleAccess, requireActionPermission } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
const view = requireAnyModuleAccess([
  { moduleKey: 'masters_settings', minimumAccess: 'view' },
  { moduleKey: 'billing_finance', minimumAccess: 'view' },
]);
const manage = requireModuleAccess('masters_settings', 'manage');
const pricingView = requireModuleAccess('billing_finance', 'view');

router.get('/payers', view, controller.listPayers);
router.post('/payers', manage, controller.createPayer);
router.get('/payers/:id', view, controller.getPayer);
router.put('/payers/:id', manage, controller.updatePayer);
router.patch('/payers/:id/archive', manage, controller.archivePayer);

router.get('/rate-cards', view, controller.listRateCards);
router.post('/rate-cards', manage, controller.createRateCard);
router.get('/rate-cards/:id', view, controller.getRateCard);
router.put('/rate-cards/:id', manage, controller.updateRateCard);
router.delete('/rate-cards/:id', manage, controller.deleteRateCard);
router.post('/rate-cards/:id/items', manage, controller.upsertRateCardItems);
router.put('/rate-cards/:id/items/:itemId', manage, controller.updateRateCardItem);
router.delete('/rate-cards/:id/items/:itemId', manage, controller.deleteRateCardItem);
router.post('/rate-cards/:id/validate', manage, controller.validateRateCard);
router.post('/rate-cards/:id/prepare', manage, controller.prepareRateCard);
router.post('/rate-cards/:id/mappings/suggest', manage, controller.suggestMappings);
router.post('/rate-cards/:id/mappings/review', manage, requireActionPermission('tariff_mapping_approve'), controller.bulkReviewMappings);
router.post('/rate-cards/:id/items/:itemId/mapping', manage, requireActionPermission('tariff_mapping_approve'), controller.reviewMapping);
router.post('/rate-cards/:id/approve', manage, requireActionPermission('rate_card_approve'), controller.approveRateCard);
router.post('/rate-cards/:id/activate', manage, requireActionPermission('rate_card_activate'), controller.activateRateCard);
router.post('/rate-cards/:id/reject', manage, requireActionPermission('rate_card_approve'), controller.rejectRateCard);
router.post('/rate-cards/:id/source-verification', manage, requireActionPermission('rate_card_approve'), controller.verifySource);
router.post('/rate-cards/source/checksum', manage, upload.single('file'), controller.checksum);
router.post('/pricing/quote', pricingView, controller.quote);

module.exports = router;
