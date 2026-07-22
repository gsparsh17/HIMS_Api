const StorePurchaseRequisition = require('../models/StorePurchaseRequisition');
const StoreRFQ = require('../models/StoreRFQ');
const StoreQuotation = require('../models/StoreQuotation');
const AssetRegister = require('../models/AssetRegister');
const InventoryRecall = require('../models/InventoryRecall');
const InventoryLot = require('../models/InventoryLot');
const StoreInventoryTransaction = require('../models/StoreInventoryTransaction');
const StorePurchaseOrder = require('../models/StorePurchaseOrder');
const mongoose = require('mongoose');
const { requireHospitalId } = require('../services/tenantScope.service');
const { nextNumber } = require('../services/hospitalSequence.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

function page(req) { return Math.max(1, Number(req.query.page || 1)); }
function limit(req) { return Math.min(250, Math.max(1, Number(req.query.limit || 50))); }
async function list(Model, req, populate = '') {
  const hospitalId = requireHospitalId(req); const filter = { hospitalId };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) filter.$or = ['requisitionNumber','rfqNumber','quotationNumber','assetTag','name','recallNumber'].map((key) => ({ [key]: { $regex: req.query.search, $options: 'i' } }));
  const [data, total] = await Promise.all([Model.find(filter).sort({ createdAt: -1 }).skip((page(req)-1)*limit(req)).limit(limit(req)).populate(populate), Model.countDocuments(filter)]);
  return { data, total, page: page(req), limit: limit(req) };
}
function ensureLines(body) { if (!Array.isArray(body.lines) || !body.lines.length) throw Object.assign(new Error('At least one line is required'), { statusCode: 400 }); }
async function transition(req, Model, allowed, nextStatus) {
  const hospitalId = requireHospitalId(req); const record = await Model.findOne({ _id: req.params.id, hospitalId });
  if (!record) throw Object.assign(new Error('Record not found'), { statusCode: 404 });
  if (!allowed.includes(record.status)) throw Object.assign(new Error(`Cannot change ${record.status} to ${nextStatus}`), { statusCode: 409 });
  record.status = nextStatus; record.version = Number(record.version || 0) + 1;
  if (record.approvals) record.approvals.push({ action: nextStatus, by: req.user._id, at: new Date(), remarks: req.body.remarks });
  await record.save(); return record;
}

exports.listPurchaseRequisitions = async (req,res,next)=>{try{res.json({success:true,...await list(StorePurchaseRequisition,req,'requestedBy requestedByDepartmentId lines.itemId')});}catch(e){next(e);}};
exports.createPurchaseRequisition = async (req,res,next)=>{try{ensureLines(req.body);const hospitalId=requireHospitalId(req);const requisitionNumber=await nextNumber(hospitalId,'purchase-requisition','PREQ');const record=await StorePurchaseRequisition.create({...req.body,hospitalId,requisitionNumber,requestedBy:req.user._id});res.status(201).json({success:true,data:record});}catch(e){next(e);}};
exports.transitionPurchaseRequisition = async (req,res,next)=>{try{const map={submit:[['Draft'],'Submitted'],approve:[['Submitted'],'Approved'],reject:[['Submitted','Approved'],'Rejected'],close:[['PO Created','Approved'],'Closed'],cancel:[['Draft','Submitted','Approved'],'Cancelled']};const action=map[req.params.action];if(!action)return res.status(400).json({error:'Unsupported action'});const record=await transition(req,StorePurchaseRequisition,...action);res.json({success:true,data:record});}catch(e){next(e);}};

exports.listRfqs = async (req,res,next)=>{try{res.json({success:true,...await list(StoreRFQ,req,'purchaseRequisitionId supplierIds lines.itemId')});}catch(e){next(e);}};
exports.createRfq = async (req,res,next)=>{try{ensureLines(req.body);const hospitalId=requireHospitalId(req);const rfqNumber=await nextNumber(hospitalId,'store-rfq','RFQ');const record=await StoreRFQ.create({...req.body,hospitalId,rfqNumber,createdBy:req.user._id});await StorePurchaseRequisition.findOneAndUpdate({_id:req.body.purchaseRequisitionId,hospitalId},{$set:{status:'RFQ Created'},$inc:{version:1}});res.status(201).json({success:true,data:record});}catch(e){next(e);}};
exports.transitionRfq = async (req,res,next)=>{try{const map={issue:[['Draft'],'Issued'],responses:[['Issued'],'Responses Received'],compare:[['Responses Received'],'Compared'],award:[['Compared'],'Awarded'],close:[['Awarded'],'Closed'],cancel:[['Draft','Issued'],'Cancelled']};const action=map[req.params.action];if(!action)return res.status(400).json({error:'Unsupported action'});const record=await transition(req,StoreRFQ,...action);res.json({success:true,data:record});}catch(e){next(e);}};

