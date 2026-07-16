const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../data/labReportTemplates.json');
const { listTemplates, getTemplate, matchTemplate } = require('../services/labReportTemplate.service');

test('structured laboratory catalog contains all 105 supplied report templates', () => {
  assert.equal(catalog.templates.length, 105);
  assert.equal(listTemplates({ limit: 105 }).length, 105);
  assert.ok(catalog.templates.every((template) => template.id && template.name));
  assert.ok(catalog.templates.every((template) => Array.isArray(template.observations)));
});

test('template lookup and common test-name matching work', () => {
  const cbc = matchTemplate('Complete Blood Count (CBC)', 'CBC');
  assert.ok(cbc);
  assert.match(cbc.name, /Complete Blood Count/i);
  assert.equal(getTemplate(cbc.id)?.id, cbc.id);
});

test('implementation-only dictionary tables are excluded from clinical output', () => {
  const hiddenTables = catalog.templates.flatMap((template) => (
    (template.additionalTables || []).filter((table) => table.displayInReport === false)
  ));
  assert.ok(hiddenTables.length > 0);
  assert.equal(
    catalog.templates.flatMap((template) => template.additionalTables || [])
      .some((table) => /coverage complete/i.test(table.title || '')),
    false
  );
});
