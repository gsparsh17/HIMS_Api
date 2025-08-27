const Bill = require('../models/Bill');
const BillItem = require('../models/BillItem');

// Create a bill with items
exports.createBill = async (req, res) => {
  try {
    const { patient_id, appointment_id, payment_method, items, status = 'Pending' } = req.body;

    // Calculate total amount
    const total_amount = items.reduce((sum, item) => sum + item.amount, 0);

    // Create the bill
    const bill = new Bill({ 
      patient_id, 
      appointment_id, 
      total_amount, 
      payment_method,
      status,
      details: items // Store the items in the bill document as well
    });
    
    await bill.save();

    // Create bill items and associate them with the bill
    const billItems = await Promise.all(
      items.map(item => {
        const billItem = new BillItem({ 
          ...item, 
          bill_id: bill._id 
        });
        return billItem.save();
      })
    );

    // Update the bill with the item references if needed
    bill.items = billItems.map(item => item._id);
    await bill.save();

    // Populate the response with patient and appointment details
    const populatedBill = await Bill.findById(bill._id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('items');

    res.status(201).json({ 
      message: 'Bill created successfully',
      bill: populatedBill,
      items: billItems 
    });
  } catch (err) {
    console.error('Error creating bill:', err);
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

// Get bill by appointment_id
exports.getBillByAppointmentId = async (req, res) => {
  try {
    const { appointmentId } = req.params;

    // Find the bill for the given appointment_id
    const bill = await Bill.findOne({ appointment_id: appointmentId })
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type doctor_id department_id')
      .populate({
        path: 'appointment_id',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName' },
          { path: 'department_id', select: 'name' }
        ]
      })
      .populate('items');;

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found for this appointment' });
    }

    // Fetch related items
    const items = await BillItem.find({ bill_id: bill._id });

    res.json({ bill, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
