const crypto=require('crypto');const mongoose=require('mongoose');
const Sale=require('../models/Sale');const PharmacyReturn=require('../models/PharmacyReturn');const PharmacyLedgerEntry=require('../models/PharmacyLedgerEntry');const PatientAdvanceLedger=require('../models/PatientAdvanceLedger');const PharmacyLedgerSettlement=require('../models/PharmacyLedgerSettlement');const IPDAdmission=require('../models/IPDAdmission');const MedicineBatch=require('../models/MedicineBatch');const InventoryLedger=require('../models/InventoryLedger');
const {buildSaleItems,calculateTotals,createUnifiedSale,createAdvanceLedgerEntry,getAdvanceBalance}=require('../services/pharmacyTransaction.service');
const {
  buildReturnPreview,
  completeAuthoritativeReturn,
  getClearanceSnapshot,
  completeFinalClearance,
} = require('../services/pharmacyReturnClearance.service');
const money=n=>Math.round((Number(n||0)+Number.EPSILON)*100)/100;const sum=(xs,k='amount')=>money((xs||[]).reduce((s,x)=>s+Number(x[k]||0),0));
function allocations(body,total){const payments=(body.payments||[]).map(p=>({method:p.method||p.paymentMethod||'Cash',amount:money(p.amount),reference:p.reference||p.referenceNumber||'',walletType:p.walletType||null}));if(payments.some(p=>p.amount<=0))throw new Error('Every immediate payment allocation must be positive');const immediate=sum(payments);const advance=money(body.advanceApplied||0);const requestedDeferred=body.deferredAmount===undefined?money(total-immediate-advance):money(body.deferredAmount);if(immediate+advance>total+0.009)throw new Error('Payment allocation exceeds net payable');if(requestedDeferred<0||Math.abs(money(immediate+advance+requestedDeferred)-total)>0.009)throw new Error('Net Sale Amount must equal Immediate Payment Total + Advance Applied + Deferred Outstanding');return {payments,immediate,advance,deferred:requestedDeferred};}
function groupId(key){return key||crypto.randomUUID();}
function saleHospitalGuard(req,sale){if(req.user.role!=='mediqliq_super_admin'&&req.user.hospital_id&&sale.hospitalId&&String(req.user.hospital_id)!==String(sale.hospitalId)){const e=new Error('Cross-hospital access denied');e.status=403;throw e;}}
exports.quotePos=async(req,res)=>{try{const items=await buildSaleItems(req.body.items||[],{honorLooseSale:req.body.allowLooseSale!==false});const totals=calculateTotals(items,req.body);const allocation=allocations(req.body,totals.total);res.json({success:true,quote:{items:items.map(({_batch,_medicine,...item})=>item),netAmount:money(totals.total),immediatePaymentTotal:allocation.immediate,advanceApplied:allocation.advance,deferredOutstanding:allocation.deferred,invariantOk:true}});}catch(error){res.status(400).json({success:false,message:error.message});}};
exports.completePos=async(req,res)=>{try{
 const idempotencyKey=req.headers['idempotency-key']||req.body.idempotencyKey; if(!idempotencyKey)return res.status(400).json({success:false,message:'Idempotency-Key is required'});
 const existing=await Sale.findOne({hospitalId:req.user.hospital_id,idempotencyKey});if(existing)return res.json({success:true,idempotent:true,sale:existing});
 const items=await buildSaleItems(req.body.items||[],{honorLooseSale:req.body.allowLooseSale!==false});const totals=calculateTotals(items,req.body);const allocation=allocations(req.body,totals.total);const transactionGroupId=groupId(req.body.transactionGroupId||idempotencyKey);
 const payload={...req.body,items:req.body.items,payments:allocation.payments,payment_method:allocation.payments.length>1?'Split':allocation.payments[0]?.method||(allocation.deferred>0?'Deferred':'Cash'),payment_deferred:allocation.deferred>0,noPayment:allocation.immediate===0&&allocation.advance===0,pay_nothing:allocation.immediate===0&&allocation.advance===0,overpayment_amount:0,total_collected_amount:allocation.immediate};
 const result=await createUnifiedSale(payload,req);const sale=await Sale.findById(result.sale?._id||result.sale?.id);if(!sale)throw new Error('Sale completion did not return a sale record');sale.transactionGroupId=transactionGroupId;sale.idempotencyKey=idempotencyKey;sale.presentationType='PHARMACY_SALE';sale.payments=allocation.payments.map(p=>({...p,transactionGroupId,parentGroupId:transactionGroupId,idempotencyKey,presentationType:'PAYMENT_ALLOCATION'}));sale.amount_paid=allocation.immediate;sale.balance_due=allocation.deferred;sale.payment_deferred=allocation.deferred>0;sale.status=allocation.deferred>0?'Pending':'Completed';await sale.save();await PharmacyLedgerEntry.updateMany({saleId:sale._id,transactionGroupId:{$exists:false}},{$set:{transactionGroupId,parentGroupId:transactionGroupId,idempotencyKey,presentationType:'PHARMACY_SALE'}});res.status(201).json({success:true,sale,receipt:{netSaleAmount:money(totals.total),immediatePaymentTotal:allocation.immediate,advanceApplied:allocation.advance,deferredOutstanding:allocation.deferred,allocations:allocation.payments}});
}catch(error){res.status(error.status||400).json({success:false,message:error.message});}};



