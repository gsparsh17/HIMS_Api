'use strict';

const crypto = require('crypto');

const Sale = require('../models/Sale');
const PharmacyReturn = require('../models/PharmacyReturn');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const PharmacyLedgerSettlement = require('../models/PharmacyLedgerSettlement');

const {
  buildSaleItems,
  calculateTotals,
  createUnifiedSale,
  getHospitalId,
} = require('../services/pharmacyTransaction.service');

const {
  buildReturnPreview,
  completeAuthoritativeReturn,
  getClearanceSnapshot,
  completeFinalClearance,
} = require('../services/pharmacyReturnClearance.service');

const MONEY_EPSILON = 0.009;

const PAYMENT_METHOD_ALIASES = {
  Bank: 'Net Banking',
  'Bank Transfer': 'Net Banking',
  'Defer Payment': 'Deferred',
  'IPD Advance': 'IPDAdvance',
  'Pharmacy Advance': 'PharmacyAdvance',
};

const ALLOWED_PAYMENT_METHODS = new Set([
  'Cash',
  'UPI',
  'Card',
  'Net Banking',
  'Insurance',
  'Government Scheme',
  'IPDAdvance',
  'PharmacyAdvance',
]);

// Wallet deposits are external payments received from the customer. Wallet
// balances themselves must never be used as a deposit method.
const ALLOWED_ADVANCE_DEPOSIT_METHODS = new Set([
  'Cash',
  'UPI',
  'Card',
  'Net Banking',
]);

const money = (value) => {
  const amount = Number(value || 0);
  return Number.isFinite(amount)
    ? Math.round((amount + Number.EPSILON) * 100) / 100
    : 0;
};

const sum = (rows = [], key = 'amount') =>
  money(rows.reduce((total, row) => total + Number(row?.[key] || 0), 0));

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createTransactionGroupId(value) {
  return String(value || crypto.randomUUID());
}

function normalizePaymentMethod(method) {
  const raw = String(method || 'Cash').trim();
  return PAYMENT_METHOD_ALIASES[raw] || raw;
}

/**
 * POS must receive the payment split exclusively through payments[].
 * advanceApplied was a second, unconsumed source of truth: it was included in
 * validation but was not debited from an advance wallet by createUnifiedSale.
 */
function buildPaymentAllocation(body = {}, total) {
  if (money(body.advanceApplied) > 0) {
    throw httpError(
      'advanceApplied is not supported. Send IPDAdvance or PharmacyAdvance in payments[].'
    );
  }

  const sourcePayments = Array.isArray(body.payments) ? body.payments : [];

  const payments = sourcePayments.map((payment) => {
    const method = normalizePaymentMethod(
      payment?.method || payment?.paymentMethod || payment?.payment_method
    );
    const amount = money(payment?.amount);

    if (!ALLOWED_PAYMENT_METHODS.has(method)) {
      throw httpError(`Unsupported payment method: ${method}.`);
    }

    if (amount <= 0) {
      throw httpError('Every immediate payment allocation must be positive.');
    }

    const walletType =
      payment?.walletType ||
      payment?.wallet_type ||
      (method === 'IPDAdvance'
        ? 'IPD_SHARED'
        : method === 'PharmacyAdvance'
          ? 'PHARMACY_IPD'
          : null);

    return {
      method,
      amount,
      reference: String(
        payment?.reference ||
        payment?.referenceNumber ||
        payment?.transaction_id ||
        ''
      ).trim(),
      walletType,
    };
  });

  const paymentTotal = sum(payments);
  const advanceApplied = sum(
    payments.filter((payment) =>
      ['IPDAdvance', 'PharmacyAdvance'].includes(payment.method)
    )
  );
  const immediateExternalPayment = money(paymentTotal - advanceApplied);

  const requestedDeferred =
    body.deferredAmount === undefined || body.deferredAmount === null
      ? money(total - paymentTotal)
      : money(body.deferredAmount);

  if (paymentTotal > money(total) + MONEY_EPSILON) {
    throw httpError('Payment allocation exceeds net payable.');
  }

  if (requestedDeferred < 0) {
    throw httpError('Deferred outstanding cannot be negative.');
  }

  if (
    Math.abs(money(paymentTotal + requestedDeferred) - money(total)) >
    MONEY_EPSILON
  ) {
    throw httpError(
      'Net Sale Amount must equal Payment Total + Deferred Outstanding.'
    );
  }

  return {
    payments,
    paymentTotal,
    advanceApplied,
    immediateExternalPayment,
    deferredOutstanding: requestedDeferred,
  };
}

