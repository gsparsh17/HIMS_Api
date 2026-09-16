const express = require('express');
const router = express.Router();
const storeController = require('../controllers/store.controller');
const { verifyToken, requireModuleAccess } = require('../middlewares/auth');
const operations = require('../controllers/storeOperations.controller');
const procurement = require('../controllers/storeProcurement.controller');

const storeView = [verifyToken, requireModuleAccess('store_inventory', 'view')];
const storeManage = [verifyToken, requireModuleAccess('store_inventory', 'manage')];

router.post('/auth/login', storeController.storeLogin);

router.get('/dashboard', storeView, storeController.getDashboard);

router.post('/categories', storeManage, storeController.createCategory);
router.get('/categories', storeView, storeController.getCategories);
router.put('/categories/:id', storeManage, storeController.updateCategory);
router.delete('/categories/:id', storeManage, storeController.deleteCategory);

router.post('/items', storeManage, storeController.createItem);
router.get('/items', storeView, storeController.getItems);
router.get('/items/low-stock', storeView, storeController.getLowStockItems);
router.get('/items/:id', storeView, storeController.getItemById);
router.put('/items/:id', storeManage, storeController.updateItem);
router.delete('/items/:id', storeManage, storeController.deleteItem);
router.post('/items/:id/adjust-stock', storeManage, storeController.adjustStock);

router.get('/transactions', storeView, storeController.getTransactions);

router.post('/requisitions', storeManage, storeController.createRequisition);
router.get('/requisitions', storeView, storeController.getRequisitions);
router.put('/requisitions/:id/status', storeManage, storeController.updateRequisitionStatus);

router.post('/issues', storeManage, storeController.createIssue);
router.get('/issues', storeView, storeController.getIssues);

router.post('/purchase-orders', storeManage, storeController.createPurchaseOrder);
router.get('/purchase-orders', storeView, storeController.getPurchaseOrders);
router.get('/purchase-orders/:id', storeView, storeController.getPurchaseOrderById);
router.put('/purchase-orders/:id/status', storeManage, storeController.updatePurchaseOrderStatus);
router.post('/purchase-orders/:id/receive', storeManage, storeController.receivePurchaseOrder);

// Equipment & Maintenance extensions
router.put('/items/:id/condition', storeManage, storeController.updateCondition);
router.put('/items/:id/assign', storeManage, storeController.assignItem);
router.post('/items/:id/maintenance', storeManage, storeController.addMaintenanceRecord);
router.get('/maintenance/records', storeView, storeController.getMaintenanceRecords);


// Enterprise inventory operations: locations, lots, reservations, GRN/QC,
// returns, transfers, physical counts and purchase returns.
router.get('/operations/stock-position', storeView, operations.getStockPosition);
router.get('/locations', storeView, operations.listLocations);
router.post('/locations', storeManage, operations.createLocation);
router.put('/locations/:id', storeManage, operations.updateLocation);
router.get('/lots', storeView, operations.listLots);
router.get('/reservations', storeView, operations.listReservations);
router.post('/reservations', storeManage, operations.createReservation);
router.post('/reservations/:id/release', storeManage, operations.releaseReservation);
router.post('/reservations/:id/issue', storeManage, operations.issueReservation);
router.get('/grns', storeView, operations.listGrns);
router.post('/grns', storeManage, operations.createGrn);
router.post('/grns/:id/post', storeManage, operations.postGrn);
router.get('/issue-returns', storeView, operations.listReturns);
router.post('/issue-returns', storeManage, operations.createReturn);
router.post('/issue-returns/:id/post', storeManage, operations.postReturn);
router.get('/transfers', storeView, operations.listTransfers);
router.post('/transfers', storeManage, operations.createTransfer);
router.post('/transfers/:id/approve', storeManage, operations.approveTransfer);
router.post('/transfers/:id/dispatch', storeManage, operations.dispatchTransfer);
router.post('/transfers/:id/receive', storeManage, operations.receiveTransfer);
router.get('/stock-counts', storeView, operations.listCounts);
router.post('/stock-counts', storeManage, operations.createCount);
router.put('/stock-counts/:id', storeManage, operations.updateCount);
router.post('/stock-counts/:id/post', storeManage, operations.postCount);
router.get('/purchase-returns', storeView, operations.listPurchaseReturns);
router.post('/purchase-returns', storeManage, operations.createPurchaseReturn);
router.post('/purchase-returns/:id/dispatch', storeManage, operations.dispatchPurchaseReturn);

// Procurement, supplier comparison, accountable assets and recall traceability.
router.get('/purchase-requisitions', storeView, procurement.listPurchaseRequisitions);
router.post('/purchase-requisitions', storeManage, procurement.createPurchaseRequisition);
router.post('/purchase-requisitions/:id/:action', storeManage, procurement.transitionPurchaseRequisition);
router.get('/rfqs', storeView, procurement.listRfqs);
router.post('/rfqs', storeManage, procurement.createRfq);
router.post('/rfqs/:id/:action', storeManage, procurement.transitionRfq);
router.get('/quotations', storeView, procurement.listQuotations);
router.post('/quotations', storeManage, procurement.createQuotation);
router.get('/rfqs/:rfqId/comparison', storeView, procurement.compareQuotations);
router.post('/quotations/:id/select', storeManage, procurement.selectQuotation);
router.post('/quotations/:id/create-purchase-order', storeManage, procurement.createPurchaseOrderFromQuotation);
router.get('/assets', storeView, procurement.listAssets);
router.post('/assets', storeManage, procurement.createAsset);
router.put('/assets/:id', storeManage, procurement.updateAsset);
router.post('/assets/:id/maintenance', storeManage, procurement.addAssetMaintenance);
router.get('/recalls', storeView, procurement.listRecalls);
router.post('/recalls', storeManage, procurement.createRecall);
router.post('/recalls/:id/trace', storeManage, procurement.traceRecall);
router.post('/recalls/:id/:action', storeManage, procurement.transitionRecall);

module.exports = router;
