const mongoose = require('mongoose');
const HospitalEquipment = require('../models/HospitalEquipment');
const Expense = require('../models/Expense');
const HRStaffProfile = require('../models/HRStaffProfile');
const { resolveHospitalId } = require('../utils/hospitalScope');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');

const toNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const isTruthy = (value) => value === true || value === 'true' || value === 1 || value === '1';
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

function getUserId(req) {
  return req.user?._id || req.user?.id || req.body?.created_by || null;
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.max(1, Math.min(200, parseInt(query.limit || '50', 10)));
  return { page, limit, skip: (page - 1) * limit };
}

async function buildHospitalFilter(req, extra = {}) {
  const hospitalId = await resolveHospitalId(req);
  const filter = { ...extra };
  if (hospitalId) filter.hospital_id = hospitalId;
  return filter;
}

async function createLinkedExpense({ equipment, req, type, amount, vendor, description, paymentMethod, receiptNumber, sourceId }) {
  const totalAmount = toNumber(amount, 0);
  if (totalAmount <= 0) return null;

  const hospitalId = equipment.hospital_id || await resolveHospitalId(req);
  const createdBy = getUserId(req) || equipment.created_by;
  if (!hospitalId || !createdBy) return null;

  return Expense.create({
    date: type === 'maintenance' ? new Date() : (equipment.invoice_date || equipment.purchase_date || new Date()),
    category: type === 'maintenance' ? 'Equipment Maintenance' : 'Equipment Purchase',
    description: description || `${type === 'maintenance' ? 'Maintenance for' : 'Purchase of'} ${equipment.equipment_name} (${equipment.asset_code || 'new asset'})`,
    amount: totalAmount,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: totalAmount,
    vendor: vendor || equipment.supplier_name || 'Equipment Vendor',
    payment_method: paymentMethod || 'Bank Transfer',
    payment_status: 'Pending',
    department: equipment.department || 'Assets',
    location: equipment.location,
    receipt_number: receiptNumber || equipment.invoice_number,
    receipt_date: equipment.invoice_date,
    hospital_id: hospitalId,
    created_by: createdBy,
    source_module: type === 'maintenance' ? 'equipment_maintenance' : 'equipment_purchase',
    source_id: sourceId || equipment._id,
    equipment_id: equipment._id
  });
}

exports.getDashboard = async (req, res) => {
  try {
    const filter = await buildHospitalFilter(req, { is_active: true });
    const today = new Date();

    const [
      totalEquipment,
      conditionBreakdown,
      statusBreakdown,
      categoryBreakdown,
      overdueMaintenance,
      dueSoonMaintenance,
      purchaseCostAgg,
      maintenanceCostAgg,
      recentEquipment,
      attentionNeeded
    ] = await Promise.all([
      HospitalEquipment.countDocuments(filter),
      HospitalEquipment.aggregate([{ $match: filter }, { $group: { _id: '$condition_status', count: { $sum: 1 } } }]),
      HospitalEquipment.aggregate([{ $match: filter }, { $group: { _id: '$operational_status', count: { $sum: 1 } } }]),
      HospitalEquipment.aggregate([{ $match: filter }, { $group: { _id: '$category', count: { $sum: 1 }, value: { $sum: '$purchase_cost' } } }, { $sort: { count: -1 } }]),
      HospitalEquipment.countDocuments({ ...filter, next_maintenance_due: { $lt: today } }),
      HospitalEquipment.countDocuments({ ...filter, next_maintenance_due: { $gte: today, $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } }),
      HospitalEquipment.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$purchase_cost' } } }]),
      HospitalEquipment.aggregate([{ $match: filter }, { $unwind: { path: '$maintenance_records', preserveNullAndEmptyArrays: false } }, { $group: { _id: null, total: { $sum: '$maintenance_records.cost' } } }]),
      HospitalEquipment.find(filter).sort({ createdAt: -1 }).limit(8).populate('assigned_to_employee', 'full_name employee_code staff_type designation'),
      HospitalEquipment.find({ ...filter, condition_status: { $in: ['Needs Maintenance', 'Under Maintenance', 'Damaged', 'Condemned'] } }).sort({ updatedAt: -1 }).limit(8)
    ]);

    const toMap = (rows) => rows.reduce((acc, row) => ({ ...acc, [row._id || 'Unknown']: row.count }), {});

    res.json({
      summary: {
        totalEquipment,
        purchaseValue: purchaseCostAgg[0]?.total || 0,
        maintenanceCost: maintenanceCostAgg[0]?.total || 0,
        overdueMaintenance,
        dueSoonMaintenance,
        needsAttention: attentionNeeded.length,
        condition: toMap(conditionBreakdown),
        operationalStatus: toMap(statusBreakdown),
        categories: categoryBreakdown
      },
      recentEquipment,
      attentionNeeded
    });
  } catch (error) {
    console.error('Equipment dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch equipment dashboard', details: error.message });
  }
};

