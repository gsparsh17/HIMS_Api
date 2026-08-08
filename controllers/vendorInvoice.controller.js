'use strict';

const VendorInvoiceRule = require('../models/VendorInvoiceRule');
const Expense = require('../models/Expense');
const Invoice = require('../models/Invoice');
const Supplier = require('../models/Supplier');
const { queueNotification } = require('../services/nabhNotification.service');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');

function validate(value, rule) {
  if (rule.rule === 'required') {
    return value !== undefined && value !== null && value !== '';
  }

  if (rule.rule === 'min') {
    return Number(value) >= Number(rule.value);
  }

  if (rule.rule === 'max') {
    return Number(value) <= Number(rule.value);
  }

  if (rule.rule === 'regex') {
    return new RegExp(String(rule.value)).test(String(value || ''));
  }

  if (rule.rule === 'allowed') {
    return Array.isArray(rule.value) && rule.value.includes(value);
  }

  return true;
}

exports.createRule = async (req, res) => {
  try {
    required(req.body, ['name', 'rules']);

    const row = await VendorInvoiceRule.create({
      hospitalId: hospitalId(req),
      name: req.body.name,
      rules: req.body.rules,
      active: req.body.active !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.listRules = async (req, res) => {
  try {
    const data = await VendorInvoiceRule
      .find({
        hospitalId: hospitalId(req),
        active: { $ne: false }
      })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.createInvoice = async (req, res) => {
  try {
    required(req.body, ['ruleId', 'vendor', 'amount', 'payment_method', 'vendor_invoice_number']);

    const rule = await VendorInvoiceRule.findOne({
      _id: req.body.ruleId,
      hospitalId: hospitalId(req),
      active: true
    });

    if (!rule) {
      return res.status(404).json({
        error: 'Invoice validation rule not found'
      });
    }

    const failures = rule.rules
      .filter(r => !validate(req.body[r.field], r))
      .map(r => ({
        field: r.field,
        message: r.message || `${r.field} failed ${r.rule}`
      }));

    if (failures.length) {
      return res.status(422).json({
        error: 'Vendor invoice validation failed',
        failures
      });
    }

    const amount = Number(req.body.amount);
    const taxRate = Number(req.body.tax_rate || 0);
    const taxAmount = (amount * taxRate) / 100;

    const row = await Expense.create({
      date: req.body.date || new Date(),
      category: req.body.category || 'Medical Supplies',
      description: req.body.description || `Vendor invoice ${req.body.vendor_invoice_number}`,
      amount,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total_amount: amount + taxAmount,
      vendor: req.body.vendor,
      vendor_phone: req.body.vendor_phone,
      vendor_email: req.body.vendor_email,
      payment_method: req.body.payment_method,
      payment_status: 'Pending',
      hospital_id: hospitalId(req),
      created_by: req.user._id,
      source_module: 'manual',
      vendor_invoice_number: req.body.vendor_invoice_number,
      supplier_id: req.body.supplier_id,
      invoice_validation: {
        ruleId: rule._id,
        validatedAt: new Date(),
        status: 'valid'
      }
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.pay = async (req, res) => {
  try {
    required(req.body, ['paymentMethod', 'transactionId']);

    const row = await Expense.findOne({
      _id: req.params.id,
      hospital_id: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Vendor invoice/expense not found'
      });
    }

    row.payment_method = req.body.paymentMethod;
    row.payment_status = 'Paid';
    row.paid_amount = row.total_amount;
    row.payment_date = new Date();
    row.transaction_id = req.body.transactionId;
    row.payment_channel = req.body.paymentChannel || req.body.paymentMethod;

    await row.save();

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.schedule = async (req, res) => {
  try {
    required(req.body, ['scheduledAt', 'paymentMethod']);

    const row = await Expense.findOne({
      _id: req.params.id,
      hospital_id: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Vendor invoice/expense not found'
      });
    }

    row.auto_pay = true;
    row.scheduled_payment_at = new Date(req.body.scheduledAt);
    row.payment_channel = req.body.paymentMethod;

    await row.save();

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.executeDue = async (req, res) => {
  try {
    const rows = await Expense.find({
      hospital_id: hospitalId(req),
      auto_pay: true,
      payment_status: 'Pending',
      scheduled_payment_at: { $lte: new Date() }
    });

    for (const row of rows) {
      row.payment_status = 'Paid';
      row.paid_amount = row.total_amount;
      row.payment_date = new Date();
      row.transaction_id = row.transaction_id || `AUTO-${Date.now()}-${row._id}`;
      row.auto_pay = false;

      await row.save();
    }

    return res.json({
      success: true,
      processed: rows.length,
      data: rows
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.dashboard = async (req, res) => {
  try {
    const hid = hospitalId(req);

    const [expenses, invoices] = await Promise.all([
      Expense
        .find({ hospital_id: hid })
        .sort({ date: -1 })
        .limit(250)
        .lean(),

      Invoice
        .find({ hospital_id: hid })
        .sort({ createdAt: -1 })
        .limit(250)
        .lean()
    ]);

    const payableOutstanding = expenses.reduce(
      (sum, x) => sum + Math.max(0, Number(x.total_amount || 0) - Number(x.paid_amount || 0)),
      0
    );

    const receivableOutstanding = invoices.reduce(
      (sum, x) => sum + Math.max(0, Number(x.total_amount || x.grand_total || 0) - Number(x.paid_amount || 0)),
      0
    );

    return res.json({
      success: true,
      data: {
        payables: {
          count: expenses.length,
          outstanding: payableOutstanding,
          rows: expenses
        },
        receivables: {
          count: invoices.length,
          outstanding: receivableOutstanding,
          rows: invoices
        }
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.adjustment = async (req, res) => {
  try {
    required(req.body, ['adjustmentType', 'amount', 'description']);

    if (!['credit_note', 'debit_note'].includes(req.body.adjustmentType)) {
      return res.status(400).json({
        error: 'Invalid adjustmentType'
      });
    }

    const row = await Expense.create({
      date: new Date(),
      category: 'Other',
      description: req.body.description,
      amount: Number(req.body.amount),
      tax_rate: 0,
      tax_amount: 0,
      total_amount: Number(req.body.amount),
      vendor: req.body.counterparty || 'Adjustment',
      payment_method: 'Online',
      payment_status: 'Paid',
      paid_amount: Number(req.body.amount),
      hospital_id: hospitalId(req),
      created_by: req.user._id,
      source_module: 'other',
      adjustment_type: req.body.adjustmentType,
      parent_expense_id: req.body.parentExpenseId,
      parent_invoice_id: req.body.parentInvoiceId
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.notifySupplier = async (req, res) => {
  try {
    const row = await Expense.findOne({
      _id: req.params.id,
      hospital_id: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Vendor invoice/expense not found'
      });
    }

    const delivery = await queueNotification({
      hospitalId: hospitalId(req),
      eventType: 'supplier_payment_status',
      correlationId: row.expense_number,
      recipientType: 'supplier',
      requestedChannels: req.body.channels || ['portal'],
      contact: {
        email: row.vendor_email,
        phone: row.vendor_phone
      },
      priority: 'normal',
      subject: 'Vendor payment status update',
      body: req.body.message || `Payment status for ${row.expense_number}: ${row.payment_status}`,
      payload: {
        expenseId: row._id,
        status: row.payment_status,
        transactionId: row.transaction_id
      },
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: delivery
    });
  } catch (e) {
    return sendError(res, e);
  }
};