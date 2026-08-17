'use strict';

const PMJAY_PACKET_TYPES = new Set(['pmjay', 'pmjay_packet']);
const INSURANCE_PACKET_TYPES = new Set(['insurance', 'insurance_packet']);
const FINANCIAL_PACKET_TYPES = new Set(['financial', 'financial_packet']);

const RAW_EXTERNAL_RENDERERS = new Set([
  'ot-case-summary',
  'ot-schedule',
  'text-document'
]);

function canonicalKey(document = {}) {
  const metadata = document.metadata || {};
  const linkedId = metadata.reportId || metadata.orderId || metadata.requestId ||
    metadata.invoiceId || metadata.billId || metadata.receiptNumber;
  if (linkedId) return `${document.documentType || document.sourceModel}:${linkedId}:${document.sourceRevision || 1}`;
  const templateId = document.templateId || document.formTemplate?.id;
  if (templateId) return `template:${document.relatedCaseId || document.admissionId || ''}:${templateId}:${document.sourceRevision || 1}`;
  return `${document.sourceModel || 'Document'}:${document.sourceId || document.id || document.key}:${document.sourceRevision || 1}`;
}

function documentPreference(document = {}) {
  let score = 0;
  // Signed is preferred only for duplicate selection. It is NOT required for inclusion.
  if (document.status === 'Final/Signed') score += 100;
  else if (document.status === 'Completed/Unsigned') score += 80;
  else if (document.status === 'Draft') score += 20;
  if (document.formTemplate) score += 20;
  if (document.fileUrl) score += 10;
  if (document.content) score += 5;
  return score;
}

function dedupeDocuments(documents = []) {
  const kept = new Map();
  const suppressed = [];
  documents.forEach((document, index) => {
    const key = canonicalKey(document);
    const current = kept.get(key);
    if (!current) {
      kept.set(key, { document, index });
      return;
    }
    if (documentPreference(document) > documentPreference(current.document)) {
      suppressed.push({ document: current.document, reason: 'duplicate' });
      kept.set(key, { document, index: current.index });
    } else {
      suppressed.push({ document, reason: 'duplicate' });
    }
  });
  return {
    documents: [...kept.values()].sort((a, b) => a.index - b.index).map((entry) => entry.document),
    suppressed
  };
}

function isRawExternalRecord(document = {}) {
  if (document.externalEligible === false || document.metadata?.externalEligible === false) return true;
  return RAW_EXTERNAL_RENDERERS.has(document.rendererKey) && !document.fileUrl;
}

function externalStatusEligible(document = {}) {
  // Per client decision, Completed/Unsigned records are printable.
  // Only records that were never completed or remain drafts are suppressed.
  if (document.status === 'Not Started' || document.status === 'Draft') return false;
  return ['Completed/Unsigned', 'Final/Signed'].includes(document.status) ||
    document.metadata?.externalReady === true;
}

function isApplicable(document = {}) {
  return document.applicable !== false && document.metadata?.applicable !== false;
}

function isPmjayPacket(packetType) {
  return PMJAY_PACKET_TYPES.has(String(packetType || '').toLowerCase());
}

function isInsurancePacket(packetType) {
  return INSURANCE_PACKET_TYPES.has(String(packetType || '').toLowerCase());
}

function buildPmjayGate(manifest = {}) {
  const payer = manifest.payerContext || {};
  const coverage = payer.coverage || {};
  const claim = payer.claim || {};
  const packageEpisodes = payer.packageEpisodes || [];
  const blockers = [];

  if (!payer.isPmjay) {
    blockers.push({
      code: 'PMJAY_PAYER_REQUIRED',
      severity: 'blocker',
      message: 'PMJAY Packet can be generated only for an Ayushman Bharat / PM-JAY encounter.'
    });
    return blockers;
  }

  const pmjay = { ...(coverage.schemeData?.pmjay || {}), ...(claim.schemeData?.pmjay || {}) };
  const beneficiaryId = pmjay.beneficiaryId || coverage.beneficiary?.beneficiaryId ||
    coverage.beneficiary?.schemeCardNumber || payer.beneficiaryId;
  if (!beneficiaryId) blockers.push({
    code: 'PMJAY_BENEFICIARY_ID_MISSING',
    severity: 'blocker',
    message: 'PMJAY beneficiary/card identifier is missing for this admission.'
  });

  const packageCode = pmjay.packageCode || coverage.preAuthorisation?.requestedPackageCode ||
    packageEpisodes.find((item) => item.packageCode)?.packageCode;
  if (!packageCode) blockers.push({
    code: 'PMJAY_PACKAGE_MISSING',
    severity: 'blocker',
    message: 'PMJAY package code is missing. Select/confirm the package before packet generation.'
  });

  const claimReference = pmjay.pmjayCaseId || claim.claimNumber || claim.preAuth?.requestNumber ||
    coverage.preAuthorisation?.requestNumber || coverage.eligibility?.responseReference;
  if (!claimReference) blockers.push({
    code: 'PMJAY_CLAIM_REFERENCE_MISSING',
    severity: 'blocker',
    message: 'PMJAY pre-authorisation / claim reference is missing.'
  });

  return blockers;
}

