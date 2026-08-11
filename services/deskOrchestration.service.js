const crypto = require('crypto');
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const IPDAdmission = require('../models/IPDAdmission');
const DeskCheckout = require('../models/DeskCheckout');
const LabRequest = require('../models/LabRequest');
const LabTest = require('../models/LabTest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ImagingTest = require('../models/ImagingTest');
const ProcedureRequest = require('../models/ProcedureRequest');
const Procedure = require('../models/Procedure');
const patientFinancial = require('./patientFinancial.service');
const ipdFinancial = require('./ipdFinancial.service');
const { getTemplate, matchTemplate } = require('./labReportTemplate.service');
const { searchServiceCatalog } = require('./serviceCatalog.service');
const { userHospitalId } = require('../utils/hospitalScope');
const { registerPatient, assertPatientReadyForContext } = require('./patientRegistration.service');
const { resolveRequestPayerContext, rememberRequestPayerContextUsage } = require('./requestPayerContext.service');
const { resolveDeclaredCoveragePreference } = require('./patientCoveragePreference.service');

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

async function resolvePatient({ hospitalId, patientSelection, quickPatient, userId }) {
  if (patientSelection?.patientId) {
    const { patient } = await assertPatientReadyForContext({
      hospitalId,
      patientId: patientSelection.patientId,
      context: 'OPD',
      userId
    });
    return { patient, created: false };
  }

  if (!quickPatient) {
    throw checkoutError('Select or create a patient');
  }

  try {
    const result = await registerPatient({
      hospitalId,
      input: {
        ...quickPatient,
        registrationSource: {
          ...(quickPatient.registrationSource || {}),
          channel: quickPatient.registrationSource?.channel || 'internal'
        },
        idempotencyKey: quickPatient.idempotencyKey
      },
      userId,
      reuseExactMatch: true,
      defaultPatientType: 'opd'
    });
    return {
      patient: result.patient,
      created: result.created,
      duplicateMatched: result.duplicateMatched
    };
  } catch (error) {
    throw checkoutError(
      error.message,
      error.statusCode || 400,
      error.code || 'PATIENT_REGISTRATION_FAILED',
      { candidates: error.candidates || [] }
    );
  }
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

  const taxAdjustment = round(payment.taxAdjustmentAmount);
  const discount = round(payment.settlementDiscountAmount);
  const outstandingBefore = totals.payableNow;
  const netPayable = round(Math.max(0, outstandingBefore + taxAdjustment - discount));
  const warnings = [];

  if (discount > 0 && !String(payment.settlementDiscountReason || '').trim()) {
    warnings.push({ code: 'DISCOUNT_REASON_REQUIRED', message: 'Settlement discount reason is required.' });
  }

  if (taxAdjustment !== 0 && !String(payment.taxAdjustmentReason || '').trim()) {
    warnings.push({ code: 'TAX_REASON_REQUIRED', message: 'Tax adjustment reason is required.' });
  }

  if (encounterType === 'IPD') {
    // For IPD checkout, money collected must first settle services marked
    // BILL_NOW. Only the amount above the issued invoice liability becomes an
    // IPD advance. The legacy `advanceAmount` request field is retained for
    // frontend compatibility, but it now represents the total amount being
    // collected at checkout.
    const collectionAmount = round(payment.advanceAmount ?? payment.amountApplied ?? payment.amountTendered ?? 0);
    const amountTendered = payment.paymentMethod === 'Cash'
      ? round(payment.amountTendered ?? collectionAmount)
      : collectionAmount;
    const amountApplied = round(Math.min(collectionAmount, netPayable));
    const advanceCreated = round(Math.max(0, collectionAmount - amountApplied));
    const changeReturned = round(Math.max(0, amountTendered - collectionAmount));

    if (collectionAmount <= 0) {
      warnings.push({ code: 'IPD_COLLECTION_AMOUNT_REQUIRED', message: 'Enter an amount greater than zero.' });
    }

    if (payment.paymentMethod === 'Cash' && amountTendered + 0.01 < collectionAmount) {
      warnings.push({ code: 'CASH_TENDERED_TOO_LOW', message: 'Cash received cannot be less than the amount being collected.' });
    }

    if (payment.paymentMethod !== 'Cash' && !String(payment.reference || '').trim()) {
      warnings.push({ code: 'PAYMENT_REFERENCE_REQUIRED', message: 'Transaction reference is required for non-cash payment.' });
    }

    return {
      mode: amountApplied > 0 ? 'IPD_PAYMENT' : 'IPD_ADVANCE',
      outstandingBefore,
      taxAdjustment,
      settlementDiscount: discount,
      netPayable,
      collectionAmount,
      amountApplied,
      amountTendered,
      overpayment: advanceCreated,
      changeReturned,
      advanceCreated,
      balanceAfter: round(Math.max(0, netPayable - amountApplied)),
      canSubmit: warnings.length === 0,
      warnings,
      suggestedPayment: { advanceAmount: collectionAmount, amountApplied, amountTendered }
    };
  }

  const amountApplied = round(payment.amountApplied ?? netPayable);
  const amountTendered = round(payment.amountTendered ?? amountApplied);
  const overpayment = round(Math.max(0, amountApplied - netPayable));
  const changeReturned = payment.overpaymentDisposition === 'RETURN_CHANGE'
    ? round(Math.max(0, amountTendered - Math.min(amountApplied, netPayable)))
    : 0;
  const advanceCreated = payment.overpaymentDisposition === 'CREATE_ADVANCE' ? overpayment : 0;

  if (overpayment > 0 && !payment.overpaymentDisposition) {
    warnings.push({ code: 'OVERPAYMENT_DISPOSITION_REQUIRED', message: 'Choose return change or credit excess to patient advance.' });
  }

  return {
    mode: 'OPD_PAYMENT',
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
    suggestedPayment: { amountApplied: netPayable, amountTendered: netPayable }
  };
}


const clinicalRequestTypes = new Set(['LAB', 'RADIOLOGY', 'PROCEDURE']);

const idOf = value => value?._id || value?.id || value || null;

function normalizeEncounterContext(context = {}) {
  return {
    appointmentId: idOf(context.appointmentId || context.appointment_id),
    doctorId: idOf(context.doctorId || context.doctor_id || context.primaryDoctorId),
    departmentId: idOf(context.departmentId || context.department_id)
  };
}

function isClinicalRequestRow(row) {
  return clinicalRequestTypes.has(row.serviceType)
    && row.billingIntent !== 'EXTERNAL_REFERRAL';
}

async function resolveClinicalContext({ payload, user, encounterType, rows, admission }) {
  const context = normalizeEncounterContext(payload.encounterContext);
  const requestRows = (rows || []).filter(isClinicalRequestRow);

  if (!requestRows.length) {
    return {
      ...context,
      admissionId: encounterType === 'IPD' ? idOf(payload.admissionId) : null
    };
  }

  if (requestRows.some(row => !row.masterId)) {
    throw checkoutError('Lab, imaging and procedure requests require a catalogue service');
  }

  if (encounterType === 'IPD') {
    const hospitalId = userHospitalId(user);
    const admissionRecord = admission || await IPDAdmission.findOne({
      _id: payload.admissionId,
      hospitalId,
      status: { $nin: ['Discharged', 'Cancelled'] }
    }).select('primaryDoctorId');

    const doctorId = idOf(admissionRecord?.primaryDoctorId || context.doctorId);

    if (!doctorId) {
      throw checkoutError('Assign a primary doctor before creating IPD service requests');
    }

    const doctorExists = await Doctor.exists({ _id: doctorId, hospitalId });
    if (!doctorExists) {
      throw checkoutError('The admission primary doctor is not available for this hospital', 409);
    }

    return {
      ...context,
      doctorId,
      admissionId: idOf(payload.admissionId),
      appointmentId: null
    };
  }

  if (!context.doctorId) {
    throw checkoutError('Select the ordering doctor before checking out lab, imaging or procedure services');
  }

  const hospitalId = userHospitalId(user);
  const doctorExists = await Doctor.exists({ _id: context.doctorId, hospitalId });
  if (!doctorExists) {
    throw checkoutError('Selected ordering doctor is not available for this hospital', 409);
  }

  return {
    ...context,
    admissionId: null
  };
}

function requestBillingState(row, refs) {
  if (['NO_CHARGE', 'PACKAGE_INCLUDED'].includes(row.billingIntent)) {
    return 'NOT_APPLICABLE';
  }
  if ((refs.invoiceIds || []).length) return 'INVOICED';
  if ((refs.chargeIds || []).length || (refs.billIds || []).length) return 'CHARGE_POSTED';
  return 'PENDING_CHARGE';
}

async function createIdempotentRequest(Model, query, values) {
  const existing = await Model.findOne(query);
  if (existing) return { request: existing, created: false };

  try {
    const request = await Model.create(values);
    return { request, created: true };
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await Model.findOne(query);
      if (duplicate) return { request: duplicate, created: false };
    }
    throw error;
  }
}

