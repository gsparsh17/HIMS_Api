const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { getTemplate } = require('../config/otSurgeryFormTemplates');
const { renderOtFormPdf } = require('../services/otFormPdf.service');

const formIds = [
  'pre_op_safety_checklist',
  'surgical_safety_checklist',
  'checklist_verification_pre_post_op',
  'intra_post_anaesthesia_record',
  'operation_notes',
  'pre_anaesthesia_assessment',
  'post_anaesthesia_recovery_record',
];

function cell(column, index) {
  if (column.type === 'checkbox') return true;
  if (column.type === 'select') return column.options?.[index % Math.max(1, column.options.length)] || 'Yes';
  if (column.type === 'date') return '2026-07-21';
  if (column.type === 'time') return `${String(9 + index).padStart(2, '0')}:00`;
  if (column.type === 'datetime-local') return `2026-07-21T${String(9 + index).padStart(2, '0')}:00`;
  if (column.type === 'number') return index + 1;
  return `${column.label} ${index + 1}`;
}

function formValue(field) {
  if (field.defaultRows) return field.defaultRows.map((row, index) => ({ ...row, ...Object.fromEntries((field.columns || []).map((column) => [column.key, row[column.key] ?? cell(column, index)])) }));
  if (field.type === 'checkbox') return true;
  if (field.type === 'checklist') return [...(field.options || [])];
  if (field.type === 'select') return field.options?.[0] || 'Yes';
  if (field.type === 'date') return '2026-07-21';
  if (field.type === 'time') return '10:30';
  if (field.type === 'datetime-local') return '2026-07-21T10:30';
  if (field.type === 'number') return 10;
  if (field.type === 'textarea') return `${field.label} completed with clinically relevant details.`;
  if (field.type === 'table') return Array.from({ length: Math.min(4, field.defaultRows?.length || 4) }, (_, index) => Object.fromEntries((field.columns || []).map((column) => [column.key, cell(column, index)])));
  return `${field.label} sample`;
}

function sampleData(template) {
  const data = {};
  for (const section of template.sections || []) for (const field of section.fields || []) data[field.key] = formValue(field);
  return data;
}

const otCase = {
  _id: '000000000000000000000001',
  hospitalId: '000000000000000000000002',
  requestNumber: 'OT/TEST/0001',
  procedureName: 'Validation Procedure',
  patientId: { first_name: 'Validation', last_name: 'Patient', uhid: 'UHID-1001', age: 45, gender: 'Female' },
  admissionId: { admissionNumber: 'IPD-1001' },
};
const hospital = { hospitalName: 'Validation Hospital', address: 'Clinical Campus', city: 'Raipur', state: 'Chhattisgarh' };

test('the supplied OT reference forms produce deterministic PDFs with the declared page count', async (t) => {
  for (const id of formIds) {
    await t.test(id, async () => {
      const template = getTemplate(id);
      const buffer = await renderOtFormPdf({ template, record: { formData: sampleData(template), version: 1 }, otCase, hospital, signatures: [] });
      assert.ok(buffer.length > 2500, `${id} PDF is unexpectedly small`);
      assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
      const pdf = await PDFDocument.load(buffer);
      assert.equal(pdf.getPageCount(), template.pageCount, `${id} produced an unexpected overflow page`);
    });
  }
});