function buildInsuranceGate(manifest = {}) {
  const payer = manifest.payerContext || {};
  const coverage = payer.coverage || {};
  const category = String(coverage.payerCategory || '').toLowerCase();
  const paymentType = String(payer.paymentType || '').toLowerCase();
  const sponsored = Boolean(payer.payer || coverage.id || payer.sponsorName || payer.sponsorType);
  const isSelf = category === 'self' || (!sponsored && /cash|self/.test(paymentType));
  if (isSelf) {
    return [{
      code: 'INSURANCE_PAYER_REQUIRED',
      severity: 'blocker',
      message: 'Insurance Packet is intended for sponsored/insured encounters and is not available for a self-pay/cash-only admission.'
    }];
  }
  return [];
}

function validateSelectedDocuments(documents = [], packetType, manifest = {}) {
  const blockers = [];
  const warnings = [];

  if (isPmjayPacket(packetType)) blockers.push(...buildPmjayGate(manifest));
  if (isInsurancePacket(packetType)) blockers.push(...buildInsuranceGate(manifest));

  if (FINANCIAL_PACKET_TYPES.has(String(packetType || '').toLowerCase())) {
    const summary = manifest.billingSummary || {};
    if ((summary.billCount || summary.invoiceCount || summary.receiptCount) > 0 && documents.length === 0) {
      blockers.push({
        code: 'FINANCIAL_DOCUMENTS_MISSING',
        severity: 'blocker',
        message: 'Billing records exist for this admission but no printable bill/invoice/receipt is available in the Financial Packet.'
      });
    }
  }

  if (isPmjayPacket(packetType)) {
    const unsigned = documents.filter((document) => document.status === 'Completed/Unsigned');
    if (unsigned.length) warnings.push({
      code: 'PMJAY_UNSIGNED_DOCUMENTS',
      severity: 'warning',
      message: `${unsigned.length} selected PMJAY document(s) are completed but unsigned. Generation is allowed, but signature status should be reviewed before submission.`,
      details: { documents: unsigned.slice(0, 25).map((document) => ({ key: document.key, title: document.title })) }
    });
  }

  if (!documents.length) warnings.push({
    code: 'EMPTY_PACKET',
    severity: 'warning',
    message: 'No printable documents are currently available for this packet.'
  });

  return { blockers, warnings };
}

function buildPacketPlan({ packetType, manifest, candidates = [] }) {
  const suppressed = [];
  const eligible = [];

  for (const document of candidates) {
    if (!isApplicable(document)) {
      suppressed.push({ document, reason: 'not_applicable' });
      continue;
    }
    if (isRawExternalRecord(document)) {
      suppressed.push({ document, reason: 'raw_internal_record' });
      continue;
    }
    if (!externalStatusEligible(document)) {
      suppressed.push({ document, reason: 'incomplete' });
      continue;
    }
    eligible.push(document);
  }

  const deduped = dedupeDocuments(eligible);
  suppressed.push(...deduped.suppressed);

  const validation = validateSelectedDocuments(deduped.documents, packetType, manifest);
  const suppressionCounts = suppressed.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {});

  return {
    packetType,
    documents: deduped.documents,
    validation: {
      ...validation,
      ready: validation.blockers.length === 0,
      suppressedCount: suppressed.length,
      suppressionCounts
    },
    suppressedDocuments: suppressed.map(({ document, reason }) => ({
      key: document.key,
      title: document.title,
      category: document.category,
      status: document.status,
      reason
    }))
  };
}

// Compatibility exports. Client decision: these checks must not block packet generation.
function completionIssues() { return []; }
function requiresFinalSignature() { return false; }

module.exports = {
  completionIssues,
  canonicalKey,
  dedupeDocuments,
  requiresFinalSignature,
  isRawExternalRecord,
  externalStatusEligible,
  buildPmjayGate,
  buildInsuranceGate,
  buildPacketPlan,
  isPmjayPacket,
  isInsurancePacket
};
