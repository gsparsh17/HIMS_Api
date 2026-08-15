'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function argValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function migrationOptions() {
  const hospitalId = argValue('hospital-id') || process.env.HOSPITAL_ID;
  if (!hospitalId || !mongoose.isValidObjectId(hospitalId)) {
    throw new Error('A valid --hospital-id=<Mongo ObjectId> (or HOSPITAL_ID) is required');
  }
  return {
    hospitalId: new mongoose.Types.ObjectId(hospitalId),
    apply: process.argv.includes('--apply'),
    statePath: argValue('state') ? path.resolve(argValue('state')) : null
  };
}

function loadMaster(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8'));
}

function normalize(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeState(report, explicitPath = null) {
  const target = explicitPath || path.resolve(process.cwd(), 'migration-state', `${report.migration}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2));
  return target;
}

async function connect() {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
}

async function close() {
  await mongoose.disconnect();
}

function baseReport(migration, apply, hospitalId) {
  return {
    migration,
    generatedAt: new Date().toISOString(),
    apply,
    hospitalId: String(hospitalId),
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: [],
    changes: []
  };
}

module.exports = { argValue, migrationOptions, loadMaster, normalize, escapeRegex, writeState, connect, close, baseReport };
