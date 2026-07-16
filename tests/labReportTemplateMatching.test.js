const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchTemplate,
  matchTemplateDetailed
} = require('../services/labReportTemplate.service');
const { auditTests } = require('../scripts/syncLabTestsFromReportTemplates');

test('common LabTest master names resolve to the intended structured report', () => {
  assert.equal(matchTemplate('Beta-hCG (Quantitative)', 'LT-BIO-089')?.number, 10);
  assert.equal(matchTemplate('Haemoglobin estimation', 'LT-HAEM-001')?.number, 49);
  assert.equal(matchTemplate('Pap smear', 'LT-CLP-039')?.number, 65);
  assert.equal(matchTemplate('Complete Blood Count (CBC)', 'LT-HAEM-009')?.number, 20);
});

test('matcher rejects clinically different tests with overlapping words', () => {
  assert.equal(matchTemplateDetailed('Procalcitonin (PCT)', 'LT-MIC-121'), null);
  assert.equal(matchTemplateDetailed('CK-MB (Creatine Kinase-MB)', 'LT-BIO-085'), null);
  assert.equal(matchTemplateDetailed('HIV Viral Load (Quantitative)', 'LT-ID-142'), null);
  assert.equal(matchTemplateDetailed('Blood Culture & Sensitivity', 'LT-MIC-110'), null);
});

test('audit counts only confirmed canonical or alias matches', () => {
  const audit = auditTests([
    { _id: '1', code: 'LT-HAEM-009', name: 'Complete Blood Count (CBC)', is_active: true },
    { _id: '2', code: 'LT-BIO-085', name: 'CK-MB (Creatine Kinase-MB)', is_active: false },
    { _id: '3', code: 'LT-BIO-089', name: 'Beta-hCG (Quantitative)', is_active: false }
  ]);

  assert.equal(audit.databaseTestCount, 3);
  assert.equal(audit.presentTemplateCount, 2);
  assert.equal(audit.missingTemplateCount, 103);
});
