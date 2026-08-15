#!/usr/bin/env node
'use strict';

const Department = require('../models/Department');
const { migrationOptions, loadMaster, normalize, escapeRegex, writeState, connect, close, baseReport } = require('./lib/hmsMigrationUtils');

const COMPATIBILITY_ALIASES = {
  'orthopedics & joint replacement': ['Orthopedics', 'Orthopaedics'],
  'dentistry': ['Dental'],
  'hospital administration': ['Administration'],
  'human resource': ['HR', 'Human Resources'],
  'inventory / stores': ['Inventory', 'Stores', 'Store Management'],
  'quality / nabh': ['Quality', 'NABH'],
  'pulmonology / chest medicine': ['Pulmonology', 'Chest Medicine'],
  'obstetrics & gynecology': ['Obstetrics and Gynecology', 'OBGYN', 'Gynecology']
};

async function run() {
  const opts = migrationOptions();
  const master = loadMaster('data/masters/department-master-2026-08-15.json');
  const report = baseReport('department-master-2026-08-15', opts.apply, opts.hospitalId);
  await connect();
  try {
    for (const source of master.records) {
      const aliases = [...new Set([...(COMPATIBILITY_ALIASES[normalize(source.name)] || []), source.name])];
      const regexes = aliases.map((name) => new RegExp(`^${escapeRegex(name)}$`, 'i'));
      let existing = await Department.findOne({
        hospitalId: opts.hospitalId,
        $or: [
          { 'masterSource.key': 'department-master-2026-08-15', 'masterSource.serialNumber': source.serialNumber },
          { name: { $in: regexes } },
          { aliases: { $in: regexes } }
        ]
      });

      const patch = {
        departmentType: source.departmentType,
        majorFunction: source.majorFunction,
        clinical: Boolean(source.clinical),
        aliases: [...new Set([...(existing?.aliases || []), ...aliases.filter((name) => normalize(name) !== normalize(existing?.name || source.name))])],
        masterSource: {
          key: 'department-master-2026-08-15',
          version: master.source.importVersion,
          serialNumber: source.serialNumber,
          importedAt: new Date()
        }
      };

      if (!existing) {
        report.inserted += 1;
        report.changes.push({ action: 'insert', serialNumber: source.serialNumber, name: source.name });
        if (opts.apply) await Department.create({ hospitalId: opts.hospitalId, name: source.name, active: true, ...patch });
        continue;
      }

      const changed = normalize(existing.departmentType) !== normalize(patch.departmentType) ||
        normalize(existing.majorFunction) !== normalize(patch.majorFunction) ||
        Boolean(existing.clinical) !== patch.clinical ||
        String(existing.masterSource?.version || '') !== String(master.source.importVersion) ||
        patch.aliases.some((alias) => !(existing.aliases || []).some((current) => normalize(current) === normalize(alias)));
      if (!changed) {
        report.unchanged += 1;
        continue;
      }
      report.updated += 1;
      report.changes.push({ action: 'update', id: existing._id, existingName: existing.name, masterName: source.name });
      if (opts.apply) {
        Object.assign(existing, patch);
        await existing.save();
      }
    }
  } finally {
    await close();
  }
  const state = writeState(report, opts.statePath);
  console.log(JSON.stringify({ ...report, state }, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
