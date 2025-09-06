const express = require('express');
const router = express.Router();
const {
  // Purchase Order functions
  createPurchaseOrder,
  getAllPurchaseOrders,
  receivePurchaseOrder,
  getPurchaseOrderStatistics,
  
  // Sales functions
  createSale,
  getAllSales,
  getSalesStatistics,
  getDailySalesReport,
  getMonthlySalesReport,
  getYearlySalesReport,
  getRevenueComparison
} = require('../controllers/order.controller');

// Purchase Order routes
router.post('/purchase', createPurchaseOrder);
router.get('/purchase', getAllPurchaseOrders);
router.get('/purchase/stats', getPurchaseOrderStatistics);
router.post('/purchase/:id/receive', receivePurchaseOrder);

// Sales routes
router.post('/sale', createSale);
router.get('/sale', getAllSales);
router.get('/sale/stats', getSalesStatistics);
router.get('/sale/daily', getDailySalesReport);
router.get('/sale/monthly', getMonthlySalesReport);
router.get('/sale/yearly', getYearlySalesReport);
router.get('/sale/comparison', getRevenueComparison);

module.exports = router;