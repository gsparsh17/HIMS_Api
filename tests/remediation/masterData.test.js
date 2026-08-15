'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/masters', name), 'utf8'));
}

test('medicine source contains all 500 supplied rows and preserves source classification fields', () => {
  const master = load('medicine-master-2026-08-15.json');
  assert.equal(master.records.length, 500);
  for (const row of master.records) {
    assert.ok(row.genericSaltName);
    assert.ok(row.brandName);
    assert.ok(row.dosageForm);
    assert.equal(typeof row.highRiskHighAlert, 'boolean');
  }
  const warfarin = master.records.find((row) => row.genericSaltName === 'Warfarin');
  assert.ok(warfarin);
  assert.equal(warfarin.highRiskHighAlert, true);
});

test('pathology source contains 632 supplied service rows with amount and department', () => {
  const master = load('pathology-test-master-2026-08-15.json');
  assert.equal(master.records.length, 632);
  assert.ok(master.records.every((row) => row.mainService && row.serviceName && Number.isFinite(Number(row.amount))));
});

test('department source contains 21 clinical and 27 non-medical departments', () => {
  const master = load('department-master-2026-08-15.json');
  assert.equal(master.records.length, 48);
  assert.equal(master.records.filter((row) => row.clinical).length, 21);
  assert.equal(master.records.filter((row) => !row.clinical).length, 27);
  assert.ok(master.records.some((row) => row.name === 'Orthopedics & Joint Replacement'));
  assert.ok(master.records.some((row) => row.name === 'Quality / NABH'));
});

test('hospital tariff source contains the required daily IPD charges and ward-specific rates', () => {
  const master = load('hospital-basic-tariff-2026-08-15.json');
  const byName = Object.fromEntries(master.primaryServices.map((row) => [row.particular, row]));
  assert.deepEqual(byName['Bed Charges / Day'].rates, { general: 1700, private: 3500, deluxe: 4500, icu: 4300 });
  assert.deepEqual(byName['Nursing Charges / Day'].rates, { general: 300, private: 500, deluxe: 600, icu: 600 });
  assert.deepEqual(byName['RMO Charges / Day'].rates, { general: 200, private: 300, deluxe: 300, icu: 500 });
  assert.equal(master.otCharges.length, 3);
});
