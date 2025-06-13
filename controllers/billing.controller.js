const Bill = require('../models/Bill');
const BillItem = require('../models/BillItem');

// Create a bill with items
exports.createBill = async (req, res) => {
  try {
    const { patient_id, appointment_id, payment_method, items } = req.body;

    const total_amount = items.reduce((sum, item) => sum + item.amount, 0);

    const bill = new Bill({ patient_id, appointment_id, total_amount, payment_method });
    await bill.save();

    const billItems = await Promise.all(
      items.map(item => BillItem.create({ ...item, bill_id: bill._id }))
    );

    res.status(201).json({ bill, items: billItems });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all bills
exports.getAllBills = async (req, res) => {
  try {
    const bills = await Bill.find()
      .populate('patient_id')
      .populate('appointment_id');
    res.json(bills);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get bill by ID
exports.getBillById = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate('patient_id')
      .populate('appointment_id');
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const items = await BillItem.find({ bill_id: bill._id });
    res.json({ bill, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update bill status
exports.updateBillStatus = async (req, res) => {
  try {
    const bill = await Bill.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    res.json(bill);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete bill
exports.deleteBill = async (req, res) => {
  try {
    const bill = await Bill.findByIdAndDelete(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    await BillItem.deleteMany({ bill_id: bill._id });

    res.json({ message: 'Bill and items deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
