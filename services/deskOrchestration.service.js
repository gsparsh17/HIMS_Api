const crypto = require('crypto');
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const IPDAdmission = require('../models/IPDAdmission');
const DeskCheckout = require('../models/DeskCheckout');
const patientFinancial = require('./patientFinancial.service');
const ipdFinancial = require('./ipdFinancial.service');
const { searchServiceCatalog } = require('./serviceCatalog.service');
const { normalizeIndianPhone, demographicsFromInput } = require('../utils/patientDemographics');
const { userHospitalId } = require('../utils/hospitalScope');

const round = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const stableHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allowedIntents = new Set([
  'DEFER_TO_ENCOUNTER',
  'BILL_NOW',
  'ADD_TO_OPD_CART',
  'PACKAGE_INCLUDED',
  'NO_CHARGE',
  'EXTERNAL_REFERRAL'
]);

function checkoutError(message, statusCode = 400, code = 'DESK_CHECKOUT_INVALID', details = {}) {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function normalizeCart(cart, encounterType) {
  if (!Array.isArray(cart) || !cart.length) {
    throw checkoutError('Add at least one service to the cart');
  }

  return cart.map((row, index) => {
    const quantity = Math.max(1, Number(row.quantity || 1));
    const rate = Math.max(0, Number(row.rate ?? row.defaultRate ?? 0));
    const intent = String(row.billingIntent || (encounterType === 'IPD' ? 'DEFER_TO_ENCOUNTER' : 'ADD_TO_OPD_CART'));

    if (!allowedIntents.has(intent)) {
      throw checkoutError(`Invalid billing intent on row ${index + 1}`);
    }

    return {
      ...row,
      quantity,
      rate,
      billingIntent: intent,
      gross: round(quantity * rate)
    };
  });
}

async function authoritativeCart({ user, cart, encounterType }) {
  const rows = normalizeCart(cart, encounterType);
  const out = [];

  for (const row of rows) {
    if (!row.masterId || row.serviceType === 'MANUAL') {
      if (row.serviceType === 'MANUAL' && !String(row.name || '').trim()) {
        throw checkoutError('Manual service description is required');
      }
      out.push(row);
      continue;
    }

    const matches = await searchServiceCatalog({
      user,
      query: row.code || row.name,
      encounterType,
      limit: 60
    });

    const match = matches.find(item =>
      String(item.masterId || '') === String(row.masterId) &&
      item.serviceType === row.serviceType
    );

    if (!match) {
      throw checkoutError(`Service is inactive or unavailable: ${row.name || row.code}`);
    }

    out.push({
      ...row,
      name: match.name,
      code: match.code,
      rate: match.defaultRate,
      gross: round(row.quantity * match.defaultRate),
      pricingDifference: round(match.defaultRate - Number(row.rate || 0))
    });
  }

  return out;
}

async function resolvePatient({ hospitalId, patientSelection, quickPatient }) {
  if (patientSelection?.patientId) {
    const patient = await Patient.findOne({
      _id: patientSelection.patientId,
      hospitalId
    });

    if (!patient) {
      throw checkoutError('Selected patient was not found', 404);
    }

    return { patient, created: false };
  }

  if (!quickPatient) {
    throw checkoutError('Select or create a patient');
  }

  const normalizedPhone = normalizeIndianPhone(quickPatient.phone);
  const demographics = demographicsFromInput(quickPatient);

  const duplicate = await Patient.findOne({
    hospitalId,
    normalizedPhone,
    first_name: new RegExp(`^${String(quickPatient.first_name || '').trim()}$`, 'i')
  });

  if (duplicate) {
    return { patient: duplicate, created: false, duplicateMatched: true };
  }

  const [patient] = await Patient.create([{
    hospitalId,
    first_name: String(quickPatient.first_name || '').trim(),
    middle_name: String(quickPatient.middle_name || '').trim(),
    last_name: String(quickPatient.last_name || '').trim(),
    phone: normalizedPhone,
    normalizedPhone,
    gender: quickPatient.gender,
    patient_type: quickPatient.patient_type || 'opd',
    ...demographics
  }]);

  return { patient, created: true };
}

function previewTotals(rows) {
  const gross = round(rows.reduce((sum, row) => sum + row.gross, 0));
  const noLiability = round(rows
    .filter(row => ['PACKAGE_INCLUDED', 'NO_CHARGE', 'EXTERNAL_REFERRAL'].includes(row.billingIntent))
    .reduce((sum, row) => sum + row.gross, 0)
  );

  return {
    gross,
    lineDiscount: 0,
    tax: 0,
    noLiability,
    net: round(gross - noLiability),
    payableNow: round(rows
      .filter(row => ['BILL_NOW', 'ADD_TO_OPD_CART'].includes(row.billingIntent))
      .reduce((sum, row) => sum + row.gross, 0)
    )
  };
}

function previewPayment(totals, payment, encounterType) {
  if (!payment?.collectNow) return null;

  if (encounterType !== 'OPD') {
    throw checkoutError(
      'Desk payment collection is currently available for OPD checkout only',
      400,
      'DESK_IPD_PAYMENT_NOT_SUPPORTED'
    );
  }

  const taxAdjustment = round(payment.taxAdjustmentAmount);
  const discount = round(payment.settlementDiscountAmount);
  const outstandingBefore = totals.payableNow;
  const netPayable = round(Math.max(0, outstandingBefore + taxAdjustment - discount));
  const amountApplied = round(payment.amountApplied ?? netPayable);
  const amountTendered = round(payment.amountTendered ?? amountApplied);
  const overpayment = round(Math.max(0, amountApplied - netPayable));
  const changeReturned = payment.overpaymentDisposition === 'RETURN_CHANGE'
    ? round(Math.max(0, amountTendered - Math.min(amountApplied, netPayable)))
    : 0;
  const advanceCreated = payment.overpaymentDisposition === 'CREATE_ADVANCE' ? overpayment : 0;

  const warnings = [];

  if (discount > 0 && !String(payment.settlementDiscountReason || '').trim()) {
    warnings.push({
      code: 'DISCOUNT_REASON_REQUIRED',
      message: 'Settlement discount reason is required.'
    });
  }

  if (taxAdjustment !== 0 && !String(payment.taxAdjustmentReason || '').trim()) {
    warnings.push({
      code: 'TAX_REASON_REQUIRED',
      message: 'Tax adjustment reason is required.'
    });
  }

  if (overpayment > 0 && !payment.overpaymentDisposition) {
    warnings.push({
      code: 'OVERPAYMENT_DISPOSITION_REQUIRED',
      message: 'Choose return change or credit excess to patient advance.'
    });
  }

  return {
    outstandingBefore,
    taxAdjustment,
    settlementDiscount: discount,
    netPayable,
    amountApplied,
    amountTendered,
    overpayment,
    changeReturned,
    advanceCreated,
    balanceAfter: round(Math.max(0, netPayable - Math.min(amountApplied, netPayable))),
    canSubmit: warnings.length === 0,
    warnings,
    suggestedPayment: {
      amountApplied: netPayable,
      amountTendered: netPayable
    }
  };
}

function clinicalActionFor(row) {
  const labels = {
    LAB: 'Create lab request',
    RADIOLOGY: 'Create radiology request',
    PROCEDURE: 'Create procedure request',
    CONSULTATION: 'Create consultation item',
    REGISTRATION: 'Create registration item',
    ADMISSION: 'Create admission item',
    NURSING: 'Create nursing charge',
    OT: 'Create OT charge'
  };

  return labels[row.serviceType] || 'Create service item';
}

function financialActionFor(row, encounterType) {
  if (row.billingIntent === 'NO_CHARGE') return 'No financial liability';
  if (row.billingIntent === 'PACKAGE_INCLUDED') return 'Package-covered liability';
  if (row.billingIntent === 'EXTERNAL_REFERRAL') return 'External/referral record';

  if (encounterType === 'IPD') {
    return row.billingIntent === 'BILL_NOW'
      ? 'Post charge and issue interim invoice'
      : 'Post to running IPD account';
  }

  return 'Add to consolidated OPD invoice';
}

async function previewDeskCheckout(payload, user) {
  const encounterType = String(payload.encounterType || 'OPD').toUpperCase();

  if (!['OPD', 'IPD'].includes(encounterType)) {
    throw checkoutError('Encounter type must be OPD or IPD');
  }

  const rows = await authoritativeCart({ user, cart: payload.serviceCart, encounterType });

  const decoratedRows = rows.map(row => ({
    ...row,
    clinicalAction: clinicalActionFor(row),
    financialAction: financialActionFor(row, encounterType)
  }));

  const totals = previewTotals(decoratedRows);
  const payment = previewPayment(totals, payload.payment, encounterType);

  const warnings = [
    ...decoratedRows
      .filter(row => row.pricingDifference)
      .map(row => ({
        code: 'RATE_REFRESHED',
        service: row.name,
        difference: row.pricingDifference
      })),
    ...(payment?.warnings || [])
  ];

  const canonicalPayload = {
    patientSelection: payload.patientSelection || null,
    quickPatient: payload.quickPatient || null,
    encounterType,
    encounterAction: payload.encounterAction || null,
    estimateOnly: Boolean(payload.estimateOnly),
    admissionId: payload.admissionId || null,
    serviceCart: decoratedRows.map(({ pricingDifference, clinicalAction, financialAction, gross, ...row }) => row),
    issueInvoice: payload.issueInvoice !== false,
    payment: payload.payment || null
  };

  return {
    encounterType,
    rows: decoratedRows,
    totals,
    payment,
    warnings,
    previewToken: stableHash(canonicalPayload),
    canCommit: !payment || payment.canSubmit
  };
}

async function commitDeskCheckout(payload, user) {
  const hospitalId = userHospitalId(user);

  if (!hospitalId) {
    throw checkoutError('Hospital context is required');
  }

  const idempotencyKey = String(payload.idempotencyKey || '').trim();

  if (!idempotencyKey) {
    throw checkoutError('Idempotency key is required');
  }

  const requestHash = stableHash({ ...payload, idempotencyKey: undefined });

  let workflow = await DeskCheckout.findOne({ hospitalId, idempotencyKey });

  if (workflow) {
    if (workflow.requestHash !== requestHash) {
      throw checkoutError('Idempotency key was already used with a different payload', 409, 'IDEMPOTENCY_CONFLICT');
    }

    if (workflow.status === 'COMPLETED') {
      return { ...workflow.result, idempotent: true };
    }

    if (workflow.status === 'PROCESSING' && Date.now() - new Date(workflow.updatedAt).getTime() < 120000) {
      throw checkoutError('Checkout is already processing', 409, 'CHECKOUT_IN_PROGRESS');
    }

    workflow.status = 'PROCESSING';
    workflow.error = undefined;
    await workflow.save();
  } else {
    workflow = await DeskCheckout.create({
      hospitalId,
      idempotencyKey,
      requestHash,
      status: 'PROCESSING',
      createdBy: user?._id
    });
  }

  try {
    const preview = await previewDeskCheckout(payload, user);

    if (payload.previewToken && payload.previewToken !== preview.previewToken) {
      throw checkoutError(
        'Checkout changed after preview. Preview again before committing.',
        409,
        'DESK_PREVIEW_STALE'
      );
    }

    if (!preview.canCommit) {
      throw checkoutError(
        'Checkout preview contains unresolved financial warnings',
        409,
        'DESK_PREVIEW_BLOCKED',
        { warnings: preview.warnings }
      );
    }

    if (payload.estimateOnly) {
      const estimateResult = {
        checkoutId: workflow._id,
        encounterType: preview.encounterType,
        estimateOnly: true,
        totals: preview.totals,
        rows: preview.rows,
        warnings: preview.warnings,
        documents: []
      };

      workflow.result = estimateResult;
      workflow.status = 'COMPLETED';
      workflow.completedAt = new Date();
      await workflow.save();

      return estimateResult;
    }

    const { patient, created, duplicateMatched } = await resolvePatient({
      hospitalId,
      patientSelection: payload.patientSelection,
      quickPatient: payload.quickPatient
    });

    let admission = null;

    if (preview.encounterType === 'IPD') {
      admission = await IPDAdmission.findOne({
        _id: payload.admissionId,
        hospitalId,
        status: { $nin: ['Discharged', 'Cancelled'] }
      });

      if (!admission || String(admission.patientId) !== String(patient._id)) {
        throw checkoutError('Active IPD admission does not match the selected patient', 409);
      }
    }

    const billIds = [];
    const chargeIds = [];
    const invoiceIds = [];
    const billNowChargeIds = [];

    for (let index = 0; index < preview.rows.length; index += 1) {
      const row = preview.rows[index];

      if (['NO_CHARGE', 'PACKAGE_INCLUDED', 'EXTERNAL_REFERRAL'].includes(row.billingIntent)) {
        continue;
      }

      const rowKey = `${idempotencyKey}:ROW:${index}`;

      if (preview.encounterType === 'OPD') {
        const chargeTypeMap = {
          LAB: 'Lab Test',
          RADIOLOGY: 'Radiology',
          PROCEDURE: 'Procedure',
          CONSULTATION: 'Consultation'
        };

        const result = await patientFinancial.addOPDCharge(patient._id, {
          description: row.name,
          chargeType: chargeTypeMap[row.serviceType] || 'Miscellaneous',
          chargeHead: row.serviceType,
          quantity: row.quantity,
          rate: row.rate,
          idempotencyKey: rowKey,
          notes: `Desk checkout ${idempotencyKey}`
        }, user);

        billIds.push(result.bill._id);
      } else {
        const typeMap = {
          LAB: 'Lab Test',
          RADIOLOGY: 'Radiology',
          PROCEDURE: 'Procedure',
          CONSULTATION: 'Consultation',
          NURSING: 'Nursing',
          OT: 'Surgery',
          ADMISSION: 'Miscellaneous',
          REGISTRATION: 'Miscellaneous'
        };

        const existing = await require('../models/IPDCharge').findOne({
          hospitalId,
          idempotencyKey: rowKey
        });

        const charge = existing || await ipdFinancial.addManualCharge({
          admissionId: admission._id,
          chargeType: typeMap[row.serviceType] || 'Miscellaneous',
          serviceType: String(row.serviceType || '').toLowerCase(),
          internalServiceId: row.masterId,
          externalCode: row.code,
          description: row.name,
          quantity: row.quantity,
          rate: row.rate,
          idempotencyKey: rowKey,
          allowStandardFallback: true,
          notes: `Desk checkout ${idempotencyKey}`
        }, user);

        const chargeDoc = charge.charge || charge;
        chargeIds.push(chargeDoc._id);

        if (row.billingIntent === 'BILL_NOW') {
          billNowChargeIds.push(chargeDoc._id);
        }
      }
    }

    if (preview.encounterType === 'OPD' && billIds.length && payload.issueInvoice !== false) {
      const issued = await patientFinancial.issueOPDInvoice(patient._id, {
        billIds,
        idempotencyKey: `${idempotencyKey}:INVOICE`
      }, user);

      invoiceIds.push(issued.invoice._id);
    }

    if (preview.encounterType === 'IPD' && billNowChargeIds.length) {
      const issued = await ipdFinancial.issueIPDInvoice(admission._id, {
        invoiceKind: 'interim',
        billingMode: 'IMMEDIATE_SELECTED',
        chargeIds: billNowChargeIds,
        idempotencyKey: `${idempotencyKey}:INVOICE`
      }, user);

      if (issued.invoice?._id) invoiceIds.push(issued.invoice._id);
      if (issued.bill?._id) billIds.push(issued.bill._id);
    }

    const paymentResults = [];

    if (preview.encounterType === 'OPD' && payload.payment?.collectNow && invoiceIds.length) {
      const paymentPayload = {
        ...payload.payment,
        invoiceId: invoiceIds[0],
        amount: preview.payment.amountApplied,
        amountApplied: preview.payment.amountApplied,
        amountTendered: preview.payment.amountTendered,
        idempotencyKey: `${idempotencyKey}:PAYMENT`
      };

      paymentResults.push(await patientFinancial.recordOPDPayment(patient._id, paymentPayload, user));
    }

    const documents = [
      ...invoiceIds.map(id => ({
        type: 'INVOICE',
        id,
        label: 'Open invoice',
        url: `/api/invoices/${id}/download`
      })),
      ...billIds.map(id => ({
        type: 'BILL',
        id,
        label: 'Open bill',
        url: null
      })),
      ...paymentResults
        .filter(item => item?.receiptNumber)
        .map(item => ({
          type: 'RECEIPT',
          id: item.receiptNumber,
          label: 'Receipt',
          url: null
        }))
    ];

    const result = {
      checkoutId: workflow._id,
      patient: {
        id: patient._id,
        name: [patient.first_name, patient.middle_name, patient.last_name]
          .filter(Boolean)
          .join(' '),
        created,
        duplicateMatched: Boolean(duplicateMatched)
      },
      encounterType: preview.encounterType,
      encounterAction: String(payload.encounterAction || 'SERVICES').toUpperCase(),
      encounterId: payload.encounterAction === 'APPOINTMENT'
        ? (preview.rows.find(row => row.sourceModule === 'Appointment')?.sourceId || null)
        : (admission?._id || null),
      admissionId: admission?._id || null,
      billIds,
      invoiceIds,
      chargeIds,
      paymentResults,
      documents,
      totals: preview.totals,
      payment: preview.payment,
      warnings: preview.warnings
    };

    workflow.patientId = patient._id;
    workflow.admissionId = admission?._id;
    workflow.billIds = billIds;
    workflow.invoiceIds = invoiceIds;
    workflow.chargeIds = chargeIds;
    workflow.result = result;
    workflow.status = 'COMPLETED';
    workflow.completedAt = new Date();
    await workflow.save();

    return result;
  } catch (error) {
    workflow.status = 'FAILED';
    workflow.error = { message: error.message, code: error.code };
    await workflow.save().catch(() => {});
    throw error;
  }
}

module.exports = {
  previewDeskCheckout,
  commitDeskCheckout
};