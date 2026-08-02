const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const { quotePricing } = require('./pricingEngine.service');
const { syncChargePosted } = require('./sourceBillingSync.service');
const { BILLING_INTENTS } = require('../utils/billingLifecycle');

const SOURCE_CONFIG = {
  LabRequest: {
    Model: LabRequest,
    masterField: 'labTestId',
    codeField: 'testCode',
    nameField: 'testName',
    chargeType: 'Lab Test',
    serviceType: 'lab'
  },
  RadiologyRequest: {
    Model: RadiologyRequest,
    masterField: 'imagingTestId',
    codeField: 'testCode',
    nameField: 'testName',
    chargeType: 'Radiology',
    serviceType: 'radiology'
  },
  ProcedureRequest: {
    Model: ProcedureRequest,
    masterField: 'procedureId',
    codeField: 'procedureCode',
    nameField: 'procedureName',
    chargeType: 'Procedure',
    serviceType: 'procedure'
  }
};

function money(v) {
  return Number(Number(v || 0).toFixed(2));
}

function opts(session) {
  return session ? { session } : {};
}

async function postIPDSourceCharge({
  sourceModule,
  sourceId,
  billingIntent,
  idempotencyKey,
  user,
  session
}) {
  const config = SOURCE_CONFIG[sourceModule];

  if (!config) {
    const e = new Error('Unsupported charge source');
    e.statusCode = 400;
    throw e;
  }

  const request = await config.Model.findOne(
    { _id: sourceId, hospitalId: user.hospital_id },
    null,
    opts(session)
  );

  if (!request) {
    const e = new Error('Source request not found');
    e.statusCode = 404;
    throw e;
  }

  if (request.sourceType !== 'IPD' || !request.admissionId) {
    const e = new Error('Source request is not linked to an IPD admission');
    e.statusCode = 409;
    throw e;
  }

  const admission = await IPDAdmission.findOne(
    { _id: request.admissionId, hospitalId: user.hospital_id },
    null,
    opts(session)
  );

  if (!admission) {
    const e = new Error('IPD admission not found');
    e.statusCode = 404;
    throw e;
  }

  const key = idempotencyKey || `${sourceModule}:${sourceId}:charge`;
  const existing = await IPDCharge.findOne(
    { hospitalId: admission.hospitalId, idempotencyKey: key },
    null,
    opts(session)
  );

  if (existing) {
    return { charge: existing, request, alreadyExists: true };
  }

  const standardAmount = Number(
    request.amount ??
    request.cost ??
    request.price ??
    request.totalAmount ??
    0
  );

  const quote = await quotePricing({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
    serviceDate: request.requestedDate || new Date(),
    chargeType: config.chargeType,
    serviceType: config.serviceType,
    internalServiceId: request[config.masterField],
    externalCode: request[config.codeField],
    standardAmount,
    quantity: 1
  });

  const charge = new IPDCharge({
    hospitalId: admission.hospitalId,
    admissionId: admission._id,
    patientId: request.patientId,
    chargeType: config.chargeType,
    description: request[config.nameField],
    quantity: 1,
    rate: money(quote.amounts.contracted),
    sourceModule,
    sourceId: request._id,
    sourceReference: {
      module: sourceModule,
      documentId: request._id,
      lineKey: 'default'
    },
    idempotencyKey: key,
    addedBy: user._id,
    patientLiability: quote.amounts.patientLiability,
    sponsorLiability: quote.amounts.sponsorLiability,
    nonAdmissibleAmount: quote.amounts.nonAdmissible,
    pricingSnapshot: {
      rateCardId: quote.rateCard?.id,
      rateCardVersion: quote.rateCard?.version,
      rateCardItemId: quote.rateCardItemId,
      serviceCode: quote.serviceCode,
      packageCode: quote.packageCode,
      inputs: quote.inputs,
      amounts: quote.amounts,
      explanation: quote.explanation,
      ruleTrace: quote.ruleTrace,
      pricedAt: new Date()
    }
  });

  await charge.save(opts(session));

  request.billingIntent = billingIntent ||
    request.billingIntent ||
    BILLING_INTENTS.DEFER_TO_ENCOUNTER;

  await syncChargePosted(charge, user._id, session);

  return { charge, request, alreadyExists: false };
}

module.exports = {
  postIPDSourceCharge,
  SOURCE_CONFIG
};