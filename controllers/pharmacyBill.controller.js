const Bill = require('../models/Bill');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');

exports.getPatientPharmacyBills = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { startDate, endDate, status, page = 1, limit = 20 } = req.query;

    const filter = {
      patient_id: patientId,
      is_pharmacy_bill: true
    };

    if (status) filter.status = status;
    if (startDate && endDate) {
      filter.generated_at = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const bills = await Bill.find(filter)
      .populate('invoice_id', 'invoice_number status total payment_history')
      .populate('sale_id', 'sale_number items')
      .populate('created_by', 'name')
      .sort({ generated_at: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Bill.countDocuments(filter);

    // Calculate summary
    const summary = await Bill.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$total_amount' },
          totalPaid: { $sum: '$paid_amount' },
          totalDue: { $sum: '$balance_due' },
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      success: true,
      bills,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      summary: summary[0] || { totalAmount: 0, totalPaid: 0, totalDue: 0, count: 0 }
    });
  } catch (err) {
    console.error('Error fetching patient pharmacy bills:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getPharmacyBillById = async (req, res) => {
  try {
    const { billId } = req.params;

    const bill = await Bill.findById(billId)
      .populate('patient_id', 'first_name last_name patientId uhid phone address')
      .populate('admission_id', 'admissionNumber shipNumber status admissionDate')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('invoice_id', 'invoice_number status total payment_history medicine_items')
      .populate('sale_id', 'sale_number items payments payment_method')
      .populate('items.medicine_id', 'name composition hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .populate('created_by', 'name');

    if (!bill) {
      return res.status(404).json({ error: 'Pharmacy bill not found' });
    }

    // Get related returns
    const PharmacyReturn = require('../models/PharmacyReturn');
    const returns = await PharmacyReturn.find({ originalSaleId: bill.sale_id?._id || bill.sale_id });

    res.json({
      success: true,
      bill,
      returns
    });
  } catch (err) {
    console.error('Error fetching pharmacy bill:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updatePharmacyBillPayment = async (req, res) => {
  try {
    const { billId } = req.params;
    const { amount, payment_method, reference, notes } = req.body;

    const bill = await Bill.findById(billId);
    if (!bill) {
      return res.status(404).json({ error: 'Pharmacy bill not found' });
    }

    if (bill.status === 'Paid') {
      return res.status(400).json({ error: 'Bill is already fully paid' });
    }

    const newPaidAmount = bill.paid_amount + amount;
    const newBalanceDue = bill.total_amount - newPaidAmount;

    bill.paid_amount = newPaidAmount;
    bill.balance_due = Math.max(0, newBalanceDue);
    
    if (bill.payments) {
      bill.payments.push({
        method: payment_method,
        amount: amount,
        reference: reference,
        date: new Date()
      });
    } else {
      bill.payments = [{
        method: payment_method,
        amount: amount,
        reference: reference,
        date: new Date()
      }];
    }

    if (newPaidAmount >= bill.total_amount) {
      bill.status = 'Paid';
      bill.paid_at = new Date();
    } else if (newPaidAmount > 0) {
      bill.status = 'Partially Paid';
    }

    await bill.save();

    // Update associated invoice
    if (bill.invoice_id) {
      const invoice = await Invoice.findById(bill.invoice_id);
      if (invoice) {
        invoice.amount_paid = (invoice.amount_paid || 0) + amount;
        invoice.balance_due = invoice.total - invoice.amount_paid;
        
        invoice.payment_history.push({
          amount: amount,
          method: payment_method,
          reference: reference,
          date: new Date(),
          status: 'Completed',
          collected_by: req.user?._id
        });
        
        if (invoice.amount_paid >= invoice.total) {
          invoice.status = 'Paid';
        } else if (invoice.amount_paid > 0) {
          invoice.status = 'Partial';
        }
        
        await invoice.save();
      }
    }

    // Update associated sale
    if (bill.sale_id) {
      const sale = await Sale.findById(bill.sale_id);
      if (sale) {
        sale.amount_paid = (sale.amount_paid || 0) + amount;
        sale.balance_due = sale.total_amount - sale.amount_paid;
        if (sale.amount_paid >= sale.total_amount) {
          sale.status = 'Completed';
        } else if (sale.amount_paid > 0) {
          sale.status = 'Pending';
        }
        await sale.save();
      }
    }

    // Update patient outstanding balance
    if (bill.patient_id) {
      await Patient.findByIdAndUpdate(bill.patient_id, {
        $inc: { pharmacy_outstanding_balance: -amount }
      });
    }

    // Create ledger entry
    await PharmacyLedgerEntry.create({
      entryType: 'OUTSTANDING_PAYMENT',
      direction: 'IN',
      amount: amount,
      paymentMethod: payment_method,
      patientId: bill.patient_id,
      admissionId: bill.admission_id,
      saleId: bill.sale_id,
      invoiceId: bill.invoice_id,
      billId: bill._id,
      notes: notes || `Payment received for bill ${bill._id}`,
      createdBy: req.user?._id
    });

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      bill: {
        _id: bill._id,
        paid_amount: bill.paid_amount,
        balance_due: bill.balance_due,
        status: bill.status
      }
    });
  } catch (err) {
    console.error('Error updating pharmacy bill payment:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.voidPharmacyBill = async (req, res) => {
  try {
    const { billId } = req.params;
    const { reason } = req.body;

    const bill = await Bill.findById(billId);
    if (!bill) {
      return res.status(404).json({ error: 'Pharmacy bill not found' });
    }

    if (bill.status === 'Cancelled') {
      return res.status(400).json({ error: 'Bill is already cancelled' });
    }

    bill.status = 'Cancelled';
    bill.notes = bill.notes ? `${bill.notes}\n[CANCELLED] ${new Date().toISOString()}: ${reason || 'No reason provided'}` : `[CANCELLED] ${new Date().toISOString()}: ${reason || 'No reason provided'}`;
    await bill.save();

    // Restore patient outstanding balance if the bill was unpaid
    if (bill.balance_due > 0 && bill.patient_id) {
      await Patient.findByIdAndUpdate(bill.patient_id, {
        $inc: { pharmacy_outstanding_balance: -bill.balance_due }
      });
    }

    res.json({
      success: true,
      message: 'Pharmacy bill cancelled successfully',
      bill: {
        _id: bill._id,
        status: bill.status
      }
    });
  } catch (err) {
    console.error('Error voiding pharmacy bill:', err);
    res.status(500).json({ error: err.message });
  }
};