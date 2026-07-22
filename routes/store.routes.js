const express = require('express');
const router = express.Router();
const storeController = require('../controllers/store.controller');
const { verifyToken, authorize } = require('../middlewares/auth');
const operations = require('../controllers/storeOperations.controller');
const procurement = require('../controllers/storeProcurement.controller');

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

// Equipment & Maintenance extensions
router.put('/items/:id/condition', storeAccess, storeController.updateCondition);
router.put('/items/:id/assign', storeAccess, storeController.assignItem);
router.post('/items/:id/maintenance', storeAccess, storeController.addMaintenanceRecord);
router.get('/maintenance/records', storeAccess, storeController.getMaintenanceRecords);


// Enterprise inventory operations: locations, lots, reservations, GRN/QC,
// returns, transfers, physical counts and purchase returns.
router.get('/operations/stock-position', storeAccess, operations.getStockPosition);
router.get('/locations', storeAccess, operations.listLocations);
router.post('/locations', storeAccess, operations.createLocation);
router.put('/locations/:id', storeAccess, operations.updateLocation);
router.get('/lots', storeAccess, operations.listLots);
router.get('/reservations', storeAccess, operations.listReservations);
router.post('/reservations', storeAccess, operations.createReservation);
router.post('/reservations/:id/release', storeAccess, operations.releaseReservation);
router.post('/reservations/:id/issue', storeAccess, operations.issueReservation);
router.get('/grns', storeAccess, operations.listGrns);
router.post('/grns', storeAccess, operations.createGrn);
router.post('/grns/:id/post', storeAccess, operations.postGrn);
router.get('/issue-returns', storeAccess, operations.listReturns);
router.post('/issue-returns', storeAccess, operations.createReturn);
router.post('/issue-returns/:id/post', storeAccess, operations.postReturn);
router.get('/transfers', storeAccess, operations.listTransfers);
router.post('/transfers', storeAccess, operations.createTransfer);
router.post('/transfers/:id/approve', storeAccess, operations.approveTransfer);
router.post('/transfers/:id/dispatch', storeAccess, operations.dispatchTransfer);
router.post('/transfers/:id/receive', storeAccess, operations.receiveTransfer);
router.get('/stock-counts', storeAccess, operations.listCounts);
router.post('/stock-counts', storeAccess, operations.createCount);
router.put('/stock-counts/:id', storeAccess, operations.updateCount);
router.post('/stock-counts/:id/post', storeAccess, operations.postCount);
router.get('/purchase-returns', storeAccess, operations.listPurchaseReturns);
router.post('/purchase-returns', storeAccess, operations.createPurchaseReturn);
router.post('/purchase-returns/:id/dispatch', storeAccess, operations.dispatchPurchaseReturn);

// Procurement, supplier comparison, accountable assets and recall traceability.
router.get('/purchase-requisitions', storeAccess, procurement.listPurchaseRequisitions);
router.post('/purchase-requisitions', storeAccess, procurement.createPurchaseRequisition);
router.post('/purchase-requisitions/:id/:action', storeAccess, procurement.transitionPurchaseRequisition);
router.get('/rfqs', storeAccess, procurement.listRfqs);
router.post('/rfqs', storeAccess, procurement.createRfq);
router.post('/rfqs/:id/:action', storeAccess, procurement.transitionRfq);
router.get('/quotations', storeAccess, procurement.listQuotations);
router.post('/quotations', storeAccess, procurement.createQuotation);
router.get('/rfqs/:rfqId/comparison', storeAccess, procurement.compareQuotations);
router.post('/quotations/:id/select', storeAccess, procurement.selectQuotation);
router.post('/quotations/:id/create-purchase-order', storeAccess, procurement.createPurchaseOrderFromQuotation);
router.get('/assets', storeAccess, procurement.listAssets);
router.post('/assets', storeAccess, procurement.createAsset);
router.put('/assets/:id', storeAccess, procurement.updateAsset);
router.post('/assets/:id/maintenance', storeAccess, procurement.addAssetMaintenance);
router.get('/recalls', storeAccess, procurement.listRecalls);
router.post('/recalls', storeAccess, procurement.createRecall);
router.post('/recalls/:id/trace', storeAccess, procurement.traceRecall);
router.post('/recalls/:id/:action', storeAccess, procurement.transitionRecall);

module.exports = router;
