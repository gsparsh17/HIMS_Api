const Procedure = require('../models/Procedure');
const OTAdditionalProcedure = require('../models/OTAdditionalProcedure');
const IPDCharge = require('../models/IPDCharge');
const ipdFinancial = require('./ipdFinancial.service');

async function addAdditionalProcedure({ otCase, payload = {}, user }) {
  const procedureId = payload.procedureId;
  if (!procedureId) throw Object.assign(new Error('Additional procedure is required'), { statusCode: 400 });
  const clinicalJustification = String(payload.clinicalJustification || payload.reason || '').trim();
  if (!clinicalJustification) throw Object.assign(new Error('Clinical justification is required for an additional OT procedure'), { statusCode: 400 });

  const procedure = await Procedure.findOne({
    _id: procedureId,
    hospitalId: otCase.hospitalId,
    is_active: { $ne: false },
    is_billable: { $ne: false }
  });
  if (!procedure) throw Object.assign(new Error('Procedure master not found or inactive'), { statusCode: 404 });

  const idempotencyKey = String(payload.idempotencyKey || '').trim() || undefined;
  if (idempotencyKey) {
    const existing = await OTAdditionalProcedure.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id, idempotencyKey });
    if (existing) return existing;
  }

  const record = await OTAdditionalProcedure.create({
    hospitalId: otCase.hospitalId,
    caseId: otCase._id,
    admissionId: otCase.admissionId,
    patientId: otCase.patientId,
    procedureId: procedure._id,
    procedureCode: procedure.code,
    procedureName: procedure.name,
    clinicalJustification,
    quantity: Math.max(1, Number(payload.quantity || 1)),
    sameOtSessionIndex: Math.max(2, Number(payload.sameOtSessionIndex || 2)),
    idempotencyKey,
    addedBy: user._id,
    notes: payload.notes
  });

  try {
    const chargeKey = `OT:${otCase._id}:additional-procedure:${record._id}`;
    let charge = await IPDCharge.findOne({ hospitalId: otCase.hospitalId, idempotencyKey: chargeKey });
    if (!charge) {
      charge = await ipdFinancial.addManualCharge({
        admissionId: otCase.admissionId,
        chargeType: 'Procedure',
        serviceType: 'procedure',
        internalServiceModel: 'Procedure',
        internalServiceId: procedure._id,
        serviceCode: procedure.code,
        description: `${procedure.name} (additional OT procedure)`,
        quantity: record.quantity,
        rate: Number(procedure.base_price || procedure.basePrice || procedure.price || 1),
        sameOtSessionIndex: record.sameOtSessionIndex,
        sourceModule: 'OT',
        sourceId: otCase._id,
        sourceReference: { sourceType: 'OT', documentId: record._id, lineKey: chargeKey },
        idempotencyKey: chargeKey,
        allowStandardFallback: true,
        notes: clinicalJustification
      }, user);
    }
    record.billingChargeId = charge._id;
    record.billingStatus = Number(charge.packageAbsorbedAmount || charge.pricingSnapshot?.amounts?.packageAbsorbed || 0) > 0
      && Number(charge.patientLiability || 0) === 0 && Number(charge.sponsorLiability || 0) === 0
      ? 'Package Covered'
      : 'Posted';
    record.pricingSnapshot = charge.pricingSnapshot;
    await record.save();
  } catch (error) {
    record.billingStatus = 'Failed';
    record.notes = [record.notes, `Billing pending: ${error.message}`].filter(Boolean).join('\n');
    await record.save();
    error.additionalProcedureId = record._id;
    throw error;
  }

  return record;
}

module.exports = { addAdditionalProcedure };
