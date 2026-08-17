const ClaimCase = require('../models/ClaimCase');
const ClaimEvidence = require('../models/ClaimEvidence');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const PackageEpisode = require('../models/PackageEpisode');
const IPDRound = require('../models/IPDRound');
const IPDVitals = require('../models/IPDVitals');
const NursingNote = require('../models/NursingNote');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const DischargeSummary = require('../models/DischargeSummary');
const OTOperativeNote = require('../models/OTOperativeNote');
const EncounterDocument = require('../models/EncounterDocument');
const FinancialTransaction = require('../models/FinancialTransaction');
const Invoice = require('../models/Invoice');
const Hospital = require('../models/Hospital');
const { resolveSchemeRuleProfile } = require('./claimRuleProfile.service');
const { present, cashCollectionRows, buildDayCoverage, effectivePmjayData, evaluateClaimReadinessData } = require('./claimReadinessRules.service');

async function loadClaimReadinessData({ hospitalId, claimId }) {
  const claim = await ClaimCase.findOne({ _id: claimId, hospitalId })
    .populate('payerId', 'code name type empanelment pricingPolicy')
    .populate('coverageId')
    .populate('admissionId')
    .populate('appointmentId')
    .populate('patientId')
    .lean();
  if (!claim) { const error = new Error('Claim not found'); error.statusCode = 404; throw error; }
  const coverage = claim.coverageId && typeof claim.coverageId === 'object'
    ? claim.coverageId
    : await AdmissionCoverage.findOne({ _id: claim.coverageId, hospitalId }).lean();
  const admissionId = claim.encounterType === 'IPD' ? (claim.admissionId?._id || claim.admissionId) : null;
  const [evidence, packageEpisodes, rounds, vitals, nursingNotes, medications, discharge, operativeNotes, encounterDocuments, financialTransactions, invoices, hospital] = await Promise.all([
    ClaimEvidence.find({ hospitalId, claimId: claim._id, status: 'current' }).sort({ capturedAt: 1, createdAt: 1 }).lean(),
    PackageEpisode.find({ hospitalId, coverageId: coverage?._id, status: { $in: ['planned', 'active', 'completed'] } }).sort({ startsAt: 1 }).lean(),
    admissionId ? IPDRound.find({ hospitalId, admissionId }).sort({ roundDateTime: 1 }).lean() : [],
    admissionId ? IPDVitals.find({ hospitalId, admissionId }).sort({ recordedAt: 1 }).lean() : [],
    admissionId ? NursingNote.find({ hospitalId, admissionId }).sort({ noteDateTime: 1 }).lean() : [],
    admissionId ? IPDMedicationChart.find({ hospitalId, admissionId }).sort({ startDate: 1 }).lean() : [],
    admissionId ? DischargeSummary.findOne({ hospitalId, admissionId }).lean() : null,
    admissionId ? OTOperativeNote.find({ hospitalId, admissionId, status: { $in: ['Completed', 'Signed', 'Amended'] } }).lean() : [],
    admissionId ? EncounterDocument.find({ hospitalId, admissionId, status: { $nin: ['Superseded', 'Entered in Error'] } }).lean() : [],
    admissionId ? FinancialTransaction.find({ hospitalId, admissionId, status: 'POSTED' }).lean() : [],
    admissionId ? Invoice.find({ hospital_id: hospitalId, admission_id: admissionId, document_stage: { $ne: 'VOID' } }).lean() : [],
    Hospital.findById(hospitalId).lean()
  ]);
  return {
    claim,
    coverage,
    payer: claim.payerId,
    admission: claim.encounterType === 'IPD' ? claim.admissionId : null,
    appointment: claim.encounterType === 'OPD' ? claim.appointmentId : null,
    patient: claim.patientId,
    evidence,
    packageEpisodes,
    rounds,
    vitals,
    nursingNotes,
    medications,
    discharge,
    operativeNotes,
    encounterDocuments,
    financialTransactions,
    invoices,
    hospital,
    schemeType: claim.schemeType || coverage?.payerCategory || claim.payerId?.type || 'generic'
  };
}

async function evaluate({ hospitalId, claimId }) {
  const data = await loadClaimReadinessData({ hospitalId, claimId });
  const profile = await resolveSchemeRuleProfile({ hospitalId, schemeType: data.schemeType });
  const result = evaluateClaimReadinessData(data, profile);
  const override = data.claim?.readiness?.override?.active ? data.claim.readiness.override : null;
  return { ...result, effectiveStatus: override ? 'overridden' : result.status, override: override || { active: false } };
}

async function evaluateAndPersist({ hospitalId, claimId, user }) {
  const data = await loadClaimReadinessData({ hospitalId, claimId });
  const profile = await resolveSchemeRuleProfile({ hospitalId, schemeType: data.schemeType });
  const result = evaluateClaimReadinessData(data, profile);
  const claim = await ClaimCase.findOne({ _id: claimId, hospitalId });
  const override = claim?.readiness?.override?.active ? claim.readiness.override.toObject?.() || claim.readiness.override : null;
  claim.readiness = {
    status: override ? 'overridden' : result.status,
    score: result.score,
    evaluatedAt: new Date(),
    rulesVersion: result.rulesVersion,
    blockers: result.blockers,
    warnings: result.warnings,
    override: override || { active: false }
  };
  claim.updatedBy = user?._id || claim.updatedBy;
  claim.revision += 1;
  await claim.save();
  return { ...result, effectiveStatus: override ? 'overridden' : result.status, override: claim.readiness.override };
}

module.exports = {
  present,
  cashCollectionRows,
  buildDayCoverage,
  effectivePmjayData,
  evaluateClaimReadinessData,
  loadClaimReadinessData,
  evaluate,
  evaluateAndPersist
};
