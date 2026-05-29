const jwt = require('jsonwebtoken');
const generateToken = require('../utils/generateToken');
const User = require('../models/User');
const Expense = require('../models/Expense');
const StoreCategory = require('../models/StoreCategory');
const StoreItem = require('../models/StoreItem');
const StoreInventoryTransaction = require('../models/StoreInventoryTransaction');
const StorePurchaseOrder = require('../models/StorePurchaseOrder');
const StoreIssue = require('../models/StoreIssue');
const StoreRequisition = require('../models/StoreRequisition');
const { resolveHospitalId } = require('../utils/hospitalScope');

const STORE_ROLES = ['store', 'store_manager', 'inventory_manager', 'admin', 'mediqliq_super_admin'];

const toNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function getUserId(req) {
  return req.user?._id || req.user?.id || req.body?.created_by || null;
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.max(1, Math.min(200, parseInt(query.limit || '50', 10)));
  return { page, limit, skip: (page - 1) * limit };
}

function calculateExpenseNumber() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `EXP-${y}${m}${d}-${rand}`;
}

async function createOrUpdateExpenseFromPO(po, req) {
  const hospitalId = po.hospital_id || await resolveHospitalId(req);
  const paidAmount = po.payment_status === 'Paid'
    ? po.total_amount
    : po.payment_status === 'Partially Paid'
      ? toNumber(req.body.paid_amount, 0)
      : 0;

  const payload = {
    expense_number: calculateExpenseNumber(),
    date: po.invoice_date || po.received_date || po.order_date || new Date(),
    category: 'Store Purchase',
    description: `Store purchase ${po.po_number}${po.supplier_name ? ` from ${po.supplier_name}` : ''}`,
    amount: po.subtotal,
    tax_rate: po.subtotal > 0 ? (po.tax_amount / po.subtotal) * 100 : 0,
    tax_amount: po.tax_amount,
    total_amount: po.total_amount,
    vendor: po.supplier_name || 'Store Supplier',
    vendor_phone: po.supplier_phone,
    vendor_email: po.supplier_email,
    payment_method: po.payment_method || 'Bank Transfer',
    payment_status: po.payment_status || 'Pending',
    paid_amount: paidAmount,
    payment_date: paidAmount > 0 ? new Date() : undefined,
    receipt_number: po.invoice_number,
    receipt_date: po.invoice_date,
    notes: po.notes,
    department: 'Store',
    hospital_id: hospitalId,
    created_by: getUserId(req) || po.created_by,
    source_module: 'store_purchase',
    source_id: po._id,
    store_purchase_id: po._id
  };

  if (po.expense_id) {
    const updatePayload = { ...payload };
    delete updatePayload.expense_number;
    return Expense.findByIdAndUpdate(
      po.expense_id,
      { $set: updatePayload },
      { new: true, runValidators: true }
    );
  }

  const expense = await Expense.create(payload);
  po.expense_id = expense._id;
  await po.save();
  return expense;
}

async function createTransaction({ item, type, quantity, before, after, unitCost, referenceModel, referenceId, department, remarks, req }) {
  return StoreInventoryTransaction.create({
    item: item._id || item,
    transaction_type: type,
    quantity,
    stock_before: before,
    stock_after: after,
    unit_cost: unitCost || 0,
    total_cost: toNumber(quantity) * toNumber(unitCost),
    reference_model: referenceModel || 'Manual',
    reference_id: referenceId,
    department,
    remarks,
    hospital_id: await resolveHospitalId(req),
    performed_by: getUserId(req)
  });
}

