#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../data/referenceDocumentManifest');
const { templates } = require('../data/ipdConsentTemplates');
const requiredOtForms = require('../config/requiredOtReferenceForms');
const surgeryTemplates = require('../config/otSurgeryFormTemplates');

const sources = new Set(manifest.map((item) => item.source));
[
  'Bill Summary.pdf', 'Final Bill.pdf', 'Discharge Summary.pdf',
  'Intra Operative Anaesthesia Notes.pdf', 'Blood Transfusion Flow Sheet.pdf',
  'Checklist Pre and Post OP.pdf', 'Consent Anaesthesia Simple.pdf',
  'Consent Blood Transfusion Simple.pdf', 'Consent High Risk Procedure.pdf',
  'Consent LAMA DOR.pdf', 'Consent Refusal for MLC.pdf', 'Consent Restrain.pdf',
  'Consent Serology HIV.pdf', 'Consent Surgery Simple.pdf', 'OT Notes.pdf',
  'PAC.pdf', 'Post Anaesthesia Notes.pdf', 'Pre OP and Surgical Safety Checklist.pdf'
].forEach((source) => assert.ok(sources.has(source), `${source} is missing from the manifest`));

const consentById = new Map(templates.map((template) => [template.id, template]));
manifest.filter((item) => item.kind === 'consent').forEach((item) => {
  const template = consentById.get(item.id);
  assert.ok(template, `${item.id} consent template missing`);
  assert.equal(template.rendererId, 'native-consent-document');
  assert.equal(template.contentPages.length, item.pages);
  assert.ok(template.contentPages.every((page) => Array.isArray(page.sections) && page.sections.length), `${item.id} has an empty page`);
  assert.ok(!JSON.stringify(template).match(/referenceAssetPages|\.png|\.jpe?g/i), `${item.id} still depends on an image`);
});

const templateText = JSON.stringify(templates);
[
  'WHAT THE TEST MEANS', 'BENEFIT OF BEING TESTED', 'DECLARATION',
  'General Anaesthesia', 'Regional Anaesthesia', 'Sedation / MAC',
  'Possible Risks & Complications', 'Severe Outcomes',
  'Patient\'s Statement of Refusal', 'Declaration of Responsibility',
  'INFORMED CONSENT FORM FOR RESTRICTION OF MEMBERS IN AGITATED PATIENTS',
  'I consent and understand that the health care establishment may at its sole discretion'
].forEach((needle) => assert.ok(templateText.includes(needle), `Missing fixed consent content: ${needle}`));

const otText = JSON.stringify([requiredOtForms, surgeryTemplates]);
assert.ok(!/referenceAssetPages|reference-documents|\.png|\.jpe?g/i.test(otText), 'OT templates still contain sample-image dependencies');
[
  'IMMEDIATE PRE-OPERATIVE RE-EVALUATION', 'Blood Transfusion Monitoring',
  'Post OP Verification', 'Modified Aldrete Score', 'Critical Events'
].forEach((needle) => assert.ok(otText.toLowerCase().includes(needle.toLowerCase()), `Missing OT content: ${needle}`));

const services = [
  path.join(__dirname, '..', 'services', 'consentPdf.service.js'),
  path.join(__dirname, '..', 'services', 'otFormPdf.service.js')
];
services.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(!source.includes('reference-documents'), `${path.basename(file)} still renders sample images`);
});

console.log(`Validated ${manifest.length} reference-document implementations with native text and zero bundled sample-page images.`);