function buildAdvanceDepositAllocation(body = {}) {
  const canonical = body.advanceDepositPayments || body.advance_deposit_payments;
  const legacyAmount = money(body.immediate_payment_to_advance);

  if (Array.isArray(canonical) && legacyAmount > 0) {
    throw httpError(
      'Send either advanceDepositPayments or immediate_payment_to_advance, not both.'
    );
  }

  const sourcePayments = Array.isArray(canonical)
    ? canonical
    : legacyAmount > 0
      ? [{
        method: body.immediate_payment_method || 'Cash',
        amount: legacyAmount,
        reference: body.immediate_payment_reference || '',
      }]
      : [];

  const payments = sourcePayments.map((payment) => {
    const method = normalizePaymentMethod(
      payment?.method || payment?.paymentMethod || payment?.payment_method
    );
    const amount = money(payment?.amount);

    if (!ALLOWED_ADVANCE_DEPOSIT_METHODS.has(method)) {
      throw httpError(
        `Unsupported Pharmacy Advance deposit method: ${method}.`
      );
    }

    if (amount <= 0) {
      throw httpError('Every Pharmacy Advance deposit allocation must be positive.');
    }

    return {
      method,
      amount,
      reference: String(
        payment?.reference ||
        payment?.referenceNumber ||
        payment?.transaction_id ||
        ''
      ).trim(),
    };
  });

  return {
    payments,
    total: sum(payments),
    walletType: body.advanceWalletType || body.advance_wallet_type || 'PHARMACY_IPD',
  };
}

function assertAdvanceDepositRules({ body = {}, total, allocation, deposit }) {
  if (deposit.total <= MONEY_EPSILON) return;

  if (deposit.walletType !== 'PHARMACY_IPD') {
    throw httpError('Only the PHARMACY_IPD wallet can receive this POS advance deposit.');
  }

  if (!body.patient_id && !body.patientId) {
    throw httpError('A patient is required for a Pharmacy Advance deposit.');
  }

  if (!body.admission_id && !body.admissionId) {
    throw httpError('An active IPD admission is required for a Pharmacy Advance deposit.');
  }

  if (allocation.paymentTotal > MONEY_EPSILON) {
    throw httpError(
      'Advance deposit cannot be combined with payment applied to the current bill. Use Pay Partial Now or To Advance, not both.'
    );
  }

  if (Math.abs(money(allocation.deferredOutstanding) - money(total)) > MONEY_EPSILON) {
    throw httpError(
      'A Pharmacy Advance deposit keeps the entire current medicine bill deferred.'
    );
  }
}

function buildSaleItemOptions(body = {}) {
  return {
    honorLooseSale: body.allowLooseSale !== false,
    billDiscount: money(body.discount),
    billDiscountType:
      body.discount_type || body.discountType || 'percentage',
  };
}

function getRequestedHospitalId(req) {
  return (
    req.body?.hospitalId ||
    req.body?.hospital_id ||
    req.query?.hospitalId ||
    req.query?.hospital_id
  );
}

