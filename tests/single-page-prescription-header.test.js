'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'clinicalPdf.service.js'),
  'utf8'
);

test('one-page blank prescription includes compact patient and encounter header', () => {
  assert.match(source, /function drawSinglePagePrescriptionPatientHeader\(/);
  assert.match(source, /drawSinglePagePrescriptionPatientHeader\(doc, prescription\)/);
  for (const label of [
    'Patient Name',
    'UHID / Patient ID',
    'Age / Gender',
    'Consultant',
    'Department',
    'Mobile No.',
    'OP/IP No.',
    'Visit Date',
    'Patient Type',
    'Address'
  ]) {
    assert.ok(source.includes(`'${label}'`), `missing single-page header label: ${label}`);
  }
});

test('one-page prescription remains based on canonical compact prescription header and medication table', () => {
  const functionStart = source.indexOf('function generateBlankPrescriptionOnePagePdf');
  const functionEnd = source.indexOf('\n\nfunction userDisplayName', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart, 'one-page generator not found');
  const body = source.slice(functionStart, functionEnd);
  assert.match(body, /drawCompactPrescriptionHeader\(doc, prescription, hospital\)/);
  assert.match(body, /drawMedicationTable\(doc, prescription\.items \|\| \[\]\)/);
  assert.match(body, /formatDoctorName\(prescription\.doctor_id\)/);
});
