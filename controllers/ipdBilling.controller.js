const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const Invoice = require('../models/Invoice');

// Helper function to update admission totals
async function updateAdmissionTotals(admissionId) {
  const charges = await IPDCharge.find({ admissionId });
  const totalBillAmount = charges.reduce((sum, c) => sum + c.netAmount, 0);
  
  const admission = await IPDAdmission.findById(admissionId);
  if (admission) {
    admission.totalBillAmount = totalBillAmount;
    admission.dueAmount = totalBillAmount - (admission.paidAmount || 0);
    await admission.save();
  }
  return totalBillAmount;
}

// ========== CHARGE MANAGEMENT ==========

// Add manual charge
exports.addManualCharge = async (req, res) => {
  try {
    const {
      admissionId,
      patientId,
      chargeType,
      description,
      quantity,
      rate,
      discount,
      tax,
      notes
    } = req.body;

    // Validate amount is passed from frontend
    if (rate === undefined || rate === null) {
      return res.status(400).json({ error: 'Rate/amount is required for the charge' });
    }

    // Check for duplicate bed charge on same day
    if (chargeType === 'Bed') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const existingBedCharge = await IPDCharge.findOne({
        admissionId,
        chargeType: 'Bed',
        chargeDate: { $gte: today, $lt: tomorrow },
        isBilled: false
      });
      
      if (existingBedCharge) {
        return res.status(409).json({ 
          error: 'Bed charge already exists for today',
          existingCharge: existingBedCharge
        });
      }
    }

    const charge = new IPDCharge({
      admissionId,
      patientId,
      chargeType,
      description,
      quantity: quantity || 1,
      rate: rate || 0,
      discount: discount || 0,
      tax: tax || 0,
      sourceModule: 'Manual',
      isBilled: false,
      addedBy: req.user?._id,
      notes,
      chargeDate: new Date()
    });

    await charge.save();
    await updateAdmissionTotals(admissionId);

    res.status(201).json({
      success: true,
      message: 'Charge added successfully',
      charge
    });
  } catch (err) {
    console.error('Error adding manual charge:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get charges by admission
exports.getChargesByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { chargeType, isBilled } = req.query;

    const filter = { admissionId };
    if (chargeType) filter.chargeType = chargeType;
    if (isBilled !== undefined) filter.isBilled = isBilled === 'true';

    const charges = await IPDCharge.find(filter)
      .sort({ chargeDate: -1 });

    // Group by charge type
    const groupedCharges = charges.reduce((acc, charge) => {
      if (!acc[charge.chargeType]) {
        acc[charge.chargeType] = [];
      }
      acc[charge.chargeType].push(charge);
      return acc;
    }, {});

    res.json({
      success: true,
      charges,
      groupedCharges,
      total: charges.reduce((sum, c) => sum + c.netAmount, 0)
    });
  } catch (err) {
    console.error('Error fetching charges:', err);
    res.status(500).json({ error: err.message });
  }
};

