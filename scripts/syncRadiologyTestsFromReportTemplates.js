require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const ImagingTest = require('../models/ImagingTest');
const { templates } = require('../data/radiologyReportTemplates');

const apply = process.argv.includes('--apply');
const hospitalId = process.env.RADIOLOGY_SEED_HOSPITAL_ID || undefined;

async function run() {
  await connectDB();
  const summary = { catalog: templates.length, existing: 0, toCreate: 0, created: 0, linked: 0 };
  for (const template of templates) {
    const scope = hospitalId ? { hospitalId } : {};
    const existing = await ImagingTest.findOne({
      ...scope,
      $or: [
        { code: template.code.toUpperCase() },
        { name: { $regex: `^${template.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }
      ]
    });
    if (existing) {
      summary.existing += 1;
      if (apply && (existing.report_template_id !== template.id || existing.report_template_name !== template.name)) {
        existing.report_template_id = template.id;
        existing.report_template_name = template.name;
        await existing.save();
        summary.linked += 1;
      }
      continue;
    }
    summary.toCreate += 1;
    if (!apply) continue;
    await ImagingTest.create({
      hospitalId,
      code: template.code,
      name: template.name,
      category: template.category,
      description: `Structured report template based on reference radiology layout ${template.number}.`,
      turnaround_time_hours: 24,
      base_price: 0,
      insurance_coverage: 'Partial',
      is_active: true,
      report_template_id: template.id,
      report_template_name: template.name
    });
    summary.created += 1;
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'audit', ...summary }, null, 2));
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
