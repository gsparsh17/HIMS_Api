const Expense = require('../models/Expense');
const mongoose = require('mongoose');

// -------------------- Helper Functions --------------------
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
const toNumber = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const parseDateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

// -------------------- Create Expense --------------------
exports.createExpense = async (req, res) => {
  try {
    const {
      date,
      category,
      description,
      amount,
      vendor,
      payment_method,
      department,
      notes,
      tax_rate,
      receipt_number,
      is_recurring,
      recurring_frequency
    } = req.body;

    // Get hospital ID from authenticated user or request
    const hospitalId = req.user?.hospital_id || req.body.hospital_id;
    if (!hospitalId) {
      return res.status(400).json({ error: 'Hospital ID is required' });
    }

    // Calculate totals
    const taxRate = toNumber(tax_rate, 0);
    const baseAmount = toNumber(amount, 0);
    const taxAmount = (baseAmount * taxRate) / 100;
    const totalAmount = baseAmount + taxAmount;

    const expense = new Expense({
      date: date ? new Date(date) : new Date(),
      category,
      description,
      amount: baseAmount,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      vendor,
      payment_method,
      payment_status: 'Pending',
      department,
      notes,
      receipt_number,
      is_recurring: is_recurring === true || is_recurring === 'true',
      recurring_frequency: is_recurring ? recurring_frequency : undefined,
      hospital_id: hospitalId,
      created_by: req.user._id
    });

    await expense.save();

    // Populate created_by field
    await expense.populate('created_by', 'name email');

    res.status(201).json({
      message: 'Expense created successfully',
      expense
    });
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(500).json({ error: 'Failed to create expense', details: error.message });
  }
};

// -------------------- Get All Expenses --------------------
exports.getAllExpenses = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      category,
      status,
      payment_status,
      startDate,
      endDate,
      search,
      sortBy = 'date',
      sortOrder = 'desc'
    } = req.query;

    const filter = {};

    // Filter by hospital
    const hospitalId = req.user?.hospital_id;
    if (hospitalId) {
      filter.hospital_id = hospitalId;
    }

    // Apply filters
    if (category && category !== 'all') filter.category = category;
    if (status && status !== 'all') filter.approval_status = status;
    if (payment_status && payment_status !== 'all') filter.payment_status = payment_status;

    // Date range filter
    if (startDate && endDate) {
      filter.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else if (startDate) {
      filter.date = { $gte: new Date(startDate) };
    } else if (endDate) {
      filter.date = { $lte: new Date(endDate) };
    }

    // Search filter
    if (search) {
      filter.$or = [
        { description: { $regex: search, $options: 'i' } },
        { vendor: { $regex: search, $options: 'i' } },
        { expense_number: { $regex: search, $options: 'i' } },
        { receipt_number: { $regex: search, $options: 'i' } }
      ];
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    // Sorting
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute queries
    const [expenses, total] = await Promise.all([
      Expense.find(filter)
        .populate('created_by', 'name email')
        .populate('approved_by', 'name email')
        .sort(sort)
        .limit(limitNum)
        .skip(skip),
      Expense.countDocuments(filter)
    ]);

    // Calculate totals
    const totalAmount = await Expense.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: '$total_amount' } } }
    ]);

    const paidAmount = await Expense.aggregate([
      { $match: { ...filter, payment_status: 'Paid' } },
      { $group: { _id: null, total: { $sum: '$paid_amount' } } }
    ]);

    res.json({
      expenses,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      },
      summary: {
        totalAmount: totalAmount[0]?.total || 0,
        paidAmount: paidAmount[0]?.total || 0,
        pendingAmount: totalAmount[0]?.total - (paidAmount[0]?.total || 0)
      }
    });
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
};

// -------------------- Get Expense by ID --------------------
exports.getExpenseById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid expense ID' });
    }

    const expense = await Expense.findById(id)
      .populate('created_by', 'name email')
      .populate('approved_by', 'name email');

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    res.json(expense);
  } catch (error) {
    console.error('Error fetching expense:', error);
    res.status(500).json({ error: 'Failed to fetch expense' });
  }
};

// -------------------- Update Expense --------------------
exports.updateExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid expense ID' });
    }

    // Find existing expense
    const expense = await Expense.findById(id);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    // Recalculate totals if amount or tax rate changed
    if (updateData.amount !== undefined || updateData.tax_rate !== undefined) {
      const amount = toNumber(updateData.amount || expense.amount, 0);
      const taxRate = toNumber(updateData.tax_rate || expense.tax_rate, 0);
      const taxAmount = (amount * taxRate) / 100;
      const totalAmount = amount + taxAmount;

      updateData.amount = amount;
      updateData.tax_rate = taxRate;
      updateData.tax_amount = taxAmount;
      updateData.total_amount = totalAmount;
    }

    // Update payment status logic
    if (updateData.payment_status === 'Paid') {
      updateData.paid_amount = updateData.total_amount || expense.total_amount;
      updateData.payment_date = updateData.payment_date || new Date();
    }

    const updatedExpense = await Expense.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    )
      .populate('created_by', 'name email')
      .populate('approved_by', 'name email');

    res.json({
      message: 'Expense updated successfully',
      expense: updatedExpense
    });
  } catch (error) {
    console.error('Error updating expense:', error);
    res.status(500).json({ error: 'Failed to update expense' });
  }
};

