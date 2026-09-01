'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeFinancialLine } = require('../utils/financialLine');
const {
  formatMedicineName,
  formatMedicationFrequency,
  formatMedication,
  formatMedicationRoute
} = require('../utils/medicationDisplay');
const {
  formatDoctorName,
  COMPUTER_GENERATED_BILL_EN,
  COMPUTER_GENERATED_BILL_HI
} = require('../utils/documentFormatters');

test('financial line ignores legacy schema-default zero when a real amount exists', () => {
  const line = normalizeFinancialLine({
    standard_amount: 0,
    gross_amount: 0,
    unit_price: 0,
    rate: 0,
    net_amount: 0,
    amount: 1200,
    quantity: 1
  });
  assert.equal(line.grossAmount, 1200);
  assert.equal(line.unitRate, 1200);
  assert.equal(line.netAmount, 1200);
});

test('financial line preserves a legitimate fully discounted zero net amount', () => {
  const line = normalizeFinancialLine({
    gross_amount: 500,
    unit_price: 500,
    discount_amount: 500,
    net_amount: 0,
    quantity: 1
  });
  assert.equal(line.grossAmount, 500);
  assert.equal(line.discountAmount, 500);
  assert.equal(line.netAmount, 0);
});

test('medicine standard expands common frequency abbreviations', () => {
  assert.equal(formatMedicationFrequency('OD'), 'One time a day');
  assert.equal(formatMedicationFrequency('BD'), 'Two times a day');
  assert.equal(formatMedicationFrequency('TDS'), 'Three times a day');
  assert.equal(formatMedicationFrequency('QID'), 'Four times a day');
  assert.equal(formatMedicationFrequency('HS'), 'Once at night');
});

test('medicine patient-facing label uses form + uppercase name + strength and normalized route', () => {
  const medication = formatMedication({
    medicine_name: 'Paracetamol',
    dosage_form: 'Tablet',
    strength: '500 mg',
    route_of_administration: 'oral',
    frequency: 'BD'
  });
  assert.equal(medication.label, 'Tab PARACETAMOL 500 mg');
  assert.equal(medication.route, 'P/O');
  assert.equal(medication.frequency, 'Two times a day');
  assert.equal(formatMedicineName('metronidazole'), 'METRONIDAZOLE');
  assert.equal(formatMedicationRoute('IV'), 'IV');
});

test('doctor formatter always produces exactly one Dr. prefix', () => {
  assert.equal(formatDoctorName('Mayank Tripathi'), 'Dr. Mayank Tripathi');
  assert.equal(formatDoctorName('Dr Mayank Tripathi'), 'Dr. Mayank Tripathi');
  assert.equal(formatDoctorName('Dr. Mayank Tripathi'), 'Dr. Mayank Tripathi');
});

test('financial footer contains the approved bilingual statement', () => {
  assert.equal(COMPUTER_GENERATED_BILL_EN, 'This is a computer-generated bill and does not require a signature.');
  assert.equal(COMPUTER_GENERATED_BILL_HI, 'यह एक कंप्यूटर जनित बिल है और इसमें हस्ताक्षर की आवश्यकता नहीं है।');
});
