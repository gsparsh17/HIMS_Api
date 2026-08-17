function numeric(value) { return Number(value || 0); }
function text(value) { return String(value || '').trim(); }
function present(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.some(present);
  if (typeof value === 'object') return Object.values(value).some(present);
  return !/^(not recorded|not applicable|n\/?a|—)$/i.test(String(value).trim());
}
const HOSPITAL_TIME_ZONE = process.env.HOSPITAL_TIME_ZONE || 'Asia/Kolkata';
const hospitalDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: HOSPITAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});
function dayKey(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(hospitalDayFormatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dateRange(start, end, maxDays = 120) {
  const startKey = dayKey(start); const endKey = dayKey(end || start);
  if (!startKey || !endKey) return [];
  const cursor = new Date(`${startKey}T12:00:00.000Z`);
  const until = new Date(`${endKey}T12:00:00.000Z`);
  const result = [];
  while (cursor <= until && result.length < maxDays) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}
function issue(code, severity, message, source, details) { return { code, severity, message, source, ...(details ? { details } : {}) }; }

function effectivePmjayData(data) {
  const coveragePmjay = data.coverage?.schemeData?.pmjay || {};
  const claimPmjay = data.claim?.schemeData?.pmjay || {};
  const packageEpisode = data.packageEpisodes?.[0] || {};
  return {
    ...coveragePmjay,
    ...claimPmjay,
    beneficiaryId: claimPmjay.beneficiaryId || coveragePmjay.beneficiaryId || data.coverage?.beneficiary?.beneficiaryId || data.coverage?.beneficiary?.schemeCardNumber,
    pmjayCaseId: claimPmjay.pmjayCaseId || coveragePmjay.pmjayCaseId,
    packageCode: claimPmjay.packageCode || coveragePmjay.packageCode || data.coverage?.preAuthorisation?.requestedPackageCode || packageEpisode.packageCode,
    packageName: claimPmjay.packageName || coveragePmjay.packageName || packageEpisode.packageName,
    specialty: claimPmjay.specialty || coveragePmjay.specialty || data.coverage?.rateContext?.specialty,
    finalDiagnosis: claimPmjay.finalDiagnosis || coveragePmjay.finalDiagnosis || data.discharge?.finalDiagnosis,
    provisionalDiagnosis: claimPmjay.provisionalDiagnosis || coveragePmjay.provisionalDiagnosis,
    icd10Codes: claimPmjay.icd10Codes?.length ? claimPmjay.icd10Codes : (coveragePmjay.icd10Codes || []),
    procedureCodes: claimPmjay.procedureCodes?.length ? claimPmjay.procedureCodes : (coveragePmjay.procedureCodes || [])
  };
}

function cashCollectionRows(transactions = []) {
  const patientMethods = new Set(['Cash', 'Card', 'UPI', 'Net Banking', 'Bank']);
  return transactions.filter((row) => {
    if (row.status !== 'POSTED' || row.direction !== 'CREDIT' || row.externalMoneyMovement === false) return false;
    if (!['RECEIPT', 'ADVANCE_DEPOSIT', 'SETTLEMENT'].includes(row.transactionType)) return false;
    if (patientMethods.has(row.paymentMethod)) return numeric(row.amount) > 0;
    return (row.paymentBreakdown || []).some((part) => patientMethods.has(part.method) && numeric(part.amount) > 0);
  });
}

function buildDayCoverage(data) {
  if (!data.admission?.admissionDate) return [];
  const end = data.admission.dischargeDate || data.discharge?.dischargeDate || new Date();
  const days = dateRange(data.admission.admissionDate, end);
  const roundByDay = new Map();
  const vitalsByDay = new Map();
  const nursingByDay = new Map();
  for (const row of data.rounds || []) {
    const key = dayKey(row.roundDateTime || row.createdAt); if (!key) continue;
    if (!roundByDay.has(key)) roundByDay.set(key, []); roundByDay.get(key).push(row);
  }
  for (const row of data.vitals || []) {
    const key = dayKey(row.chartDate || row.recordedAt || row.createdAt); if (!key) continue;
    if (!vitalsByDay.has(key)) vitalsByDay.set(key, []); vitalsByDay.get(key).push(row);
  }
  for (const row of data.nursingNotes || []) {
    const key = dayKey(row.noteDateTime || row.createdAt); if (!key) continue;
    if (!nursingByDay.has(key)) nursingByDay.set(key, []); nursingByDay.get(key).push(row);
  }
  return days.map((date) => {
    const rounds = roundByDay.get(date) || [];
    const vitals = vitalsByDay.get(date) || [];
    const nursing = nursingByDay.get(date) || [];
    const clinicalNotes = rounds.some((row) => present(row.dailyHistoryAndExamination) || present(row.examinationFindings) || present(row.complaints) || present(row.notes)) || nursing.some((row) => present(row.note));
    const treatment = rounds.some((row) => present(row.treatmentPlan) || present(row.medicationChanges) || present(row.advice)) || (data.medications || []).some((med) => {
      const start = dayKey(med.startDate || med.createdAt); const stop = dayKey(med.stoppedAt || med.endDate || med.updatedAt || end);
      return start && start <= date && (!stop || stop >= date) && !['Stopped', 'Requested'].includes(med.status);
    });
    return { date, vitals: vitals.length > 0, clinicalNotes, treatment, complete: vitals.length > 0 && clinicalNotes && treatment };
  });
}


function packageRuleFor(profile, packageCode) {
  const code = String(packageCode || '').trim().toUpperCase();
  if (!code) return null;
  return (profile?.packageRules || []).find((row) =>
    String(row.packageCode || '').trim().toUpperCase() === code
  ) || null;
}

function evaluateClaimReadinessData(data, profile) {
  const blockers = [];
  const warnings = [];
  const schemeType = String(data.schemeType || data.coverage?.payerCategory || data.payer?.type || 'generic').toLowerCase();
  const rules = profile?.rules || {};
  const pmjay = effectivePmjayData(data);
  const preauth = data.coverage?.preAuthorisation || data.claim?.preAuth || {};

  if (rules.requirePreauthWhenCoverageSaysRequired && data.coverage?.preAuthorisation?.required) {
    if (!['approved', 'partially_approved'].includes(String(preauth.status || '').toLowerCase())) blockers.push(issue('PREAUTH_NOT_APPROVED', 'critical', 'Required pre-authorisation is not approved.', 'coverage.preAuthorisation', { status: preauth.status }));
  }
  const approvedPreauth = numeric(data.coverage?.preAuthorisation?.approvedAmount || data.claim?.preAuth?.approvedAmount);
  const submitted = numeric(data.claim?.amounts?.claimSubmittedAmount || data.claim?.amounts?.sponsorLiability);
  if (rules.requireClaimAtOrBelowPreauth && approvedPreauth > 0 && submitted > approvedPreauth + 0.01) blockers.push(issue('CLAIM_EXCEEDS_PREAUTH', 'critical', 'Claim submitted amount exceeds the approved pre-authorisation amount.', 'claim.amounts', { submitted, approvedPreauth }));

  if (schemeType === 'pmjay') {
    if (rules.requireBeneficiaryId && !present(pmjay.beneficiaryId)) blockers.push(issue('PMJAY_BENEFICIARY_ID_MISSING', 'critical', 'PMJAY beneficiary/card identifier is missing.', 'coverage.beneficiary'));
    const genericEligibilityStatus = String(data.coverage?.eligibility?.status || '').toLowerCase();
    const bisStatus = String(pmjay?.bis?.status || '').toLowerCase();
    const eligibilityVerified = ['verified', 'emergency_override'].includes(genericEligibilityStatus) || bisStatus === 'verified';
    if (rules.requireEligibilityVerified && !eligibilityVerified) blockers.push(issue('PMJAY_ELIGIBILITY_NOT_VERIFIED', 'critical', 'Beneficiary eligibility has not been verified through the configured PMJAY/BIS workflow.', 'coverage.eligibility', { status: data.coverage?.eligibility?.status, bisStatus: pmjay?.bis?.status }));
    if (genericEligibilityStatus === 'emergency_override' || bisStatus === 'manual_override') warnings.push(issue('PMJAY_ELIGIBILITY_OVERRIDE', 'high', 'Eligibility uses an override and should be reconciled with BIS/TMS evidence.', 'coverage.eligibility'));
    if (rules.requirePackageCode && !present(pmjay.packageCode)) blockers.push(issue('PMJAY_PACKAGE_MISSING', 'critical', 'PMJAY package code is missing.', 'scheme.package'));
    if (rules.requireDiagnosis && !present(pmjay.finalDiagnosis) && !present(pmjay.provisionalDiagnosis)) blockers.push(issue('PMJAY_DIAGNOSIS_MISSING', 'critical', 'Claim diagnosis is missing.', 'scheme.diagnosis'));
    if (rules.requireIcd10 && !(pmjay.icd10Codes || []).length) warnings.push(issue('PMJAY_ICD10_MISSING', 'high', 'ICD-10 code is required by the active rule profile but has not been recorded.', 'scheme.diagnosis'));
    if (rules.requireDischargeSummary && !data.discharge) blockers.push(issue('PMJAY_DISCHARGE_SUMMARY_MISSING', 'critical', 'Discharge summary is missing.', 'discharge'));

    const cashRows = cashCollectionRows(data.financialTransactions || []);
    if (rules.blockCashCollection && cashRows.length) blockers.push(issue('PMJAY_PATIENT_CASH_COLLECTION', 'critical', 'Patient-facing cash/card/UPI/bank collection exists against this PMJAY admission. Reconcile or document an authorized exception before claim submission.', 'financial', { transactionNumbers: cashRows.map((row) => row.transactionNumber), amount: cashRows.reduce((sum, row) => sum + numeric(row.amount), 0) }));

    const currentEvidenceTypes = new Set((data.evidence || []).filter((row) => row.status === 'current').map((row) => row.evidenceType));
    const currentDocumentTypes = new Set((data.encounterDocuments || []).map((row) => String(row.documentType || '').toLowerCase()));
    for (const requiredType of rules.requiredEvidenceTypes || []) {
      if (!currentEvidenceTypes.has(requiredType)) blockers.push(issue('PMJAY_PROFILE_EVIDENCE_MISSING', 'critical', `Active PMJAY rule profile requires evidence: ${requiredType}.`, 'claim.evidence', { evidenceType: requiredType }));
    }
    for (const requiredType of rules.requiredDocumentTypes || []) {
      if (!currentDocumentTypes.has(String(requiredType).toLowerCase())) blockers.push(issue('PMJAY_PROFILE_DOCUMENT_MISSING', 'critical', `Active PMJAY rule profile requires document: ${requiredType}.`, 'documents', { documentType: requiredType }));
    }
    const caseKey = String(pmjay.caseType || pmjay.packageType || '').toLowerCase();
    const caseRule = rules.custom?.caseTypeRequirements?.[caseKey];
    if (caseRule) {
      for (const requiredType of caseRule.requiredEvidenceTypes || []) if (!currentEvidenceTypes.has(requiredType)) blockers.push(issue('PMJAY_CASE_EVIDENCE_MISSING', 'critical', `${caseKey} case requires evidence: ${requiredType}.`, 'claim.evidence', { evidenceType: requiredType, caseType: caseKey }));
      for (const requiredType of caseRule.requiredDocumentTypes || []) if (!currentDocumentTypes.has(String(requiredType).toLowerCase())) blockers.push(issue('PMJAY_CASE_DOCUMENT_MISSING', 'critical', `${caseKey} case requires document: ${requiredType}.`, 'documents', { documentType: requiredType, caseType: caseKey }));
    }
    if (numeric(rules.stateSubmissionDeadlineDays) > 0 && !data.claim?.submittedAt) {
      const dischargeAt = data.admission?.dischargeDate || data.discharge?.dischargeDate;
      if (dischargeAt) {
        const dueAt = new Date(dischargeAt); dueAt.setDate(dueAt.getDate() + numeric(rules.stateSubmissionDeadlineDays));
        if (!Number.isNaN(dueAt.getTime()) && Date.now() > dueAt.getTime()) {
          const target = rules.submissionDeadlineSeverity === 'blocker' ? blockers : warnings;
          target.push(issue('PMJAY_CONFIGURED_SUBMISSION_DEADLINE', rules.submissionDeadlineSeverity === 'blocker' ? 'critical' : 'high', `Claim is beyond the configured ${rules.stateSubmissionDeadlineDays}-day post-discharge submission window. This is a configured SHA/hospital rule, not a universal hard-coded national deadline.`, 'claim.submission', { dueAt }));
        }
      }
    }

    const packageRule = packageRuleFor(profile, pmjay.packageCode);
    if (packageRule) {
      if (packageRule.hospitalEligible === false) blockers.push(issue('PMJAY_HOSPITAL_NOT_ELIGIBLE_FOR_PACKAGE', 'critical', 'This hospital is not configured as eligible/empanelled for the selected PMJAY package or specialty.', 'scheme.package', { packageCode: pmjay.packageCode, specialty: packageRule.specialty }));
      const diagnoses = (pmjay.icd10Codes || []).map((value) => String(value).toUpperCase());
      if (packageRule.diagnosisCodes?.length && !packageRule.diagnosisCodes.some((value) => diagnoses.includes(String(value).toUpperCase()))) blockers.push(issue('PMJAY_PACKAGE_DIAGNOSIS_MISMATCH', 'critical', 'Recorded ICD-10 diagnosis does not match the configured package rule.', 'scheme.reconciliation', { packageCode: pmjay.packageCode, allowed: packageRule.diagnosisCodes, recorded: diagnoses }));
      const procedures = (pmjay.procedureCodes || []).map((value) => String(value).toUpperCase());
      if (packageRule.procedureCodes?.length && !packageRule.procedureCodes.some((value) => procedures.includes(String(value).toUpperCase()))) blockers.push(issue('PMJAY_PACKAGE_PROCEDURE_MISMATCH', 'critical', 'Recorded procedure does not match the configured package rule.', 'scheme.reconciliation', { packageCode: pmjay.packageCode, allowed: packageRule.procedureCodes, recorded: procedures }));
      if (packageRule.specialty && pmjay.specialty && text(packageRule.specialty).toLowerCase() !== text(pmjay.specialty).toLowerCase()) blockers.push(issue('PMJAY_SPECIALTY_MISMATCH', 'critical', 'Package specialty does not match the claim/admission specialty.', 'scheme.reconciliation', { required: packageRule.specialty, recorded: pmjay.specialty }));
      const evidenceTypes = new Set((data.evidence || []).filter((row) => row.status === 'current').map((row) => row.evidenceType));
      for (const requiredType of packageRule.requiredEvidenceTypes || []) {
        if (!evidenceTypes.has(requiredType)) blockers.push(issue('PMJAY_REQUIRED_EVIDENCE_MISSING', 'critical', `Package evidence is missing: ${requiredType}.`, 'claim.evidence', { evidenceType: requiredType, packageCode: pmjay.packageCode }));
      }
      const documentTypes = new Set((data.encounterDocuments || []).map((row) => String(row.documentType || '').toLowerCase()));
      for (const requiredType of packageRule.requiredDocumentTypes || []) {
        if (!documentTypes.has(String(requiredType).toLowerCase())) blockers.push(issue('PMJAY_REQUIRED_DOCUMENT_MISSING', 'critical', `Package document is missing: ${requiredType}.`, 'documents', { documentType: requiredType, packageCode: pmjay.packageCode }));
      }
    }

    const preauthStatus = String(data.coverage?.preAuthorisation?.status || data.claim?.preAuth?.status || '').toLowerCase();
    if ((pmjay.portability || String(pmjay.caseType || '').toLowerCase() === 'portability') && !['approved', 'partially_approved'].includes(preauthStatus)) blockers.push(issue('PMJAY_PORTABILITY_PREAUTH_REQUIRED', 'critical', 'Portability cases require approved pre-authorisation.', 'coverage.preAuthorisation'));
    if (String(pmjay.packageType || pmjay.caseType || '').toLowerCase() === 'unspecified_surgical' && !['approved', 'partially_approved'].includes(preauthStatus)) blockers.push(issue('PMJAY_UNSPECIFIED_SURGICAL_PREAUTH_REQUIRED', 'critical', 'Unspecified surgical packages require approved pre-authorisation.', 'coverage.preAuthorisation'));
    if ((data.packageEpisodes || []).filter((row) => ['planned', 'active', 'completed'].includes(row.status)).length > 1) warnings.push(issue('PMJAY_MULTIPLE_PACKAGE_REVIEW', 'high', 'Multiple package episodes are linked to this admission. Review combination/unbundling rules before submission.', 'scheme.package'));

    const surgical = String(pmjay.packageType || pmjay.caseType || '').toLowerCase().includes('surg') || (data.operativeNotes || []).length > 0;
    if (surgical && !(data.operativeNotes || []).length) warnings.push(issue('PMJAY_OT_NOTE_MISSING', 'high', 'Surgical claim has no structured operative note linked to the admission.', 'ot'));

    if (rules.requireDayWiseClinicalCoverage) {
      const dayCoverage = buildDayCoverage(data);
      const incomplete = dayCoverage.filter((row) => !row.complete);
      if (incomplete.length) warnings.push(issue('PMJAY_DAYWISE_CLINICAL_COVERAGE_INCOMPLETE', 'high', `Day-wise clinical coverage is incomplete for ${incomplete.length} hospitalization day(s). Each day should carry vitals, clinical notes and treatment evidence.`, 'clinical.daywise', { days: dayCoverage }));
    }

    if (rules.warnUnsignedClinicalDocuments) {
      const unsigned = (data.encounterDocuments || []).filter((row) => row.status === 'Completed/Unsigned' && ['consent', 'assessment', 'progress', 'procedure', 'ot', 'anesthesia', 'discharge', 'investigation'].includes(row.category));
      if (unsigned.length) warnings.push(issue('PMJAY_UNSIGNED_DOCUMENTS', 'warning', `${unsigned.length} claim-relevant completed document(s) are unsigned. Packet generation remains allowed, but signature status should be reviewed.`, 'documents', { documents: unsigned.slice(0, 25).map((row) => ({ id: row._id, title: row.title, category: row.category })) }));
    }

    if (data.discharge) {
      const annexureMissing = [];
      if (!present(pmjay.pmjayCaseId)) annexureMissing.push('PMJAY Case ID');
      if (!present(pmjay.packageCode)) annexureMissing.push('Package booked');
      if (!(pmjay.icd10Codes || []).length) annexureMissing.push('ICD-10');
      if (!present(data.discharge.treatmentGiven)) annexureMissing.push('Treatment given');
      if (!present(data.discharge.conditionAtDischargeText || data.discharge.conditionOnDischarge)) annexureMissing.push('Condition at discharge');
      if (!present(data.discharge.followUpDate || data.discharge.followUpAdvice || data.discharge.followUpDetails)) annexureMissing.push('Follow-up');
      if (annexureMissing.length) warnings.push(issue('PMJAY_DISCHARGE_ANNEXURE_FIELDS_INCOMPLETE', 'high', 'PMJAY discharge-summary fields are incomplete.', 'discharge', { missing: annexureMissing }));
    }
  }

  if (!(data.invoices || []).some((row) => String(row.document_stage || '').toUpperCase() === 'ISSUED')) warnings.push(issue('CLAIM_FINAL_INVOICE_MISSING', 'warning', 'No issued/final invoice is linked to this claim encounter.', 'financial'));
  const openQueries = (data.claim?.queries || []).filter((row) => row.status === 'open');
  if (openQueries.length) warnings.push(issue('CLAIM_OPEN_QUERIES', 'high', `${openQueries.length} claim query/queries remain open.`, 'claim.queries', { queryNumbers: openQueries.map((row) => row.queryNumber) }));

  const status = blockers.length ? 'blocked' : (warnings.length ? 'warning' : 'ready');
  const penalty = blockers.length * 25 + warnings.reduce((sum, row) => sum + (row.severity === 'high' ? 8 : 4), 0);
  return { status, score: Math.max(0, 100 - penalty), blockers, warnings, dayCoverage: buildDayCoverage(data), pmjay, rulesVersion: profile?.version || 'HIMS-2026.1', profile: { schemeType: profile?.schemeType, jurisdiction: profile?.jurisdiction, profileName: profile?.profileName, version: profile?.version, sourceReference: profile?.sourceReference, appliedProfiles: profile?.appliedProfiles || [] } };
}

module.exports = {
  present,
  cashCollectionRows,
  buildDayCoverage,
  effectivePmjayData,
  evaluateClaimReadinessData
};
