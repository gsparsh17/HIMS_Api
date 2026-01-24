const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const mongoose = require('mongoose');

exports.createBill = async (req, res) => {
  try {
    const { 
      patient_id, 
      appointment_id, 
      prescription_id,
      payment_method, 
      items, 
      status = 'Draft', 
      total_amount,
      subtotal,
      tax_amount = 0,
      discount = 0,
      notes
    } = req.body;

    // Validate required fields
    if (!patient_id || !appointment_id || !payment_method) {
      return res.status(400).json({ 
        error: 'Patient ID, Appointment ID, and Payment Method are required' 
      });
    }

    // Calculate totals if not provided
    let calculatedSubtotal = subtotal;
    let calculatedTotal = total_amount;
    
    if (!subtotal || !total_amount) {
      calculatedSubtotal = items.reduce((sum, item) => sum + (item.amount * (item.quantity || 1)), 0);
      calculatedTotal = calculatedSubtotal + (tax_amount || 0) - (discount || 0);
    }

    // Create the bill
    const bill = new Bill({ 
      patient_id, 
      appointment_id,
      prescription_id,
      total_amount: calculatedTotal,
      subtotal: calculatedSubtotal,
      tax_amount: tax_amount || 0,
      discount: discount || 0,
      payment_method,
      status: status === 'Draft' ? 'Draft' : 'Generated',
      items: items.map(item => ({
        description: item.description,
        amount: item.amount,
        quantity: item.quantity || 1,
        item_type: item.item_type || 'Other',
        procedure_code: item.procedure_code,
        prescription_id: item.prescription_id,
        procedure_id: item.procedure_id
      })),
      notes,
      created_by: req.user?._id
    });
    
    await bill.save();

    // If status is not Draft, create invoice
    let invoice = null;
    if (status !== 'Draft') {
      // Get appointment details for invoice
      const appointment = await Appointment.findById(appointment_id)
        .populate('patient_id')
        .populate('doctor_id');

      if (!appointment) {
        throw new Error('Appointment not found');
      }

      // Determine invoice type based on items
      const hasProcedures = items.some(item => item.item_type === 'Procedure');
      const hasMedicines = items.some(item => item.item_type === 'Medicine');
      
      let invoiceType = 'Appointment';
      if (hasProcedures && hasMedicines) {
        invoiceType = 'Mixed';
      } else if (hasProcedures) {
        invoiceType = 'Procedure';
      } else if (hasMedicines) {
        invoiceType = 'Pharmacy';
      }

      // Create invoice items
      const serviceItems = [];
      const medicineItems = [];
      const procedureItems = [];

      items.forEach(item => {
        if (item.item_type === 'Procedure') {
          procedureItems.push({
            procedure_code: item.procedure_code,
            procedure_name: item.description,
            quantity: item.quantity || 1,
            unit_price: item.amount / (item.quantity || 1),
            total_price: item.amount,
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            status: 'Pending',
            scheduled_date: new Date()
          });
        } else if (item.item_type === 'Medicine') {
          medicineItems.push({
            medicine_name: item.description,
            quantity: item.quantity || 1,
            unit_price: item.amount / (item.quantity || 1),
            total_price: item.amount,
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            is_dispensed: false
          });
        } else {
          serviceItems.push({
            description: item.description,
            quantity: item.quantity || 1,
            unit_price: item.amount / (item.quantity || 1),
            total_price: item.amount,
            tax_rate: 0,
            tax_amount: 0,
            service_type: item.item_type,
            prescription_id: item.prescription_id,
            bill_id: bill._id
          });
        }
      });

      // Create invoice
      invoice = new Invoice({
        invoice_type: invoiceType,
        patient_id: patient_id,
        customer_type: 'Patient',
        customer_name: appointment.patient_id ? 
          `${appointment.patient_id.first_name} ${appointment.patient_id.last_name}` : 
          'Patient',
        customer_phone: appointment.patient_id?.phone,
        appointment_id: appointment_id,
        prescription_id: prescription_id,
        bill_id: bill._id,
        issue_date: new Date(),
        due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        service_items: serviceItems,
        medicine_items: medicineItems,
        procedure_items: procedureItems,
        subtotal: calculatedSubtotal,
        tax: tax_amount || 0,
        discount: discount || 0,
        total: calculatedTotal,
        status: payment_method === 'Pending' ? 'Issued' : 'Paid',
        amount_paid: payment_method === 'Pending' ? 0 : calculatedTotal,
        balance_due: payment_method === 'Pending' ? calculatedTotal : 0,
        notes: `Bill for appointment on ${appointment?.appointment_date?.toLocaleDateString() || ''}`,
        created_by: req.user?._id,
        has_procedures: procedureItems.length > 0,
        procedures_status: procedureItems.length > 0 ? 'Pending' : 'None'
      });

      await invoice.save();

      // Update bill with invoice reference
      bill.invoice_id = invoice._id;
      await bill.save();

      // Update prescription procedures billing status if prescription_id exists
      if (prescription_id) {
        const prescription = await Prescription.findById(prescription_id);
        if (prescription && prescription.recommendedProcedures.length > 0) {
          items.forEach(item => {
            if (item.item_type === 'Procedure' && item.procedure_id) {
              const procIndex = prescription.recommendedProcedures.findIndex(
                p => p._id.toString() === item.procedure_id
              );
              if (procIndex !== -1) {
                prescription.recommendedProcedures[procIndex].is_billed = true;
                prescription.recommendedProcedures[procIndex].invoice_id = invoice._id;
                prescription.recommendedProcedures[procIndex].cost = item.amount;
              }
            }
          });
          await prescription.save();
        }
      }
    }

    // Populate response
    const populatedBill = await Bill.findById(bill._id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('invoice_id', 'invoice_number status')
      .populate('created_by', 'name');

    res.status(201).json({ 
      success: true,
      message: 'Bill created successfully',
      bill: populatedBill,
      invoice: invoice
    });
  } catch (err) {
    console.error('Error creating bill:', err);
    res.status(400).json({ error: err.message });
  }
};

// Get bills with procedure items
exports.getAllBills = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      patient_id,
      has_procedures,
      start_date,
      end_date 
    } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (patient_id) filter.patient_id = patient_id;
    
    if (has_procedures === 'true') {
      filter['items.item_type'] = 'Procedure';
    }
    
    if (start_date && end_date) {
      filter.generated_at = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }
    
    const bills = await Bill.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('prescription_id', 'prescription_number')
      .populate('invoice_id', 'invoice_number total')
      .sort({ generated_at: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Bill.countDocuments(filter);
    
    // Calculate statistics
    const totalRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...filter } },
      { $group: { _id: null, total: { $sum: '$total_amount' } } }
    ]);
    
    const procedureRevenue = await Bill.aggregate([
      { 
        $match: { 
          status: 'Paid', 
          'items.item_type': 'Procedure',
          ...filter 
        } 
      },
      { $unwind: '$items' },
      { $match: { 'items.item_type': 'Procedure' } },
      { $group: { _id: null, total: { $sum: '$items.amount' } } }
    ]);

    res.json({
      success: true,
      bills,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      statistics: {
        totalRevenue: totalRevenue[0]?.total || 0,
        procedureRevenue: procedureRevenue[0]?.total || 0,
        totalBills: total
      }
    });
  } catch (err) {
    console.error('Error fetching bills:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get bill by ID
exports.getBillById = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate('patient_id', 'first_name last_name patientId phone address')
      .populate('appointment_id', 'appointment_date type doctor_id department_id')
      .populate('prescription_id', 'prescription_number diagnosis recommendedProcedures')
      .populate('invoice_id')
      .populate('created_by', 'name');
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    // Get related prescription procedures if exists
    let procedures = [];
    if (bill.prescription_id && bill.prescription_id.recommendedProcedures) {
      procedures = bill.prescription_id.recommendedProcedures;
    }

    res.json({
      success: true,
      bill,
      procedures
    });
  } catch (err) {
    console.error('Error fetching bill:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update bill status
exports.updateBillStatus = async (req, res) => {
  try {
    const { 
      status, 
      paid_amount,
      payment_method,
      notes 
    } = req.body;
    
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    // Update bill
    const updateData = {};
    if (status) updateData.status = status;
    if (paid_amount !== undefined) {
      updateData.paid_amount = bill.paid_amount + paid_amount;
      if (status === 'Paid' || updateData.paid_amount >= bill.total_amount) {
        updateData.status = 'Paid';
        updateData.paid_at = new Date();
      } else if (updateData.paid_amount > 0) {
        updateData.status = 'Partially Paid';
      }
    }
    if (payment_method) updateData.payment_method = payment_method;
    if (notes) updateData.notes = notes;

    const updatedBill = await Bill.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).populate('patient_id appointment_id invoice_id');

    // Update related invoice if exists
    if (updatedBill.invoice_id) {
      const invoice = await Invoice.findById(updatedBill.invoice_id);
      if (invoice) {
        if (paid_amount !== undefined) {
          invoice.amount_paid += paid_amount;
          invoice.balance_due = invoice.total - invoice.amount_paid;
          
          // Add payment to history
          invoice.payment_history.push({
            amount: paid_amount,
            method: payment_method || bill.payment_method,
            date: new Date(),
            status: 'Completed',
            collected_by: req.user?._id
          });

          // Update invoice status
          if (invoice.amount_paid >= invoice.total) {
            invoice.status = 'Paid';
          } else if (invoice.amount_paid > 0) {
            invoice.status = 'Partial';
          }
          
          await invoice.save();
        }
        
        // Update invoice status if bill status changed
        if (status === 'Paid' && invoice.status !== 'Paid') {
          invoice.status = 'Paid';
          invoice.amount_paid = invoice.total;
          invoice.balance_due = 0;
          await invoice.save();
        }
      }
    }

    res.json({
      success: true,
      message: 'Bill status updated successfully',
      bill: updatedBill
    });
  } catch (err) {
    console.error("Error updating bill status:", err);
    res.status(400).json({ error: err.message });
  }
};

// Generate bill for procedures
exports.generateProcedureBill = async (req, res) => {
  try {
    const { 
      prescription_id, 
      procedure_ids, 
      additional_items = [] 
    } = req.body;

    const prescription = await Prescription.findById(prescription_id)
      .populate('patient_id')
      .populate('doctor_id')
      .populate('appointment_id');
    
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    // Filter selected procedures
    const selectedProcedures = prescription.recommendedProcedures.filter(proc => 
      procedure_ids.includes(proc._id.toString())
    );

    if (selectedProcedures.length === 0) {
      return res.status(400).json({ error: 'No procedures selected' });
    }

    // Create bill items from procedures
    const procedureItems = selectedProcedures.map(proc => ({
      description: `${proc.procedure_code} - ${proc.procedure_name}`,
      amount: proc.cost || 0, // Use stored cost or default to 0
      quantity: 1,
      item_type: 'Procedure',
      procedure_code: proc.procedure_code,
      prescription_id: prescription._id,
      procedure_id: proc._id
    }));

    // Add additional items if any
    const allItems = [...procedureItems, ...additional_items];

    // Calculate totals
    const subtotal = allItems.reduce((sum, item) => sum + (item.amount * (item.quantity || 1)), 0);
    const tax = 0; // Calculate tax if needed
    const total = subtotal + tax;

    // Create bill
    const bill = new Bill({
      patient_id: prescription.patient_id._id,
      appointment_id: prescription.appointment_id?._id,
      prescription_id: prescription._id,
      total_amount: total,
      subtotal: subtotal,
      tax_amount: tax,
      payment_method: 'Pending',
      items: allItems,
      status: 'Generated',
      notes: `Procedure bill for prescription ${prescription.prescription_number}`,
      created_by: req.user?._id
    });

    await bill.save();

    // Create invoice
    const invoice = new Invoice({
      invoice_type: 'Procedure',
      patient_id: prescription.patient_id._id,
      customer_type: 'Patient',
      customer_name: `${prescription.patient_id.first_name} ${prescription.patient_id.last_name}`,
      customer_phone: prescription.patient_id.phone,
      appointment_id: prescription.appointment_id?._id,
      prescription_id: prescription._id,
      bill_id: bill._id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      procedure_items: selectedProcedures.map(proc => ({
        procedure_code: proc.procedure_code,
        procedure_name: proc.procedure_name,
        quantity: 1,
        unit_price: proc.cost || 0,
        total_price: proc.cost || 0,
        prescription_id: prescription._id,
        status: proc.status,
        scheduled_date: proc.scheduled_date
      })),
      subtotal: subtotal,
      tax: tax,
      total: total,
      status: 'Issued',
      amount_paid: 0,
      balance_due: total,
      notes: `Invoice for procedures from prescription ${prescription.prescription_number}`,
      created_by: req.user?._id,
      has_procedures: true,
      procedures_status: 'Pending'
    });

    await invoice.save();

    // Update bill with invoice reference
    bill.invoice_id = invoice._id;
    await bill.save();

    // Update procedures billing status
    selectedProcedures.forEach(proc => {
      const procIndex = prescription.recommendedProcedures.findIndex(
        p => p._id.toString() === proc._id.toString()
      );
      if (procIndex !== -1) {
        prescription.recommendedProcedures[procIndex].is_billed = true;
        prescription.recommendedProcedures[procIndex].invoice_id = invoice._id;
        if (!prescription.recommendedProcedures[procIndex].cost && proc.cost) {
          prescription.recommendedProcedures[procIndex].cost = proc.cost;
        }
      }
    });

    await prescription.save();

    // Populate response
    const populatedBill = await Bill.findById(bill._id)
      .populate('patient_id', 'first_name last_name')
      .populate('appointment_id', 'appointment_date')
      .populate('prescription_id', 'prescription_number')
      .populate('invoice_id', 'invoice_number');

    res.status(201).json({
      success: true,
      message: 'Procedure bill generated successfully',
      bill: populatedBill,
      invoice,
      procedures_billed: selectedProcedures.length
    });
  } catch (err) {
    console.error('Error generating procedure bill:', err);
    res.status(400).json({ error: err.message });
  }
};

// Get bill by appointment_id
exports.getBillByAppointmentId = async (req, res) => {
  try {
    const { appointmentId } = req.params;

    const bill = await Bill.findOne({ appointment_id: appointmentId })
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type doctor_id department_id')
      .populate('prescription_id', 'prescription_number diagnosis recommendedProcedures')
      .populate('invoice_id', 'invoice_number status total')
      .populate({
        path: 'appointment_id',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName' },
          { path: 'department_id', select: 'name' }
        ]
      });

    if (!bill) {
      return res.status(404).json({ 
        success: false,
        error: 'Bill not found for this appointment' 
      });
    }

    res.json({
      success: true,
      bill
    });
  } catch (err) {
    console.error('Error fetching bill by appointment:', err);
    res.status(500).json({ error: err.message });
  }
};

// Delete bill
exports.deleteBill = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    // Check if bill can be deleted
    if (bill.status === 'Paid') {
      return res.status(400).json({ 
        error: 'Cannot delete a paid bill. Please refund instead.' 
      });
    }

    // Delete related invoice if exists
    if (bill.invoice_id) {
      await Invoice.findByIdAndDelete(bill.invoice_id);
    }

    // Update prescription procedures billing status if needed
    if (bill.prescription_id) {
      const prescription = await Prescription.findById(bill.prescription_id);
      if (prescription) {
        // Reset billing status for procedures in this bill
        bill.items.forEach(item => {
          if (item.item_type === 'Procedure' && item.procedure_id) {
            const procIndex = prescription.recommendedProcedures.findIndex(
              p => p._id.toString() === item.procedure_id
            );
            if (procIndex !== -1) {
              prescription.recommendedProcedures[procIndex].is_billed = false;
              prescription.recommendedProcedures[procIndex].invoice_id = null;
            }
          }
        });
        await prescription.save();
      }
    }

    await Bill.findByIdAndDelete(req.params.id);

    res.json({ 
      success: true,
      message: 'Bill deleted successfully' 
    });
  } catch (err) {
    console.error('Error deleting bill:', err);
    res.status(500).json({ error: err.message });
  }
};