const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSpecimen,
  normalizeCategory,
  serviceSignature,
  imagingCategory,
  placeholderName,
  parsePageMap
} = require('../utils/insuranceTariffMigration');

test('detailed specimen values are preserved while mapped to a broad specimen class', () => {
  assert.deepEqual(normalizeSpecimen('EDTA whole blood and serum'), {
    specimen_type: 'Blood',
    specimen_detail: 'EDTA whole blood and serum'
  });
  assert.deepEqual(normalizeSpecimen('Pleural fluid'), {
    specimen_type: 'Body Fluid',
    specimen_detail: 'Pleural fluid'
  });
});

test('tariff category capitalization is deterministic and preserves clinical acronyms', () => {
  assert.equal(normalizeCategory('ENT investigation'), 'ENT Investigation');
  assert.equal(normalizeCategory('behavioural therapy'), 'Behavioural Therapy');
  assert.equal(normalizeCategory('CT scan of the head'), 'CT Scan of the Head');
});

test('canonical signatures normalize common imaging synonyms', () => {
  assert.equal(serviceSignature('Computed Tomography Brain Scan'), serviceSignature('CT Brain'));
  assert.equal(serviceSignature('USG Whole Abdomen'), serviceSignature('Ultrasound Abdomen'));
});

test('imaging category inference handles migrated radiology and cardiology services', () => {
  assert.equal(imagingCategory('C-Arm Fluoroscopy'), 'Fluoroscopy');
  assert.equal(imagingCategory('Electrocardiogram ECG'), 'ECG');
  assert.equal(imagingCategory('Mammography'), 'Mammography');
});

test('missing source names receive explicit blocking placeholders', () => {
  assert.equal(
    placeholderName({ externalCode: 'DP060', category: 'Dental Procedure' }),
    '[SOURCE NAME MISSING] Dental Procedure (DP060)'
  );
});

test('source page maps reject non-positive or non-integer pages', () => {
  assert.equal(parsePageMap({ LB001: 8, OP101: { page: 42 } }).get('OP101'), 42);
  assert.throws(() => parsePageMap({ LB001: 0 }), /Invalid page/);
  assert.throws(() => parsePageMap([]), /JSON object/);
});