exports.listQuotations = async (req,res,next)=>{try{res.json({success:true,...await list(StoreQuotation,req,'rfqId supplierId lines.itemId')});}catch(e){next(e);}};
exports.createQuotation = async (req,res,next)=>{try{ensureLines(req.body);const hospitalId=requireHospitalId(req);const quotationNumber=await nextNumber(hospitalId,'store-quotation','QUO');const lines=req.body.lines;const computed=lines.reduce((sum,l)=>sum+(Number(l.quantity||0)*Number(l.unitPrice||0))*(1+Number(l.taxPercent||0)/100)*(1-Number(l.discountPercent||0)/100),0)+Number(req.body.freight||0)+Number(req.body.otherCharges||0);const record=await StoreQuotation.create({...req.body,hospitalId,quotationNumber,totalAmount:req.body.totalAmount??computed,receivedBy:req.user._id});res.status(201).json({success:true,data:record});}catch(e){next(e);}};
exports.compareQuotations = async (req,res,next)=>{try{const hospitalId=requireHospitalId(req);const rows=await StoreQuotation.find({hospitalId,rfqId:req.params.rfqId,status:{$ne:'Rejected'}}).populate('supplierId lines.itemId');rows.sort((a,b)=>Number(a.totalAmount||0)-Number(b.totalAmount||0));for(let i=0;i<rows.length;i+=1){rows[i].rank=i+1;rows[i].commercialScore=rows[0]?.totalAmount?Math.round((rows[0].totalAmount/rows[i].totalAmount)*100):0;await rows[i].save();}await StoreRFQ.findOneAndUpdate({_id:req.params.rfqId,hospitalId},{$set:{status:'Compared'},$inc:{version:1}});res.json({success:true,data:rows});}catch(e){next(e);}};
exports.selectQuotation = async (req,res,next)=>{try{const hospitalId=requireHospitalId(req);const record=await StoreQuotation.findOne({_id:req.params.id,hospitalId});if(!record)return res.status(404).json({error:'Quotation not found'});await StoreQuotation.updateMany({hospitalId,rfqId:record.rfqId,_id:{$ne:record._id}},{$set:{status:'Not Selected'}});record.status='Selected';await record.save();await StoreRFQ.findOneAndUpdate({_id:record.rfqId,hospitalId},{$set:{status:'Awarded'},$inc:{version:1}});res.json({success:true,data:record});}catch(e){next(e);}};

exports.listAssets = async (req,res,next)=>{try{res.json({success:true,...await list(AssetRegister,req,'itemId locationId custodianUserId')});}catch(e){next(e);}};
exports.createAsset = async (req,res,next)=>{try{const hospitalId=requireHospitalId(req);const assetTag=req.body.assetTag||await nextNumber(hospitalId,'asset-register','AST');const record=await AssetRegister.create({...req.body,hospitalId,assetTag,createdBy:req.user._id});res.status(201).json({success:true,data:record});}catch(e){next(e);}};
exports.updateAsset = async (req,res,next)=>{try{const hospitalId=requireHospitalId(req);const record=await AssetRegister.findOneAndUpdate({_id:req.params.id,hospitalId},{$set:req.body,$inc:{version:1}},{new:true});if(!record)return res.status(404).json({error:'Asset not found'});res.json({success:true,data:record});}catch(e){next(e);}};
exports.addAssetMaintenance = async (req,res,next)=>{try{const hospitalId=requireHospitalId(req);const record=await AssetRegister.findOneAndUpdate({_id:req.params.id,hospitalId},{$push:{maintenanceHistory:{...req.body,date:req.body.date||new Date(),recordedBy:req.user._id}},$set:{status:req.body.status||'Under Maintenance'},$inc:{version:1}},{new:true});if(!record)return res.status(404).json({error:'Asset not found'});res.json({success:true,data:record});}catch(e){next(e);}};