exports.storeLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!STORE_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'This account does not have store dashboard access' });
    }

    return res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      dashboard: 'store',
      token: generateToken(user._id, user.role)
    });
  } catch (error) {
    console.error('Store login error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getDashboard = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};

    const [
      totalItems,
      activeItems,
      lowStockItems,
      pendingRequisitions,
      pendingPOs,
      inventoryValueAgg,
      recentTransactions,
      recentPOs
    ] = await Promise.all([
      StoreItem.countDocuments(filter),
      StoreItem.countDocuments({ ...filter, is_active: true }),
      StoreItem.countDocuments({ ...filter, $expr: { $lte: ['$current_stock', { $ifNull: ['$reorder_level', '$minimum_stock'] }] } }),
      StoreRequisition.countDocuments({ ...filter, status: 'Pending' }),
      StorePurchaseOrder.countDocuments({ ...filter, status: { $in: ['Draft', 'Submitted', 'Approved', 'Partially Received'] } }),
      StoreItem.aggregate([
        { $match: filter },
        { $group: { _id: null, value: { $sum: { $multiply: ['$current_stock', '$average_cost'] } } } }
      ]),
      StoreInventoryTransaction.find(filter).populate('item', 'name item_code unit').sort({ createdAt: -1 }).limit(10),
      StorePurchaseOrder.find(filter).sort({ createdAt: -1 }).limit(10)
    ]);

    res.json({
      summary: {
        totalItems,
        activeItems,
        lowStockItems,
        pendingRequisitions,
        pendingPurchaseOrders: pendingPOs,
        inventoryValue: inventoryValueAgg[0]?.value || 0
      },
      recentTransactions,
      recentPurchaseOrders: recentPOs
    });
  } catch (error) {
    console.error('Store dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch store dashboard', details: error.message });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const category = await StoreCategory.create({
      ...req.body,
      hospital_id: await resolveHospitalId(req),
      created_by: getUserId(req)
    });
    res.status(201).json({ message: 'Store category created', category });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getCategories = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.active !== undefined) filter.is_active = req.query.active === 'true';
    const categories = await StoreCategory.find(filter).sort({ name: 1 });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const category = await StoreCategory.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!category) return res.status(404).json({ error: 'Store category not found' });
    res.json({ message: 'Store category updated', category });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const category = await StoreCategory.findByIdAndUpdate(req.params.id, { is_active: false }, { new: true });
    if (!category) return res.status(404).json({ error: 'Store category not found' });
    res.json({ message: 'Store category deactivated', category });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createItem = async (req, res) => {
  try {
    const item = await StoreItem.create({
      ...req.body,
      hospital_id: await resolveHospitalId(req),
      created_by: getUserId(req)
    });

    if (toNumber(item.opening_stock, 0) > 0) {
      await createTransaction({
        item,
        type: 'opening',
        quantity: item.opening_stock,
        before: 0,
        after: item.current_stock,
        unitCost: item.average_cost,
        remarks: 'Opening stock',
        req
      });
    }

    res.status(201).json({ message: 'Store item created', item });
  } catch (error) {
    console.error('Create store item error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getItems = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};

    if (req.query.category) filter.category = req.query.category;
    if (req.query.item_type) filter.item_type = req.query.item_type;
    if (req.query.active !== undefined) filter.is_active = req.query.active === 'true';
    if (req.query.low_stock === 'true') filter.$expr = { $lte: ['$current_stock', { $ifNull: ['$reorder_level', '$minimum_stock'] }] };
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { item_code: { $regex: req.query.search, $options: 'i' } },
        { brand: { $regex: req.query.search, $options: 'i' } },
        { preferred_supplier: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const [items, total] = await Promise.all([
      StoreItem.find(filter).populate('category', 'name code').sort({ name: 1 }).skip(skip).limit(limit),
      StoreItem.countDocuments(filter)
    ]);

    res.json({ items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getItemById = async (req, res) => {
  try {
    const item = await StoreItem.findById(req.params.id).populate('category', 'name code');
    if (!item) return res.status(404).json({ error: 'Store item not found' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateItem = async (req, res) => {
  try {
    const item = await StoreItem.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updated_by: getUserId(req) },
      { new: true, runValidators: true }
    ).populate('category', 'name code');
    if (!item) return res.status(404).json({ error: 'Store item not found' });
    res.json({ message: 'Store item updated', item });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deleteItem = async (req, res) => {
  try {
    const item = await StoreItem.findByIdAndUpdate(req.params.id, { is_active: false, updated_by: getUserId(req) }, { new: true });
    if (!item) return res.status(404).json({ error: 'Store item not found' });
    res.json({ message: 'Store item deactivated', item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.adjustStock = async (req, res) => {
  try {
    const { quantity, adjustment_type, unit_cost, remarks } = req.body;
    const item = await StoreItem.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Store item not found' });

    const qty = toNumber(quantity, 0);
    if (qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than zero' });

    const before = item.current_stock;
    const isOut = ['out', 'decrease', 'adjustment_out', 'damage'].includes(String(adjustment_type).toLowerCase());
    const after = isOut ? before - qty : before + qty;
    if (after < 0) return res.status(400).json({ error: 'Insufficient stock' });

    item.current_stock = after;
    if (!isOut && unit_cost !== undefined) {
      item.average_cost = toNumber(unit_cost, item.average_cost);
      item.last_purchase_price = toNumber(unit_cost, item.last_purchase_price);
    }
    item.updated_by = getUserId(req);
    await item.save();

    const transaction = await createTransaction({
      item,
      type: isOut ? (String(adjustment_type).toLowerCase() === 'damage' ? 'damage' : 'adjustment_out') : 'adjustment_in',
      quantity: qty,
      before,
      after,
      unitCost: unit_cost || item.average_cost,
      remarks,
      req
    });

    res.json({ message: 'Stock adjusted successfully', item, transaction });
  } catch (error) {
    console.error('Adjust stock error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getTransactions = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.item) filter.item = req.query.item;
    if (req.query.type) filter.transaction_type = req.query.type;
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
    }

    const [transactions, total] = await Promise.all([
      StoreInventoryTransaction.find(filter)
        .populate('item', 'name item_code unit')
        .populate('performed_by', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      StoreInventoryTransaction.countDocuments(filter)
    ]);

    res.json({ transactions, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createRequisition = async (req, res) => {
  try {
    const requisition = await StoreRequisition.create({
      ...req.body,
      requested_by: req.body.requested_by || getUserId(req),
      hospital_id: await resolveHospitalId(req)
    });
    await requisition.populate('items.item', 'name item_code unit current_stock');
    res.status(201).json({ message: 'Store requisition created', requisition });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getRequisitions = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.department) filter.department = req.query.department;

    const [requisitions, total] = await Promise.all([
      StoreRequisition.find(filter)
        .populate('items.item', 'name item_code unit current_stock')
        .populate('requested_by approved_by', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      StoreRequisition.countDocuments(filter)
    ]);
    res.json({ requisitions, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateRequisitionStatus = async (req, res) => {
  try {
    const { status, items, rejection_reason } = req.body;
    const update = { status, rejection_reason };
    if (status === 'Approved') {
      update.approved_by = getUserId(req);
      update.approved_at = new Date();
      if (Array.isArray(items)) update.items = items;
    }

    const requisition = await StoreRequisition.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .populate('items.item', 'name item_code unit current_stock')
      .populate('requested_by approved_by', 'name email role');
    if (!requisition) return res.status(404).json({ error: 'Store requisition not found' });
    res.json({ message: 'Store requisition updated', requisition });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.createIssue = async (req, res) => {
  try {
    const { items = [] } = req.body;
    if (!items.length) return res.status(400).json({ error: 'At least one issue item is required' });

    const preparedItems = [];
    for (const line of items) {
      const item = await StoreItem.findById(line.item);
      if (!item) return res.status(404).json({ error: `Store item not found: ${line.item}` });
      const qty = toNumber(line.quantity, 0);
      if (qty <= 0) return res.status(400).json({ error: 'Issue quantity must be greater than zero' });
      if (item.current_stock < qty) return res.status(400).json({ error: `Insufficient stock for ${item.name}` });
      preparedItems.push({ item, qty, unit_cost: toNumber(line.unit_cost, item.average_cost), remarks: line.remarks });
    }

    const issue = await StoreIssue.create({
      ...req.body,
      items: preparedItems.map((line) => ({ item: line.item._id, quantity: line.qty, unit_cost: line.unit_cost, remarks: line.remarks })),
      issued_by: req.body.issued_by || getUserId(req),
      hospital_id: await resolveHospitalId(req)
    });

    for (const line of preparedItems) {
      const before = line.item.current_stock;
      line.item.current_stock = before - line.qty;
      line.item.updated_by = getUserId(req);
      await line.item.save();
      await createTransaction({
        item: line.item,
        type: 'issue',
        quantity: line.qty,
        before,
        after: line.item.current_stock,
        unitCost: line.unit_cost,
        referenceModel: 'StoreIssue',
        referenceId: issue._id,
        department: req.body.department,
        remarks: line.remarks || req.body.notes,
        req
      });
    }

    if (issue.requisition) {
      await StoreRequisition.findByIdAndUpdate(issue.requisition, { status: 'Issued' });
    }

    await issue.populate('items.item', 'name item_code unit');
    res.status(201).json({ message: 'Store issue created and stock deducted', issue });
  } catch (error) {
    console.error('Create issue error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getIssues = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.department) filter.department = req.query.department;
    if (req.query.status) filter.status = req.query.status;

    const [issues, total] = await Promise.all([
      StoreIssue.find(filter)
        .populate('items.item', 'name item_code unit')
        .populate('issued_by requested_by', 'name email role')
        .sort({ issue_date: -1 })
        .skip(skip)
        .limit(limit),
      StoreIssue.countDocuments(filter)
    ]);
    res.json({ issues, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createPurchaseOrder = async (req, res) => {
  try {
    const po = await StorePurchaseOrder.create({
      ...req.body,
      hospital_id: await resolveHospitalId(req),
      created_by: getUserId(req)
    });
    await po.populate('items.item', 'name item_code unit');
    res.status(201).json({ message: 'Store purchase order created', purchaseOrder: po });
  } catch (error) {
    console.error('Create purchase order error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getPurchaseOrders = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.supplier) filter.supplier_name = { $regex: req.query.supplier, $options: 'i' };
    if (req.query.payment_status) filter.payment_status = req.query.payment_status;

    const [purchaseOrders, total] = await Promise.all([
      StorePurchaseOrder.find(filter)
        .populate('items.item', 'name item_code unit')
        .populate('expense_id', 'expense_number total_amount payment_status')
        .populate('created_by approved_by received_by', 'name email role')
        .sort({ order_date: -1 })
        .skip(skip)
        .limit(limit),
      StorePurchaseOrder.countDocuments(filter)
    ]);
    res.json({ purchaseOrders, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPurchaseOrderById = async (req, res) => {
  try {
    const po = await StorePurchaseOrder.findById(req.params.id)
      .populate('items.item', 'name item_code unit current_stock average_cost')
      .populate('expense_id')
      .populate('created_by approved_by received_by', 'name email role');
    if (!po) return res.status(404).json({ error: 'Store purchase order not found' });
    res.json(po);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updatePurchaseOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const update = { status };
    if (status === 'Approved') update.approved_by = getUserId(req);
    const po = await StorePurchaseOrder.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .populate('items.item', 'name item_code unit');
    if (!po) return res.status(404).json({ error: 'Store purchase order not found' });
    res.json({ message: 'Purchase order status updated', purchaseOrder: po });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.receivePurchaseOrder = async (req, res) => {
  try {
    const po = await StorePurchaseOrder.findById(req.params.id).populate('items.item');
    if (!po) return res.status(404).json({ error: 'Store purchase order not found' });
    if (po.status === 'Cancelled') return res.status(400).json({ error: 'Cannot receive a cancelled purchase order' });

    const receivedItems = Array.isArray(req.body.items) && req.body.items.length
      ? req.body.items
      : po.items.map((line) => ({ item: line.item._id.toString(), received_quantity: line.quantity - line.received_quantity }));

    let anyReceived = false;
    for (const receiveLine of receivedItems) {
      const poLine = po.items.find((line) => line.item._id.toString() === String(receiveLine.item));
      if (!poLine) continue;
      const qty = toNumber(receiveLine.received_quantity, 0);
      if (qty <= 0) continue;
      const remaining = poLine.quantity - poLine.received_quantity;
      if (qty > remaining) return res.status(400).json({ error: `Received quantity exceeds pending quantity for ${poLine.item.name}` });

      const item = poLine.item;
      const before = item.current_stock;
      const after = before + qty;
      const oldValue = before * toNumber(item.average_cost, 0);
      const newValue = qty * toNumber(poLine.unit_price, 0);
      item.current_stock = after;
      item.last_purchase_price = poLine.unit_price;
      item.average_cost = after > 0 ? (oldValue + newValue) / after : poLine.unit_price;
      item.tax_rate = poLine.tax_rate;
      item.updated_by = getUserId(req);
      await item.save();

      poLine.received_quantity += qty;
      anyReceived = true;
      await createTransaction({
        item,
        type: 'purchase',
        quantity: qty,
        before,
        after,
        unitCost: poLine.unit_price,
        referenceModel: 'StorePurchaseOrder',
        referenceId: po._id,
        remarks: `Received against ${po.po_number}`,
        req
      });
    }

    if (!anyReceived) return res.status(400).json({ error: 'No items were received' });

    const allReceived = po.items.every((line) => line.received_quantity >= line.quantity);
    po.status = allReceived ? 'Received' : 'Partially Received';
    po.received_date = req.body.received_date ? new Date(req.body.received_date) : new Date();
    po.received_by = getUserId(req);
    if (req.body.invoice_number) po.invoice_number = req.body.invoice_number;
    if (req.body.invoice_date) po.invoice_date = new Date(req.body.invoice_date);
    if (req.body.payment_status) po.payment_status = req.body.payment_status;
    if (req.body.payment_method) po.payment_method = req.body.payment_method;
    await po.save();

    let expense = null;
    if (po.create_expense !== false && req.body.create_expense !== false) {
      expense = await createOrUpdateExpenseFromPO(po, req);
    }

    await po.populate('items.item', 'name item_code unit current_stock');
    await po.populate('expense_id', 'expense_number total_amount payment_status');
    res.json({ message: 'Purchase order received and stock updated', purchaseOrder: po, expense });
  } catch (error) {
    console.error('Receive purchase order error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getLowStockItems = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    const items = await StoreItem.find({
      ...filter,
      is_active: true,
      $expr: { $lte: ['$current_stock', { $ifNull: ['$reorder_level', '$minimum_stock'] }] }
    }).populate('category', 'name code').sort({ current_stock: 1 });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
