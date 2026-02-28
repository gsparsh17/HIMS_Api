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

    console.log('Creating bill with data:', req.body);

    // Validate required fields
    if (!patient_id || !appointment_id || !payment_method) {
      return res.status(400).json({
        error: 'Patient ID, Appointment ID, and Payment Method are required'
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one bill item is required' });
    }

    // Calculate totals if not provided
    let calculatedSubtotal = subtotal;
    let calculatedTotal = total_amount;

    if (!subtotal || !total_amount) {
      calculatedSubtotal = items.reduce((sum, item) => sum + (Number(item.amount || 0) * (item.quantity || 1)), 0);
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
      status,
      items: items.map(item => ({
        description: item.description,
        amount: Number(item.amount || 0),
        quantity: item.quantity || 1,
        item_type: item.item_type || 'Other',

        // Procedure fields
        procedure_code: item.procedure_code,
        procedure_id: item.procedure_id,

        // Lab test fields
        lab_test_code: item.lab_test_code,
        lab_test_id: item.lab_test_id,

        // Common
        prescription_id: item.prescription_id
      })),
      notes,
      created_by: req.user?._id
    });

    await bill.save();

    // Only create invoice if status is 'Paid' (not for Draft, Pending, or Partially Paid)
    let invoice = null;
    // if (status === 'Paid') {
      // Get appointment details for invoice
      const appointment = await Appointment.findById(appointment_id)
        .populate('patient_id')
        .populate('doctor_id');

      if (!appointment) {
        throw new Error('Appointment not found');
      }

      // Determine invoice type based on items
      const hasProcedures = items.some(item => item.item_type === 'Procedure');
      const hasLabTests = items.some(item => item.item_type === 'Lab Test');
      const hasMedicines = items.some(item => item.item_type === 'Medicine');

      let invoiceType = 'Appointment';
      if (hasMedicines && (hasProcedures || hasLabTests)) {
        invoiceType = 'Mixed';
      } else if (hasProcedures) {
        invoiceType = 'Procedure';
      } else if (hasLabTests) {
        invoiceType = 'Lab Test';
      } else if (hasMedicines) {
        invoiceType = 'Pharmacy';
      }

      // Create invoice items
      const serviceItems = [];
      const medicineItems = [];
      const procedureItems = [];
      const labTestItems = [];

      items.forEach(item => {
        const qty = item.quantity || 1;
        const unitPrice = qty > 0 ? (Number(item.amount || 0) / qty) : Number(item.amount || 0);

        if (item.item_type === 'Procedure') {
          procedureItems.push({
            procedure_code: item.procedure_code,
            procedure_name: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            status: 'Paid',
            scheduled_date: new Date()
          });
        } else if (item.item_type === 'Lab Test') {
          labTestItems.push({
            lab_test_code: item.lab_test_code,
            lab_test_name: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            status: 'Paid',
            scheduled_date: new Date()
          });
        } else if (item.item_type === 'Medicine') {
          medicineItems.push({
            medicine_name: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            is_dispensed: false
          });
        } else {
          serviceItems.push({
            description: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            service_type: item.item_type,
            prescription_id: item.prescription_id,
            bill_id: bill._id,

            // optional codes
            procedure_code: item.procedure_code,
            lab_test_code: item.lab_test_code
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
        due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),

        service_items: serviceItems,
        medicine_items: medicineItems,
        procedure_items: procedureItems,
        lab_test_items: labTestItems,

        subtotal: calculatedSubtotal,
        tax: tax_amount || 0,
        discount: discount || 0,
        total: calculatedTotal,
        amount_paid: status === 'Paid' ? calculatedTotal : 0,
        balance_due: 0,
        method: payment_method,
        status: status === 'Paid' ? 'Paid' : 'Pending',
        notes: `Bill for appointment on ${appointment?.appointment_date?.toLocaleDateString() || ''}`,
        created_by: req.user?._id,

        has_procedures: procedureItems.length > 0,
        procedures_status: procedureItems.length > 0 ? 'Paid' : 'None',

        has_lab_tests: labTestItems.length > 0,
        lab_tests_status: labTestItems.length > 0 ? 'Paid' : 'None'
      });

      await invoice.save();

      // Update bill with invoice reference
      bill.invoice_id = invoice._id;
      await bill.save();

      // Update prescription billing status for procedures/labtests if prescription_id exists
      if (prescription_id) {
        const prescription = await Prescription.findById(prescription_id);

        if (prescription) {
          // Procedures
          if (prescription.recommendedProcedures?.length > 0) {
            items.forEach(item => {
              if (item.item_type === 'Procedure' && item.procedure_id) {
                const procIndex = prescription.recommendedProcedures.findIndex(
                  p => p._id.toString() === item.procedure_id
                );
                if (procIndex !== -1) {
                  prescription.recommendedProcedures[procIndex].is_billed = true;
                  prescription.recommendedProcedures[procIndex].invoice_id = invoice._id;
                  prescription.recommendedProcedures[procIndex].cost = Number(item.amount || 0);
                  prescription.recommendedProcedures[procIndex].status = 'Paid';
                }
              }
            });
          }

          // Lab Tests
          if (prescription.recommendedLabTests?.length > 0) {
            items.forEach(item => {
              if (item.item_type === 'Lab Test' && item.lab_test_id) {
                const testIndex = prescription.recommendedLabTests.findIndex(
                  t => t._id.toString() === item.lab_test_id
                );
                if (testIndex !== -1) {
                  prescription.recommendedLabTests[testIndex].is_billed = true;
                  prescription.recommendedLabTests[testIndex].invoice_id = invoice._id;
                  prescription.recommendedLabTests[testIndex].cost = Number(item.amount || 0);
                  prescription.recommendedLabTests[testIndex].status = 'Paid';
                }
              }
            });
          }

          await prescription.save();
        }
      }
    // }

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

exports.updateBillStatus = async (req, res) => {
  try {
    const { status, paid_amount, payment_method, notes } = req.body;

    const bill = await Bill.findById(req.params.id)
      .populate('patient_id')
      .populate('appointment_id');
      
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const updateData = {};
    const oldStatus = bill.status;
    
    if (status) updateData.status = status;

    // Handle payment
    if (paid_amount !== undefined) {
      updateData.paid_amount = (bill.paid_amount || 0) + paid_amount;
      
      // Check if fully paid
      if (updateData.paid_amount >= bill.total_amount) {
        updateData.status = 'Paid';
        updateData.paid_at = new Date();
      } else if (updateData.paid_amount > 0) {
        updateData.status = 'Partially Paid';
      }
    }

    if (payment_method) updateData.payment_method = payment_method;
    if (notes) {
      updateData.notes = bill.notes 
        ? `${bill.notes}\n${new Date().toLocaleDateString()}: ${notes}`
        : `${new Date().toLocaleDateString()}: ${notes}`;
    }

    const updatedBill = await Bill.findByIdAndUpdate(req.params.id, updateData, { new: true })
      .populate('patient_id appointment_id invoice_id');

    // Check if we need to create/update invoice
    const newStatus = updatedBill.status;
    const isBecomingPaid = newStatus === 'Paid' && oldStatus !== 'Paid';
    
    // Create invoice if bill becomes Paid and doesn't have one
    if (isBecomingPaid && !updatedBill.invoice_id) {
      // Get appointment details for invoice
      const appointment = await Appointment.findById(updatedBill.appointment_id)
        .populate('patient_id')
        .populate('doctor_id');

      if (!appointment) {
        throw new Error('Appointment not found');
      }

      // Determine invoice type based on items
      const hasProcedures = updatedBill.items.some(item => item.item_type === 'Procedure');
      const hasLabTests = updatedBill.items.some(item => item.item_type === 'Lab Test');
      const hasMedicines = updatedBill.items.some(item => item.item_type === 'Medicine');

      let invoiceType = 'Appointment';
      if (hasMedicines && (hasProcedures || hasLabTests)) {
        invoiceType = 'Mixed';
      } else if (hasProcedures) {
        invoiceType = 'Procedure';
      } else if (hasLabTests) {
        invoiceType = 'Lab Test';
      } else if (hasMedicines) {
        invoiceType = 'Pharmacy';
      }

      // Create invoice items
      const serviceItems = [];
      const medicineItems = [];
      const procedureItems = [];
      const labTestItems = [];

      updatedBill.items.forEach(item => {
        const qty = item.quantity || 1;
        const unitPrice = qty > 0 ? (Number(item.amount || 0) / qty) : Number(item.amount || 0);

        if (item.item_type === 'Procedure') {
          procedureItems.push({
            procedure_code: item.procedure_code,
            procedure_name: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            status: 'Paid',
            scheduled_date: new Date()
          });
        } else if (item.item_type === 'Lab Test') {
          labTestItems.push({
            lab_test_code: item.lab_test_code,
            lab_test_name: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            status: 'Paid',
            scheduled_date: new Date()
          });
        } else if (item.item_type === 'Medicine') {
          medicineItems.push({
            medicine_name: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            prescription_id: item.prescription_id,
            is_dispensed: false
          });
        } else {
          serviceItems.push({
            description: item.description,
            quantity: qty,
            unit_price: unitPrice,
            total_price: Number(item.amount || 0),
            tax_rate: 0,
            tax_amount: 0,
            service_type: item.item_type,
            prescription_id: item.prescription_id,
            bill_id: updatedBill._id,
            procedure_code: item.procedure_code,
            lab_test_code: item.lab_test_code
          });
        }
      });

      // Create invoice
      const invoice = new Invoice({
        invoice_type: invoiceType,
        patient_id: updatedBill.patient_id._id,
        customer_type: 'Patient',
        customer_name: updatedBill.patient_id ?
          `${updatedBill.patient_id.first_name} ${updatedBill.patient_id.last_name}` :
          'Patient',
        customer_phone: updatedBill.patient_id?.phone,
        appointment_id: updatedBill.appointment_id,
        prescription_id: updatedBill.prescription_id,
        bill_id: updatedBill._id,
        issue_date: new Date(),
        due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),

        service_items: serviceItems,
        medicine_items: medicineItems,
        procedure_items: procedureItems,
        lab_test_items: labTestItems,

        subtotal: updatedBill.subtotal,
        tax: updatedBill.tax_amount || 0,
        discount: updatedBill.discount || 0,
        total: updatedBill.total_amount,
        amount_paid: updatedBill.total_amount,
        balance_due: 0,
        method: updatedBill.payment_method,
        status: 'Paid',
        notes: `Bill for appointment on ${appointment?.appointment_date?.toLocaleDateString() || ''}`,
        created_by: req.user?._id,

        has_procedures: procedureItems.length > 0,
        procedures_status: procedureItems.length > 0 ? 'Paid' : 'None',

        has_lab_tests: labTestItems.length > 0,
        lab_tests_status: labTestItems.length > 0 ? 'Paid' : 'None'
      });

      await invoice.save();

      // Update bill with invoice reference
      updatedBill.invoice_id = invoice._id;
      await updatedBill.save();

      // Update prescription billing status
      if (updatedBill.prescription_id) {
        const prescription = await Prescription.findById(updatedBill.prescription_id);

        if (prescription) {
          // Procedures
          if (prescription.recommendedProcedures?.length > 0) {
            updatedBill.items.forEach(item => {
              if (item.item_type === 'Procedure' && item.procedure_id) {
                const procIndex = prescription.recommendedProcedures.findIndex(
                  p => p._id.toString() === item.procedure_id.toString()
                );
                if (procIndex !== -1) {
                  prescription.recommendedProcedures[procIndex].is_billed = true;
                  prescription.recommendedProcedures[procIndex].invoice_id = invoice._id;
                  prescription.recommendedProcedures[procIndex].cost = Number(item.amount || 0);
                  prescription.recommendedProcedures[procIndex].status = 'Paid';
                }
              }
            });
          }

          // Lab Tests
          if (prescription.recommendedLabTests?.length > 0) {
            updatedBill.items.forEach(item => {
              if (item.item_type === 'Lab Test' && item.lab_test_id) {
                const testIndex = prescription.recommendedLabTests.findIndex(
                  t => t._id.toString() === item.lab_test_id.toString()
                );
                if (testIndex !== -1) {
                  prescription.recommendedLabTests[testIndex].is_billed = true;
                  prescription.recommendedLabTests[testIndex].invoice_id = invoice._id;
                  prescription.recommendedLabTests[testIndex].cost = Number(item.amount || 0);
                  prescription.recommendedLabTests[testIndex].status = 'Paid';
                }
              }
            });
          }

          await prescription.save();
        }
      }

      // Add invoice to response
      updatedBill._doc.invoice = invoice;
    }
    // Update existing invoice if bill becomes paid
    else if (isBecomingPaid && updatedBill.invoice_id) {
      const invoice = await Invoice.findById(updatedBill.invoice_id);
      
      if (invoice && invoice.status !== 'Paid') {
        const remainingAmount = invoice.total - (invoice.amount_paid || 0);
        
        if (remainingAmount > 0) {
          invoice.amount_paid = invoice.total;
          invoice.balance_due = 0;
          invoice.status = 'Paid';
          
          invoice.payment_history.push({
            amount: remainingAmount,
            method: payment_method || updatedBill.payment_method || 'Cash',
            date: new Date(),
            status: 'Completed',
            collected_by: req.user?._id,
            reference: notes || `Bulk payment from bill ${updatedBill._id}`
          });
          
          // Update invoice items status
          if (invoice.procedure_items?.length > 0) {
            invoice.procedure_items.forEach(item => {
              if (item.status !== 'Paid') {
                item.status = 'Paid';
              }
            });
            invoice.procedures_status = 'Paid';
          }
          
          if (invoice.lab_test_items?.length > 0) {
            invoice.lab_test_items.forEach(item => {
              if (item.status !== 'Paid') {
                item.status = 'Paid';
              }
            });
            invoice.lab_tests_status = 'Paid';
          }
          
          await invoice.save();
        }
      }
    }
    // Handle other status changes for existing invoice
    else if (updatedBill.invoice_id) {
      const invoice = await Invoice.findById(updatedBill.invoice_id);
      
      if (invoice) {
        if (paid_amount !== undefined) {
          invoice.amount_paid = (invoice.amount_paid || 0) + paid_amount;
          invoice.balance_due = invoice.total - invoice.amount_paid;

          invoice.payment_history.push({
            amount: paid_amount,
            method: payment_method || updatedBill.payment_method || 'Cash',
            date: new Date(),
            status: 'Completed',
            collected_by: req.user?._id,
            reference: notes || `Payment from bill ${updatedBill._id}`
          });

          if (invoice.amount_paid >= invoice.total) {
            invoice.status = 'Paid';
            
            // Update invoice items status
            if (invoice.procedure_items?.length > 0) {
              invoice.procedure_items.forEach(item => {
                if (item.status !== 'Paid') {
                  item.status = 'Paid';
                }
              });
              invoice.procedures_status = 'Paid';
            }
            
            if (invoice.lab_test_items?.length > 0) {
              invoice.lab_test_items.forEach(item => {
                if (item.status !== 'Paid') {
                  item.status = 'Paid';
                }
              });
              invoice.lab_tests_status = 'Paid';
            }
          } else if (invoice.amount_paid > 0) {
            invoice.status = 'Partial';
          }

          await invoice.save();
        } else if (status === 'Refunded' && invoice.status !== 'Refunded') {
          invoice.status = 'Refunded';
          invoice.notes = invoice.notes 
            ? `${invoice.notes}\n${new Date().toLocaleDateString()}: Bill marked as Refunded`
            : `${new Date().toLocaleDateString()}: Bill marked as Refunded`;
          
          // Update invoice items status
          if (invoice.procedure_items?.length > 0) {
            invoice.procedure_items.forEach(item => {
              item.status = 'Refunded';
            });
            invoice.procedures_status = 'Refunded';
          }
          
          if (invoice.lab_test_items?.length > 0) {
            invoice.lab_test_items.forEach(item => {
              item.status = 'Refunded';
            });
            invoice.lab_tests_status = 'Refunded';
          }
          
          await invoice.save();
        } else if (status === 'Cancelled' && invoice.status !== 'Cancelled') {
          invoice.status = 'Cancelled';
          invoice.notes = invoice.notes 
            ? `${invoice.notes}\n${new Date().toLocaleDateString()}: Bill cancelled`
            : `${new Date().toLocaleDateString()}: Bill cancelled`;
          
          // Update invoice items status
          if (invoice.procedure_items?.length > 0) {
            invoice.procedure_items.forEach(item => {
              item.status = 'Cancelled';
            });
            invoice.procedures_status = 'Cancelled';
          }
          
          if (invoice.lab_test_items?.length > 0) {
            invoice.lab_test_items.forEach(item => {
              item.status = 'Cancelled';
            });
            invoice.lab_tests_status = 'Cancelled';
          }
          
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
    console.error('Error updating bill status:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.getAllBills = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      patient_id,
      has_procedures,
      has_lab_tests,
      start_date,
      end_date,
      includeDeleted = false
    } = req.query;

    const filter = {};
    
    // Exclude soft-deleted bills by default
    if (!includeDeleted) {
      filter.is_deleted = { $ne: true };
    }
    
    if (status) filter.status = status;
    if (patient_id) filter.patient_id = patient_id;

    if (has_procedures === 'true') {
      filter['items.item_type'] = 'Procedure';
    }
    if (has_lab_tests === 'true') {
      filter['items.item_type'] = 'Lab Test';
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

    // Stats: total revenue (excluding deleted)
    const statsFilter = { ...filter, is_deleted: { $ne: true } };
    
    const totalRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...statsFilter } },
      { $group: { _id: null, total: { $sum: '$total_amount' } } }
    ]);

    const procedureRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...statsFilter } },
      { $unwind: '$items' },
      { $match: { 'items.item_type': 'Procedure' } },
      { $group: { _id: null, total: { $sum: '$items.amount' } } }
    ]);

    const labTestRevenue = await Bill.aggregate([
      { $match: { status: 'Paid', ...statsFilter } },
      { $unwind: '$items' },
      { $match: { 'items.item_type': 'Lab Test' } },
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
        labTestRevenue: labTestRevenue[0]?.total || 0,
        totalBills: total
      }
    });
  } catch (err) {
    console.error('Error fetching bills:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getBillById = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate('patient_id', 'first_name last_name patientId phone address')
      .populate('appointment_id', 'appointment_date type doctor_id department_id')
      .populate('prescription_id', 'prescription_number diagnosis recommendedProcedures recommendedLabTests')
      .populate('invoice_id')
      .populate('created_by', 'name')
      .populate('deleted_by', 'name')
      .populate('deletion_request.requested_by', 'name')
      .populate('deletion_request.reviewed_by', 'name');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    let procedures = [];
    let lab_tests = [];

    if (bill.prescription_id) {
      if (bill.prescription_id.recommendedProcedures) {
        procedures = bill.prescription_id.recommendedProcedures;
      }
      if (bill.prescription_id.recommendedLabTests) {
        lab_tests = bill.prescription_id.recommendedLabTests;
      }
    }

    res.json({
      success: true,
      bill,
      procedures,
      lab_tests
    });
  } catch (err) {
    console.error('Error fetching bill:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Admin direct delete bill (permanent deletion)
 * Only accessible by admin users - deletes both bill and associated invoice
 */
exports.adminDeleteBill = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const bill = await Bill.findById(id)
      .populate('patient_id')
      .populate('invoice_id');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    // Store deletion info for audit
    const deletionInfo = {
      deleted_by: req.user?._id,
      deleted_by_name: req.user?.name || 'Admin',
      deleted_at: new Date(),
      deletion_reason: reason || 'Admin direct deletion',
      bill_amount: bill.total_amount,
      bill_id: bill._id,
      bill_number: bill.bill_number || bill._id.toString().slice(-6).toUpperCase(),
      patient_name: bill.patient_id ? 
        `${bill.patient_id.first_name} ${bill.patient_id.last_name}` : 'Unknown',
      invoice_number: bill.invoice_id?.invoice_number
    };

    // Delete associated invoice if exists
    if (bill.invoice_id) {
      await Invoice.findByIdAndDelete(bill.invoice_id);
      console.log(`🧾 Invoice ${bill.invoice_id.invoice_number} deleted with bill`);
    }

    // Update prescription billing status if needed
    if (bill.prescription_id) {
      const prescription = await Prescription.findById(bill.prescription_id);
      if (prescription) {
        let needsUpdate = false;
        
        bill.items.forEach(item => {
          if (item.item_type === 'Procedure' && item.procedure_id) {
            const procIndex = prescription.recommendedProcedures.findIndex(
              p => p._id.toString() === item.procedure_id.toString()
            );
            if (procIndex !== -1) {
              prescription.recommendedProcedures[procIndex].is_billed = false;
              prescription.recommendedProcedures[procIndex].invoice_id = null;
              needsUpdate = true;
            }
          }
          
          if (item.item_type === 'Lab Test' && item.lab_test_id) {
            const testIndex = prescription.recommendedLabTests.findIndex(
              t => t._id.toString() === item.lab_test_id.toString()
            );
            if (testIndex !== -1) {
              prescription.recommendedLabTests[testIndex].is_billed = false;
              prescription.recommendedLabTests[testIndex].invoice_id = null;
              needsUpdate = true;
            }
          }
        });
        
        if (needsUpdate) {
          await prescription.save();
        }
      }
    }

    // Permanently delete the bill
    await Bill.findByIdAndDelete(id);

    // Log the deletion for audit purposes
    console.log('🗑️ Admin deleted bill:', deletionInfo);

    res.json({
      success: true,
      message: 'Bill and associated invoice permanently deleted',
      deletion_info: deletionInfo
    });
  } catch (err) {
    console.error('Error in adminDeleteBill:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Request deletion of a bill (soft delete request)
 * Staff users call this to request deletion
 */
exports.requestBillDeletion = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Deletion reason is required' });
    }

    const bill = await Bill.findById(id)
      .populate('patient_id')
      .populate('invoice_id');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    // Check if bill is already deleted
    if (bill.is_deleted) {
      return res.status(400).json({ error: 'Bill is already deleted' });
    }

    // Check if there's already a pending deletion request
    if (bill.deletion_request && bill.deletion_request.status === 'pending') {
      return res.status(400).json({ 
        error: 'A deletion request is already pending for this bill',
        request: bill.deletion_request
      });
    }

    // Create deletion request
    bill.deletion_request = {
      requested_by: req.user._id,
      requested_at: new Date(),
      reason: reason,
      status: 'pending'
    };

    await bill.save();

    // Also mark the associated invoice for deletion (but don't delete yet)
    if (bill.invoice_id) {
      const invoice = await Invoice.findById(bill.invoice_id);
      if (invoice) {
        invoice.deletion_request_id = bill._id;
        await invoice.save();
      }
    }

    res.json({
      success: true,
      message: 'Deletion request submitted successfully. Waiting for admin approval.',
      bill
    });
  } catch (err) {
    console.error('Error requesting bill deletion:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get all pending deletion requests (for admin)
 */
exports.getPendingDeletionRequests = async (req, res) => {
  try {
    const bills = await Bill.find({
      'deletion_request.status': 'pending',
      is_deleted: false
    })
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date')
      .populate('invoice_id', 'invoice_number total')
      .populate('deletion_request.requested_by', 'name email')
      .sort({ 'deletion_request.requested_at': -1 });

    res.json({
      success: true,
      count: bills.length,
      requests: bills
    });
  } catch (err) {
    console.error('Error fetching deletion requests:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Approve or reject deletion request (admin only)
 */
exports.reviewDeletionRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, review_notes } = req.body; // action: 'approve' or 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use "approve" or "reject"' });
    }

    const bill = await Bill.findById(id)
      .populate('invoice_id');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    if (!bill.deletion_request || bill.deletion_request.status !== 'pending') {
      return res.status(400).json({ error: 'No pending deletion request found for this bill' });
    }

    // Update deletion request status
    bill.deletion_request.status = action === 'approve' ? 'approved' : 'rejected';
    bill.deletion_request.reviewed_by = req.user._id;
    bill.deletion_request.reviewed_at = new Date();
    if (review_notes) {
      bill.deletion_request.review_notes = review_notes;
    }

    if (action === 'approve') {
      // Soft delete the bill
      bill.is_deleted = true;
      bill.deleted_at = new Date();
      bill.deleted_by = req.user._id;
      bill.deletion_reason = bill.deletion_request.reason;

      // Also soft delete the associated invoice
      if (bill.invoice_id) {
        await Invoice.findByIdAndUpdate(bill.invoice_id, {
          is_deleted: true,
          deleted_at: new Date(),
          deleted_by: req.user._id,
          deletion_reason: `Bill deletion approved: ${bill.deletion_request.reason}`
        });
      }

      // Update prescription billing status if needed
      if (bill.prescription_id) {
        const prescription = await Prescription.findById(bill.prescription_id);
        if (prescription) {
          let needsUpdate = false;
          
          bill.items.forEach(item => {
            if (item.item_type === 'Procedure' && item.procedure_id) {
              const procIndex = prescription.recommendedProcedures.findIndex(
                p => p._id.toString() === item.procedure_id.toString()
              );
              if (procIndex !== -1) {
                prescription.recommendedProcedures[procIndex].is_billed = false;
                prescription.recommendedProcedures[procIndex].invoice_id = null;
                needsUpdate = true;
              }
            }
            
            if (item.item_type === 'Lab Test' && item.lab_test_id) {
              const testIndex = prescription.recommendedLabTests.findIndex(
                t => t._id.toString() === item.lab_test_id.toString()
              );
              if (testIndex !== -1) {
                prescription.recommendedLabTests[testIndex].is_billed = false;
                prescription.recommendedLabTests[testIndex].invoice_id = null;
                needsUpdate = true;
              }
            }
          });
          
          if (needsUpdate) {
            await prescription.save();
          }
        }
      }
    }

    await bill.save();

    res.json({
      success: true,
      message: `Deletion request ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
      bill
    });
  } catch (err) {
    console.error('Error reviewing deletion request:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get deleted bills history (admin only)
 */
exports.getDeletedBills = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      start_date,
      end_date
    } = req.query;

    const filter = { is_deleted: true };

    if (start_date && end_date) {
      filter.deleted_at = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const bills = await Bill.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date')
      .populate('invoice_id', 'invoice_number total')
      .populate('deleted_by', 'name email')
      .populate('deletion_request.requested_by', 'name email')
      .populate('deletion_request.reviewed_by', 'name email')
      .sort({ deleted_at: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Bill.countDocuments(filter);

    res.json({
      success: true,
      bills,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    console.error('Error fetching deleted bills:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Main delete function - handles both admin direct delete and staff deletion requests
 */
exports.deleteBill = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const isAdmin = req.user?.role === 'admin' || req.user?.isAdmin === true;
    
    if (isAdmin) {
      // Admin can directly delete
      return exports.adminDeleteBill(req, res);
    } else {
      // Staff must use deletion request system
      return exports.requestBillDeletion(req, res);
    }
  } catch (err) {
    console.error('Error in deleteBill:', err);
    res.status(500).json({ error: err.message });
  }
};

// Generate bill for procedures
exports.generateProcedureBill = async (req, res) => {
  try {
    const { prescription_id, procedure_ids, additional_items = [] } = req.body;

    const prescription = await Prescription.findById(prescription_id)
      .populate('patient_id')
      .populate('doctor_id')
      .populate('appointment_id');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const selectedProcedures = (prescription.recommendedProcedures || []).filter(proc =>
      procedure_ids.includes(proc._id.toString())
    );

    if (selectedProcedures.length === 0) {
      return res.status(400).json({ error: 'No procedures selected' });
    }

    const procedureItems = selectedProcedures.map(proc => ({
      description: `${proc.procedure_code} - ${proc.procedure_name}`,
      amount: proc.cost || 0,
      quantity: 1,
      item_type: 'Procedure',
      procedure_code: proc.procedure_code,
      prescription_id: prescription._id,
      procedure_id: proc._id
    }));

    const allItems = [...procedureItems, ...additional_items];

    const subtotal = allItems.reduce((sum, item) => sum + (Number(item.amount || 0) * (item.quantity || 1)), 0);
    const tax = 0;
    const total = subtotal + tax;

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

    bill.invoice_id = invoice._id;
    await bill.save();

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

// Generate bill for lab tests
exports.generateLabTestBill = async (req, res) => {
  try {
    const { prescription_id, lab_test_ids, additional_items = [] } = req.body;

    const prescription = await Prescription.findById(prescription_id)
      .populate('patient_id')
      .populate('doctor_id')
      .populate('appointment_id');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const selectedLabTests = (prescription.recommendedLabTests || []).filter(test =>
      lab_test_ids.includes(test._id.toString())
    );

    if (selectedLabTests.length === 0) {
      return res.status(400).json({ error: 'No lab tests selected' });
    }

    const labTestBillItems = selectedLabTests.map(test => ({
      description: `${test.lab_test_code} - ${test.lab_test_name}`,
      amount: test.cost || 0,
      quantity: 1,
      item_type: 'Lab Test',
      lab_test_code: test.lab_test_code,
      prescription_id: prescription._id,
      lab_test_id: test._id
    }));

    const allItems = [...labTestBillItems, ...additional_items];

    const subtotal = allItems.reduce((sum, item) => sum + (Number(item.amount || 0) * (item.quantity || 1)), 0);
    const tax = 0;
    const total = subtotal + tax;

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
      notes: `Lab test bill for prescription ${prescription.prescription_number}`,
      created_by: req.user?._id
    });

    await bill.save();

    const invoice = new Invoice({
      invoice_type: 'Lab Test',
      patient_id: prescription.patient_id._id,
      customer_type: 'Patient',
      customer_name: `${prescription.patient_id.first_name} ${prescription.patient_id.last_name}`,
      customer_phone: prescription.patient_id.phone,
      appointment_id: prescription.appointment_id?._id,
      prescription_id: prescription._id,
      bill_id: bill._id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),

      lab_test_items: selectedLabTests.map(test => ({
        lab_test_code: test.lab_test_code,
        lab_test_name: test.lab_test_name,
        quantity: 1,
        unit_price: test.cost || 0,
        total_price: test.cost || 0,
        prescription_id: prescription._id,
        status: test.status || 'Pending',
        scheduled_date: test.scheduled_date
      })),

      subtotal: subtotal,
      tax: tax,
      total: total,
      status: 'Issued',
      amount_paid: 0,
      balance_due: total,
      notes: `Invoice for lab tests from prescription ${prescription.prescription_number}`,
      created_by: req.user?._id,

      has_lab_tests: true,
      lab_tests_status: 'Pending'
    });

    await invoice.save();

    bill.invoice_id = invoice._id;
    await bill.save();

    selectedLabTests.forEach(test => {
      const idx = prescription.recommendedLabTests.findIndex(t => t._id.toString() === test._id.toString());
      if (idx !== -1) {
        prescription.recommendedLabTests[idx].is_billed = true;
        prescription.recommendedLabTests[idx].invoice_id = invoice._id;
        if (!prescription.recommendedLabTests[idx].cost && test.cost) {
          prescription.recommendedLabTests[idx].cost = test.cost;
        }
      }
    });

    await prescription.save();

    const populatedBill = await Bill.findById(bill._id)
      .populate('patient_id', 'first_name last_name')
      .populate('appointment_id', 'appointment_date')
      .populate('prescription_id', 'prescription_number')
      .populate('invoice_id', 'invoice_number');

    res.status(201).json({
      success: true,
      message: 'Lab test bill generated successfully',
      bill: populatedBill,
      invoice,
      lab_tests_billed: selectedLabTests.length
    });
  } catch (err) {
    console.error('Error generating lab test bill:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.getBillByAppointmentId = async (req, res) => {
  try {
    const { appointmentId } = req.params;

    const bill = await Bill.findOne({ appointment_id: appointmentId })
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type doctor_id department_id')
      .populate('prescription_id', 'prescription_number diagnosis recommendedProcedures recommendedLabTests')
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