// -------------------- Delete Expense --------------------
exports.deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid expense ID' });
    }

    const expense = await Expense.findByIdAndDelete(id);

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    res.json({ message: 'Expense deleted successfully' });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
};

// -------------------- Get Daily Expenses --------------------
exports.getDailyExpenses = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();

    // Set to start and end of day
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

    const filter = {
      date: { $gte: startOfDay, $lte: endOfDay }
    };

    // Filter by hospital
    const hospitalId = req.user?.hospital_id;
    if (hospitalId) {
      filter.hospital_id = hospitalId;
    }

    const expenses = await Expense.find(filter)
      .populate('created_by', 'name email')
      .sort({ date: -1 });

    // Calculate daily summary
    const summary = await Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$total_amount' },
          totalExpenses: { $sum: 1 },
          paidAmount: {
            $sum: {
              $cond: [{ $eq: ['$payment_status', 'Paid'] }, '$paid_amount', 0]
            }
          }
        }
      }
    ]);

    // Group by category
    const byCategory = await Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$category',
          amount: { $sum: '$total_amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { amount: -1 } }
    ]);

    res.json({
      date: targetDate.toISOString().split('T')[0],
      expenses,
      summary: summary[0] || {
        totalAmount: 0,
        totalExpenses: 0,
        paidAmount: 0
      },
      byCategory
    });
  } catch (error) {
    console.error('Error fetching daily expenses:', error);
    res.status(500).json({ error: 'Failed to fetch daily expenses' });
  }
};

// -------------------- Get Monthly Expenses --------------------
exports.getMonthlyExpenses = async (req, res) => {
  try {
    const { year, month } = req.query;
    
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;

    // Create date range for the month
    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

    const filter = {
      date: { $gte: startDate, $lte: endDate }
    };

    // Filter by hospital
    const hospitalId = req.user?.hospital_id;
    if (hospitalId) {
      filter.hospital_id = hospitalId;
    }

    const expenses = await Expense.find(filter)
      .populate('created_by', 'name email')
      .sort({ date: -1 });

    // Calculate monthly summary
    const summary = await Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$total_amount' },
          totalExpenses: { $sum: 1 },
          paidAmount: {
            $sum: {
              $cond: [{ $eq: ['$payment_status', 'Paid'] }, '$paid_amount', 0]
            }
          }
        }
      }
    ]);

    // Group by category
    const byCategory = await Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$category',
          amount: { $sum: '$total_amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { amount: -1 } }
    ]);

    // Group by day
    const byDay = await Expense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          amount: { $sum: '$total_amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      period: {
        year: targetYear,
        month: targetMonth,
        monthName: startDate.toLocaleString('default', { month: 'long' })
      },
      expenses,
      summary: summary[0] || {
        totalAmount: 0,
        totalExpenses: 0,
        paidAmount: 0
      },
      byCategory,
      byDay
    });
  } catch (error) {
    console.error('Error fetching monthly expenses:', error);
    res.status(500).json({ error: 'Failed to fetch monthly expenses' });
  }
};