function getPaymentArrangement(payments = [], deferredOutstanding = 0, advanceDepositTotal = 0) {
  const hasDeferredBalance = money(deferredOutstanding) > MONEY_EPSILON;

  if (money(advanceDepositTotal) > MONEY_EPSILON) return 'DEFERRED_WITH_ADVANCE_DEPOSIT';
  if (hasDeferredBalance && payments.length > 1) return 'SPLIT_WITH_DEFERRED';
  if (hasDeferredBalance && payments.length === 1) return 'PARTIAL_WITH_DEFERRED';
  if (hasDeferredBalance) return 'FULL_DEFERRED';
  if (payments.length > 1) return 'SPLIT';
  return 'FULL_PAYMENT';
}

function createReceiptSummary(sale, allocation = null, deposit = null) {
  const payments = allocation?.payments || sale?.payments || [];
  const paymentTotal = allocation?.paymentTotal ?? money(sale?.amount_paid);
  const advanceApplied =
    allocation?.advanceApplied ??
    sum(
      payments.filter((payment) =>
        ['IPDAdvance', 'PharmacyAdvance'].includes(payment.method)
      )
    );
  const deferredOutstanding =
    allocation?.deferredOutstanding ?? money(sale?.balance_due);
  const advanceDepositAllocations =
    deposit?.payments ||
    sale?.advance_deposit_payments ||
    [];
  const advanceDepositTotal =
    deposit?.total ??
    money(sale?.advance_deposit_total);

  return {
    netSaleAmount: money(sale?.total_amount),
    immediatePaymentTotal: money(paymentTotal),
    immediateExternalPaymentTotal:
      allocation?.immediateExternalPayment ??
      money(paymentTotal - advanceApplied),
    advanceApplied: money(advanceApplied),
    advanceDepositTotal: money(advanceDepositTotal),
    advanceDepositWalletType:
      deposit?.walletType ||
      sale?.advance_deposit_wallet_type ||
      null,
    deferredOutstanding,
    paymentArrangement: getPaymentArrangement(
      payments,
      deferredOutstanding,
      advanceDepositTotal
    ),
    allocations: payments,
    advanceDepositAllocations,
  };
}

