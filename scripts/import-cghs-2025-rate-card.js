#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Hospital = require('../models/Hospital');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const Bed = require('../models/Bed');

function arg(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; }
function required(name) { const value = arg(name); if (!value) throw new Error(`--${name} is required`); return value; }

async function suggestMapping(hospitalId, item) {
  const code = item.externalCode;
  const candidates = [
    ['LabTest', LabTest, { hospitalId, $or: [{ code }, { testCode: code }] }],
    ['ImagingTest', ImagingTest, { hospitalId, $or: [{ code }, { testCode: code }] }],
    ['Procedure', Procedure, { hospitalId, code }],
    ['Bed', Bed, { hospitalId, bedCode: code }]
  ];
  for (const [model, Model, filter] of candidates) {
    const row = await Model.findOne(filter).select('_id code testCode bedCode');
    if (row) return { model, id: row._id, code: row.code || row.testCode || row.bedCode, mappingStatus: 'suggested' };
  }
  return { mappingStatus: 'unmapped' };
}

(async () => {
  try {
    const hospitalRef = required('hospital');
    const payerRef = arg('payer') || 'CGHS';
    const createdBy = arg('created-by');
    const input = path.resolve(arg('file') || path.join(__dirname, '../data/cghs-2025-rate-items.json'));
    const payload = require(input);
    if (payload.itemCount !== 1998 || payload.items.length !== 1998) throw new Error('Official CGHS import must contain exactly 1,998 tariff rows');
    if (new Set(payload.items.map((row) => row.externalCode)).size !== payload.items.length) throw new Error('Duplicate CGHS codes detected');
    await connectDB();
    const hospital = await Hospital.findOne({ $or: [{ _id: mongoose.isValidObjectId(hospitalRef) ? hospitalRef : undefined }, { hospitalID: hospitalRef }, { tenantCode: hospitalRef }] });
    if (!hospital) throw new Error('Hospital not found');
    let payer = await Payer.findOne({ hospitalId: hospital._id, $or: [{ _id: mongoose.isValidObjectId(payerRef) ? payerRef : undefined }, { code: String(payerRef).toUpperCase() }] });
    if (!payer) payer = await Payer.create({ hospitalId: hospital._id, code: 'CGHS', name: 'Central Government Health Scheme', type: 'cghs', empanelment: { status: 'pending' }, createdBy, updatedBy: createdBy });
    const version = 'CGHS-2025-10-13-v1';
    let card = await RateCard.findOne({ hospitalId: hospital._id, payerId: payer._id, version });
    if (card?.status === 'active') throw new Error('The active CGHS version cannot be overwritten. Create a new version.');
    card = await RateCard.findOneAndUpdate(
      { hospitalId: hospital._id, payerId: payer._id, version },
      { $set: { name: 'CGHS Revised Rates 2025', currency: 'INR', effectiveFrom: new Date(payload.source.effectiveFrom), status: 'staging', applicability: { cityTiers: ['I','II','III'], accreditations: ['non_nabh_non_nabl','nabh_nabl','super_speciality'], wardEntitlements: ['general','semi_private','private','icu','day_care','not_applicable'] }, rules: payload.rules, source: { title: payload.source.title, filename: payload.source.filename, checksum: payload.source.sha256, issueDate: new Date(payload.source.issueDate), effectiveDate: new Date(payload.source.effectiveFrom), pageOrAnnexure: payload.source.annexure, uploadedBy: createdBy, uploadedAt: new Date() }, itemCount: payload.itemCount, updatedBy: createdBy }, $setOnInsert: { createdBy } },
      { new: true, upsert: true, runValidators: true }
    );
    const operations=[]; let suggested=0;
    for (const item of payload.items) {
      const internalService = await suggestMapping(hospital._id, item); if (internalService.mappingStatus === 'suggested') suggested += 1;
      operations.push({ updateOne: { filter: { rateCardId: card._id, externalCode: item.externalCode }, update: { $set: { ...item, hospitalId: hospital._id, payerId: payer._id, rateCardId: card._id, internalService } }, upsert: true } });
    }
    const result = await RateCardItem.bulkWrite(operations, { ordered: false });
    const count = await RateCardItem.countDocuments({ rateCardId: card._id });
    if (count !== 1998) throw new Error(`Post-import validation failed: expected 1,998 items, found ${count}`);
    card.itemCount = count; await card.save();
    console.log(JSON.stringify({ success: true, hospitalId: hospital._id, payerId: payer._id, rateCardId: card._id, version, status: card.status, itemCount: count, suggestedMappings: suggested, unmapped: count - suggested, sourceChecksum: payload.source.sha256, bulkResult: { upserted: result.upsertedCount, modified: result.modifiedCount } }, null, 2));
    console.log('The rate card remains in STAGING. Review mappings, then obtain two distinct approvals through POST /api/rate-cards/:id/approve.');
  } catch (error) {
    console.error(error.stack || error.message); process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
})();
