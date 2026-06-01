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

  // Sales functions
  createSale,
  getAllSales,
  getSalesStatistics,
  getDailySalesReport,
  getMonthlySalesReport,
  getYearlySalesReport,
  getRevenueComparison,

  // NEW: Enhanced pharmacy transaction functions
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
router.post('/purchase-orders',
  // protect, 
  //   authorize('admin', 'pharmacy_head', 'store'),
  createPurchaseOrder
);

// Get all purchase orders with filters
router.get('/purchase',
  // protect, 
  //   authorize('admin', 'pharmacy', 'pharmacy_head', 'store'),
  getAllPurchaseOrders
);

// Get purchase order statistics
router.get('/purchase/stats',
  // protect, 
  //   authorize('admin', 'pharmacy_head'),
  getPurchaseOrderStatistics
);

// Receive purchase order stock
router.post('/purchase/:id/receive',
  // protect, 
  //   authorize('admin', 'pharmacy_head', 'store'),
  receivePurchaseOrder
);

// Get purchase order by ID
router.get('/purchase/:id',
  // protect, 
  //   authorize('admin', 'pharmacy', 'pharmacy_head', 'store'),
  getPurchaseOrderById
);

// ========== SALES ROUTES ==========
// Create sale (pharmacy POS)
router.post('/sale',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'registrar'),
  createSale
);

// Get all sales with filters
router.get('/sale',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'billing'),
  getAllSales
);

// Get sales statistics
router.get('/sale/stats',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin'),
  getSalesStatistics
);

// Get daily sales report
router.get('/sale/daily',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'billing'),
  getDailySalesReport
);

// Get monthly sales report
router.get('/sale/monthly',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'billing'),
  getMonthlySalesReport
);

// Get yearly sales report
router.get('/sale/yearly',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'billing'),
  getYearlySalesReport
);

// Get revenue comparison
router.get('/sale/comparison',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin'),
  getRevenueComparison
);

// ========== NEW PHARMACY ENHANCED ROUTES ==========
// Get sale by ID with full details (for printing bills)
router.get('/sale/:id',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'billing'),
  getSaleById
);

// Update sale payment (for partial payments or payment adjustments)
router.patch('/sale/:id/payment',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin'),
  updateSalePayment
);

// Void/cancel a sale (with reason and audit)
router.post('/sale/:id/void',
  // protect, 
  //   authorize('pharmacy_head', 'admin'),
  voidSale
);

// Get sales by patient (for patient ledger)
router.get('/sales/patient/:patientId',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'billing', 'registrar'),
  getSalesByPatient
);

// Get sales by admission (for IPD pharmacy file)
router.get('/sales/admission/:admissionId',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin', 'billing', 'doctor'),
  getSalesByAdmission
);

// Get pending prescriptions for pharmacy
router.get('/prescriptions/pending',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin'),
  getPendingPrescriptions
);

// Get recent sales for dashboard
router.get('/recent',
  // protect, 
  //   authorize('pharmacy', 'pharmacy_head', 'admin'),
  getRecentSales
);

module.exports = router;