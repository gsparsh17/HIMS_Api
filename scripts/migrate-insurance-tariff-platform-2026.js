#!/usr/bin/env node
'use strict';

/**
 * Single-hospital insurance/tariff/claims platform migration.
 *
 * Safe default: PREVIEW ONLY. Pass --apply to write.
 * hospitalId is a server-derived technical scope key, never an upload column.
 *
 * Examples:
 *   node scripts/migrate-insurance-tariff-platform-2026.js --hospital-id=<id>
 *   node scripts/migrate-insurance-tariff-platform-2026.js --hospital-id=<id> --apply
 *   node scripts/migrate-insurance-tariff-platform-2026.js --hospital-id=<id> \
 *     --source-page-map=./data/cghs-page-map.json --source-verified --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Hospital = require('../models/Hospital');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const { validateRateCard } = require('../services/tariffValidation.service');
const {
  compact,
  normalizeCode,
  normalizeSpecimen,
  normalizeCategory,
  serviceSignature,
  imagingCategory,
  payerTypeFromLegacy,
  placeholderName,
  parsePageMap
} = require('../utils/insuranceTariffMigration');

const MIGRATION_ID = 'insurance-tariff-claims-platform-2026-v1';
const NEW_BILLING_ACTIONS = [
  'claim_submit', 'claim_manage', 'claim_export', 'preauth_decide',
  'coverage_reprice', 'coverage_reprice_commit', 'pricing_override',
  'settlement', 'final_clearance'
];
const NEW_MASTER_ACTIONS = [
  'bulk_import_commit', 'rate_card_approve', 'rate_card_activate',
  'tariff_mapping_approve'
];
const NON_LAB_CATEGORIES = new Set(['radiology', 'cardiology']);
const CGHS_CLASSIFICATION_REPAIRS = new Map([
  ['CP021', 'procedure'],
  ['CP026', 'procedure'],
  ['NI007', 'other']
]);
const KNOWN_CGHS_BLANK_NAMES = new Set(['DP060', 'OP101', 'NS059']);

function parseArgs(argv) {
  const result = {
    apply: false,
    hospitalId: null,
    mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || '',
    pageMapPath: null,
    sourceVerified: false,
    reportPath: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') result.apply = true;
    else if (arg === '--source-verified') result.sourceVerified = true;
    else if (arg.startsWith('--hospital-id=')) result.hospitalId = arg.slice('--hospital-id='.length);
    else if (arg.startsWith('--mongo-uri=')) result.mongoUri = arg.slice('--mongo-uri='.length);
    else if (arg.startsWith('--source-page-map=')) result.pageMapPath = arg.slice('--source-page-map='.length);
    else if (arg.startsWith('--report=')) result.reportPath = arg.slice('--report='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.mongoUri) throw new Error('MONGODB_URI or MONGO_URI is required');
  if (result.hospitalId && !mongoose.isValidObjectId(result.hospitalId)) throw new Error('--hospital-id must be a valid ObjectId');
  if (result.sourceVerified && !result.pageMapPath) throw new Error('--source-verified requires --source-page-map');
  return result;
}

function objectId(value) {
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
}
function sameId(a, b) { return a != null && b != null && String(a) === String(b); }
function now() { return new Date(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function toPlain(value) { return value?.toObject?.() || value || {}; }
function mergeRaw(sourceRow, patch) {
  const row = toPlain(sourceRow);
  return { ...row, raw: { ...(row.raw || {}), ...patch } };
}
function reportLine(report, section, field, increment = 1) {
  report[section] ||= {};
  report[section][field] = Number(report[section][field] || 0) + increment;
}
async function bulk(collection, operations, apply) {
  if (!operations.length || !apply) return null;
  return collection.bulkWrite(operations, { ordered: false });
}

async function resolveHospital(explicitId) {
  if (explicitId) {
    const hospital = await Hospital.findById(explicitId).lean();
    if (!hospital) throw new Error('Hospital not found');
    return hospital;
  }
  const hospitals = await Hospital.find({}).limit(3).lean();
  if (hospitals.length !== 1) {
    throw new Error(`Could not infer one hospital (${hospitals.length} found). Pass --hospital-id=<ObjectId>.`);
  }
  return hospitals[0];
}

async function ensureSelfPayer({ hospitalId, apply, report }) {
  const collection = mongoose.connection.collection('payers');
  const existing = await collection.findOne({ hospitalId, code: 'SELF' });
  if (existing) return existing;
  reportLine(report, 'payers', 'selfPayerToCreate');
  const doc = {
    hospitalId, code: 'SELF', name: 'Self Pay', type: 'self', networkStatus: 'not_applicable', demoOnly: false,
    empanelment: { status: 'not_required' }, contacts: [], settlementTerms: { creditDays: 0, claimSubmissionDays: 0 },
    pricingPolicy: { missingItem: 'cash_fallback', balanceBilling: 'patient', defaultCoPayPercentage: 100, defaultDeductibleAmount: 0, requireEligibility: false, requirePreAuthorisation: false, receivableRecognition: 'invoice_issue' },
    documentChecklist: [], isActive: true, createdAt: now(), updatedAt: now()
  };
  if (apply) await collection.insertOne(doc);
  return doc;
}

async function migrateProcedures({ hospitalId, apply, report }) {
  const collection = mongoose.connection.collection('procedures');
  const rows = await collection.find({}).toArray();
  const codeGroups = new Map();
  const operations = [];
  for (const row of rows) {
    const code = normalizeCode(row.code);
    const key = code;
    const ids = codeGroups.get(key) || [];
    ids.push(row._id);
    codeGroups.set(key, ids);

    const update = {
      hospitalId,
      code,
      name: compact(row.name),
      category: compact(row.category || 'Other'),
      subcategory: compact(row.subcategory || row.category || ''),
      specialty: compact(row.specialty || (String(row.code || '').toUpperCase().startsWith('D') ? 'Dentistry' : row.category || '')),
      serviceDomain: row.serviceDomain || (/surgery|excision|ectomy|repair|replacement|fixation|reconstruction/i.test(row.name || '') ? 'surgery' : 'procedure'),
      base_price: Number(row.base_price || 0),
      is_billable: row.is_billable !== false,
      allow_zero_price: row.allow_zero_price === true || (Number(row.base_price || 0) === 0 && row.is_billable !== false),
      is_active: row.is_active !== false,
      insurance_coverage: row.insurance_coverage || 'Partial',
      version: String(row.version || '1.0'),
      createdAt: row.createdAt || row.created_at || now(),
      updatedAt: row.updatedAt || row.updated_at || now()
    };
    if (!sameId(row.hospitalId, hospitalId)) reportLine(report, 'procedures', 'hospitalScopeRepairs');
    if (row.version !== update.version) reportLine(report, 'procedures', 'versionRepairs');
    operations.push({ updateOne: { filter: { _id: row._id }, update: { $set: update, $unset: { created_at: '', updated_at: '' } } } });
  }
  const duplicates = [...codeGroups.entries()].filter(([code, ids]) => code && ids.length > 1);
  report.procedures = { ...(report.procedures || {}), scanned: rows.length, writesPlanned: operations.length, duplicateCodesBlockingIndex: duplicates.map(([code, ids]) => ({ code, count: ids.length, ids: ids.map(String) })) };
  await bulk(collection, operations, apply);

  if (apply) {
    const indexes = await collection.indexes();
    for (const index of indexes) {
      const fields = Object.keys(index.key || {});
      if (index.unique && fields.length === 1 && fields[0] === 'code') await collection.dropIndex(index.name);
    }
    if (!duplicates.length) {
      await collection.createIndex({ hospitalId: 1, code: 1 }, { unique: true, name: 'hospitalId_1_code_1' });
      await collection.createIndex({ hospitalId: 1, is_active: 1, is_billable: 1 }, { name: 'hospitalId_1_is_active_1_is_billable_1' });
    }
  }
}

async function migrateLegacyProviders({ report }) {
  const legacy = mongoose.connection.collection('insuranceproviders');
  const count = await legacy.countDocuments({});
  report.payers = {
    ...(report.payers || {}),
    legacyProvidersDetected: count,
    legacyMigrationDeferred: count > 0,
    instruction: count > 0
      ? 'Run scripts/consolidate-payer-masters-2026.js before applying this migration.'
      : 'No legacy insuranceproviders collection data remains.'
  };
  if (count > 0) {
    throw new Error(
      'Legacy insuranceproviders still exist. Run consolidate-payer-masters-2026.js first to migrate references and drop the duplicate collection.'
    );
  }
}

async function migrateLabAndImaging({ hospitalId, apply, report }) {
  const labs = mongoose.connection.collection('labtests');
  const images = mongoose.connection.collection('imagingtests');
  const labRows = await labs.find({}).toArray();
  const imageRows = await images.find({}).toArray();
  const imageBySignature = new Map();
  const imageByCode = new Map(imageRows.map((row) => [normalizeCode(row.code), row]));
  for (const row of imageRows) {
    const signature = serviceSignature(row.name);
    if (!signature) continue;
    const list = imageBySignature.get(signature) || [];
    list.push(row);
    imageBySignature.set(signature, list);
  }

  const labOps = [];
  const imageOps = [];
  let moved = 0;
  for (const row of labRows) {
    const categoryLower = compact(row.category).toLowerCase();
    const specimen = normalizeSpecimen(row.specimen_detail || row.specimen_type);
    const labUpdate = {
      hospitalId,
      code: normalizeCode(row.code),
      specimen_type: specimen.specimen_type,
      specimen_detail: specimen.specimen_detail,
      insurance_coverage: row.insurance_coverage || 'Partial',
      is_billable: row.is_billable !== false,
      allow_zero_price: row.allow_zero_price === true || (Number(row.base_price || 0) === 0 && row.is_billable !== false),
      updatedAt: now()
    };
    if (!sameId(row.hospitalId, hospitalId)) reportLine(report, 'lab', 'hospitalScopeRepairs');
    if (compact(row.specimen_type) !== specimen.specimen_type || compact(row.specimen_detail) !== specimen.specimen_detail) reportLine(report, 'lab', 'specimenRepairs');

    if (NON_LAB_CATEGORIES.has(categoryLower)) {
      moved += 1;
      const signature = serviceSignature(row.name);
      const candidates = imageBySignature.get(signature) || [];
      const canonical = candidates
        .filter((item) => Number(item.base_price || 0) > 0 && item.is_active !== false)
        .sort((a, b) => Number(b.usage_count || 0) - Number(a.usage_count || 0) || Number(b.base_price || 0) - Number(a.base_price || 0))[0];
      let targetId = canonical?._id;
      if (!targetId) {
        let code = normalizeCode(row.code || `IMG-${String(row._id).slice(-8)}`);
        if (imageByCode.has(code)) code = `IMG-${code}`;
        const target = {
          _id: new mongoose.Types.ObjectId(), hospitalId, code, name: compact(row.name), aliases: [],
          category: imagingCategory(row.name, row.category), description: compact(row.description || `Migrated from legacy LabTest ${row.code}`),
          preparation_instructions: compact(row.preparation_instructions), contraindications: compact(row.contraindications), contrast_required: Boolean(row.contrast_required),
          turnaround_time_hours: Number(row.turnaround_time_hours || 24), base_price: Number(row.base_price || 0), insurance_coverage: row.insurance_coverage || 'Partial',
          template_only: false, is_billable: true, allow_zero_price: Number(row.base_price || 0) === 0, is_active: row.is_active !== false,
          usage_count: Number(row.usage_count || 0), createdAt: row.createdAt || row.updatedAt || now(), updatedAt: now(), migratedFromLabTestId: row._id
        };
        targetId = target._id;
        imageOps.push({ insertOne: { document: target } });
        imageByCode.set(code, target);
        const list = imageBySignature.get(signature) || []; list.push(target); imageBySignature.set(signature, list);
        reportLine(report, 'imaging', 'createdFromLab');
      } else {
        imageOps.push({ updateOne: { filter: { _id: targetId }, update: { $addToSet: { aliases: compact(row.name) }, $set: { updatedAt: now() } } } });
        reportLine(report, 'imaging', 'labServicesConsolidatedIntoExisting');
      }
      Object.assign(labUpdate, {
        category: 'Other', is_active: false, is_billable: false,
        archived_reason: 'Moved to ImagingTest during insurance/tariff platform migration',
        migratedToImagingTestId: targetId
      });
    }
    labOps.push({ updateOne: { filter: { _id: row._id }, update: { $set: labUpdate } } });
  }

  // Re-read planned + existing candidates conceptually. Existing image rows are
  // cleaned here; created rows already have valid billability settings.
  const positiveCanonicalBySignature = new Map();
  for (const [signature, rows] of imageBySignature.entries()) {
    const positive = rows.filter((row) => Number(row.base_price || 0) > 0 && row.is_active !== false)
      .sort((a, b) => Number(b.usage_count || 0) - Number(a.usage_count || 0) || Number(b.base_price || 0) - Number(a.base_price || 0));
    if (positive[0]) positiveCanonicalBySignature.set(signature, positive[0]);
  }
  for (const row of imageRows) {
    const signature = serviceSignature(row.name);
    const canonical = positiveCanonicalBySignature.get(signature);
    const templateDerived = Number(row.base_price || 0) === 0 && Boolean(row.report_template_id || /structured report template/i.test(row.description || ''));
    const update = { hospitalId, code: normalizeCode(row.code), updatedAt: now() };
    if (!sameId(row.hospitalId, hospitalId)) reportLine(report, 'imaging', 'hospitalScopeRepairs');
    if (templateDerived) {
      Object.assign(update, { template_only: true, is_billable: false, allow_zero_price: false });
      reportLine(report, 'imaging', 'zeroPriceTemplatesMadeNonBillable');
      if (canonical && !sameId(canonical._id, row._id)) {
        update.canonical_test_id = canonical._id;
        reportLine(report, 'imaging', 'templatesLinkedToCanonical');
      }
    } else if (Number(row.base_price || 0) === 0 && row.is_billable !== false) {
      Object.assign(update, { is_billable: false, allow_zero_price: false, archived_reason: 'Zero-priced service disabled pending cash-price review' });
      reportLine(report, 'imaging', 'otherZeroPriceServicesDisabled');
    } else {
      update.template_only = Boolean(row.template_only);
      update.is_billable = row.is_billable !== false;
      update.allow_zero_price = Boolean(row.allow_zero_price);
    }
    imageOps.push({ updateOne: { filter: { _id: row._id }, update: { $set: update } } });
  }

  report.lab = { ...(report.lab || {}), scanned: labRows.length, nonLabServicesMoved: moved, writesPlanned: labOps.length };
  report.imaging = { ...(report.imaging || {}), scanned: imageRows.length, writesPlanned: imageOps.length };
  await bulk(images, imageOps, apply);
  await bulk(labs, labOps, apply);
  if (apply) {
    await images.createIndex({ hospitalId: 1, code: 1 }, { unique: true, name: 'hospitalId_1_code_1' });
    await labs.createIndex({ hospitalId: 1, code: 1 }, { unique: true, name: 'hospitalId_1_code_1' });
  }
}

function loadPageMap(filePath) {
  if (!filePath) return new Map();
  const absolute = path.resolve(filePath);
  return parsePageMap(JSON.parse(fs.readFileSync(absolute, 'utf8')));
}

async function repairCghs({ hospitalId, apply, report, pageMap, sourceVerified }) {
  const payer = await Payer.findOne({ hospitalId, code: 'CGHS' }).lean();
  if (!payer) {
    report.cghs = { found: false, note: 'CGHS payer not present; no CGHS data repaired' };
    return;
  }
  const cards = await RateCard.find({ hospitalId, payerId: payer._id }).lean();
  const itemCollection = mongoose.connection.collection('ratecarditems');
  const cardCollection = mongoose.connection.collection('ratecards');
  report.cghs = { found: true, rateCards: cards.length, cards: [] };

  for (const card of cards) {
    const items = await itemCollection.find({ hospitalId, rateCardId: card._id }).toArray();
    const ops = [];
    const cardReport = { rateCardId: String(card._id), version: card.version, items: items.length, blankNamePlaceholders: 0, categoriesNormalized: 0, classificationsRepaired: 0, sourcePagesRestored: 0, sourcePagesMarkedUnresolved: 0 };
    for (const item of items) {
      const code = normalizeCode(item.externalCode);
      const set = {};
      const originalName = compact(item.externalName);
      if (!originalName || KNOWN_CGHS_BLANK_NAMES.has(code)) {
        set.externalName = placeholderName(item);
        set.sourceRow = mergeRaw(item.sourceRow, { sourceNameMissing: true, originalExternalName: originalName || null });
        cardReport.blankNamePlaceholders += 1;
      }
      const category = normalizeCategory(item.category);
      if (category && category !== compact(item.category)) {
        set.category = category;
        set.normalizedCategory = category.toLowerCase();
        cardReport.categoriesNormalized += 1;
      }
      if (CGHS_CLASSIFICATION_REPAIRS.has(code) && item.serviceType !== CGHS_CLASSIFICATION_REPAIRS.get(code)) {
        set.serviceType = CGHS_CLASSIFICATION_REPAIRS.get(code);
        set.sourceRow = mergeRaw(set.sourceRow || item.sourceRow, { serviceTypeCorrectedFrom: item.serviceType, serviceTypeCorrectionReason: 'Known keyword-classification error' });
        cardReport.classificationsRepaired += 1;
      }
      if (Number(item.packagePeriodDays || 0) > 0 && !item.packageDefinition?.isPackage) {
        set.pricingMode = 'package';
        set.packageDefinition = {
          isPackage: true,
          triggerOnCharge: true,
          startsAt: 'procedure_time',
          inclusions: [],
          exclusions: [],
          defaultUnlistedComponentTreatment: 'excluded',
          includesMedicines: false,
          includesConsumables: false,
          includesInvestigations: false,
          includesRoom: false,
          includesProfessionalFees: false
        };
        cardReport.packageFlagsRestored = Number(cardReport.packageFlagsRestored || 0) + 1;
      }
      if (!item.mappingOptions) set.mappingOptions = { requiredForBilling: true, unavailableAtHospital: false, allowMultipleExternalCodes: false };
      const mappedPage = pageMap.get(code);
      if (mappedPage) {
        set.sourceRow = { ...toPlain(set.sourceRow || item.sourceRow), page: mappedPage, raw: { ...(toPlain(set.sourceRow || item.sourceRow).raw || {}), sourcePageVerifiedFromMap: true, previousPage: item.sourceRow?.page } };
        cardReport.sourcePagesRestored += 1;
      } else if (items.length > 100 && Number(item.sourceRow?.page) === 7) {
        set.sourceRow = { ...toPlain(set.sourceRow || item.sourceRow), page: null, raw: { ...(toPlain(set.sourceRow || item.sourceRow).raw || {}), sourcePageUnresolved: true, previousPage: 7 } };
        cardReport.sourcePagesMarkedUnresolved += 1;
      }
      if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: item._id }, update: { $set: set } } });
    }
    await bulk(itemCollection, ops, apply);
    report.cghs.cards.push(cardReport);
    if (apply) {
      const completePageMap = pageMap.size > 0 && cardReport.sourcePagesRestored === items.length;
      await cardCollection.updateOne({ _id: card._id }, {
        $set: {
          status: 'staging',
          'source.verifiedAgainstSource': Boolean(sourceVerified && completePageMap),
          ...(sourceVerified && completePageMap ? { 'source.verifiedAt': now() } : {}),
          activationRequirements: {
            requireActiveEmpanelment: true,
            requireAllBillableMappings: true,
            minimumApprovedMappingPercentage: 100,
            requireSourceVerification: true
          },
          updatedAt: now()
        }
      });
      await validateRateCard({ hospitalId, rateCardId: card._id, persist: true });
    }
  }
}

function permissionRowsForUser(user) {
  const rows = Array.isArray(user.modulePermissions) ? user.modulePermissions.map((row) => ({ ...row })) : [];
  const role = compact(user.role).toLowerCase();
  const ensure = (moduleKey, access) => {
    let row = rows.find((item) => item.moduleKey === moduleKey);
    if (!row) { row = { moduleKey, access, actions: [], grantedAt: now() }; rows.push(row); }
    if (access === 'manage' && row.access === 'none') row.access = 'manage';
    return row;
  };
  const billingRoles = new Set(['admin', 'accountant', 'insurance_desk', 'registrar', 'receptionist']);
  const masterRoles = new Set(['admin']);
  const billing = rows.find((row) => row.moduleKey === 'billing_finance') || (billingRoles.has(role) ? ensure('billing_finance', 'manage') : null);
  if (billing && billing.access === 'manage') billing.actions = unique([...(billing.actions || []), ...NEW_BILLING_ACTIONS]);
  const masters = rows.find((row) => row.moduleKey === 'masters_settings') || (masterRoles.has(role) ? ensure('masters_settings', 'manage') : null);
  if (masters && masters.access === 'manage') masters.actions = unique([...(masters.actions || []), ...NEW_MASTER_ACTIONS]);
  rows.forEach((row) => { row.updatedAt = now(); });
  return rows;
}

function utilizationAmounts(snapshot = {}, fallback = {}) {
  const amounts = snapshot.amounts || {};
  return {
    eligibleAmount: Number(amounts.eligible ?? fallback.eligibleAmount ?? 0),
    sponsorLiability: Number(amounts.sponsorLiability ?? fallback.sponsorLiability ?? 0),
    patientLiability: Number(amounts.patientLiability ?? fallback.patientLiability ?? 0),
    coPayAmount: Number(amounts.coPay ?? 0),
    deductibleAmount: Number(amounts.deductible ?? 0),
    fixedPatientShare: Number(amounts.fixedPatientShare ?? 0),
    uncoveredAmount: Number(amounts.uncovered ?? 0)
  };
}

async function rebuildCoverageUtilization({ hospitalId, apply, report }) {
  const coverages = mongoose.connection.collection('admissioncoverages');
  const charges = mongoose.connection.collection('ipdcharges');
  const bills = mongoose.connection.collection('bills');
  const utilization = mongoose.connection.collection('coverageutilizations');
  const rows = await coverages.find({ hospitalId, active: true }).toArray();
  const utilizationOps = [];
  const coverageOps = [];
  let sourceLines = 0;

  for (const coverage of rows) {
    let sponsor = 0;
    let deductible = 0;
    const sourceRows = [];
    if (coverage.encounterType === 'IPD' && coverage.admissionId) {
      const chargeRows = await charges.find({
        hospitalId,
        admissionId: coverage.admissionId,
        status: { $in: ['ACTIVE', 'INVOICED'] }
      }).toArray();
      for (const charge of chargeRows) {
        const snapshot = charge.pricingSnapshot || {};
        const amounts = utilizationAmounts(snapshot, {
          eligibleAmount: charge.eligibleAmount ?? charge.contractedAmount ?? charge.netAmount,
          sponsorLiability: charge.sponsorLiability,
          patientLiability: charge.patientLiability
        });
        sourceRows.push({ sourceType: 'IPDCharge', sourceId: charge._id, sourceLineId: null, patientId: charge.patientId || coverage.patientId, snapshot, amounts });
      }
    } else if (coverage.encounterType === 'OPD' && coverage.appointmentId) {
      const billRows = await bills.find({
        hospital_id: hospitalId,
        appointment_id: coverage.appointmentId,
        status: { $nin: ['Cancelled', 'Refunded'] }
      }).toArray();
      for (const bill of billRows) {
        for (const item of bill.items || []) {
          const snapshot = item.pricing_snapshot || {};
          const amounts = utilizationAmounts(snapshot, {
            eligibleAmount: item.eligible_amount ?? item.contracted_amount ?? item.amount,
            sponsorLiability: item.sponsor_liability,
            patientLiability: item.patient_liability ?? item.amount
          });
          sourceRows.push({ sourceType: 'BillItem', sourceId: bill._id, sourceLineId: item._id, patientId: bill.patient_id || coverage.patientId, snapshot, amounts });
        }
      }
    }

    for (const row of sourceRows) {
      sponsor += Number(row.amounts.sponsorLiability || 0);
      deductible += Number(row.amounts.deductibleAmount || 0);
      const key = `${row.sourceType}:${row.sourceId}:${row.sourceLineId || 'root'}`;
      utilizationOps.push({
        updateOne: {
          filter: { hospitalId, sourceKey: key },
          update: {
            $set: {
              hospitalId,
              coverageId: coverage._id,
              encounterType: coverage.encounterType,
              admissionId: coverage.admissionId,
              appointmentId: coverage.appointmentId,
              patientId: row.patientId,
              sourceType: row.sourceType,
              sourceId: row.sourceId,
              sourceLineId: row.sourceLineId || undefined,
              sourceKey: key,
              serviceCode: row.snapshot.serviceCode,
              rateCardId: row.snapshot.rateCardId,
              rateCardItemId: row.snapshot.rateCardItemId,
              amounts: row.amounts,
              status: 'active',
              pricingSnapshot: row.snapshot,
              updatedAt: now()
            },
            $setOnInsert: { createdAt: now() }
          },
          upsert: true
        }
      });
      sourceLines += 1;
    }
    coverageOps.push({
      updateOne: {
        filter: { _id: coverage._id, hospitalId },
        update: { $set: {
          'beneficiary.coverageLimitUsed': Number(sponsor.toFixed(2)),
          'beneficiary.deductibleUsed': Number(deductible.toFixed(2)),
          'preAuthorisation.consumedAmount': Number(sponsor.toFixed(2)),
          updatedAt: now()
        } }
      }
    });
  }

  report.coverageUtilization = { activeCoveragesScanned: rows.length, sourceLinesToUpsert: sourceLines, coverageCountersToRebuild: coverageOps.length };
  await bulk(utilization, utilizationOps, apply);
  await bulk(coverages, coverageOps, apply);
  if (apply) {
    await utilization.createIndex({ hospitalId: 1, sourceKey: 1 }, { unique: true, name: 'hospitalId_1_sourceKey_1' });
    await utilization.createIndex({ hospitalId: 1, coverageId: 1, status: 1, createdAt: 1 }, { name: 'hospitalId_1_coverageId_1_status_1_createdAt_1' });
  }
}

async function migratePermissions({ hospitalId, apply, report }) {
  const users = mongoose.connection.collection('users');
  const rows = await users.find({ hospital_id: hospitalId }).toArray();
  const ops = [];
  for (const user of rows) {
    const next = permissionRowsForUser(user);
    if (JSON.stringify(next.map((row) => ({ moduleKey: row.moduleKey, access: row.access, actions: row.actions }))) !== JSON.stringify((user.modulePermissions || []).map((row) => ({ moduleKey: row.moduleKey, access: row.access, actions: row.actions })))) {
      ops.push({ updateOne: { filter: { _id: user._id }, update: { $set: { modulePermissions: next, updatedAt: now() } } } });
    }
  }
  report.permissions = { usersScanned: rows.length, usersToUpdate: ops.length };
  await bulk(users, ops, apply);
}

async function markFeatureFlag({ hospitalId, apply, report }) {
  report.hospital = { ...(report.hospital || {}), sponsorPricingFeatureToEnable: true };
  if (apply) await mongoose.connection.collection('hospitals').updateOne({ _id: hospitalId }, { $set: { 'featureFlags.sponsorPricing': true, updatedAt: now() } });
}

async function writeMigrationAudit({ hospitalId, report, apply }) {
  if (!apply) return;
  await mongoose.connection.collection('systemmigrations').updateOne(
    { migrationId: MIGRATION_ID, hospitalId },
    { $set: { migrationId: MIGRATION_ID, hospitalId, status: 'completed', appliedAt: now(), report, updatedAt: now() }, $setOnInsert: { createdAt: now() } },
    { upsert: true }
  );
}

async function main() {
  const args = parseArgs(process.argv);
  await mongoose.connect(args.mongoUri, { serverSelectionTimeoutMS: 15000 });
  const hospital = await resolveHospital(args.hospitalId);
  const hospitalId = objectId(hospital._id);
  const pageMap = loadPageMap(args.pageMapPath);
  const report = {
    migrationId: MIGRATION_ID,
    mode: args.apply ? 'APPLY' : 'PREVIEW',
    generatedAt: now(),
    hospital: { id: String(hospitalId), name: hospital.hospitalName || hospital.name },
    sourcePageMapEntries: pageMap.size,
    warnings: [
      'hospitalId is retained only as a server-derived technical scope key; it is not a user-facing field or import column.',
      'CGHS source names and source pages are never fabricated. Placeholders/unresolved traceability remain activation-blocking validation errors.',
      'Review all preview counts and database backups before using --apply.'
    ]
  };

  console.log(`\n${args.apply ? 'APPLY' : 'PREVIEW'} ${MIGRATION_ID} for ${report.hospital.name} (${hospitalId})\n`);
  await ensureSelfPayer({ hospitalId, apply: args.apply, report });
  await migrateProcedures({ hospitalId, apply: args.apply, report });
  await migrateLegacyProviders({ hospitalId, apply: args.apply, report });
  await migrateLabAndImaging({ hospitalId, apply: args.apply, report });
  await repairCghs({ hospitalId, apply: args.apply, report, pageMap, sourceVerified: args.sourceVerified });
  await rebuildCoverageUtilization({ hospitalId, apply: args.apply, report });
  await migratePermissions({ hospitalId, apply: args.apply, report });
  await markFeatureFlag({ hospitalId, apply: args.apply, report });
  await writeMigrationAudit({ hospitalId, report, apply: args.apply });

  const output = JSON.stringify(report, null, 2);
  console.log(output);
  if (args.reportPath) fs.writeFileSync(path.resolve(args.reportPath), output);
  if (!args.apply) console.log('\nPreview only. Back up MongoDB, review this report, then rerun with --apply.');
}

if (require.main === module) {
  main()
    .catch((error) => { console.error(error.stack || error); process.exitCode = 1; })
    .finally(async () => { await mongoose.connection.close().catch(() => {}); });
}

module.exports = {
  parseArgs,
  permissionRowsForUser,
  CGHS_CLASSIFICATION_REPAIRS,
  KNOWN_CGHS_BLANK_NAMES
};
