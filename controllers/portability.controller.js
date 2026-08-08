'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { hospitalId, sendError } = require('../utils/functionalDomain');

const SCHEMA_VERSION = 'hims-portability-2';

function checksum(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function loadAllModels() {
  const modelDir = path.join(__dirname, '..', 'models');
  const skipped = [];
  for (const filename of fs.readdirSync(modelDir).filter((name) => name.endsWith('.js') && name !== 'index.js')) {
    try {
      require(path.join(modelDir, filename));
    } catch (error) {
      // A migration export should remain usable even if an optional/legacy model
      // cannot be loaded. The skipped list is returned as migration metadata.
      skipped.push({ file: filename, reason: error.message });
    }
  }
  return skipped;
}

function directHospitalFilter(Model, hid) {
  if (Model.modelName === 'Hospital') return { _id: hid };
  if (Model.schema.path('hospitalId')) return { hospitalId: hid };
  if (Model.schema.path('hospital_id')) return { hospital_id: hid };
  return null;
}

function refPaths(Model, exportedIds) {
  const conditions = [];
  Model.schema.eachPath((schemaPath, schemaType) => {
    const ref = schemaType?.options?.ref || schemaType?.caster?.options?.ref;
    if (!ref || !exportedIds.has(ref) || !exportedIds.get(ref).length) return;
    conditions.push({ [schemaPath]: { $in: exportedIds.get(ref) } });
  });
  return conditions;
}

async function buildExport(hid) {
  const skippedModelFiles = loadAllModels();
  const data = {};
  const exportedIds = new Map();
  const exportedModels = new Set();

  // First pass: every model that is explicitly tenant scoped.
  for (const name of mongoose.modelNames().sort()) {
    const Model = mongoose.model(name);
    const filter = directHospitalFilter(Model, hid);
    if (!filter) continue;
    const rows = await Model.find(filter).lean();
    data[name] = rows;
    exportedModels.add(name);
    exportedIds.set(name, rows.map((row) => row?._id).filter(Boolean));
  }

  // Additional passes: legacy records that do not carry hospitalId directly but
  // reference an already-exported tenant entity (patient/admission/etc.).
  for (let pass = 0; pass < 3; pass += 1) {
    let added = 0;
    for (const name of mongoose.modelNames().sort()) {
      if (exportedModels.has(name)) continue;
      const Model = mongoose.model(name);
      const conditions = refPaths(Model, exportedIds);
      if (!conditions.length) continue;
      const rows = await Model.find({ $or: conditions }).lean();
      data[name] = rows;
      exportedModels.add(name);
      exportedIds.set(name, rows.map((row) => row?._id).filter(Boolean));
      added += 1;
    }
    if (!added) break;
  }

  const notTenantScoped = mongoose.modelNames().sort().filter((name) => !exportedModels.has(name));
  const counts = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));

  return {
    schemaVersion: SCHEMA_VERSION,
    hospitalId: String(hid),
    exportedAt: new Date().toISOString(),
    metadata: {
      modelCount: Object.keys(data).length,
      recordCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
      skippedModelFiles,
      excludedUnscopedModels: notTenantScoped
    },
    data
  };
}

function validatePayload(payload, expectedHospitalId) {
  const errors = [];
  if (!payload || payload.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!payload?.hospitalId) errors.push('hospitalId is required');
  if (expectedHospitalId && String(payload?.hospitalId) !== String(expectedHospitalId)) errors.push('payload hospitalId does not match current hospital');
  if (!payload?.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) errors.push('data object is required');
  if (payload?.data) {
    for (const [name, rows] of Object.entries(payload.data)) {
      if (!Array.isArray(rows)) errors.push(`${name} must be an array`);
    }
  }
  return errors;
}

exports.exportCore = async (req, res) => {
  try {
    const payload = await buildExport(hospitalId(req));
    const digest = checksum(payload);
    if (String(req.query.summary || 'false').toLowerCase() === 'true') {
      return res.json({ success: true, checksum: digest, payload: { schemaVersion: payload.schemaVersion, hospitalId: payload.hospitalId, exportedAt: payload.exportedAt, metadata: payload.metadata } });
    }
    return res.json({ success: true, checksum: digest, payload });
  } catch (error) {
    return sendError(res, error, 500);
  }
};

exports.validateImport = async (req, res) => {
  try {
    const payload = req.body?.payload;
    const errors = validatePayload(payload, hospitalId(req));
    if (errors.length) return res.status(422).json({ success: false, errors });
    const actual = checksum(payload);
    if (req.body?.checksum && req.body.checksum !== actual) {
      return res.status(409).json({ success: false, error: 'Migration checksum mismatch', actual });
    }
    const counts = Object.fromEntries(Object.entries(payload.data).map(([name, rows]) => [name, rows.length]));
    return res.json({ success: true, valid: true, checksum: actual, counts, modelCount: Object.keys(counts).length });
  } catch (error) {
    return sendError(res, error);
  }
};


exports.validateCurrent = async (req, res) => {
  try {
    const payload = await buildExport(hospitalId(req));
    const errors = validatePayload(payload, hospitalId(req));
    if (errors.length) return res.status(422).json({ success: false, valid: false, errors });
    const actual = checksum(payload);
    return res.json({
      success: true,
      valid: true,
      schemaVersion: payload.schemaVersion,
      checksum: actual,
      modelCount: payload.metadata.modelCount,
      recordCount: payload.metadata.recordCount,
      counts: payload.metadata.counts
    });
  } catch (error) {
    return sendError(res, error, 500);
  }
};

exports.importData = async (req, res) => {
  try {
    if (String(process.env.ALLOW_PORTABILITY_IMPORT || 'false').toLowerCase() !== 'true') {
      return res.status(403).json({ error: 'Portability import is disabled. Set ALLOW_PORTABILITY_IMPORT=true only in a controlled migration window.' });
    }
    const payload = req.body?.payload;
    const errors = validatePayload(payload, hospitalId(req));
    if (errors.length) return res.status(422).json({ success: false, errors });
    const actual = checksum(payload);
    if (req.body?.checksum && req.body.checksum !== actual) return res.status(409).json({ error: 'Migration checksum mismatch', actual });
    if (req.body?.confirm !== `IMPORT:${actual}`) return res.status(400).json({ error: `Confirmation must equal IMPORT:${actual}` });

    loadAllModels();
    const result = {};
    for (const [name, rows] of Object.entries(payload.data)) {
      if (!mongoose.modelNames().includes(name)) {
        result[name] = { skipped: rows.length, reason: 'Model is not registered in target version' };
        continue;
      }
      const Model = mongoose.model(name);
      if (!rows.length) {
        result[name] = { upserted: 0 };
        continue;
      }
      const operations = rows.filter((row) => row?._id).map((row) => ({
        replaceOne: { filter: { _id: row._id }, replacement: row, upsert: true }
      }));
      if (!operations.length) {
        result[name] = { skipped: rows.length, reason: 'Rows have no _id' };
        continue;
      }
      const write = await Model.bulkWrite(operations, { ordered: false });
      result[name] = { matched: write.matchedCount, modified: write.modifiedCount, upserted: write.upsertedCount };
    }
    return res.json({ success: true, checksum: actual, result });
  } catch (error) {
    return sendError(res, error, 500);
  }
};
