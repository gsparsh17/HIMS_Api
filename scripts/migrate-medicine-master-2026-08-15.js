#!/usr/bin/env node
'use strict';

const Medicine = require('../models/Medicine');
const { migrationOptions, loadMaster, normalize, escapeRegex, writeState, connect, close, baseReport } = require('./lib/hmsMigrationUtils');

function baseUnit(form) {
  const value = normalize(form);
  if (value.includes('capsule')) return 'capsule';
  if (value.includes('syrup') || value.includes('solution') || value.includes('suspension') || value.includes('drops')) return 'ml';
  if (value.includes('vial')) return 'vial';
  if (value.includes('ampoule') || value.includes('ampule')) return 'ampoule';
  if (value.includes('bottle')) return 'bottle';
  if (value.includes('tube') || value.includes('cream') || value.includes('ointment') || value.includes('gel')) return 'tube';
  if (value.includes('sachet')) return 'sachet';
  if (value.includes('tablet')) return 'tablet';
  return 'other';
}

async function run() {
  const opts = migrationOptions();
  const master = loadMaster('data/masters/medicine-master-2026-08-15.json');
  const report = baseReport('medicine-master-2026-08-15', opts.apply, opts.hospitalId);
  await connect();
  try {
    for (const source of master.records) {
      const generic = String(source.genericSaltName || '').trim();
      const brand = String(source.brandName || '').trim();
      const dosage = String(source.dosageForm || '').trim();
      const manufacturer = String(source.manufacturerBrandOwner || '').trim();
      if (!generic && !brand) { report.skipped += 1; continue; }

      let existing = await Medicine.findOne({
        hospitalId: opts.hospitalId,
        'masterSource.key': 'medicine-master-2026-08-15',
        'masterSource.serialNumber': source.serialNumber
      });

      const tenantCompatibility = [{ hospitalId: opts.hospitalId }, { hospitalId: { $exists: false } }, { hospitalId: null }];
      const dosageCompatibility = dosage
        ? { $or: [
          { dosage_form: new RegExp(`^${escapeRegex(dosage)}$`, 'i') },
          { category: new RegExp(`^${escapeRegex(dosage)}$`, 'i') }
        ] }
        : {};

      // The supplied master intentionally contains the same brand/generic in
      // multiple dosage forms. Dosage form is therefore part of the natural
      // reconciliation key; otherwise one row would be overwritten repeatedly.
      if (!existing && brand) {
        existing = await Medicine.findOne({
          $and: [
            { $or: tenantCompatibility },
            { brand: new RegExp(`^${escapeRegex(brand)}$`, 'i') },
            { generic_name: new RegExp(`^${escapeRegex(generic)}$`, 'i') },
            dosageCompatibility
          ]
        });
      }
      if (!existing) {
        existing = await Medicine.findOne({
          $and: [
            { $or: tenantCompatibility },
            { name: new RegExp(`^${escapeRegex(brand || generic)}$`, 'i') },
            { generic_name: new RegExp(`^${escapeRegex(generic)}$`, 'i') },
            dosageCompatibility
          ]
        });
      }

      const highRisk = Boolean(source.highRiskHighAlert);
      const patch = {
        hospitalId: opts.hospitalId,
        generic_name: generic,
        composition: generic,
        brand,
        dosage_form: dosage,
        manufacturer,
        manufacturer_brand_owner: manufacturer,
        prescription_required: highRisk || Boolean(existing?.prescription_required),
        is_high_risk: highRisk,
        is_high_alert: highRisk,
        medicationSafety: {
          ...(existing?.medicationSafety?.toObject?.() || existing?.medicationSafety || {}),
          highRisk,
          requiresDoubleCheck: highRisk || Boolean(existing?.medicationSafety?.requiresDoubleCheck)
        },
        masterSource: {
          key: 'medicine-master-2026-08-15', version: master.source.importVersion,
          serialNumber: source.serialNumber, checksum: master.source.sha256, importedAt: new Date()
        }
      };

      if (!existing) {
        report.inserted += 1;
        report.changes.push({ action: 'insert', serialNumber: source.serialNumber, generic, brand });
        if (opts.apply) {
          await Medicine.create({
            hospitalId: opts.hospitalId,
            name: brand || generic,
            category: dosage || 'Medicine',
            dosage_form: dosage,
            base_unit: baseUnit(dosage),
            pack_unit: ['tablet', 'capsule'].includes(baseUnit(dosage)) ? 'strip' : baseUnit(dosage) === 'ml' ? 'bottle' : baseUnit(dosage),
            units_per_pack: 1,
            catalog_source: 'MANUAL',
            is_active: true,
            taxComplianceStatus: 'pending',
            hsn_code: undefined,
            gst_rate: 0,
            ...patch
          });
        }
        continue;
      }

      const changed = normalize(existing.generic_name) !== normalize(generic) || normalize(existing.brand) !== normalize(brand) ||
        normalize(existing.dosage_form) !== normalize(dosage) || normalize(existing.manufacturer_brand_owner || existing.manufacturer) !== normalize(manufacturer) ||
        Boolean(existing.is_high_risk || existing.is_high_alert || existing.medicationSafety?.highRisk) !== highRisk ||
        existing.masterSource?.checksum !== master.source.sha256;
      if (!changed) { report.unchanged += 1; continue; }
      report.updated += 1;
      report.changes.push({ action: 'update', id: existing._id, name: existing.name, generic, brand });
      if (opts.apply) {
        Object.assign(existing, patch);
        await existing.save();
      }
    }
  } finally { await close(); }
  const state = writeState(report, opts.statePath);
  console.log(JSON.stringify({ ...report, state }, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
