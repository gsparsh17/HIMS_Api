const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../data/referenceDocumentManifest');
const { templates: consentTemplates } = require('../data/ipdConsentTemplates');
const requiredOtForms = require('../config/requiredOtReferenceForms');
const surgeryTemplates = require('../config/otSurgeryFormTemplates');

test('all supplied document types are represented as native text or structured forms', () => {
  const sources = new Set(manifest.map((item) => item.source));
  [
    'Bill Summary.pdf', 'Final Bill.pdf', 'Discharge Summary.pdf',
    'Intra Operative Anaesthesia Notes.pdf', 'Blood Transfusion Flow Sheet.pdf',
    'Checklist Pre and Post OP.pdf', 'Consent Anaesthesia Simple.pdf',
    'Consent Blood Transfusion Simple.pdf', 'Consent High Risk Procedure.pdf',
    'Consent LAMA DOR.pdf', 'Consent Refusal for MLC.pdf', 'Consent Restrain.pdf',
    'Consent Serology HIV.pdf', 'Consent Surgery Simple.pdf', 'OT Notes.pdf',
    'PAC.pdf', 'Post Anaesthesia Notes.pdf', 'Pre OP and Surgical Safety Checklist.pdf'
  ].forEach((source) => assert.ok(sources.has(source), `${source} is missing`));
  manifest.forEach((item) => assert.match(item.implementation, /native-text/));
});

test('consent templates contain complete versioned native-text pages and no sample images', () => {
  const byId = new Map(consentTemplates.map((item) => [item.id, item]));
  for (const document of manifest.filter((item) => item.kind === 'consent')) {
    const template = byId.get(document.id);
    assert.ok(template, `${document.id} template missing`);
    assert.equal(template.version, '4.0');
    assert.equal(template.rendererId, 'native-consent-document');
    assert.equal(template.contentPages.length, document.pages);
    assert.ok(template.contentPages.every((page) => page.sections?.length));
    assert.ok(!/referenceAssetPages|\.png|\.jpe?g/i.test(JSON.stringify(template)));
  }
  assert.notEqual(byId.get('lama-dor-consent'), byId.get('mlc-refusal-consent'));
});

test('HIV consent includes all fixed explanatory and declaration sections', () => {
  const template = consentTemplates.find((item) => item.id === 'infectious-disease-screening-consent');
  const text = JSON.stringify(template);
  [
    'INTRODUCTION', 'WHAT THE TEST MEANS', '8-12 weeks', 'False results are rare',
    'BENEFIT OF BEING TESTED', 'DECLARATION', 'Patient / Authorized Representative',
    'A witness must be at least eighteen years old'
  ].forEach((needle) => assert.ok(text.includes(needle), `${needle} missing`));
});

test('all consent samples retain their fixed clauses', () => {
  const text = JSON.stringify(consentTemplates);
  [
    'Rare awareness during surgery', 'Spinal headache',
    'Acute hemolysis', 'I hereby give my consent to blood transfusion',
    'outcome cannot be guaranteed', 'discharged against medical advice',
    'legal implications of registering or refusing MLC',
    'continuous monitoring', 'photograph or video tape the operation/procedure',
    'usage and disposal of any tissue or body parts'
  ].forEach((needle) => assert.ok(text.includes(needle), `${needle} missing`));
});

test('OT templates and PDF service have no sample-page image dependency', () => {
  const templateText = JSON.stringify([requiredOtForms, surgeryTemplates]);
  assert.ok(!/referenceAssetPages|reference-documents|\.png|\.jpe?g/i.test(templateText));
  const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'otFormPdf.service.js'), 'utf8');
  assert.ok(!service.includes('referenceOtPdf.service'));
  assert.ok(!service.includes('reference-documents'));
});

test('billing issuance and settlement preserve discount and tax instead of flattening them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'ipdFinancial.service.js'), 'utf8');
  [
    'line_discount_total: lineDiscountTotal', 'bill_discount_total: billDiscountTotal',
    'taxable_amount: taxableAmount', 'tax: taxTotal', 'settlementDiscountAmount',
    'taxAdjustmentAmount', "receiptType: 'Final Settlement'"
  ].forEach((needle) => assert.ok(source.includes(needle), `${needle} missing from IPD financial flow`));
  assert.ok(!/issueIPDInvoice[\s\S]{0,9000}tax_amount:\s*0[\s\S]{0,200}discount:\s*0/.test(source));
});

test('discharge summary stores the structured medicine schedule and print fields', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'models', 'DischargeSummary.js'), 'utf8');
  [
    'operativeNotes', 'conditionAtDischargeText', 'followUpAfterDays', 'followUpDate',
    'followUpDetails', 'adviceAtDischarge', 'emergencyContactNumber', 'patientAcknowledgement',
    'saltName', 'days', 'type', 'meal', 'morning', 'noon', 'evening', 'extra', 'unit'
  ].forEach((field) => assert.ok(source.includes(field), `${field} missing`));
});
