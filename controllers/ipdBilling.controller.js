const IPDCharge = require('../models/IPDCharge');
const finance = require('../services/ipdFinancial.service');

function handleError(res, error) {
  console.error('IPD billing error:', error);
  return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'IPD billing operation failed', details: error.details });
}

// Kept as the compatibility controller for existing IPD routes. All financial
// mutations now use the shared finance service so Bills, Invoices, receipts and
// advance ledger entries cannot drift apart.
exports.addManualCharge = async (req, res) => {
  try {
    const charge = await finance.addManualCharge(req.body, req.user);
    res.status(201).json({ success: true, message: 'Charge added successfully', charge });
  } catch (error) { handleError(res, error); }
};

exports.getChargesByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const filter = { admissionId };
    if (req.query.chargeType) filter.chargeType = req.query.chargeType;
    if (req.query.isBilled !== undefined) filter.isBilled = req.query.isBilled === 'true';
    if (req.query.includeVoided !== 'true') filter.status = { $ne: 'VOIDED' };
    const charges = await IPDCharge.find(filter).sort({ chargeDate: -1, createdAt: -1 });
    const groupedCharges = charges.reduce((groups, charge) => {
      groups[charge.chargeType] = groups[charge.chargeType] || [];
      groups[charge.chargeType].push(charge);
      return groups;
    }, {});
    const total = charges.reduce((sum, charge) => sum + (Number(charge.netAmount) || 0), 0);
    res.json({ success: true, charges, groupedCharges, total: Math.round(total * 100) / 100 });
  } catch (error) { handleError(res, error); }
};

exports.getRunningBill = async (req, res) => {
  try { res.json(await finance.getRunningBill(req.params.admissionId)); }
  catch (error) { handleError(res, error); }
};

exports.generateBedCharges = async (req, res) => {
  try {
    const result = await finance.generateBedCharge(req.params.admissionId, req.body, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({ success: true, message: result.alreadyExists ? 'Bed charge already exists for this date' : 'Bed charge generated successfully', ...result });
  } catch (error) { handleError(res, error); }
};

exports.markChargesAsBilled = async (req, res) => {
  try {
    // Legacy endpoint is intentionally blocked: charges may only be marked
    // billed by issueIPDInvoice, which creates the linked Bill/Invoice atomically.
    const error = new Error('Use the IPD invoice issuance workflow to bill charges. Direct marking is disabled to prevent double billing.');
    error.statusCode = 409;
    throw error;
  } catch (error) { handleError(res, error); }
};

exports.getUnbilledChargesByType = async (req, res) => {
  try {
    const filter = { admissionId: req.params.admissionId, isBilled: false, status: { $in: ['ACTIVE', null] } };
    if (req.query.chargeType) filter.chargeType = req.query.chargeType;
    const charges = await IPDCharge.find(filter).sort({ chargeDate: 1 });
    const total = charges.reduce((sum, charge) => sum + (Number(charge.netAmount) || 0), 0);
    res.json({ success: true, charges, count: charges.length, total: Math.round(total * 100) / 100 });
  } catch (error) { handleError(res, error); }
};

exports.applyDiscount = async (req, res) => {
  try {
    const charge = await finance.applyDiscount(req.params.admissionId, req.body, req.user);
    res.status(201).json({ success: true, message: 'Discount applied successfully', discount: charge });
  } catch (error) { handleError(res, error); }
};

exports.recordPayment = async (req, res) => {
  try {
    const result = await finance.recordIPDPayment(req.params.admissionId, req.body, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({ success: true, message: result.alreadyExists ? 'Existing receipt returned' : 'Payment recorded successfully', ...result });
  } catch (error) { handleError(res, error); }
};

exports.finalizeBill = async (req, res) => {
  try {
    const result = await finance.issueIPDInvoice(req.params.admissionId, {
      ...req.body,
      invoiceKind: req.body?.invoiceKind || 'final'
    }, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({
      success: true,
      message: result.alreadyExists ? 'Existing invoice returned' : 'IPD invoice issued successfully',
      invoice: result.invoice,
      bill: result.bill,
      unbilledAmount: result.invoice.total,
      alreadyExists: result.alreadyExists
    });
  } catch (error) { handleError(res, error); }
};

exports.recordAdvance = async (req, res) => {
  try {
    const result = await finance.recordAdvance(req.params.admissionId, req.body, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({ success: true, message: result.alreadyExists ? 'Existing advance receipt returned' : 'Advance recorded successfully', ...result });
  } catch (error) { handleError(res, error); }
};

exports.refundAdvance = async (req, res) => {
  try {
    const result = await finance.refundAdvance(req.params.admissionId, req.body, req.user);
    res.status(201).json({ success: true, message: 'Advance refund recorded successfully', ...result });
  } catch (error) { handleError(res, error); }
};

exports.getLedger = async (req, res) => {
  try { res.json(await finance.getFinancialLedger(req.params.admissionId)); }
  catch (error) { handleError(res, error); }
};

exports.getFinancialClearance = async (req, res) => {
  try { res.json(await finance.getFinancialClearance(req.params.admissionId)); }
  catch (error) { handleError(res, error); }
};

exports.finaliseFinancialClearance = async (req, res) => {
  try {
    const result = await finance.finaliseFinancialClearance(req.params.admissionId, req.body, req.user);
    res.json({ success: true, message: 'Financial clearance processed successfully', ...result });
  } catch (error) { handleError(res, error); }
};

exports.voidCharge = async (req, res) => {
  try {
    const charge = await finance.voidCharge(req.params.admissionId, req.params.chargeId, req.body, req.user);
    res.json({ success: true, message: 'Charge voided successfully', charge });
  } catch (error) { handleError(res, error); }
};
