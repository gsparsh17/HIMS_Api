const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const { quotePricing, pricingSnapshot } = require('./pricingEngine.service');
const { activatePackageEpisode, recordPackageUtilization } = require('./packageAdjudication.service');
const { activeCoverage } = require('./coverage.service');
const { replaceCoverageUtilization } = require('./coverageUtilization.service');
const { syncChargePosted } = require('./sourceBillingSync.service');
const { BILLING_INTENTS } = require('../utils/billingLifecycle');

const SOURCE_CONFIG = {
  LabRequest: {
    Model: LabRequest,
    masterField: 'labTestId',
    codeField: 'testCode',
    nameField: 'testName',
    chargeType: 'Lab Test',
    serviceType: 'laboratory',
    internalServiceModel: 'LabTest'
  },
  RadiologyRequest: {
    Model: RadiologyRequest,
    masterField: 'imagingTestId',
    codeField: 'testCode',
    nameField: 'testName',
    chargeType: 'Radiology',
    serviceType: 'radiology',
    internalServiceModel: 'ImagingTest'
  },
  ProcedureRequest: {
    Model: ProcedureRequest,
    masterField: 'procedureId',
    codeField: 'procedureCode',
    nameField: 'procedureName',
    chargeType: 'Procedure',
    serviceType: 'procedure',
    internalServiceModel: 'Procedure'
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
    serviceDate: request.requestedDate || operationNow(),
    chargeType: config.chargeType,
    serviceType: config.serviceType,
    internalServiceModel: config.internalServiceModel,
    internalServiceId: request[config.masterField],
    internalCode: request[config.codeField],
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
    pricingSnapshot: pricingSnapshot(quote, {
      internalServiceModel: config.internalServiceModel,
      internalServiceId: request[config.masterField]
    })
  });

  await charge.save(opts(session));

  const coverage = await activeCoverage(admission.hospitalId, admission._id, session);
  await replaceCoverageUtilization({
    coverage,
    quote,
    hospitalId: admission.hospitalId,
    encounterType: 'IPD',
    admissionId: admission._id,
    patientId: request.patientId,
    sourceType: 'IPDCharge',
    sourceId: charge._id,
    internalServiceModel: config.internalServiceModel,
    internalServiceId: request[config.masterField],
    userId: user._id,
    session
  });

  let packageEpisode = null;
  if (coverage && quote.rateCardItemId && quote.packageCode) {
    packageEpisode = await activatePackageEpisode({
      quote, coverage, hospitalId: admission.hospitalId, encounterType: 'IPD', encounterId: admission._id,
      patientId: request.patientId, sourceType: 'IPDCharge', sourceId: charge._id, userId: user._id, session
    });
  }
  if (quote.packageAdjudication) {
    await recordPackageUtilization({
      decision: quote.packageAdjudication,
      input: { serviceType: config.serviceType, internalServiceModel: config.internalServiceModel, internalServiceId: request[config.masterField], internalCode: request[config.codeField], description: request[config.nameField], quantity: 1 },
      quote, sourceType: 'IPDCharge', sourceId: charge._id, session
    });
  }

  request.billingIntent = billingIntent ||
    request.billingIntent ||
    BILLING_INTENTS.DEFER_TO_ENCOUNTER;

  await syncChargePosted(charge, user._id, session);

  return { charge, request, packageEpisode, alreadyExists: false };
}

module.exports = {
  postIPDSourceCharge,
  SOURCE_CONFIG
};