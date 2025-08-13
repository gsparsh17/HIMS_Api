const Invoice = require('../models/Invoice');

// Get all invoices (for the list page)
exports.getAllInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find().populate('patient_id', 'first_name last_name');
    res.status(200).json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get a single invoice by ID
exports.getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id).populate('patient_id', 'first_name last_name');
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.status(200).json(invoice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Record a new payment for an invoice
exports.recordPayment = async (req, res) => {
    try {
        const { amount, method, reference } = req.body;
        const invoice = await Invoice.findById(req.params.id);

        if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

        // Add payment to history
        invoice.paymentHistory.push({ amount, method, reference });

        // Update amount paid
        invoice.amountPaid += Number(amount);

        // Update status
        if (invoice.amountPaid >= invoice.total) {
            invoice.status = 'Paid';
        } else {
            invoice.status = 'Partial';
        }

        await invoice.save();
        res.status(200).json(invoice);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Add this function to billingPharmacy.controller.js

// Create a new invoice
exports.createInvoice = async (req, res) => {
  try {
    const { patient_id, dueDate, services, subtotal, tax, total } = req.body;

    // Generate a unique invoice number
    const lastInvoice = await Invoice.findOne().sort({ createdAt: -1 });
    let newInvoiceNumber = 'INV-0001';
    if (lastInvoice && lastInvoice.invoiceNumber) {
      const lastNum = parseInt(lastInvoice.invoiceNumber.split('-')[1]);
      newInvoiceNumber = `INV-${String(lastNum + 1).padStart(4, '0')}`;
    }

    const newInvoice = new Invoice({
      invoiceNumber: newInvoiceNumber,
      patient_id,
      dueDate,
      services,
      subtotal,
      tax,
      total,
      status: 'Pending', // Invoices start as pending
    });

    await newInvoice.save();
    res.status(201).json(newInvoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};