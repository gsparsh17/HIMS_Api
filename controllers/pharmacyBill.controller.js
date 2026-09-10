const Bill = require('../models/Bill');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const { requestHospitalId } = require('../utils/hospitalScope');
const { operationNow } = require('../utils/operationTimeContext');

function isIpdOwnedPharmacyBill(bill = {}, sale = null) {
  return bill.collection_owner === 'IPD' ||
    bill.collection_mode === 'IPD_CONSOLIDATED' ||
    bill.collection_transferred_to_ipd === true ||
    sale?.billing_owner === 'IPD' ||
    sale?.collection_mode === 'IPD_CONSOLIDATED';
}

exports.getPatientPharmacyBills = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { startDate, endDate, status, page = 1, limit = 20 } = req.query;

    const hospitalId = requestHospitalId(req);
    const filter = {
      hospital_id: hospitalId,
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
          totalDue: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$collection_owner', 'IPD'] },
                    { $eq: ['$collection_mode', 'IPD_CONSOLIDATED'] },
                    { $eq: ['$collection_transferred_to_ipd', true] }
                  ]
                },
                0,
                '$balance_due'
              ]
            }
          },
          transferredToIpdAmount: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$collection_owner', 'IPD'] },
                    { $eq: ['$collection_mode', 'IPD_CONSOLIDATED'] },
                    { $eq: ['$collection_transferred_to_ipd', true] }
                  ]
                },
                { $ifNull: ['$collection_transferred_amount', '$total_amount'] },
                0
              ]
            }
          },
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

    const hospitalId = requestHospitalId(req);
    const bill = await Bill.findOne({ _id: billId, hospital_id: hospitalId, is_pharmacy_bill: true })
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
    const returns = await PharmacyReturn.find({
      hospitalId,
      originalSaleId: bill.sale_id?._id || bill.sale_id
    });

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
    const { recordPharmacyOutstandingPayment } = require('../services/pharmacyTransaction.service');
    const result = await recordPharmacyOutstandingPayment({
      billId: req.params.billId,
      amount: req.body.amount,
      paymentMethod: req.body.payment_method || req.body.paymentMethod || 'Cash',
      reference: req.body.reference,
      notes: req.body.notes,
      idempotencyKey: req.body.idempotencyKey || req.get?.('Idempotency-Key')
    }, req);

    return res.json({
      success: true,
      message: result.alreadyExists ? 'Payment already recorded' : 'Payment recorded successfully',
      receiptNumber: result.receiptNumber,
      transaction: result.transaction,
      bill: result.bill,
      invoice: result.invoice,
      sale: result.sale,
      balance_due: result.balanceAfter,
      alreadyExists: result.alreadyExists
    });
  } catch (err) {
    console.error('Error updating pharmacy bill payment:', err);
    return res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
};

exports.voidPharmacyBill = async (req, res) => {
  try {
    const { billId } = req.params;
    const { reason } = req.body;
    const hospitalId = requestHospitalId(req);

    const bill = await Bill.findOne({ _id: billId, hospital_id: hospitalId, is_pharmacy_bill: true });
    if (!bill) {
      return res.status(404).json({ error: 'Pharmacy bill not found' });
    }

    if (bill.status === 'Cancelled') {
      return res.status(400).json({ error: 'Bill is already cancelled' });
    }

    const linkedSale = bill.sale_id
      ? await Sale.findOne({ _id: bill.sale_id, hospitalId }).select('billing_owner collection_mode')
      : null;
    if (isIpdOwnedPharmacyBill(bill, linkedSale)) {
      return res.status(409).json({
        error: 'This Pharmacy bill has been transferred to the IPD file. Use the Pharmacy return/correction workflow so the IPD running charge is reversed consistently.',
        code: 'PHARMACY_IPD_TRANSFER_VOID_BLOCKED',
        collectionOwner: 'IPD'
      });
    }

    bill.status = 'Cancelled';
    bill.notes = bill.notes ? `${bill.notes}\n[CANCELLED] ${new Date().toISOString()}: ${reason || 'No reason provided'}` : `[CANCELLED] ${new Date().toISOString()}: ${reason || 'No reason provided'}`;
    await bill.save();

    // Restore patient outstanding balance if the bill was unpaid
    if (bill.balance_due > 0 && bill.patient_id) {
      await Patient.findOneAndUpdate(
        { _id: bill.patient_id, hospitalId },
        { $inc: { pharmacy_outstanding_balance: -bill.balance_due } }
      );
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