/** Returns and pharmacy clearance use the shared authoritative service. */
exports.previewReturn = async (req, res) => {
  try {
    const preview = await buildReturnPreview({
      saleId: req.body.saleId || req.body.originalSaleId || req.body.original_sale_id,
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
        refundMethods: preview.allocation.refundableResidual > 0
          ? ['Cash', 'UPI', 'Card', 'IPDAdvance', 'PharmacyAdvance']
          : ['NoRefund'],
        message: preview.allocation.refundableResidual > 0
          ? 'The unpaid due is reduced first. Only the paid excess is refundable.'
          : 'No refund is due. The full return value reduces the original unpaid pharmacy due.',
      },
    });
  } catch (error) {
    res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

exports.completeReturn = async (req, res) => {
  try {
    const result = await completeAuthoritativeReturn({ payload: req.body, req });
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
      message: result.returnRecord.refundableResidual > 0
        ? 'Return completed. Outstanding was reduced first; only the paid residual was refunded.'
        : 'Return completed. The return value was applied to the original unpaid due; no advance credit was created.',
    });
  } catch (error) {
    res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

exports.clearancePreview = async (req, res) => {
  try {
    const snapshot = await getClearanceSnapshot({ admissionId: req.params.admissionId, req });
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
        // A clearance can START with open dues because this engine settles them.
        // It can only POST when the client supplies matching payment/advance/refund allocations.
        canStartClearance: snapshot.pendingReturns.length === 0 && snapshot.admission.pharmacyClearanceStatus !== 'cleared',
        canFinalizeWithoutCollection: snapshot.outstanding === 0 && snapshot.pendingReturns.length === 0 && snapshot.admission.pharmacyClearanceStatus !== 'cleared',
      },
    });
  } catch (error) {
    res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

exports.clearanceComplete = async (req, res) => {
  try {
    const result = await completeFinalClearance({ admissionId: req.params.admissionId, payload: req.body, req });
    res.json({
      success: true,
      idempotent: result.idempotent,
      settlement: result.settlement,
      message: result.idempotent
        ? 'This final pharmacy clearance request was already completed.'
        : 'Final pharmacy clearance completed after settling open dues and reconciling unused Pharmacy Advance.',
    });
  } catch (error) {
    res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

/**
 * Patient-facing grouped view. Raw journal rows remain available to Finance;
 * this endpoint deliberately returns one comprehensible business event/group.
 */
exports.groupedLedger = async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const admissionId = req.query.admissionId;
    const filter = { patient_id: patientId };
    if (admissionId) filter.admission_id = admissionId;

    const [sales, returns, entries, settlements, advances] = await Promise.all([
      Sale.find(filter).sort({ sale_date: -1 }).lean(),
      PharmacyReturn.find({ patientId, ...(admissionId ? { admissionId } : {}) }).sort({ createdAt: -1 }).lean(),
      PharmacyLedgerEntry.find({ patientId, ...(admissionId ? { admissionId } : {}) }).sort({ entryDate: -1 }).lean(),
      PharmacyLedgerSettlement.find({ patient_id: patientId, ...(admissionId ? { admission_id: admissionId } : {}) }).sort({ createdAt: -1 }).lean(),
      PatientAdvanceLedger.find({ patientId, ...(admissionId ? { admissionId } : {}) }).sort({ createdAt: -1 }).lean(),
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
      if (!group.date || new Date(event.date) > new Date(group.date)) group.date = event.date;
      groups.set(id, group);
    };

    sales.forEach((sale) => add(sale.transactionGroupId || sale._id, {
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
    }));
    returns.forEach((record) => add(record.transactionGroupId || record._id, {
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
    }));
    settlements.forEach((settlement) => add(settlement.transactionGroupId || settlement._id, {
      _id: settlement._id,
      type: settlement.presentationType === 'FINAL_CLEARANCE' ? 'Final Pharmacy Clearance' : 'Pharmacy Settlement',
      date: settlement.createdAt,
      reference: settlement.settlement_number,
      amount: settlement.payment_received || settlement.discount_applied || 0,
      summary: { status: settlement.status, openingDue: settlement.opening_outstanding_total },
    }));
    advances.forEach((advance) => add(advance.transactionGroupId || advance._id, {
      _id: advance._id,
      type: advance.transactionType === 'PHARMACY_RETURN_CREDIT' ? 'Refund / Wallet Restoration' : 'Patient Advance',
      date: advance.createdAt,
      reference: advance.referenceNumber,
      amount: advance.amount,
      summary: { direction: advance.direction, balanceAfter: advance.balanceAfter, walletType: advance.walletType },
    }));
    entries
      .filter((entry) => !entry.saleId && !entry.returnId && !entry.settlementId)
      .forEach((entry) => add(entry.transactionGroupId || entry._id, {
        _id: entry._id,
        type: entry.entryType,
        date: entry.entryDate,
        reference: entry._id,
        amount: entry.amount,
        summary: { method: entry.paymentMethod, notes: entry.notes },
      }));

    res.json({
      success: true,
      events: [...groups.values()].sort((a, b) => new Date(b.date) - new Date(a.date)),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
