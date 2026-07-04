/*
 * Usage: node scripts/migrations/migrate-clinical-documents-v2.js --apply
 * Backward-compatible clinical migration. Existing IPDInitialAssessment records
 * remain doctor/legacy records; nursing data is never guessed or manufactured.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const IPDInitialAssessment = require('../../models/IPDInitialAssessment');
const IPDVitals = require('../../models/IPDVitals');
const IPDAdmission = require('../../models/IPDAdmission');
const { clinicalContext } = require('../../utils/clinicalDate');
const { DEFAULT_TIMEZONE } = require('../../config/clinicalScoring');
const apply = process.argv.includes('--apply');

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  let assessmentCount = 0; let vitalsCount = 0;
  for await (const assessment of IPDInitialAssessment.find({}).cursor()) {
    if (!assessment.hospitalId) {
      const admission = await IPDAdmission.findById(assessment.admissionId).select('hospitalId hospital_id patientId');
      const patch = { hospitalId: admission?.hospitalId || admission?.hospital_id || undefined, patientId: assessment.patientId || admission?.patientId, encounterContext: assessment.encounterContext || 'IPD', formStatus: assessment.formStatus || 'Completed' };
      console.log(`${apply ? 'APPLY' : 'DRY-RUN'} assessment ${assessment._id}: doctor/legacy classification only`);
      if (apply) { assessment.set(patch); await assessment.save(); assessmentCount += 1; }
    }
  }
  for await (const vital of IPDVitals.find({}).cursor()) {
    const context = clinicalContext(vital.recordedAt || vital.createdAt || new Date(), vital.recordedTimezone || DEFAULT_TIMEZONE);
    const patch = { chartDate: vital.chartDate || context.chartDate, clinicalShift: vital.clinicalShift || context.clinicalShift, recordedTimezone: vital.recordedTimezone || DEFAULT_TIMEZONE };
    if (!vital.hospitalId) { const admission = await IPDAdmission.findById(vital.admissionId).select('hospitalId hospital_id'); patch.hospitalId = admission?.hospitalId || admission?.hospital_id; }
    const legacyIntake = Number(vital.intakeOutput?.intake || 0); const legacyOutput = Number(vital.intakeOutput?.output || 0);
    if (!vital.ivFluidsMl && !vital.oralRtMl) patch.ivFluidsMl = legacyIntake;
    if (!vital.urineMl && !vital.rtOutputMl && !vital.vomitMl) patch.urineMl = legacyOutput;
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'} vital ${vital._id}: chart ${patch.chartDate}`);
    if (apply) { vital.set(patch); await vital.save(); vitalsCount += 1; }
  }
  console.log(`Assessments ${assessmentCount}; vitals ${vitalsCount}. No nursing assessment was inferred.`);
  await mongoose.disconnect();
}
run().catch(async (error) => { console.error(error); await mongoose.disconnect().catch(() => {}); process.exit(1); });
