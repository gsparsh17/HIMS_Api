const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expense.controller');
const vendorInvoice = require('../controllers/vendorInvoice.controller');

// Create a new expense
router.post('/', 
  expenseController.createExpense
);

// Get all expenses with filters
router.get('/', 
  expenseController.getAllExpenses
);

// Get daily expenses
router.get('/daily', 
  expenseController.getDailyExpenses
);

// Get monthly expenses
router.get('/monthly', 
  expenseController.getMonthlyExpenses
);

// Get expense summary
router.get('/summary', 
  expenseController.getExpenseSummary
);


// Vendor invoice/payment additions reuse Expense and Invoice ledgers.
router.post('/vendor-rules', vendorInvoice.createRule);
router.get('/vendor-rules', vendorInvoice.listRules);
router.post('/vendor-invoices', vendorInvoice.createInvoice);
router.post('/vendor-invoices/:id/pay', vendorInvoice.pay);
router.post('/vendor-invoices/:id/schedule', vendorInvoice.schedule);
router.post('/vendor-payments/execute-due', vendorInvoice.executeDue);
router.get('/vendor-dashboard', vendorInvoice.dashboard);
router.post('/adjustments', vendorInvoice.adjustment);
router.post('/vendor-invoices/:id/notify-supplier', vendorInvoice.notifySupplier);

// Get expense by ID
router.get('/:id', 
  expenseController.getExpenseById
);

// Update expense
router.put('/:id', 
  expenseController.updateExpense
);

// Delete expense
router.delete('/:id', 
  expenseController.deleteExpense
);

// Approve/Reject expense
router.put('/:id/approve', 
  expenseController.approveExpense
);

// Update payment status
router.put('/:id/payment', 
  expenseController.updatePaymentStatus
);


module.exports = router;