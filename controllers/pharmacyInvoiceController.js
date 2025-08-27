const PharmacyInvoice = require('../models/pharmacyInvoiceModel');
const Medicine = require('../models/Medicine');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit'); // ADD: Import pdfkit
const Prescription = require('../models/Prescription');

const createInvoiceAndHandleStock = async (req, res) => {
  // ADDED: Receive the prescription_id
  const { prescription_id, patient_id, doctor_id, items, total_amount, payment_mode } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: 'Invoice must contain at least one item.' });
  }

  try {
    // 1. Create the new invoice
    const invoice = new PharmacyInvoice({
      patient_id,
      doctor_id,
      items,
      total_amount,
      payment_mode,
    });
    const createdInvoice = await invoice.save();

    // 2. Update the stock for each medicine sold
    for (const item of items) {
      await Medicine.updateOne(
        { _id: item.medicine_id },
        { $inc: { stock_quantity: -item.quantity } }
      );
    }

    // 3. ADDED: Delete the original prescription
    if (prescription_id) {
        await Prescription.findByIdAndDelete(prescription_id);
    }
    
    res.status(201).json(createdInvoice);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server Error: Could not process invoice.' });
  }
};


const downloadInvoicePDF = async (req, res) => {
  try {
    const invoice = await PharmacyInvoice.findById(req.params.id).populate('patient_id');
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found.' });
    }

    const doc = new PDFDocument({ margin: 50 });

    // Set response headers to trigger download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice._id}.pdf`);

    // Pipe the PDF document directly to the response stream
    doc.pipe(res);

    // --- Add Content to the PDF ---
    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('Pharmacy Invoice', { align: 'center' });
    doc.moveDown();

    // Patient & Invoice Details
    doc.fontSize(12).font('Helvetica');
    doc.text(`Invoice ID: ${invoice._id}`);
    doc.text(`Patient: ${invoice.patient_id.first_name} ${invoice.patient_id.last_name}`);
    doc.text(`Date: ${new Date(invoice.createdAt).toLocaleDateString()}`);
    doc.moveDown(2);

    // Table Header
    const tableTop = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('Medicine', 50, tableTop);
    doc.text('Qty', 300, tableTop, { width: 90, align: 'right' });
    doc.text('Price', 400, tableTop, { width: 90, align: 'right' });
    doc.font('Helvetica');
    doc.moveDown();
    
    // Table Rows
    invoice.items.forEach(item => {
      const y = doc.y;
      doc.text(item.name, 50, y);
      doc.text(item.quantity, 300, y, { width: 90, align: 'right' });
      doc.text(`$${item.price.toFixed(2)}`, 400, y, { width: 90, align: 'right' });
      doc.moveDown();
    });
    
    // Total
    doc.font('Helvetica-Bold').fontSize(14);
    doc.text(`Total: $${invoice.total_amount.toFixed(2)}`, 300, doc.y + 20, { align: 'right' });

    // Finalize the PDF and end the stream
    doc.end();

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server Error: Could not generate PDF.' });
  }
};


const getAllPharmacyInvoices = async (req, res) => {
  try {
    const invoices = await PharmacyInvoice.find({})
      .populate('patient_id', 'first_name last_name') // Get patient's name
      .sort({ createdAt: -1 }); // Show newest first
    res.status(200).json(invoices);
  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not fetch invoices.' });
  }
};

const getPharmacyInvoiceById = async (req, res) => {
  try {
    const invoice = await PharmacyInvoice.findById(req.params.id)
      .populate('patient_id') // Get full patient details
      .populate('doctor_id', 'first_name last_name'); // Get doctor's name

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found.' });
    }
    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not fetch invoice details.' });
  }
};


const getMonthlyRevenue = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const result = await PharmacyInvoice.aggregate([
      {
        $match: {
          status: 'Paid',
          createdAt: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total_amount' }
        }
      }
    ]);

    const totalRevenue = result.length > 0 ? result[0].totalRevenue : 0;
    res.status(200).json({ totalRevenue });

  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not calculate revenue.' });
  }
};

module.exports = {
  createInvoiceAndHandleStock,
  downloadInvoicePDF,
  getAllPharmacyInvoices,    // ADDED export
  getPharmacyInvoiceById,    // ADDED export
  getMonthlyRevenue,
};