exports.createEquipment = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    if (!hospitalId) return res.status(400).json({ error: 'Hospital ID is required' });

    const payload = {
      ...req.body,
      purchase_cost: toNumber(req.body.purchase_cost, 0),
      hospital_id: hospitalId,
      created_by: getUserId(req),
      updated_by: getUserId(req)
    };

    const equipment = await HospitalEquipment.create(payload);

    if (isTruthy(req.body.create_expense) && equipment.purchase_cost > 0) {
      const expense = await createLinkedExpense({
        equipment,
        req,
        type: 'purchase',
        amount: equipment.purchase_cost,
        vendor: equipment.supplier_name,
        paymentMethod: req.body.payment_method,
        receiptNumber: equipment.invoice_number
      });
      if (expense) {
        equipment.purchase_expense_id = expense._id;
        await equipment.save();
      }
    }

    await equipment.populate([
      { path: 'assigned_to_employee', select: 'full_name employee_code staff_type designation department_name' },
      { path: 'purchase_expense_id', select: 'expense_number category total_amount payment_status approval_status' },
      { path: 'store_item_id', select: 'name item_code unit' },
      { path: 'store_purchase_order_id', select: 'po_number supplier_name total_amount status' }
    ]);

    res.status(201).json({ message: 'Equipment created successfully', equipment });
  } catch (error) {
    console.error('Create equipment error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getEquipment = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { search, category, condition_status, operational_status, department, location, assigned_to_employee, maintenance_due } = req.query;
    const filter = await buildHospitalFilter(req, { is_active: true });

    if (category && category !== 'all') filter.category = category;
    if (condition_status && condition_status !== 'all') filter.condition_status = condition_status;
    if (operational_status && operational_status !== 'all') filter.operational_status = operational_status;
    if (department && department !== 'all') filter.department = department;
    if (location && location !== 'all') filter.location = location;
    if (assigned_to_employee && isValidObjectId(assigned_to_employee)) filter.assigned_to_employee = assigned_to_employee;
    if (maintenance_due === 'overdue') filter.next_maintenance_due = { $lt: new Date() };
    if (maintenance_due === 'next_30_days') filter.next_maintenance_due = { $gte: new Date(), $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) };

    if (search) {
      filter.$or = [
        { equipment_name: { $regex: search, $options: 'i' } },
        { asset_code: { $regex: search, $options: 'i' } },
        { serial_no: { $regex: search, $options: 'i' } },
        { brand: { $regex: search, $options: 'i' } },
        { model_no: { $regex: search, $options: 'i' } },
        { supplier_name: { $regex: search, $options: 'i' } },
        { department: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } }
      ];
    }

    const [equipment, total] = await Promise.all([
      HospitalEquipment.find(filter)
        .populate('assigned_to_employee', 'full_name employee_code staff_type designation department_name')
        .populate('purchase_expense_id', 'expense_number category total_amount payment_status approval_status')
        .populate('store_item_id', 'name item_code unit')
        .populate('store_purchase_order_id', 'po_number supplier_name total_amount status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      HospitalEquipment.countDocuments(filter)
    ]);

    res.json({
      equipment,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('List equipment error:', error);
    res.status(500).json({ error: 'Failed to fetch equipment', details: error.message });
  }
};

exports.getEquipmentById = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid equipment ID' });

    const equipment = await HospitalEquipment.findById(req.params.id)
      .populate('assigned_to_employee', 'full_name employee_code staff_type designation department_name email phone')
      .populate('purchase_expense_id', 'expense_number category total_amount payment_status approval_status')
      .populate('maintenance_records.expense_id', 'expense_number category total_amount payment_status approval_status')
      .populate('store_item_id', 'name item_code unit')
      .populate('store_purchase_order_id', 'po_number supplier_name total_amount status');

    if (!equipment || !equipment.is_active) return res.status(404).json({ error: 'Equipment not found' });
    res.json(equipment);
  } catch (error) {
    console.error('Get equipment error:', error);
    res.status(500).json({ error: 'Failed to fetch equipment', details: error.message });
  }
};

