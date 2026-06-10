const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  // Purchase Order functions
  createPurchaseOrder,
  getAllPurchaseOrders,
  receivePurchaseOrder,
  getPurchaseOrderStatistics,
  getPurchaseOrderById,
  getPurchaseOrderGSTSummary,  // NEW

  // Sales functions
  createSale,
  getAllSales,
  getSalesStatistics,
  getDailySalesReport,
  getMonthlySalesReport,
  getYearlySalesReport,
  getRevenueComparison,

  // Enhanced pharmacy transaction functions
  getSaleById,
  updateSalePayment,
  voidSale,
  getSalesByPatient,
  getSalesByAdmission,
  getPendingPrescriptions,
  getRecentSales
} = require('../controllers/order.controller');

// ========== PURCHASE ORDER ROUTES ==========
// Create new purchase order
router.post('/purchase-orders', createPurchaseOrder);

// Get all purchase orders with filters
router.get('/purchase', getAllPurchaseOrders);

// Get purchase order statistics
router.get('/purchase/stats', getPurchaseOrderStatistics);

// Get purchase order GST summary (for GSTR-2 reporting)
router.get('/purchase/gst-summary', getPurchaseOrderGSTSummary);  // NEW

// Receive purchase order stock
router.post('/purchase/:id/receive', receivePurchaseOrder);

// Get purchase order by ID
router.get('/purchase/:id', getPurchaseOrderById);

// ========== SALES ROUTES ==========
// Create sale (pharmacy POS)
router.post('/sale', createSale);

// Get all sales with filters
router.get('/sale', getAllSales);

// Get sales statistics
router.get('/sale/stats', getSalesStatistics);

// Get daily sales report
router.get('/sale/daily', getDailySalesReport);

// Get monthly sales report
router.get('/sale/monthly', getMonthlySalesReport);

// Get yearly sales report
router.get('/sale/yearly', getYearlySalesReport);

// Get revenue comparison
router.get('/sale/comparison', getRevenueComparison);

// ========== PHARMACY ENHANCED ROUTES ==========
// Get sale by ID with full details (for printing bills)
router.get('/sale/:id', getSaleById);

// Update sale payment (for partial payments or payment adjustments)
router.patch('/sale/:id/payment', updateSalePayment);

// Void/cancel a sale (with reason and audit)
router.post('/sale/:id/void', voidSale);

// Get sales by patient (for patient ledger)
router.get('/sales/patient/:patientId', getSalesByPatient);

// Get sales by admission (for IPD pharmacy file)
router.get('/sales/admission/:admissionId', getSalesByAdmission);

// Get pending prescriptions for pharmacy
router.get('/prescriptions/pending', getPendingPrescriptions);

// Get recent sales for dashboard
router.get('/recent', getRecentSales);

module.exports = router;