// Generate daily bed charges
exports.generateBedCharges = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { date, dailyRate } = req.body;

    const admission = await IPDAdmission.findById(admissionId).populate('bedId');
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (!admission.bedId) {
      return res.status(400).json({ error: 'No bed allocated for this admission' });
    }

    const chargeDate = date ? new Date(date) : new Date();
    chargeDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(chargeDate);
    nextDay.setDate(nextDay.getDate() + 1);

    // Check if charge already exists for this date
    const existingCharge = await IPDCharge.findOne({
      admissionId,
      chargeType: 'Bed',
      chargeDate: {
        $gte: chargeDate,
        $lt: nextDay
      }
    });

    if (existingCharge) {
      return res.status(400).json({ error: 'Bed charge already generated for this date' });
    }

    // Use rate from frontend or fallback to bed's daily charge
    const bedRate = dailyRate || admission.bedId.dailyCharge || 0;

    const bedCharge = new IPDCharge({
      admissionId,
      patientId: admission.patientId,
      chargeType: 'Bed',
      description: `Bed Charges - ${admission.bedId.bedNumber} (${admission.bedId.bedType}) for ${chargeDate.toLocaleDateString()}`,
      quantity: 1,
      rate: bedRate,
      amount: bedRate,
      netAmount: bedRate,
      sourceModule: 'Bed',
      sourceId: admission.bedId._id,
      isAutoGenerated: true,
      isBilled: false,
      chargeDate,
      addedBy: req.user?._id
    });

    await bedCharge.save();
    await updateAdmissionTotals(admissionId);

    res.json({
      success: true,
      message: 'Bed charge generated successfully',
      charge: bedCharge
    });
  } catch (err) {
    console.error('Error generating bed charges:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get running bill with separation of billed vs unbilled
exports.getRunningBill = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const admission = await IPDAdmission.findById(admissionId)
      .populate('patientId', 'first_name last_name patientId phone')
      .populate('primaryDoctorId', 'firstName lastName');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const allCharges = await IPDCharge.find({ admissionId }).sort({ chargeDate: 1 });
    
    // SEPARATE: Billed vs Unbilled charges
    const unbilledCharges = allCharges.filter(c => !c.isBilled);
    const billedCharges = allCharges.filter(c => c.isBilled);

    // Calculate summary for unbilled only (what's pending to be billed)
    const unbilledSummary = {
      bedCharges: unbilledCharges.filter(c => c.chargeType === 'Bed').reduce((sum, c) => sum + c.netAmount, 0),
      doctorVisitCharges: unbilledCharges.filter(c => c.chargeType === 'Doctor Visit').reduce((sum, c) => sum + c.netAmount, 0),
      labCharges: unbilledCharges.filter(c => c.chargeType === 'Lab Test').reduce((sum, c) => sum + c.netAmount, 0),
      pharmacyCharges: unbilledCharges.filter(c => c.chargeType === 'Pharmacy').reduce((sum, c) => sum + c.netAmount, 0),
      procedureCharges: unbilledCharges.filter(c => c.chargeType === 'Procedure').reduce((sum, c) => sum + c.netAmount, 0),
      surgeryCharges: unbilledCharges.filter(c => c.chargeType === 'Surgery').reduce((sum, c) => sum + c.netAmount, 0),
      equipmentCharges: unbilledCharges.filter(c => c.chargeType === 'Equipment').reduce((sum, c) => sum + c.netAmount, 0),
      miscellaneousCharges: unbilledCharges.filter(c => c.chargeType === 'Miscellaneous').reduce((sum, c) => sum + c.netAmount, 0),
      discounts: unbilledCharges.filter(c => c.chargeType === 'Discount').reduce((sum, c) => sum + c.netAmount, 0),
      taxes: unbilledCharges.filter(c => c.chargeType === 'Tax').reduce((sum, c) => sum + c.netAmount, 0),
      total: unbilledCharges.reduce((sum, c) => sum + c.netAmount, 0)
    };

    // Already billed summary
    const billedSummary = {
      total: billedCharges.reduce((sum, c) => sum + c.netAmount, 0),
      count: billedCharges.length,
      bySource: billedCharges.reduce((acc, c) => {
        const module = c.sourceReference?.module || c.sourceModule;
        acc[module] = (acc[module] || 0) + c.netAmount;
        return acc;
      }, {})
    };

    // Group unbilled charges by date for better display
    const unbilledChargesByDate = unbilledCharges.reduce((acc, charge) => {
      const dateKey = charge.chargeDate.toISOString().split('T')[0];
      if (!acc[dateKey]) acc[dateKey] = [];
      acc[dateKey].push(charge);
      return acc;
    }, {});

    res.json({
      success: true,
      admission: {
        admissionNumber: admission.admissionNumber,
        admissionDate: admission.admissionDate,
        lengthOfStay: admission.lengthOfStay,
        status: admission.status
      },
      patient: admission.patientId,
      unbilledCharges,
      unbilledChargesByDate,
      unbilledSummary,
      billedCharges,
      billedSummary,
      advanceAmount: admission.advanceAmount,
      paidAmount: admission.paidAmount,
      dueAmount: admission.dueAmount,
      totalBillAmount: admission.totalBillAmount
    });
  } catch (err) {
    console.error('Error fetching running bill:', err);
    res.status(500).json({ error: err.message });
  }
};

// Mark charges as billed (called by lab/procedure modules when they bill IPD patients)
exports.markChargesAsBilled = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { chargeIds, invoiceId, invoiceNumber, sourceModule, sourceDocumentId } = req.body;

    if (!chargeIds || !Array.isArray(chargeIds) || chargeIds.length === 0) {
      return res.status(400).json({ error: 'chargeIds array is required' });
    }

    const updateResult = await IPDCharge.updateMany(
      { 
        _id: { $in: chargeIds },
        admissionId: admissionId,
        isBilled: false
      },
      { 
        isBilled: true, 
        invoiceId: invoiceId,
        billedAt: new Date(),
        sourceReference: {
          module: sourceModule,
          documentId: sourceDocumentId,
          invoiceNumber: invoiceNumber
        }
      }
    );

    await updateAdmissionTotals(admissionId);

    res.json({
      success: true,
      message: `${updateResult.modifiedCount} charges marked as billed`,
      modifiedCount: updateResult.modifiedCount
    });
  } catch (err) {
    console.error('Error marking charges as billed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get unbilled charges for a specific type
exports.getUnbilledChargesByType = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { chargeType } = req.query;

    const filter = { 
      admissionId, 
      isBilled: false 
    };
    if (chargeType) filter.chargeType = chargeType;

    const charges = await IPDCharge.find(filter).sort({ chargeDate: 1 });

    res.json({
      success: true,
      charges,
      total: charges.reduce((sum, c) => sum + c.netAmount, 0),
      count: charges.length
    });
  } catch (err) {
    console.error('Error fetching unbilled charges:', err);
    res.status(500).json({ error: err.message });
  }
};

