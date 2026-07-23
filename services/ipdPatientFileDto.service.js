const { hasFeatureAccess } = require('../utils/mainFeatureAccess');

const CLINICAL_ROLES = new Set(['doctor', 'nurse']);
const REGISTRATION_ROLES = new Set(['staff', 'registrar', 'receptionist', 'bed_manager']);
const FULL_FINANCE_ROLES = new Set(['admin', 'mediqliq_super_admin', 'accountant', 'insurance_desk']);

function plain(value) {
  if (!value) return value;
  return typeof value.toObject === 'function' ? value.toObject({ virtuals: true }) : value;
}

function canSeeFullFinance(user) {
  return FULL_FINANCE_ROLES.has(user?.role) || hasFeatureAccess(user, 'billing_finance', 'manage');
}

function coverageOperationalView(coverage) {
  if (!coverage) return null;

  const row = plain(coverage);

  return {
    _id: row._id,
    payerCategory: row.payerCategory,
    payer: row.payerId ? {
      _id: row.payerId._id,
      code: row.payerId.code,
      name: row.payerId.name,
      type: row.payerId.type
    } : null,
    beneficiaryId: row.beneficiary?.beneficiaryId,
    schemeCardNumber: row.beneficiary?.schemeCardNumber,
    memberId: row.beneficiary?.memberId,
    wardEntitlement: row.beneficiary?.wardEntitlement,
    coPayAlert: Number(row.beneficiary?.coPayPercentage || 0) > 0 || Number(row.beneficiary?.deductibleAmount || 0) > 0,
    eligibility: row.eligibility ? {
      status: row.eligibility.status,
      verifiedAt: row.eligibility.verifiedAt,
      reason: row.eligibility.reason,
      emergencyOverrideExpiresAt: row.eligibility.emergencyOverrideExpiresAt
    } : null,
    preAuthorisation: row.preAuthorisation ? {
      required: row.preAuthorisation.required,
      status: row.preAuthorisation.status,
      requestNumber: row.preAuthorisation.requestNumber,
      requestedPackageCode: row.preAuthorisation.requestedPackageCode,
      requestedProcedure: row.preAuthorisation.requestedProcedure,
      validTo: row.preAuthorisation.validTo
    } : null,
    rateContext: row.rateContext,
    documentChecklist: (row.documentChecklist || []).map((item) => ({
      code: item.code,
      label: item.label,
      required: item.required,
      status: item.status
    })),
    financialClearanceStatus: row.financialClearanceStatus
  };
}

function coverageFinanceView(coverage) {
  if (!coverage) return null;

  const row = plain(coverage);

  return {
    ...coverageOperationalView(row),
    beneficiary: row.beneficiary,
    eligibility: row.eligibility,
    preAuthorisation: row.preAuthorisation,
    rateCardId: row.rateCardId,
    rateCardVersion: row.rateCardVersion,
    revision: row.revision,
    active: row.active,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo
  };
}

function admissionBase(admission) {
  const row = plain(admission);

  const {
    totalBillAmount,
    invoicedAmount,
    paidAmount,
    dueAmount,
    advanceAmount,
    patientReceivable,
    sponsorReceivable,
    approvedSponsorAmount,
    claimSubmittedAmount,
    sponsorPaidAmount,
    nonAdmissibleAmount,
    insuranceDetails,
    ...base
  } = row;

  return base;
}

function financeSummary(admission) {
  const row = plain(admission);

  return {
    totalBillAmount: row.totalBillAmount || 0,
    invoicedAmount: row.invoicedAmount || 0,
    paidAmount: row.paidAmount || 0,
    dueAmount: row.dueAmount || 0,
    advanceAmount: row.advanceAmount || 0,
    patientReceivable: row.patientReceivable || 0,
    sponsorReceivable: row.sponsorReceivable || 0,
    approvedSponsorAmount: row.approvedSponsorAmount || 0,
    claimSubmittedAmount: row.claimSubmittedAmount || 0,
    sponsorPaidAmount: row.sponsorPaidAmount || 0,
    nonAdmissibleAmount: row.nonAdmissibleAmount || 0,
    financialClearanceStatus: row.financialClearanceStatus
  };
}

function buildPatientFileDto({
  user,
  admission,
  coverage,
  transfers = [],
  accommodationSegments = [],
  rounds = [],
  nursingNotes = [],
  vitals = [],
  charges = [],
  dischargeSummary,
  invoices = [],
  bills = []
}) {
  const fullFinance = canSeeFullFinance(user);
  const clinicalOnly = CLINICAL_ROLES.has(user?.role) && !fullFinance;
  const registrationView = REGISTRATION_ROLES.has(user?.role) && !fullFinance;

  const dto = {
    admission: admissionBase(admission),
    coverage: fullFinance ? coverageFinanceView(coverage) : coverageOperationalView(coverage),
    currentLocation: {
      ward: plain(admission.wardId),
      room: plain(admission.roomId),
      bed: plain(admission.bedId),
      effectiveFrom: admission.currentLocationEffectiveAt || admission.admissionDate
    },
    transfers: transfers.map(plain),
    accommodationSegments: accommodationSegments.map(plain),
    rounds: rounds.map(plain),
    nursingNotes: nursingNotes.map(plain),
    vitals: vitals.map(plain),
    dischargeSummary: plain(dischargeSummary),
    visibility: {
      view: fullFinance ? 'financial' : clinicalOnly ? 'clinical' : registrationView ? 'operational' : 'clinical',
      canViewAmounts: fullFinance,
      canManageCoverage: fullFinance,
      canRequestTransfer: hasFeatureAccess(user, 'ipd', 'manage'),
      canReserveTransfer: ['admin', 'mediqliq_super_admin', 'bed_manager', 'staff', 'registrar', 'receptionist'].includes(user?.role),
      canCompleteTransfer: ['admin', 'mediqliq_super_admin', 'nurse', 'bed_manager', 'ot_staff'].includes(user?.role)
    }
  };

  if (fullFinance) {
    dto.financialSummary = financeSummary(admission);
    dto.charges = charges.map(plain);
    dto.invoices = invoices.map(plain);
    dto.bills = bills.map(plain);
  }

  return dto;
}

module.exports = {
  buildPatientFileDto,
  canSeeFullFinance,
  coverageOperationalView,
  coverageFinanceView
};