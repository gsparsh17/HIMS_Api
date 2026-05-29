const express = require('express');
const router = express.Router();
const storeController = require('../controllers/store.controller');
const { verifyToken, authorize } = require('../middlewares/auth');

const storeAccess = [verifyToken, authorize('admin', 'mediqliq_super_admin', 'store', 'store_manager', 'inventory_manager')];

router.post('/auth/login', storeController.storeLogin);

router.get('/dashboard', storeAccess, storeController.getDashboard);

router.post('/categories', storeAccess, storeController.createCategory);
router.get('/categories', storeAccess, storeController.getCategories);
router.put('/categories/:id', storeAccess, storeController.updateCategory);
router.delete('/categories/:id', storeAccess, storeController.deleteCategory);

router.post('/items', storeAccess, storeController.createItem);
router.get('/items', storeAccess, storeController.getItems);
router.get('/items/low-stock', storeAccess, storeController.getLowStockItems);
router.get('/items/:id', storeAccess, storeController.getItemById);
router.put('/items/:id', storeAccess, storeController.updateItem);
router.delete('/items/:id', storeAccess, storeController.deleteItem);
router.post('/items/:id/adjust-stock', storeAccess, storeController.adjustStock);

router.get('/transactions', storeAccess, storeController.getTransactions);

router.post('/requisitions', storeAccess, storeController.createRequisition);
router.get('/requisitions', storeAccess, storeController.getRequisitions);
router.put('/requisitions/:id/status', storeAccess, storeController.updateRequisitionStatus);

router.post('/issues', storeAccess, storeController.createIssue);
router.get('/issues', storeAccess, storeController.getIssues);

router.post('/purchase-orders', storeAccess, storeController.createPurchaseOrder);
router.get('/purchase-orders', storeAccess, storeController.getPurchaseOrders);
router.get('/purchase-orders/:id', storeAccess, storeController.getPurchaseOrderById);
router.put('/purchase-orders/:id/status', storeAccess, storeController.updatePurchaseOrderStatus);
router.post('/purchase-orders/:id/receive', storeAccess, storeController.receivePurchaseOrder);

module.exports = router;
