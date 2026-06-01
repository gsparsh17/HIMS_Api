const express = require('express');
const router = express.Router();
const { authorize } = require('../middlewares/auth');

const {
  calculateHospitalRevenue,
  getDailyRevenueReport,
  getMonthlyRevenueReport,
  getDoctorRevenue,
  getDepartmentRevenue,
  getDetailedRevenueReport,

  exportRevenueData,
  exportOverview,
  exportDaily,
  exportMonthly,
  exportDoctor,
  exportDepartment,
  exportDetailed,

  getProcedureRevenueAnalytics,
  exportProcedureRevenue,

  getLabTestRevenueAnalytics,
  exportLabTestRevenue,

  // Radiology analytics
  getRadiologyRevenueAnalytics,
  exportRadiologyRevenue,

  // IPD analytics
  getIpdRevenueAnalytics,
  exportIpdRevenue,

  // Pharmacy specific revenue endpoints
  getPharmacyRevenueAnalytics,
  exportPharmacyRevenue,
  getMedicineWiseRevenue,
  getPharmacyOutstandingReport
} = require('../controllers/revenue.controller');

// ========== BASE REVENUE ROUTES ==========
router.get('/',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  calculateHospitalRevenue
);

router.get('/daily',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getDailyRevenueReport
);

router.get('/monthly',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getMonthlyRevenueReport
);

router.get('/doctor',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getDoctorRevenue
);

router.get('/department',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getDepartmentRevenue
);

router.get('/detailed',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getDetailedRevenueReport
);

// ========== ANALYTICS ==========
router.get('/procedures',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  getProcedureRevenueAnalytics
);

router.get('/labtests',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  getLabTestRevenueAnalytics
);

router.get('/radiology',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  getRadiologyRevenueAnalytics
);

router.get('/ipd',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  getIpdRevenueAnalytics
);

// ========== PHARMACY SPECIFIC REVENUE ROUTES ==========
router.get('/pharmacy',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getPharmacyRevenueAnalytics
);

router.get('/pharmacy/medicines',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getMedicineWiseRevenue
);

router.get('/pharmacy/outstanding',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  getPharmacyOutstandingReport
);

// ========== EXPORT ROUTES ==========
router.get('/export',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportRevenueData
);

router.get('/export/overview',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportOverview
);

router.get('/export/daily',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportDaily
);

router.get('/export/monthly',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportMonthly
);

router.get('/export/doctor',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportDoctor
);

router.get('/export/department',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportDepartment
);

router.get('/export/detailed',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportDetailed
);

router.get('/export/procedures',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  exportProcedureRevenue
);

router.get('/export/labtests',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  exportLabTestRevenue
);

router.get('/export/radiology',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  exportRadiologyRevenue
);

router.get('/export/ipd',
  // protect, 
  // authorize('admin', 'billing', 'accountant'),
  exportIpdRevenue
);

router.get('/export/pharmacy',
  // protect, 
  // authorize('admin', 'pharmacy_head', 'billing', 'accountant'),
  exportPharmacyRevenue
);

module.exports = router;