exports.updateEquipment = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid equipment ID' });

    const update = {
      ...req.body,
      updated_by: getUserId(req)
    };
    if (update.purchase_cost !== undefined) update.purchase_cost = toNumber(update.purchase_cost, 0);

    const equipment = await HospitalEquipment.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true })
      .populate('assigned_to_employee', 'full_name employee_code staff_type designation department_name')
      .populate('purchase_expense_id', 'expense_number category total_amount payment_status approval_status');

    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    res.json({ message: 'Equipment updated successfully', equipment });
  } catch (error) {
    console.error('Update equipment error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.deactivateEquipment = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid equipment ID' });
    const equipment = await HospitalEquipment.findByIdAndUpdate(req.params.id, { is_active: false, updated_by: getUserId(req) }, { new: true });
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    res.json({ message: 'Equipment deactivated successfully', equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateCondition = async (req, res) => {
  try {
    const { condition_status, operational_status, remarks, next_maintenance_due } = req.body;
    const equipment = await HospitalEquipment.findById(req.params.id);
    if (!equipment || !equipment.is_active) return res.status(404).json({ error: 'Equipment not found' });

    equipment.condition_status = condition_status || equipment.condition_status;
    equipment.operational_status = operational_status || equipment.operational_status;
    equipment.condition_notes = remarks || equipment.condition_notes;
    if (next_maintenance_due !== undefined) equipment.next_maintenance_due = next_maintenance_due || undefined;
    equipment.updated_by = getUserId(req);
    equipment.condition_history.push({
      condition_status: equipment.condition_status,
      operational_status: equipment.operational_status,
      remarks,
      checked_by: getUserId(req)
    });
    await equipment.save();

    res.json({ message: 'Equipment condition updated', equipment });
  } catch (error) {
    console.error('Update condition error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.assignEquipment = async (req, res) => {
  try {
    const { assigned_to_employee, department, location, room_no, operational_status = 'In Use' } = req.body;
    const equipment = await HospitalEquipment.findById(req.params.id);
    if (!equipment || !equipment.is_active) return res.status(404).json({ error: 'Equipment not found' });

    let employeeName = '';
    if (assigned_to_employee && isValidObjectId(assigned_to_employee)) {
      const employee = await HRStaffProfile.findById(assigned_to_employee).select('full_name employee_code');
      employeeName = employee ? `${employee.full_name} (${employee.employee_code})` : '';
    }

    equipment.assigned_to_employee = assigned_to_employee || undefined;
    equipment.assigned_to_name = employeeName || req.body.assigned_to_name || '';
    equipment.department = department || equipment.department;
    equipment.location = location || equipment.location;
    equipment.room_no = room_no || equipment.room_no;
    equipment.operational_status = operational_status;
    equipment.assigned_at = assigned_to_employee || req.body.assigned_to_name ? new Date() : undefined;
    equipment.updated_by = getUserId(req);
    await equipment.save();

    await equipment.populate('assigned_to_employee', 'full_name employee_code staff_type designation department_name');
    res.json({ message: 'Equipment assignment updated', equipment });
  } catch (error) {
    console.error('Assign equipment error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.addMaintenanceRecord = async (req, res) => {
  try {
    const equipment = await HospitalEquipment.findById(req.params.id);
    if (!equipment || !equipment.is_active) return res.status(404).json({ error: 'Equipment not found' });

    const cost = toNumber(req.body.cost, 0);
    let expense = null;

    const record = {
      maintenance_date: req.body.maintenance_date || new Date(),
      maintenance_type: req.body.maintenance_type || 'Preventive',
      vendor: req.body.vendor,
      vendor_phone: req.body.vendor_phone,
      cost,
      payment_method: req.body.payment_method || 'Bank Transfer',
      description: req.body.description,
      before_condition: equipment.condition_status,
      after_condition: req.body.after_condition || equipment.condition_status,
      next_due_date: req.body.next_due_date,
      document_url: req.body.document_url,
      recorded_by: getUserId(req)
    };

    if (isTruthy(req.body.create_expense) && cost > 0) {
      expense = await createLinkedExpense({
        equipment,
        req,
        type: 'maintenance',
        amount: cost,
        vendor: req.body.vendor,
        paymentMethod: req.body.payment_method,
        receiptNumber: req.body.receipt_number,
        description: req.body.description || `Equipment maintenance for ${equipment.equipment_name}`,
        sourceId: equipment._id
      });
      if (expense) record.expense_id = expense._id;
    }

    equipment.maintenance_records.push(record);
    if (req.body.after_condition) equipment.condition_status = req.body.after_condition;
    if (req.body.operational_status) equipment.operational_status = req.body.operational_status;
    if (req.body.next_due_date) equipment.next_maintenance_due = req.body.next_due_date;
    equipment.updated_by = getUserId(req);
    await equipment.save();

    res.status(201).json({ message: 'Maintenance record added', equipment, expense });
  } catch (error) {
    console.error('Maintenance record error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getMaintenanceRecords = async (req, res) => {
  try {
    const filter = await buildHospitalFilter(req, { is_active: true });
    if (req.query.equipment_id && isValidObjectId(req.query.equipment_id)) filter._id = new mongoose.Types.ObjectId(req.query.equipment_id);

    const rows = await HospitalEquipment.aggregate([
      { $match: filter },
      { $unwind: '$maintenance_records' },
      { $sort: { 'maintenance_records.maintenance_date': -1 } },
      { $limit: Math.min(500, parseInt(req.query.limit || '100', 10)) },
      {
        $project: {
          equipment_id: '$_id',
          asset_code: '$asset_code',
          equipment_name: '$equipment_name',
          category: '$category',
          department: '$department',
          location: '$location',
          record: '$maintenance_records'
        }
      }
    ]);

    res.json({ maintenance: rows });
  } catch (error) {
    console.error('Get maintenance records error:', error);
    res.status(500).json({ error: 'Failed to fetch maintenance records', details: error.message });
  }
};

exports.equipmentLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const allowed = ['equipment_manager', 'admin', 'mediqliq_super_admin'];
    if (!allowed.includes(user.role)) {
      return res.status(403).json({ error: 'This account does not have equipment dashboard access' });
    }

    return res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      dashboard: 'equipment',
      token: generateToken(user._id, user.role)
    });
  } catch (error) {
    console.error('Equipment login error:', error);
    res.status(500).json({ error: error.message });
  }
};
