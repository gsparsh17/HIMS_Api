#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const AbdmCareContext = require('../models/AbdmCareContext');
const ShiftHandover = require('../models/ShiftHandover');
const Staff = require('../models/Staff');
const IPDAdmission = require('../models/IPDAdmission');

const APPLY = process.argv.includes('--apply');
const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is required');
const id = (v) => v ? String(v) : null;

async function main() {
  await mongoose.connect(uri);
  const report = { mode: APPLY ? 'APPLY' : 'DRY_RUN', startedAt: new Date().toISOString(), usersBackfilledSecurityVersion: [], shiftHandoversBackfilledHospital: [], abhaStatusCandidates: [], legacyLinkedCareContexts: [], warnings: [] };
  const users = await User.find({ $or: [{ securityVersion: { $exists: false } }, { securityVersion: null }] }).select('_id email role hospital_id').lean();
  report.usersBackfilledSecurityVersion = users.map((u) => ({ _id: id(u._id), hospitalId: id(u.hospital_id), role: u.role, emailHint: u.email ? `${u.email.slice(0,1)}***@${String(u.email).split('@')[1] || ''}` : null }));
  if (APPLY && users.length) await User.updateMany({ _id: { $in: users.map((u) => u._id) } }, { $set: { securityVersion: 1, sessionRevokedAt: new Date() } });

  const legacyHandovers = await ShiftHandover.find({ $or: [{ hospitalId: { $exists: false } }, { hospitalId: null }] }).select('_id outgoingNurse patients.admissionId').lean();
  for (const handover of legacyHandovers) {
    let hospitalId = null;
    if (handover.outgoingNurse) {
      const staff = await Staff.findById(handover.outgoingNurse).select('hospitalId').lean();
      hospitalId = staff?.hospitalId || null;
    }
    if (!hospitalId) {
      const admissionId = handover.patients?.map((row) => row?.admissionId).find(Boolean);
      if (admissionId) {
        const admission = await IPDAdmission.findById(admissionId).select('hospitalId').lean();
        hospitalId = admission?.hospitalId || null;
      }
    }
    report.shiftHandoversBackfilledHospital.push({ handoverId: id(handover._id), hospitalId: id(hospitalId), action: hospitalId ? 'SET_HOSPITAL_ID' : 'MANUAL_REVIEW_REQUIRED' });
    if (APPLY && hospitalId) await ShiftHandover.updateOne({ _id: handover._id }, { $set: { hospitalId } });
    if (!hospitalId) report.warnings.push(`Shift handover ${id(handover._id)} could not be mapped to a hospital automatically`);
  }

  const candidates = await Patient.find({ 'abha.status': { $in: ['UNLINKED', 'NOT_LINKED', 'NOT_ASSOCIATED', null] } }).select('_id hospitalId abha.number abha.address abha.status').lean();
  for (const patient of candidates) {
    const linkedCount = await AbdmCareContext.countDocuments({ patientId: patient._id, linkStatus: 'ABDM_LINKED' });
    const hasIdentity = Boolean(patient.abha?.number || patient.abha?.address);
    const safe = !hasIdentity && linkedCount === 0;
    report.abhaStatusCandidates.push({ patientId: id(patient._id), hospitalId: id(patient.hospitalId), oldStatus: patient.abha?.status || null, linkedCareContexts: linkedCount, hasIdentity, action: safe ? 'SET_NOT_ASSOCIATED' : 'NO_CHANGE' });
    if (APPLY && safe && patient.abha?.status !== 'NOT_ASSOCIATED') await Patient.updateOne({ _id: patient._id }, { $set: { 'abha.status': 'NOT_ASSOCIATED' } });
  }

  const legacy = await AbdmCareContext.find({ linkStatus: 'ABDM_LINKED', 'metadata.linkEvidenceId': { $exists: false } }).select('_id hospitalId patientId').lean();
  report.legacyLinkedCareContexts = legacy.map((c) => ({ careContextId: id(c._id), hospitalId: id(c.hospitalId), patientId: id(c.patientId), action: 'MARK_LEGACY_EVIDENCE_ONLY' }));
  if (APPLY && legacy.length) await AbdmCareContext.updateMany({ _id: { $in: legacy.map((c) => c._id) } }, { $set: { 'metadata.evidenceVersion': 'LEGACY_PRE_SECURITY_HARDENING' } });

  report.completedAt = new Date().toISOString();
  if (APPLY) {
    const out = path.resolve(process.cwd(), `security-hardening-migration-evidence-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`Migration evidence written to ${out}`);
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect().catch(() => {}); });
