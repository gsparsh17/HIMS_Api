const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expense.controller');

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