// Apply discount
exports.applyDiscount = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { discountAmount, discountReason, approvedBy } = req.body;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const discountCharge = new IPDCharge({
      admissionId,
      patientId: admission.patientId,
      chargeType: 'Discount',
      description: `Discount applied: ${discountReason}`,
      quantity: 1,
      rate: -Math.abs(discountAmount),
      amount: -Math.abs(discountAmount),
      netAmount: -Math.abs(discountAmount),
      sourceModule: 'Manual',
      isAutoGenerated: false,
      isBilled: false,
      addedBy: req.user?._id,
      notes: discountReason
    });

    await discountCharge.save();

    admission.discountAmount = (admission.discountAmount || 0) + discountAmount;
    admission.discountReason = discountReason;
    await admission.save();

    await updateAdmissionTotals(admissionId);

    res.json({
      success: true,
      message: 'Discount applied successfully',
      discount: discountCharge
    });
  } catch (err) {
    console.error('Error applying discount:', err);
    res.status(500).json({ error: err.message });
  }
};

// Record payment
exports.recordPayment = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { amount, paymentMethod, reference, notes } = req.body;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    // Create invoice for payment
    const invoice = new Invoice({
      patient_id: admission.patientId,
      admission_id: admissionId,
      invoice_type: 'IPD Payment',
      invoice_number: `IPD-PAY-${admission.admissionNumber}-${Date.now()}`,
      total: amount,
      amount_paid: amount,
      balance_due: 0,
      status: 'Paid',
      payment_method: paymentMethod,
      transaction_id: reference,
      notes: notes || `IPD payment for admission ${admission.admissionNumber}`,
      issue_date: new Date(),
      due_date: new Date()
    });

    await invoice.save();

    // Update admission payment amounts
    admission.paidAmount = (admission.paidAmount || 0) + amount;
    admission.dueAmount = admission.totalBillAmount - admission.paidAmount;
    await admission.save();

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      invoice,
      admission: {
        paidAmount: admission.paidAmount,
        dueAmount: admission.dueAmount
      }
    });
  } catch (err) {
    console.error('Error recording payment:', err);
    res.status(500).json({ error: err.message });
  }
};

// Finalize bill - ONLY bills unbilled charges (prevents double billing)
exports.finalizeBill = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const admission = await IPDAdmission.findById(admissionId)
      .populate('patientId', 'first_name last_name patientId phone');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    // Get ONLY unbilled charges
    const unbilledCharges = await IPDCharge.find({ 
      admissionId, 
      isBilled: false 
    });

    if (unbilledCharges.length === 0) {
      return res.json({
        success: true,
        message: 'No pending charges to bill. All charges have already been invoiced.',
        totalAmount: admission.totalBillAmount,
        paidAmount: admission.paidAmount,
        dueAmount: admission.dueAmount,
        unbilledCount: 0
      });
    }

    // Calculate unbilled total
    const unbilledTotal = unbilledCharges.reduce((sum, c) => sum + c.netAmount, 0);

    // Create final invoice for unbilled charges only
    const invoice = new Invoice({
      patient_id: admission.patientId,
      admission_id: admissionId,
      invoice_type: 'IPD Final',
      invoice_number: `IPD-FINAL-${admission.admissionNumber}-${Date.now()}`,
      total: unbilledTotal,
      amount_paid: 0,
      balance_due: unbilledTotal,
      status: 'Issued',
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      service_items: unbilledCharges.map(c => ({
        description: c.description,
        quantity: c.quantity,
        unit_price: c.rate,
        total_price: c.netAmount,
        service_type: c.chargeType,
        tax_rate: c.tax > 0 ? (c.tax / c.netAmount * 100) : 0,
        tax_amount: c.tax || 0
      })),
      notes: `Final bill for admission ${admission.admissionNumber}. ${unbilledCharges.length} pending charges.`,
      created_by: req.user?._id
    });

    await invoice.save();

    // Mark all unbilled charges as billed
    await IPDCharge.updateMany(
      { admissionId, isBilled: false },
      { 
        isBilled: true, 
        invoiceId: invoice._id,
        billedAt: new Date(),
        sourceReference: {
          module: 'IPD Final Bill',
          invoiceNumber: invoice.invoice_number
        }
      }
    );

    await updateAdmissionTotals(admissionId);

    // If due amount is 0, mark admission as ready for discharge
    const updatedAdmission = await IPDAdmission.findById(admissionId);
    if (updatedAdmission.dueAmount === 0 && updatedAdmission.status === 'Billing Pending') {
      updatedAdmission.status = 'Ready for Discharge';
      await updatedAdmission.save();
    }

    res.json({
      success: true,
      message: `Final bill created for ${unbilledCharges.length} pending charges`,
      invoice,
      unbilledAmount: unbilledTotal,
      unbilledCount: unbilledCharges.length,
      totalAmount: admission.totalBillAmount,
      paidAmount: admission.paidAmount,
      dueAmount: admission.dueAmount,
      admissionStatus: updatedAdmission.status
    });
  } catch (err) {
    console.error('Error finalizing bill:', err);
    res.status(500).json({ error: err.message });
  }
};

// Helper function to be used by other modules
exports.updateAdmissionTotals = updateAdmissionTotals;