// -------------------- Get Expense Summary --------------------
exports.getExpenseSummary = async (req, res) => {
  try {
    const { period = 'monthly', year, month, date } = req.query;

    const filter = {};

    // Filter by hospital
    const hospitalId = req.user?.hospital_id;
    if (hospitalId) {
      filter.hospital_id = hospitalId;
    }

    // Apply period filter
    if (period === 'daily' && date) {
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));
      filter.date = { $gte: startOfDay, $lte: endOfDay };
    } else if (period === 'monthly') {
      const targetYear = parseInt(year) || new Date().getFullYear();
      const targetMonth = parseInt(month) || new Date().getMonth() + 1;
      const startDate = new Date(targetYear, targetMonth - 1, 1);
      const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);
      filter.date = { $gte: startDate, $lte: endDate };
    }
    // For 'all', no date filter

    // Calculate summary statistics
    const [overallSummary, byCategory, byPaymentStatus, byApprovalStatus] = await Promise.all([
      // Overall summary
      Expense.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalExpenses: { $sum: '$total_amount' },
            totalRecords: { $sum: 1 },
            paidExpenses: {
              $sum: {
                $cond: [{ $eq: ['$payment_status', 'Paid'] }, '$paid_amount', 0]
              }
            },
            pendingExpenses: {
              $sum: {
                $cond: [
                  { $in: ['$payment_status', ['Pending', 'Partially Paid']] },
                  { $subtract: ['$total_amount', '$paid_amount'] },
                  0
                ]
              }
            }
          }
        }
      ]),
      
      // By category
      Expense.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$category',
            amount: { $sum: '$total_amount' },
            count: { $sum: 1 }
          }
        },
        { $sort: { amount: -1 } }
      ]),
      
      // By payment status
      Expense.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$payment_status',
            amount: { $sum: '$total_amount' },
            count: { $sum: 1 }
          }
        }
      ]),
      
      // By approval status
      Expense.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$approval_status',
            amount: { $sum: '$total_amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    // Calculate category breakdown for frontend
    const categoryBreakdown = {
      'Medical Equipment': 0,
      'Medical Supplies': 0,
      'Utilities': 0,
      'Staff Salaries': 0,
      'Pharmaceuticals': 0,
      'Maintenance': 0,
      'Insurance': 0,
      'Rent': 0,
      'Other': 0
    };

    byCategory.forEach(item => {
      if (categoryBreakdown[item._id] !== undefined) {
        categoryBreakdown[item._id] = item.amount;
      }
    });

    res.json({
      period,
      dateFilter: { year, month, date },
      overall: overallSummary[0] || {
        totalExpenses: 0,
        totalRecords: 0,
        paidExpenses: 0,
        pendingExpenses: 0
      },
      byCategory: categoryBreakdown,
      byPaymentStatus,
      byApprovalStatus,
      detailedByCategory: byCategory,
      salaryExpenses: categoryBreakdown['Staff Salaries'] || 0,
      medicalSupplies: categoryBreakdown['Medical Supplies'] || 0,
      utilities: categoryBreakdown['Utilities'] || 0,
      otherExpenses: categoryBreakdown['Other'] || 0
    });
  } catch (error) {
    console.error('Error fetching expense summary:', error);
    res.status(500).json({ error: 'Failed to fetch expense summary' });
  }
};

// -------------------- Approve Expense --------------------
exports.approveExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid expense ID' });
    }

    if (!['Approved', 'Rejected', 'On Hold'].includes(status)) {
      return res.status(400).json({ error: 'Invalid approval status' });
    }

    const expense = await Expense.findByIdAndUpdate(
      id,
      {
        approval_status: status,
        approved_by: req.user._id,
        approved_date: new Date(),
        notes: notes ? `${expense?.notes || ''}\nApproval Note: ${notes}`.trim() : expense?.notes
      },
      { new: true, runValidators: true }
    )
      .populate('created_by', 'name email')
      .populate('approved_by', 'name email');

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    res.json({
      message: `Expense ${status.toLowerCase()} successfully`,
      expense
    });
  } catch (error) {
    console.error('Error approving expense:', error);
    res.status(500).json({ error: 'Failed to update expense approval' });
  }
};

// -------------------- Update Payment Status --------------------
exports.updatePaymentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_status, paid_amount, payment_date, transaction_id, notes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid expense ID' });
    }

    if (!['Pending', 'Partially Paid', 'Paid', 'Cancelled'].includes(payment_status)) {
      return res.status(400).json({ error: 'Invalid payment status' });
    }

    const expense = await Expense.findById(id);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const updateData = { payment_status };
    
    if (payment_status === 'Paid') {
      updateData.paid_amount = expense.total_amount;
      updateData.payment_date = payment_date ? new Date(payment_date) : new Date();
    } else if (payment_status === 'Partially Paid') {
      const paid = toNumber(paid_amount, 0);
      if (paid <= 0 || paid >= expense.total_amount) {
        return res.status(400).json({ 
          error: 'Partial payment amount must be greater than 0 and less than total amount' 
        });
      }
      updateData.paid_amount = paid;
      updateData.payment_date = payment_date ? new Date(payment_date) : null;
    } else {
      updateData.paid_amount = 0;
      updateData.payment_date = null;
    }

    if (transaction_id) updateData.transaction_id = transaction_id;
    if (notes) {
      updateData.notes = `${expense.notes || ''}\nPayment Note: ${notes}`.trim();
    }

    const updatedExpense = await Expense.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    )
      .populate('created_by', 'name email')
      .populate('approved_by', 'name email');

    res.json({
      message: 'Payment status updated successfully',
      expense: updatedExpense
    });
  } catch (error) {
    console.error('Error updating payment status:', error);
    res.status(500).json({ error: 'Failed to update payment status' });
  }
};