exports.listRecalls = async (req,res,next)=>{try{res.json({success:true,...await list(InventoryRecall,req,'itemId lotIds tracedLocations.locationId')});}catch(e){next(e);}};
exports.createRecall = async (req,res,next)=>{try{const hospitalId=requireHospitalId(req);const recallNumber=await nextNumber(hospitalId,'inventory-recall','RCL');const record=await InventoryRecall.create({...req.body,hospitalId,recallNumber,initiatedBy:req.user._id});await InventoryLot.updateMany({_id:{$in:req.body.lotIds||[]},hospitalId},{$set:{qualityStatus:'Recalled'}});res.status(201).json({success:true,data:record});}catch(e){next(e);}};
exports.traceRecall = async (req,res,next)=>{try{const hospitalId=requireHospitalId(req);const record=await InventoryRecall.findOne({_id:req.params.id,hospitalId});if(!record)return res.status(404).json({error:'Recall not found'});const tx=await StoreInventoryTransaction.find({hospital_id:hospitalId,lot:{$in:record.lotIds}}).lean();record.tracedIssues=tx.filter(t=>t.patient_id||t.admission_id||t.ot_case_id).map(t=>({issueId:t.reference_id,patientId:t.patient_id,admissionId:t.admission_id,otCaseId:t.ot_case_id,quantity:t.quantity}));record.status='Tracing';record.actions.push({action:'Trace completed',by:req.user._id,at:new Date(),notes:`${tx.length} transactions found`});await record.save();res.json({success:true,data:{record,transactions:tx}});}catch(e){next(e);}};
exports.transitionRecall = async (req,res,next)=>{try{const map={quarantine:[['Open','Tracing'],'Quarantined'],recover:[['Quarantined'],'Recovered'],close:[['Recovered','Quarantined'],'Closed'],cancel:[['Open'],'Cancelled']};const action=map[req.params.action];if(!action)return res.status(400).json({error:'Unsupported action'});const record=await transition(req,InventoryRecall,...action);if(record.status==='Closed')record.closedAt=new Date();record.actions.push({action:record.status,by:req.user._id,at:new Date(),notes:req.body.notes});await record.save();res.json({success:true,data:record});}catch(e){next(e);}};


exports.createPurchaseOrderFromQuotation = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const hospitalId = requireHospitalId(req);
    let purchaseOrder;
    await session.withTransaction(async () => {
      const quotation = await StoreQuotation.findOne({ _id: req.params.id, hospitalId }).populate('supplierId').session(session);
      if (!quotation) throw Object.assign(new Error('Quotation not found'), { statusCode: 404 });
      if (!['Selected', 'Shortlisted', 'Validated', 'Received'].includes(quotation.status)) throw Object.assign(new Error(`Cannot create a purchase order from ${quotation.status} quotation`), { statusCode: 409 });
      const supplier = quotation.supplierId || {};
      purchaseOrder = await StorePurchaseOrder.create([{
        supplier_name: supplier.companyName || supplier.name || 'Selected supplier',
        supplier_phone: supplier.phone,
        supplier_email: supplier.email,
        supplier_gst: supplier.gstNo,
        order_date: new Date(),
        expected_delivery_date: req.body.expectedDeliveryDate,
        items: quotation.lines.map((line) => ({
          item: line.itemId,
          description: [line.brand, line.remarks].filter(Boolean).join(' · '),
          quantity: Number(line.quantity || 0),
          unit_price: Number(line.unitPrice || 0),
          tax_rate: Number(line.taxPercent || 0),
          unit: line.unit || 'pcs'
        })),
        shipping_amount: Number(quotation.freight || 0) + Number(quotation.otherCharges || 0),
        discount_amount: quotation.lines.reduce((sum, line) => sum + (Number(line.quantity || 0) * Number(line.unitPrice || 0) * Number(line.discountPercent || 0) / 100), 0),
        status: req.body.autoApprove === true ? 'Approved' : 'Draft',
        approved_by: req.body.autoApprove === true ? req.user._id : undefined,
        terms: [quotation.paymentTerms, quotation.warrantyTerms].filter(Boolean).join('\n'),
        notes: `Created from quotation ${quotation.quotationNumber}`,
        hospital_id: hospitalId,
        created_by: req.user._id,
        revision: 1
      }], { session }).then((rows) => rows[0]);
      quotation.status = 'Selected'; quotation.version = Number(quotation.version || 0) + 1; await quotation.save({ session });
      const rfq = await StoreRFQ.findOneAndUpdate({ _id: quotation.rfqId, hospitalId }, { $set: { status: 'Awarded' }, $inc: { version: 1 } }, { new: true, session });
      if (rfq?.purchaseRequisitionId) await StorePurchaseRequisition.findOneAndUpdate({ _id: rfq.purchaseRequisitionId, hospitalId }, { $set: { status: 'PO Created' }, $inc: { version: 1 } }, { session });
    });
    res.status(201).json({ success: true, data: purchaseOrder });
  } catch (error) { next(error); }
  finally { await session.endSession(); }
};
