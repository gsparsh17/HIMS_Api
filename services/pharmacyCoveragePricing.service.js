const { operationNow } = require('../utils/operationTimeContext');
const Prescription = require('../models/Prescription');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const { quotePricing, pricingSnapshot } = require('./pricingEngine.service');
const { recordPackageUtilization } = require('./packageAdjudication.service');
const claimService = require('./claim.service');
const { replaceCoverageUtilization } = require('./coverageUtilization.service');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function resolveAppointmentId({ appointmentId, prescriptionId }) {
  if (appointmentId) return appointmentId;
  if (!prescriptionId) return undefined;
  const prescription = await Prescription.findById(prescriptionId).select('appointment_id').lean();
  return prescription?.appointment_id;
}

async function pricePharmacyItems({ hospitalId, admissionId, appointmentId, prescriptionId, items, serviceDate }) {
  const resolvedAppointmentId = await resolveAppointmentId({ appointmentId, prescriptionId });
  const pricedItems = [];
  for (const item of items || []) {
    const standard = money(item.net_amount ?? item.total_price ?? item.gross_amount);
    const quote = await quotePricing({
      hospitalId,
      admissionId,
      appointmentId: resolvedAppointmentId,
      serviceDate: serviceDate || operationNow(),
      chargeType: 'Pharmacy',
      serviceType: 'pharmacy',
      internalServiceModel: 'Medicine',
      internalServiceId: item.medicine_id,
      internalCode: item._medicine?.code || item._medicine?.medicine_code || item.hsn_code || String(item.medicine_id),
      standardAmount: standard,
      quantity: 1,
      description: item.medicine_name
    });
    const snapshot = pricingSnapshot(quote, {
      internalServiceModel: 'Medicine',
      internalServiceId: item.medicine_id
    });
    pricedItems.push({
      ...item,
      pricing_snapshot: snapshot,
      standard_amount: money(quote.amounts.hospitalStandard),
      contracted_amount: money(quote.amounts.contracted),
      eligible_amount: money(quote.amounts.eligible),
      patient_liability: money(quote.amounts.patientLiability),
      sponsor_liability: money(quote.amounts.sponsorLiability),
      non_admissible_amount: money(quote.amounts.nonAdmissible),
      contractual_adjustment: money(quote.amounts.hospitalAdjustment),
      hospital_concession: money(quote.amounts.hospitalConcession),
      package_absorbed: money(quote.amounts.packageAbsorbed),
      _pricingQuote: quote
    });
  }
  const allocation = pricedItems.reduce((sum, item) => {
    sum.standard_amount += Number(item.standard_amount || 0);
    sum.contracted_amount += Number(item.contracted_amount || 0);
    sum.eligible_amount += Number(item.eligible_amount || 0);
    sum.patient_liability += Number(item.patient_liability || 0);
    sum.sponsor_liability += Number(item.sponsor_liability || 0);
    sum.non_admissible_amount += Number(item.non_admissible_amount || 0);
    sum.contractual_adjustment += Number(item.contractual_adjustment || 0);
    sum.hospital_concession += Number(item.hospital_concession || 0);
    sum.package_absorbed += Number(item.package_absorbed || 0);
    if (item.pricing_snapshot?.resultType === 'cash_fallback') sum.fallback_count += 1;
    return sum;
  }, {
    standard_amount: 0,
    contracted_amount: 0,
    eligible_amount: 0,
    patient_liability: 0,
    sponsor_liability: 0,
    non_admissible_amount: 0,
    contractual_adjustment: 0,
    hospital_concession: 0,
    package_absorbed: 0,
    fallback_count: 0
  });
  Object.keys(allocation).forEach((key) => {
    if (key !== 'fallback_count') allocation[key] = money(allocation[key]);
  });
  const coverage = await AdmissionCoverage.findOne({
    hospitalId,
    active: true,
    ...(admissionId ? { encounterType: 'IPD', admissionId } : resolvedAppointmentId ? { encounterType: 'OPD', appointmentId: resolvedAppointmentId } : { _id: null })
  }).populate('payerId').lean();
  return { pricedItems, allocation, coverage, appointmentId: resolvedAppointmentId };
}

function lineAllocation(item) {
  return {
    pricing_snapshot: item.pricing_snapshot,
    standard_amount: item.standard_amount,
    contracted_amount: item.contracted_amount,
    eligible_amount: item.eligible_amount,
    patient_liability: item.patient_liability,
    sponsor_liability: item.sponsor_liability,
    non_admissible_amount: item.non_admissible_amount,
    contractual_adjustment: item.contractual_adjustment,
    hospital_concession: item.hospital_concession,
    package_absorbed: item.package_absorbed
  };
}

async function recordUtilizationForBill({ pricedItems, bill, coverage, sourceType = 'BillItem', userId, session }) {
  for (let index = 0; index < pricedItems.length; index += 1) {
    const item = pricedItems[index];
    const quote = item._pricingQuote;
    const sourceLineId = bill?.items?.[index]?._id;
    await replaceCoverageUtilization({
      coverage,
      quote,
      hospitalId: bill.hospital_id,
      encounterType: bill.admission_id ? 'IPD' : 'OPD',
      admissionId: bill.admission_id,
      appointmentId: bill.appointment_id,
      patientId: bill.patient_id,
      sourceType,
      sourceId: bill._id,
      sourceLineId,
      internalServiceModel: 'Medicine',
      internalServiceId: item.medicine_id,
      userId,
      session
    });
    if (!quote?.packageAdjudication) continue;
    await recordPackageUtilization({
      decision: quote.packageAdjudication,
      input: {
        serviceType: 'pharmacy',
        internalServiceModel: 'Medicine',
        internalServiceId: item.medicine_id,
        internalCode: item._medicine?.code || item._medicine?.medicine_code || item.hsn_code,
        description: item.medicine_name,
        quantity: item.quantity_base_units || item.quantity || 1
      },
      quote,
      sourceType,
      sourceId: bill._id,
      sourceLineId,
      session
    });
  }
}

async function recognizeSponsorReceivable({ coverage, allocation, invoice, bill, patientId, admissionId, appointmentId, createdBy, session }) {
  if (!coverage || Number(allocation.sponsor_liability || 0) <= 0) return null;
  const recognition = coverage.payerId?.pricingPolicy?.receivableRecognition || 'invoice_issue';
  if (recognition !== 'invoice_issue') return null;
  return claimService.appendLedger({
    hospitalId: coverage.hospitalId,
    payerId: coverage.payerId?._id || coverage.payerId,
    encounterType: admissionId ? 'IPD' : 'OPD',
    admissionId,
    appointmentId,
    patientId,
    coverageId: coverage._id,
    invoiceId: invoice?._id,
    entryType: 'receivable',
    debit: allocation.sponsor_liability,
    reference: invoice?.invoice_number || bill?.bill_number,
    reason: 'Sponsor receivable recognized at invoice issue',
    sourceType: 'invoice',
    sourceId: invoice?._id || bill?._id,
    idempotencyKey: `invoice:${invoice?._id || bill?._id}:sponsor-receivable`,
    createdBy,
    session
  });
}

module.exports = {
  money,
  resolveAppointmentId,
  pricePharmacyItems,
  lineAllocation,
  recordUtilizationForBill,
  recognizeSponsorReceivable
};
