const express = require('express');
const router = express.Router();
const { protect, authorize, requirePharmacyFinancialAccess } = require('../middlewares/auth');
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

const pharmacyFinanceView = requirePharmacyFinancialAccess('view');
const pharmacyFinanceManage = requirePharmacyFinancialAccess('manage');

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
router.post('/sale', pharmacyFinanceManage, createSale);

// Get all sales with filters
router.get('/sale', pharmacyFinanceView, getAllSales);

// Get sales statistics
router.get('/sale/stats', pharmacyFinanceView, getSalesStatistics);

// Get daily sales report
router.get('/sale/daily', pharmacyFinanceView, getDailySalesReport);

// Get monthly sales report
router.get('/sale/monthly', pharmacyFinanceView, getMonthlySalesReport);

// Get yearly sales report
router.get('/sale/yearly', pharmacyFinanceView, getYearlySalesReport);

// Get revenue comparison
router.get('/sale/comparison', pharmacyFinanceView, getRevenueComparison);

// ========== PHARMACY ENHANCED ROUTES ==========
// Get sale by ID with full details (for printing bills)
router.get('/sale/:id', pharmacyFinanceView, getSaleById);

// Update sale payment (for partial payments or payment adjustments)
router.patch('/sale/:id/payment', pharmacyFinanceManage, updateSalePayment);

// Void/cancel a sale (with reason and audit)
router.post('/sale/:id/void', pharmacyFinanceManage, voidSale);

// Get sales by patient (for patient ledger)
router.get('/sales/patient/:patientId', pharmacyFinanceView, getSalesByPatient);

// Get sales by admission (for IPD pharmacy file)
router.get('/sales/admission/:admissionId', pharmacyFinanceView, getSalesByAdmission);

// Get pending prescriptions for pharmacy
router.get('/prescriptions/pending', pharmacyFinanceView, getPendingPrescriptions);

// Get recent sales for dashboard
router.get('/recent', pharmacyFinanceView, getRecentSales);

module.exports = router;