exports.quotePos = async (req, res) => {
  try {

    const items = await buildSaleItems(
      req.body.items || [],
      buildSaleItemOptions(req.body)
    );
    const totals = calculateTotals(items, req.body);
    const allocation = buildPaymentAllocation(req.body, totals.total);
    const deposit = buildAdvanceDepositAllocation(req.body);
    assertAdvanceDepositRules({ body: req.body, total: totals.total, allocation, deposit });

    res.json({
      success: true,
      quote: {
        items: items.map(({ _batch, _medicine, ...item }) => item),
        netAmount: money(totals.total),
        immediatePaymentTotal: allocation.paymentTotal,
        immediateExternalPaymentTotal: allocation.immediateExternalPayment,
        advanceApplied: allocation.advanceApplied,
        advanceDepositTotal: deposit.total,
        advanceDepositWalletType: deposit.total > 0 ? deposit.walletType : null,
        advanceDepositAllocations: deposit.payments,
        deferredOutstanding: allocation.deferredOutstanding,
        paymentArrangement: getPaymentArrangement(
          allocation.payments,
          allocation.deferredOutstanding,
          deposit.total
        ),
        invariantOk: true,
      },
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.completePos = async (req, res) => {
  const idempotencyKey = String(
    req.headers['idempotency-key'] || req.body?.idempotencyKey || ''
  ).trim();

  try {

    if (!idempotencyKey) {
      throw httpError('Idempotency-Key is required.');
    }

    const existing = await Sale.findOne({
      idempotencyKey,
    });

    if (existing) {

      return res.status(200).json({
        success: true,
        idempotent: true,
        sale: existing,
        receipt: createReceiptSummary(existing),
      });
    }

    const items = await buildSaleItems(
      req.body.items || [],
      buildSaleItemOptions(req.body)
    );
    const totals = calculateTotals(items, req.body);
    const allocation = buildPaymentAllocation(req.body, totals.total);
    const deposit = buildAdvanceDepositAllocation(req.body);
    assertAdvanceDepositRules({ body: req.body, total: totals.total, allocation, deposit });

    const transactionGroupId = createTransactionGroupId(
      req.body.transactionGroupId || idempotencyKey
    );

    const paymentDeferred = allocation.deferredOutstanding > MONEY_EPSILON;
    const payload = {
      ...req.body,
      items: req.body.items || [],
      idempotencyKey,
      transactionGroupId,
      parentGroupId: transactionGroupId,
      presentationType: 'PHARMACY_SALE',
      payments: allocation.payments.map((payment) => ({
        ...payment,
        transactionGroupId,
        parentGroupId: transactionGroupId,
        idempotencyKey,
        presentationType: 'PAYMENT_ALLOCATION',
      })),
      // Kept separate from payments[] because this money is credited to the
      // wallet, not applied to the current sale.
      advanceDepositPayments: deposit.payments.map((payment) => ({
        ...payment,
        transactionGroupId,
        parentGroupId: transactionGroupId,
        idempotencyKey,
        presentationType: 'ADVANCE_DEPOSIT',
      })),
      advanceWalletType: deposit.total > 0 ? deposit.walletType : undefined,
      // "Split" is a summary only. payments[] keeps the actual Cash/UPI/Card/etc. allocations,
      // while deferredAmount preserves the balance that remains collectible later.
      payment_method:
        allocation.payments.length > 1
          ? 'Split'
          : allocation.payments[0]?.method ||
            (paymentDeferred ? 'Deferred' : 'Cash'),
      payment_deferred: paymentDeferred,
      noPayment: allocation.paymentTotal === 0 && paymentDeferred,
      pay_nothing: allocation.paymentTotal === 0 && paymentDeferred,
      total_collected_amount: money(allocation.paymentTotal + deposit.total),
      deferredAmount: allocation.deferredOutstanding,
      overpayment_amount: 0,
    };

    const result = await createUnifiedSale(payload, req);
    const sale = await Sale.findById(result.sale?._id || result.sale?.id);

    if (!sale) {
      throw httpError('Sale completion did not return a sale record.', 500);
    }

    await Promise.all([
      PharmacyLedgerEntry.updateMany(
        { saleId: sale._id },
        {
          $set: {
            transactionGroupId,
            parentGroupId: transactionGroupId,
            idempotencyKey,
            presentationType: 'PHARMACY_SALE',
          },
        }
      ),
      PatientAdvanceLedger.updateMany(
        { sourceId: sale._id },
        {
          $set: {
            transactionGroupId,
            parentGroupId: transactionGroupId,
            idempotencyKey,
            presentationType: 'PHARMACY_SALE',
          },
        }
      ),
    ]);
    res.status(201).json({
      success: true,
      idempotent: false,
      sale,
      receipt: createReceiptSummary(sale, allocation, deposit),
    });
  } catch (error) {
    console.log('Error completing POS sale:', error);
    if (error?.code === 11000 && idempotencyKey) {
      try {
        const existing = await Sale.findOne({ idempotencyKey });

        if (existing) {
          return res.status(200).json({
            success: true,
            idempotent: true,
            sale: existing,
            receipt: createReceiptSummary(existing),
          });
        }
      } catch (lookupError) {
       console.log('Idempotent sale lookup failed after duplicate key error:', lookupError);
      }
    }
    console.log('Error completing POS sale:', error);
    res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

/** Returns and pharmacy clearance use the shared authoritative service. */
exports.previewReturn = async (req, res) => {
  try {

    const preview = await buildReturnPreview({
      saleId:
        req.body.saleId ||
        req.body.originalSaleId ||
        req.body.original_sale_id,
      items: req.body.items,
      req,
    });

    res.json({
      success: true,
      preview: {
        saleId: preview.sale._id,
        saleNumber: preview.sale.sale_number,
        items: preview.rows,
        returnValue: preview.returnValue,
        ...preview.allocation,
        refundRequired: preview.allocation.refundableResidual > 0,
        refundMethods:
          preview.allocation.refundableResidual > 0
            ? ['Cash', 'UPI', 'Card', 'IPDAdvance', 'PharmacyAdvance']
            : ['NoRefund'],
        message:
          preview.allocation.refundableResidual > 0
            ? 'The unpaid due is reduced first. Only the paid excess is refundable.'
            : 'No refund is due. The full return value reduces the original unpaid pharmacy due.',
      },
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.completeReturn = async (req, res) => {
  try {

    const result = await completeAuthoritativeReturn({
      payload: req.body,
      req,
    });

    res.status(result.idempotent ? 200 : 201).json({
      success: true,
      idempotent: result.idempotent,
      returnRecord: result.returnRecord,
      allocation: result.allocation || {
        dueBefore: result.returnRecord.dueBefore,
        outstandingReduction: result.returnRecord.outstandingReduction,
        refundableResidual: result.returnRecord.refundableResidual,
        dueAfter: result.returnRecord.dueAfter,
      },
      message:
        result.returnRecord.refundableResidual > 0
          ? 'Return completed. Outstanding was reduced first; only the paid residual was refunded.'
          : 'Return completed. The return value was applied to the original unpaid due; no advance credit was created.',
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.clearancePreview = async (req, res) => {
  try {

    const snapshot = await getClearanceSnapshot({
      admissionId: req.params.admissionId,
      req,
    });

    res.json({
      success: true,
      preview: {
        admissionId: snapshot.admission._id,
        clearanceStatus: snapshot.admission.pharmacyClearanceStatus,
        sales: snapshot.sales.map((sale) => ({
          _id: sale._id,
          saleNumber: sale.sale_number,
          saleDate: sale.sale_date,
          netAmount: sale.net_amount_after_returns || sale.total_amount,
          paidRetained: sale.amount_paid,
          refunded: sale.refunded_amount || 0,
          due: sale.balance_due,
          returnValue: sale.return_amount || 0,
          paymentDeferred: sale.payment_deferred,
          status: sale.status,
        })),
        outstanding: snapshot.outstanding,
        returnValue: snapshot.returnValue,
        paidRetained: snapshot.paidRetained,
        walletBalances: {
          pharmacyAdvance: snapshot.pharmacyAdvance,
          ipdAdvance: snapshot.ipdAdvance,
        },
        pendingReturnRequests: snapshot.pendingReturns,
        suggestedSettlement: snapshot.suggestedSettlement,
        sourceVersion: snapshot.sourceVersion,
        generatedAt: snapshot.generatedAt,
        canStartClearance:
          snapshot.pendingReturns.length === 0 &&
          snapshot.admission.pharmacyClearanceStatus !== 'cleared',
        canFinalizeWithoutCollection:
          snapshot.outstanding === 0 &&
          snapshot.pendingReturns.length === 0 &&
          snapshot.admission.pharmacyClearanceStatus !== 'cleared',
      },
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.clearanceComplete = async (req, res) => {
  try {

    const result = await completeFinalClearance({
      admissionId: req.params.admissionId,
      payload: req.body,
      req,
    });

    res.json({
      success: true,
      idempotent: result.idempotent,
      settlement: result.settlement,
      message: result.idempotent
        ? 'This final pharmacy clearance request was already completed.'
        : 'Final pharmacy clearance completed after settling open dues and reconciling unused Pharmacy Advance.',
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * This remains available to internal callers, but is intentionally not mounted
 * by pharmacy.routes.js because the current frontend uses the IPD ledger route.
 */
exports.groupedLedger = async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const admissionId = req.query.admissionId;

    const saleFilter = { patient_id: patientId };
    const returnFilter = { patientId };
    const ledgerFilter = { patientId };
    const settlementFilter = { patient_id: patientId };
    const advanceFilter = { patientId };

    if (admissionId) {
      saleFilter.admission_id = admissionId;
      returnFilter.admissionId = admissionId;
      ledgerFilter.admissionId = admissionId;
      settlementFilter.admission_id = admissionId;
      advanceFilter.admissionId = admissionId;
    }

    const [sales, returns, entries, settlements, advances] = await Promise.all([
      Sale.find(saleFilter).sort({ sale_date: -1 }).lean(),
      PharmacyReturn.find(returnFilter).sort({ createdAt: -1 }).lean(),
      PharmacyLedgerEntry.find(ledgerFilter).sort({ entryDate: -1 }).lean(),
      PharmacyLedgerSettlement.find(settlementFilter)
        .sort({ createdAt: -1 })
        .lean(),
      PatientAdvanceLedger.find(advanceFilter).sort({ createdAt: -1 }).lean(),
    ]);

    const groups = new Map();

    const add = (groupId, event) => {
      const id = String(groupId || event.reference || event._id);
      const group = groups.get(id) || {
        transactionGroupId: id,
        date: event.date,
        type: event.type,
        reference: event.reference,
        amount: 0,
        events: [],
      };

      group.events.push(event);
      group.amount = money(group.amount + Number(event.amount || 0));

      if (!group.date || new Date(event.date) > new Date(group.date)) {
        group.date = event.date;
      }

      groups.set(id, group);
    };

    sales.forEach((sale) =>
      add(sale.transactionGroupId || sale._id, {
        _id: sale._id,
        type: 'Pharmacy Sale',
        date: sale.sale_date,
        reference: sale.sale_number,
        amount: sale.total_amount,
        summary: {
          paidNow: sale.amount_paid,
          deferredDue: sale.balance_due,
          returnValue: sale.return_amount || 0,
          refunded: sale.refunded_amount || 0,
        },
      })
    );

    returns.forEach((record) =>
      add(record.transactionGroupId || record._id, {
        _id: record._id,
        type: 'Medicine Return',
        date: record.createdAt,
        reference: record.returnNumber,
        amount: record.totalRefundAmount,
        summary: {
          dueReduction: record.outstandingReduction,
          refundableResidual: record.refundableResidual,
          refundMode: record.refundMode,
        },
      })
    );

    settlements.forEach((settlement) =>
      add(settlement.transactionGroupId || settlement._id, {
        _id: settlement._id,
        type:
          settlement.presentationType === 'FINAL_CLEARANCE'
            ? 'Final Pharmacy Clearance'
            : 'Pharmacy Settlement',
        date: settlement.createdAt,
        reference: settlement.settlement_number,
        amount:
          settlement.payment_received ||
          settlement.discount_applied ||
          0,
        summary: {
          status: settlement.status,
          openingDue: settlement.opening_outstanding_total,
        },
      })
    );

    advances.forEach((advance) =>
      add(advance.transactionGroupId || advance._id, {
        _id: advance._id,
        type:
          advance.transactionType === 'PHARMACY_RETURN_CREDIT'
            ? 'Refund / Wallet Restoration'
            : 'Patient Advance',
        date: advance.createdAt,
        reference: advance.referenceNumber,
        amount: advance.amount,
        summary: {
          direction: advance.direction,
          balanceAfter: advance.balanceAfter,
          walletType: advance.walletType,
        },
      })
    );

    entries
      .filter((entry) => !entry.saleId && !entry.returnId && !entry.settlementId)
      .forEach((entry) =>
        add(entry.transactionGroupId || entry._id, {
          _id: entry._id,
          type: entry.entryType,
          date: entry.entryDate,
          reference: entry._id,
          amount: entry.amount,
          summary: {
            method: entry.paymentMethod,
            notes: entry.notes,
          },
        })
      );

    res.json({
      success: true,
      events: [...groups.values()].sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      ),
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
