#!/usr/bin/env node
'use strict';

/**
 * Permanently consolidate the legacy `insuranceproviders` collection into
 * canonical `payers`, rewrite legacy references, verify them, and drop the
 * duplicate collection.
 *
 * Preview is the default. Writes require --apply.
 *
 * Usage:
 *   node scripts/consolidate-payer-masters-2026.js --hospital-id=<ObjectId>
 *   node scripts/consolidate-payer-masters-2026.js --hospital-id=<ObjectId> --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

function parseArgs(argv) {
  const result = {
    apply: false,
    hospitalId: null,
    mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || ''
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') result.apply = true;
    else if (arg.startsWith('--hospital-id=')) result.hospitalId = arg.slice('--hospital-id='.length);
    else if (arg.startsWith('--mongo-uri=')) result.mongoUri = arg.slice('--mongo-uri='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.mongoUri) throw new Error('MONGODB_URI or MONGO_URI is required');
  if (!result.hospitalId || !mongoose.isValidObjectId(result.hospitalId)) {
    throw new Error('--hospital-id=<ObjectId> is required');
  }
  return result;
}

function compact(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function normalize(value) { return compact(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function normalizeCode(value) { return compact(value).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function objectId(value) { return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value)); }

const ALIASES = [
  ['cghs', ['cghs', 'central government health scheme']],
  ['icici lombard', ['icici lombard', 'icici lombard general insurance co ltd']],
  ['niva bupa', ['niva bupa', 'niva bupa health insurance']],
  ['medi assist', ['medi assist', 'medi assist insurance tpa pvt ltd']],
  ['paramount health', ['paramount health', 'paramount health services insurance tpa pvt ltd']],
  ['sbi general', ['sbi general', 'sbi general insurance']],
  ['go digit', ['go digit', 'go digit general insurance ltd']]
];

function identityKeys(row) {
  const values = [row.name, row.code];
  const normalizedName = normalize(row.name);
  for (const [key, aliases] of ALIASES) {
    if (aliases.some((alias) => normalizedName.includes(normalize(alias)))) values.push(key, ...aliases);
  }
  return new Set(values.map(normalize).filter(Boolean));
}

function matchPayer(legacy, payers) {
  const legacyId = String(legacy._id);
  const keys = identityKeys(legacy);
  const candidates = payers.filter((payer) => {
    if (String(payer.empanelment?.contractReference || '') === legacyId) return true;
    const payerKeys = identityKeys(payer);
    return [...keys].some((key) => payerKeys.has(key));
  });
  if (candidates.length === 1) return { payer: candidates[0], reason: 'identity-match' };
  if (candidates.length > 1) {
    return { conflict: candidates.map((item) => ({ id: String(item._id), code: item.code, name: item.name })) };
  }
  return {};
}

function payerType(row) {
  const name = normalize(row.name);
  if (/\btpa\b/.test(name) || normalize(row.type) === 'tpa') return 'tpa';
  if (name === 'cghs' || name.includes('central government health scheme')) return 'cghs';
  if (normalize(row.type) === 'government') return 'government_other';
  return 'private_insurer';
}

function preferredCode(row, usedCodes) {
  const name = normalize(row.name);
  let candidate;
  if (name.includes('central government health scheme') || name === 'cghs') candidate = 'CGHS';
  else if (name.includes('icici lombard')) candidate = 'ICICI-LOMBARD';
  else if (name.includes('niva bupa')) candidate = 'NIVA-BUPA';
  else if (name.includes('medi assist')) candidate = 'MEDI-ASSIST-TPA';
  else if (name.includes('paramount')) candidate = 'PARAMOUNT-TPA';
  else if (name.includes('sbi general')) candidate = 'SBI-GENERAL';
  else if (name.includes('go digit')) candidate = 'GO-DIGIT';
  else candidate = normalizeCode(row.code) || normalizeCode(row.name).slice(0, 40) || `LEGACY-${String(row._id).slice(-8).toUpperCase()}`;

  let finalCode = candidate;
  let suffix = 2;
  while (usedCodes.has(finalCode)) finalCode = `${candidate}-${suffix++}`;
  usedCodes.add(finalCode);
  return finalCode;
}

function buildPayer(legacy, hospitalId, code) {
  return {
    _id: new mongoose.Types.ObjectId(),
    hospitalId,
    code,
    name: compact(legacy.name || legacy.code),
    type: payerType(legacy),
    networkStatus: 'not_applicable',
    demoOnly: false,
    empanelment: {
      status: legacy.is_active !== false && legacy.is_approved !== false
        ? 'active'
        : (legacy.is_active === false ? 'suspended' : 'pending'),
      number: compact(legacy.empanelment_number),
      effectiveFrom: legacy.empanelment_date,
      contractReference: String(legacy._id)
    },
    contacts: (legacy.contact_person || legacy.contact_phone || legacy.contact_email) ? [{
      name: compact(legacy.contact_person),
      phone: compact(legacy.contact_phone),
      email: compact(legacy.contact_email).toLowerCase()
    }] : [],
    settlementTerms: { creditDays: 30, claimSubmissionDays: 7, notes: compact(legacy.notes) },
    pricingPolicy: {
      missingItem: 'cash_fallback',
      balanceBilling: 'patient',
      defaultCoPayPercentage: Math.max(0, 100 - Number(legacy.coverage_percentage ?? 100)),
      defaultDeductibleAmount: 0,
      requireEligibility: true,
      requirePreAuthorisation: false,
      receivableRecognition: 'invoice_issue'
    },
    documentChecklist: [],
    isActive: legacy.is_active !== false,
    createdAt: legacy.createdAt || new Date(),
    updatedAt: new Date()
  };
}

async function collectionExists(db, name) {
  return Boolean(await db.db.listCollections({ name }, { nameOnly: true }).hasNext());
}

async function main() {
  const args = parseArgs(process.argv);
  await mongoose.connect(args.mongoUri);
  const db = mongoose.connection;
  const hospitalId = objectId(args.hospitalId);
  const payerCollection = db.collection('payers');
  const patientCollection = db.collection('patients');

  if (!(await collectionExists(db, 'insuranceproviders'))) {
    console.log(JSON.stringify({
      mode: args.apply ? 'apply' : 'preview',
      hospitalId: String(hospitalId),
      status: 'already-consolidated',
      message: 'insuranceproviders collection does not exist; no action required.'
    }, null, 2));
    await mongoose.disconnect();
    return;
  }

  const legacyCollection = db.collection('insuranceproviders');
  const legacyRows = await legacyCollection.find({}).toArray();
  const payers = await payerCollection.find({ hospitalId }).toArray();
  const usedCodes = new Set(payers.map((row) => normalizeCode(row.code)));

  const report = {
    mode: args.apply ? 'apply' : 'preview',
    hospitalId: String(hospitalId),
    legacyProviders: legacyRows.length,
    existingPayers: payers.length,
    matched: [],
    created: [],
    conflicts: [],
    references: { patients: 0 },
    collectionWillBeDropped: args.apply
  };

  const payerOps = [];
  const patientOps = [];
  const oldIds = [];

  for (const legacy of legacyRows) {
    oldIds.push(legacy._id);
    const result = matchPayer(legacy, payers);
    if (result.conflict) {
      report.conflicts.push({
        legacyId: String(legacy._id),
        code: legacy.code,
        name: legacy.name,
        candidates: result.conflict
      });
      continue;
    }

    let canonical = result.payer;
    if (!canonical) {
      canonical = buildPayer(legacy, hospitalId, preferredCode(legacy, usedCodes));
      payerOps.push({ insertOne: { document: canonical } });
      payers.push(canonical);
      report.created.push({
        legacyId: String(legacy._id), payerId: String(canonical._id), code: canonical.code, name: canonical.name
      });
    } else {
      payerOps.push({
        updateOne: {
          filter: { _id: canonical._id, hospitalId },
          update: {
            $set: {
              'empanelment.contractReference': String(legacy._id),
              updatedAt: new Date()
            }
          }
        }
      });
      report.matched.push({
        legacyId: String(legacy._id), payerId: String(canonical._id), code: canonical.code, name: canonical.name, reason: result.reason
      });
    }

    const count = await patientCollection.countDocuments({ insurance_provider_id: legacy._id });
    report.references.patients += count;
    if (count) {
      patientOps.push({
        updateMany: {
          filter: { insurance_provider_id: legacy._id },
          update: { $set: { insurance_provider_id: canonical._id } }
        }
      });
    }
  }

  if (report.conflicts.length) {
    console.log(JSON.stringify(report, null, 2));
    throw new Error('Conflicting payer matches found. Resolve them before using --apply.');
  }

  if (args.apply) {
    const hello = await db.db.admin().command({ hello: 1 });
    const transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
    report.transactionMode = transactionsSupported ? 'transaction' : 'ordered-bulk-writes';

    if (transactionsSupported) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (payerOps.length) await payerCollection.bulkWrite(payerOps, { ordered: true, session });
          if (patientOps.length) await patientCollection.bulkWrite(patientOps, { ordered: true, session });
        });
      } finally {
        await session.endSession();
      }
    } else {
      // Standalone MongoDB installations do not support multi-document
      // transactions. Ordered writes plus post-write verification are used.
      if (payerOps.length) await payerCollection.bulkWrite(payerOps, { ordered: true });
      if (patientOps.length) await patientCollection.bulkWrite(patientOps, { ordered: true });
    }

    const remainingPatientRefs = await patientCollection.countDocuments({ insurance_provider_id: { $in: oldIds } });
    if (remainingPatientRefs !== 0) {
      throw new Error(`Verification failed: ${remainingPatientRefs} patient references still point to legacy InsuranceProvider ids.`);
    }

    // The duplicate collection is removed only after payer writes and reference
    // rewrites have committed and verification has passed.
    await legacyCollection.drop();
    report.verification = {
      remainingPatientReferences: 0,
      legacyCollectionDropped: true
    };
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exitCode = 1;
});