async function createClinicalRequest({
  row,
  rowIndex,
  patient,
  hospitalId,
  context,
  refs,
  payerContext,
  idempotencyKey,
  user
}) {
  if (!isClinicalRequestRow(row)) return null;

  const deskCheckoutKey = `${idempotencyKey}:CLINICAL:${rowIndex}`;
  const invoiceId = idOf(refs.invoiceIds?.[0]);
  const billingState = requestBillingState(row, refs);
  const common = {
    hospitalId,
    deskCheckoutKey,
    sourceType: context.admissionId ? 'IPD' : (context.appointmentId ? 'OPD' : 'WALKIN'),
    admissionId: context.admissionId || null,
    appointmentId: context.appointmentId || null,
    patientId: patient._id,
    doctorId: context.doctorId,
    priority: 'Routine',
    requestedDate: new Date(),
    patient_notes: `Created from Desk checkout ${idempotencyKey}`,
    billingIntent: row.billingIntent,
    billingState,
    chargeIds: refs.chargeIds || [],
    billIds: refs.billIds || [],
    invoiceIds: refs.invoiceIds || [],
    payerContext: payerContext || undefined,
    pricingSnapshot: {
      source: 'Desk',
      serviceCode: row.code,
      quantity: row.quantity,
      rate: row.rate,
      gross: row.gross
    },
    billingHistory: [{
      from: 'PENDING_CHARGE',
      to: billingState,
      action: 'DESK_CHECKOUT',
      documentId: invoiceId || idOf(refs.billIds?.[0]) || idOf(refs.chargeIds?.[0]),
      by: user?._id,
      reason: `Desk checkout ${idempotencyKey}`
    }],
    cost: row.gross,
    is_billed: Boolean(invoiceId),
    invoiceId: invoiceId || null,
    createdBy: user?._id
  };

  let result;
  let master;

  if (row.serviceType === 'LAB') {
    master = await LabTest.findOne({
      _id: row.masterId,
      hospitalId,
      is_active: { $ne: false }
    });
    if (!master) throw checkoutError(`Lab test is no longer available: ${row.name}`, 409);

    const reportTemplate = getTemplate(master.report_template_id)
      || matchTemplate(master.name, master.code, master.report_template_id);

    result = await createIdempotentRequest(
      LabRequest,
      { hospitalId, deskCheckoutKey },
      {
        ...common,
        labTestId: master._id,
        testCode: master.code,
        testName: master.name,
        category: master.category || 'General',
        reportTemplateId: reportTemplate?.id || '',
        reportTemplateName: reportTemplate?.name || ''
      }
    );
  } else if (row.serviceType === 'RADIOLOGY') {
    master = await ImagingTest.findOne({
      _id: row.masterId,
      hospitalId,
      is_active: { $ne: false }
    });
    if (!master) throw checkoutError(`Imaging test is no longer available: ${row.name}`, 409);

    result = await createIdempotentRequest(
      RadiologyRequest,
      { hospitalId, deskCheckoutKey },
      {
        ...common,
        imagingTestId: master._id,
        testCode: master.code,
        testName: master.name,
        category: master.category || 'General',
        reportTemplateId: master.report_template_id || '',
        reportTemplateName: master.report_template_name || ''
      }
    );
  } else {
    master = await Procedure.findOne({
      _id: row.masterId,
      is_active: { $ne: false }
    });
    if (!master) throw checkoutError(`Procedure is no longer available: ${row.name}`, 409);

    result = await createIdempotentRequest(
      ProcedureRequest,
      { hospitalId, deskCheckoutKey },
      {
        ...common,
        procedureId: master._id,
        procedureCode: master.code,
        procedureName: master.name,
        category: master.category || 'General',
        subcategory: master.subcategory || '',
        estimated_duration_minutes: master.duration_minutes || 30,
        anesthesia_type: 'Local',
        pre_procedure_instructions: master.pre_procedure_instructions || ''
      }
    );
  }

  if (result.created && typeof master?.incrementUsage === 'function') {
    try {
      await master.incrementUsage();
    } catch (error) {
      console.warn('Desk clinical request usage counter could not be updated', error.message);
    }
  }

  return {
    type: row.serviceType,
    id: result.request._id,
    requestNumber: result.request.requestNumber,
    serviceName: row.name,
    created: result.created
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

function canonicalPaymentForPreview(inputPayment, previewedPayment) {
  if (!previewedPayment) return null;

  const source = inputPayment || {};

  if (String(previewedPayment.mode || '').startsWith('IPD_')) {
    return {
      collectNow: true,
      paymentMethod: source.paymentMethod || 'Cash',
      reference: String(source.reference || '').trim(),
      // Keep the legacy field in the canonical payload so existing clients do
      // not need a request-contract migration.
      advanceAmount: round(previewedPayment.collectionAmount),
      settlementDiscountAmount: round(previewedPayment.settlementDiscount),
      settlementDiscountReason: String(source.settlementDiscountReason || '').trim(),
      taxAdjustmentAmount: round(previewedPayment.taxAdjustment),
      taxAdjustmentReason: String(source.taxAdjustmentReason || '').trim(),
      amountApplied: round(previewedPayment.amountApplied),
      amountTendered: round(previewedPayment.amountTendered)
    };
  }

  return {
    collectNow: true,
    paymentMethod: source.paymentMethod || 'Cash',
    reference: String(source.reference || '').trim(),
    settlementDiscountAmount: round(previewedPayment.settlementDiscount),
    settlementDiscountReason: String(source.settlementDiscountReason || '').trim(),
    taxAdjustmentAmount: round(previewedPayment.taxAdjustment),
    taxAdjustmentReason: String(source.taxAdjustmentReason || '').trim(),
    amountApplied: round(previewedPayment.amountApplied),
    amountTendered: round(previewedPayment.amountTendered),
    overpaymentDisposition: source.overpaymentDisposition || null
  };
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
  const clinicalContext = await resolveClinicalContext({
    payload,
    user,
    encounterType,
    rows: decoratedRows
  });

  if (payload.coverage && (payload.coverage.payerId || payload.coverage.payerCategory)) {
    await resolveDeclaredCoveragePreference({
      hospitalId: userHospitalId(user),
      coverage: payload.coverage
    });
  }

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
    encounterContext: normalizeEncounterContext(payload.encounterContext),
    serviceCart: decoratedRows.map(({ pricingDifference, clinicalAction, financialAction, gross, ...row }) => row),
    coverage: payload.coverage || null,
    issueInvoice: payload.issueInvoice !== false,
    payment: canonicalPaymentForPreview(payload.payment, payment)
  };

  return {
    encounterType,
    rows: decoratedRows,
    totals,
    payment,
    clinicalContext,
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

  // Idempotency must represent the business request only. previewToken is a
  // validation artifact and may legitimately change after a fresh preview.
  // Including it makes a retry with the same checkout data look like a
  // different payload and causes a false IDEMPOTENCY_CONFLICT.
  const { idempotencyKey: _ignoredKey, previewToken: _ignoredPreviewToken, ...businessPayload } = payload;
  const requestHash = stableHash(businessPayload);

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
      quickPatient: payload.quickPatient,
      userId: user?._id
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

    const financialEncounterContext = normalizeEncounterContext(payload.encounterContext);
    const billIds = [];
    const chargeIds = [];
    const invoiceIds = [];
    const billNowChargeIds = [];
    const rowFinancialRefs = preview.rows.map(() => ({ billIds: [], chargeIds: [], invoiceIds: [] }));
    let issuedIPDInvoice = null;

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
          appointmentId: financialEncounterContext.appointmentId || undefined,
          idempotencyKey: rowKey,
          notes: `Desk checkout ${idempotencyKey}`
        }, user);

        billIds.push(result.bill._id);
        rowFinancialRefs[index].billIds.push(result.bill._id);
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
        rowFinancialRefs[index].chargeIds.push(chargeDoc._id);

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
      rowFinancialRefs.forEach(refs => {
        if (refs.billIds.length) refs.invoiceIds.push(issued.invoice._id);
      });
    }

    if (preview.encounterType === 'IPD' && billNowChargeIds.length) {
      const issued = await ipdFinancial.issueIPDInvoice(admission._id, {
        invoiceKind: 'interim',
        billingMode: 'IMMEDIATE_SELECTED',
        chargeIds: billNowChargeIds,
        idempotencyKey: `${idempotencyKey}:INVOICE`
      }, user);

      issuedIPDInvoice = issued.invoice || null;
      if (issuedIPDInvoice?._id) invoiceIds.push(issuedIPDInvoice._id);
      if (issued.bill?._id) billIds.push(issued.bill._id);
      preview.rows.forEach((row, index) => {
        if (row.billingIntent !== 'BILL_NOW') return;
        if (issued.bill?._id) rowFinancialRefs[index].billIds.push(issued.bill._id);
        if (issuedIPDInvoice?._id) rowFinancialRefs[index].invoiceIds.push(issuedIPDInvoice._id);
      });
    }

    const paymentResults = [];
    let committedPayment = preview.payment;

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

    if (preview.encounterType === 'IPD' && payload.payment?.collectNow) {
      const paymentMethod = payload.payment.paymentMethod || 'Cash';
      const reference = payload.payment.reference || '';
      const collectionAmount = round(preview.payment?.collectionAmount || 0);
      // Use the issued document as the final authority because coverage pricing
      // can make patient liability lower than the cart's gross estimate. Apply
      // payment-time tax first and settlement discount second, matching the
      // finance service's accounting order.
      const issuedOutstanding = round(issuedIPDInvoice?.balance_due || 0);
      const taxAdjustmentAmount = round(preview.payment?.taxAdjustment || 0);
      const settlementDiscountAmount = round(preview.payment?.settlementDiscount || 0);
      const adjustedOutstanding = round(Math.max(
        0,
        issuedOutstanding + taxAdjustmentAmount - settlementDiscountAmount
      ));
      const amountApplied = round(Math.min(collectionAmount, adjustedOutstanding));
      const advanceCreated = round(Math.max(0, collectionAmount - amountApplied));

      committedPayment = {
        ...preview.payment,
        amountApplied,
        advanceCreated,
        overpayment: advanceCreated,
        netPayable: adjustedOutstanding,
        balanceAfter: round(Math.max(0, adjustedOutstanding - amountApplied))
      };

      // BILL_NOW means issue an invoice now and apply the checkout collection
      // to that invoice. Previously the entire collection was posted as an
      // advance, leaving the new invoice unpaid and due.
      if (
        issuedIPDInvoice?._id &&
        (amountApplied > 0 || settlementDiscountAmount > 0 || taxAdjustmentAmount !== 0)
      ) {
        const settlement = await ipdFinancial.recordIPDPayment(admission._id, {
          invoiceId: issuedIPDInvoice._id,
          amount: amountApplied,
          settlementDiscountAmount,
          settlementDiscountReason: payload.payment.settlementDiscountReason || '',
          taxAdjustmentAmount,
          adjustmentReason: payload.payment.taxAdjustmentReason || payload.payment.settlementDiscountReason || '',
          paymentMethod,
          reference,
          sourceModule: 'IPD',
          receiptType: 'Payment',
          notes: payload.payment.notes || `Payment received during Desk admission checkout ${idempotencyKey}`,
          idempotencyKey: `${idempotencyKey}:IPD_PAYMENT`
        }, user);

        paymentResults.push({
          ...settlement,
          paymentKind: 'IPD_PAYMENT',
          amount: amountApplied,
          paymentMethod,
          reference
        });
      }

      // Only the excess over BILL_NOW invoice liability is retained as advance.
      // If there are no BILL_NOW rows, the full collection remains an advance.
      if (advanceCreated > 0) {
        const advance = await ipdFinancial.recordAdvance(admission._id, {
          amount: advanceCreated,
          paymentMethod,
          reference,
          notes: payload.payment.notes || `Advance received during Desk admission checkout ${idempotencyKey}`,
          idempotencyKey: `${idempotencyKey}:IPD_ADVANCE`
        }, user);

        paymentResults.push({
          ...advance,
          paymentKind: 'IPD_ADVANCE',
          amount: advanceCreated,
          paymentMethod,
          reference
        });
      }
    }

    const clinicalContext = await resolveClinicalContext({
      payload,
      user,
      encounterType: preview.encounterType,
      rows: preview.rows,
      admission
    });
    const clinicalRequests = [];
    const hasClinicalRequests = preview.rows.some(isClinicalRequestRow);
    const hasDeclaredCoverage = Boolean(payload.coverage && (payload.coverage.payerId || payload.coverage.payerCategory));
    const requestPayerContext = (hasClinicalRequests || hasDeclaredCoverage)
      ? await resolveRequestPayerContext({
        hospitalId,
        patientId: patient._id,
        sourceType: clinicalContext.admissionId ? 'IPD' : (clinicalContext.appointmentId ? 'OPD' : 'WALKIN'),
        admissionId: clinicalContext.admissionId,
        appointmentId: clinicalContext.appointmentId,
        declaredCoverage: payload.coverage,
        userId: user?._id,
        rememberSource: 'OTHER'
      })
      : null;

    for (let index = 0; index < preview.rows.length; index += 1) {
      const request = await createClinicalRequest({
        row: preview.rows[index],
        rowIndex: index,
        patient,
        hospitalId,
        context: clinicalContext,
        refs: rowFinancialRefs[index],
        payerContext: requestPayerContext,
        idempotencyKey,
        user
      });
      if (request) clinicalRequests.push(request);
    }

    if (requestPayerContext) {
      const serviceSources = [...new Set(preview.rows.filter(isClinicalRequestRow).map(row => row.serviceType))];
      const preferenceSource = clinicalContext.admissionId
        ? 'IPD'
        : clinicalContext.appointmentId
          ? 'OPD'
          : serviceSources.length === 1 && ['LAB', 'RADIOLOGY', 'PROCEDURE'].includes(serviceSources[0])
            ? serviceSources[0]
            : 'OTHER';
      await rememberRequestPayerContextUsage({
        hospitalId,
        patientId: patient._id,
        payerContext: requestPayerContext,
        source: preferenceSource,
        encounterId: clinicalContext.admissionId || clinicalContext.appointmentId || undefined,
        userId: user?._id,
        usedAt: new Date()
      });
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
          label: String(item.paymentKind || '').startsWith('IPD_') ? 'Admission receipt' : 'Receipt',
          receiptType: item.paymentKind === 'IPD_ADVANCE' ? 'IPD_ADVANCE' : 'IPD_PAYMENT',
          amount: item.amount,
          paymentMethod: item.paymentMethod,
          reference: item.reference || '',
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
      admissionSummary: admission ? {
        id: admission._id,
        admissionNumber: admission.admissionNumber,
        shipNumber: admission.shipNumber,
        admissionDate: admission.admissionDate,
        admissionType: admission.admissionType,
        departmentId: admission.departmentId,
        primaryDoctorId: admission.primaryDoctorId,
        wardId: admission.wardId,
        roomId: admission.roomId,
        bedId: admission.bedId,
        attendant: admission.attendant || {},
        paymentType: admission.paymentType
      } : null,
      billIds,
      invoiceIds,
      chargeIds,
      clinicalRequests,
      paymentResults,
      documents,
      totals: preview.totals,
      payment: committedPayment,
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