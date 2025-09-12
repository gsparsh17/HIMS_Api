const Bill = require('../models/Bill');
const BillItem = require('../models/BillItem');
const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');

// Create a bill with items
// exports.createBill = async (req, res) => {
//   try {
//     const { patient_id, appointment_id, payment_method, items, status = 'Pending' } = req.body;

//     // Calculate total amount
//     const total_amount = items.reduce((sum, item) => sum + item.amount, 0);

//     // Create the bill
//     const bill = new Bill({ 
//       patient_id, 
//       appointment_id, 
//       total_amount, 
//       payment_method,
//       status,
//       details: items // Store the items in the bill document as well
//     });
    
//     await bill.save();

//     // Create bill items and associate them with the bill
//     const billItems = await Promise.all(
//       items.map(item => {
//         const billItem = new BillItem({ 
//           ...item, 
//           bill_id: bill._id 
//         });
//         return billItem.save();
//       })
//     );

//     // Update the bill with the item references if needed
//     bill.items = billItems.map(item => item._id);
//     await bill.save();

//     // Populate the response with patient and appointment details
//     const populatedBill = await Bill.findById(bill._id)
//       .populate('patient_id', 'first_name last_name patientId')
//       .populate('appointment_id', 'appointment_date type')
//       .populate('items');

//     res.status(201).json({ 
//       message: 'Bill created successfully',
//       bill: populatedBill,
//       items: billItems 
//     });
//   } catch (err) {
//     console.error('Error creating bill:', err);
//     res.status(400).json({ error: err.message });
//   }
// };

exports.createBill = async (req, res) => {
  try {
    const { patient_id, appointment_id, payment_method, items, status = 'Pending', total_amount } = req.body;

    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.amount), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    // const total_amount = subtotal + tax;

    // Create the bill
    const bill = new Bill({ 
      patient_id, 
      appointment_id, 
      total_amount, 
      payment_method,
      status,
      details: items,
      // created_by: req.user._id
    });
    
    await bill.save();

    // Get appointment details for invoice
    const appointment = await Appointment.findById(appointment_id)
      .populate('patient_id')
      .populate('doctor_id');

    // Create invoice for the bill
    const invoice = new Invoice({
      invoice_type: 'Appointment',
      patient_id: patient_id,
      customer_type: 'Patient',
      customer_name: appointment?.patient_id ? 
        `${appointment.patient_id.first_name} ${appointment.patient_id.last_name}` : 
        'Patient',
      customer_phone: appointment?.patient_id?.phone,
      appointment_id: appointment_id,
      bill_id: bill._id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      service_items: items.map(item => ({
        description: item.description,
        // quantity: item.quantity,
        // unit_price: item.unit_price,
        total_price: item.amount,
        // tax_rate: item.tax_rate || 0,
        // tax_amount: item.tax_amount || 0,
        service_type: item.service_type || 'Consultation'
      })),
      subtotal: subtotal,
      tax: tax,
      total: total_amount,
      status: payment_method !== 'Pending' ? 'Paid' : 'Issued',
      payment_method: payment_method,
      amount_paid: payment_method !== 'Pending' ? total_amount : 0,
      balance_due: payment_method !== 'Pending' ? 0 : total_amount,
      notes: `Appointment Bill - ${appointment?.appointment_date?.toLocaleDateString() || ''}`,
      // created_by: req.user._id
    });

    await invoice.save();

    // Update bill with invoice reference
    bill.invoice_id = invoice._id;
    await bill.save();

    const populatedBill = await Bill.findById(bill._id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      // .populate('created_by', 'name');

    res.status(201).json({ 
      message: 'Bill created successfully',
      bill: populatedBill,
      invoice: invoice
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
      });

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found for this appointment' });
    }

    // Fetch related items
    // const items = await BillItem.find({ bill_id: bill._id });

    res.json({ bill });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
