#!/usr/bin/env node
'use strict';

const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const HospitalCharges = require('../models/HospitalCharges');
const { migrationOptions, loadMaster, writeState, connect, close, baseReport } = require('./lib/hmsMigrationUtils');
const { HOSPITAL_BASIC_TARIFF_VERSION } = require('../services/hospitalTariff.service');


const SERVICE_ALIASES = {
  'CBC': ['Complete Blood Count (CBC)', 'CBC'],
  'RFT': ['Renal Function Test (RFT)', 'RFT'],
  'LFT': ['Liver Function Test (LFT)', 'LFT'],
  'HIV': ['HIV 1/2 Antibody test', 'HIV'],
  'HBsAg': ['HBsAg (Hepatitis B surface antigen)', 'HBsAg'],
  'HCV': ['HCV', 'Anti HCV'],
  'Blood Group': ['Blood grouping and Rh typing', 'Blood Group'],
  'Urine Routine Examination': ['Urine complete analysis (Haemoglobin, bile salts, bile pigments, ketone bodies, specific gravity, pH)', 'Urine Routine Examination'],
  'Electrolyte': ['Electrolytes', 'Serum Electrolytes', 'Electrolyte'],
  'Prothrombin Time': ['Prothrombin Time (PT) with INR', 'Prothrombin Time'],
  'ABG': ['Arterial Blood Gas (ABG)', 'ABG'],
  'ECG': ['ECG'],
  'Echo': ['Echo', 'Echocardiography']
};

function exactRegex(value) {
  const escaped = String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}

async function resolveInternalMapping(hospitalId, particular, serviceType) {
  const names = SERVICE_ALIASES[particular] || [particular];
  const Model = serviceType === 'laboratory' ? LabTest : serviceType === 'radiology' ? ImagingTest : serviceType === 'procedure' || serviceType === 'consultation' ? Procedure : null;
  if (!Model) return null;
  for (const name of names) {
    const row = await Model.findOne({ hospitalId, name: exactRegex(name) }).select('_id code name').lean();
    if (row) return { model: Model.modelName, id: row._id, code: row.code, name: row.name, mappingStatus: 'approved', confidence: 1, rationale: 'Exact/approved hospital tariff master alias match', suggestedBy: 'import', suggestedAt: new Date(), reviewedAt: new Date(), approvedAt: new Date() };
  }
  return null;
}

function classify(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('bed')) return { serviceType: 'bed', category: 'Accommodation' };
  if (n.includes('cbc') || n.includes('rft') || n.includes('lft') || n.includes('hiv') || n.includes('hbsag') || n.includes('hcv') || n.includes('blood group') || n.includes('urine') || n.includes('electrolyte') || n.includes('prothrombin') || n.includes('abg')) return { serviceType: 'laboratory', category: 'Laboratory' };
  if (n.includes('x-ray') || n.includes('usg') || n.includes('echo')) return { serviceType: 'radiology', category: 'Diagnostic' };
  if (n.includes('consultation') || n.includes('rmo')) return { serviceType: 'consultation', category: 'Consultation' };
  if (n.includes('o.t.') || n.includes('ot charges')) return { serviceType: 'ot', category: 'OT' };
  return { serviceType: 'procedure', category: 'Hospital Service' };
}

function exactWard(rates) {
  return {
    general: Number(rates.general || 0),
    semiPrivate: Number(rates.private || rates.general || 0),
    private: Number(rates.private || 0),
    deluxe: Number(rates.deluxe || 0),
    icu: Number(rates.icu || 0),
    dayCare: Number(rates.general || 0),
    notApplicable: Number(rates.general || 0)
  };
}

async function run() {
  const opts = migrationOptions();
  const master = loadMaster('data/masters/hospital-basic-tariff-2026-08-15.json');
  const report = baseReport('hospital-basic-tariff-2026-08-15', opts.apply, opts.hospitalId);
  await connect();
  try {
    let payer = await Payer.findOne({ hospitalId: opts.hospitalId, code: 'SELF' });
    if (!payer) {
      report.changes.push({ action: 'insert-payer', code: 'SELF' });
      if (opts.apply) payer = await Payer.create({ hospitalId: opts.hospitalId, code: 'SELF', name: 'Self Pay', type: 'self', empanelment: { status: 'not_required' }, isActive: true, pricingPolicy: { missingItem: 'cash_fallback', balanceBilling: 'patient', requireEligibility: false } });
      else payer = { _id: null };
    }

    let card = payer._id ? await RateCard.findOne({ hospitalId: opts.hospitalId, payerId: payer._id, version: HOSPITAL_BASIC_TARIFF_VERSION }) : null;
    if (!card) {
      report.changes.push({ action: 'insert-rate-card', version: HOSPITAL_BASIC_TARIFF_VERSION });
      if (opts.apply) card = await RateCard.create({
        hospitalId: opts.hospitalId, payerId: payer._id, name: 'Hospital Basic Tariff', version: HOSPITAL_BASIC_TARIFF_VERSION,
        currency: master.currency || 'INR', effectiveFrom: new Date(`${master.effectiveFrom || '2026-08-15'}T00:00:00.000Z`), status: 'active',
        applicability: { cityTiers: ['I'], accreditations: ['nabh_nabl'], wardEntitlements: ['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care', 'not_applicable'] },
        rules: { baseWard: 'general', wardFactors: { general: 1, semi_private: 1, private: 1, deluxe: 1, icu: 1 }, accreditationFactors: { non_nabh_non_nabl: 1, nabh_nabl: 1, super_speciality: 1 }, cityTierFactors: { I: 1, II: 1, III: 1 }, missingItemPolicy: 'cash_fallback', rounding: 'two_decimals' },
        source: { title: master.source.title, filename: master.source.filename, checksum: master.source.sha256, effectiveDate: new Date(`${master.effectiveFrom || '2026-08-15'}T00:00:00.000Z`), uploadedAt: new Date(), verifiedAgainstSource: true },
        activationRequirements: { requireActiveEmpanelment: false, requireAllBillableMappings: false, minimumApprovedMappingPercentage: 0, requireSourceVerification: true }
      });
    }

    if (!opts.apply) {
      report.inserted = master.primaryServices.length + master.otCharges.length;
    } else {
      for (const row of master.primaryServices) {
        const externalCode = `HBT-${String(row.serialNumber).padStart(3, '0')}`;
        const cfg = classify(row.particular);
        const internalService = await resolveInternalMapping(opts.hospitalId, row.particular, cfg.serviceType);
        const existing = await RateCardItem.findOne({ hospitalId: opts.hospitalId, rateCardId: card._id, externalCode });
        const update = {
          hospitalId: opts.hospitalId, payerId: payer._id, rateCardId: card._id, externalCode,
          externalName: row.particular, serviceType: cfg.serviceType, category: cfg.category, specialty: cfg.category,
          pricingMode: 'exact_ward', rates: { exactWard: exactWard(row.rates) }, active: true, wardUniform: false,
          ...(internalService ? { internalService } : {}),
          sourceRow: { serialNumber: row.serialNumber, raw: { source: master.source.filename }, annexure: 'Hospital Basic Tariff' },
          mappingOptions: { requiredForBilling: false, unavailableAtHospital: false, allowMultipleExternalCodes: true },
          patientShare: { mode: 'coverage_default' }
        };
        if (existing) { await RateCardItem.updateOne({ _id: existing._id }, { $set: update }); report.updated += 1; }
        else { await RateCardItem.create(update); report.inserted += 1; }
      }
      let otIndex = 1;
      for (const row of master.otCharges) {
        const code = `HBT-OT-${['GA', 'SA', 'LA'][otIndex - 1] || otIndex}`;
        const existing = await RateCardItem.findOne({ hospitalId: opts.hospitalId, rateCardId: card._id, externalCode: code });
        const slabs = row.hourlyRates.map((amount, index) => ({ sequence: index + 1, fromHour: index, toHour: index + 1, amount: Number(amount), unit: 'hour' }));
        const update = { hospitalId: opts.hospitalId, payerId: payer._id, rateCardId: card._id, externalCode: code, externalName: row.particular, serviceType: 'ot', category: 'OT', specialty: 'OT', pricingMode: 'flat', rates: { flatAmount: Number(row.hourlyRates[0] || 0) }, timeSlabs: slabs, active: true, wardUniform: true, sourceRow: { serialNumber: row.serialNumber, raw: { source: master.source.filename }, annexure: 'O.T. CHARGES' }, mappingOptions: { requiredForBilling: false, unavailableAtHospital: false, allowMultipleExternalCodes: true }, patientShare: { mode: 'coverage_default' } };
        if (existing) { await RateCardItem.updateOne({ _id: existing._id }, { $set: update }); report.updated += 1; }
        else { await RateCardItem.create(update); report.inserted += 1; }
        otIndex += 1;
      }
      const bed = master.primaryServices.find((r) => r.serialNumber === 1)?.rates || {};
      const nursing = master.primaryServices.find((r) => r.serialNumber === 2)?.rates || {};
      const rmo = master.primaryServices.find((r) => r.serialNumber === 3)?.rates || {};
      await HospitalCharges.findOneAndUpdate(
        { hospital: opts.hospitalId },
        { $set: {
          'ipdCharges.roomCharges': [
            { type: 'General', chargePerDay: Number(bed.general || 0) },
            { type: 'Private', chargePerDay: Number(bed.private || 0) },
            { type: 'Deluxe', chargePerDay: Number(bed.deluxe || 0) },
            { type: 'ICU', chargePerDay: Number(bed.icu || 0) }
          ],
          'ipdCharges.nursingCharges': Number(nursing.general || 0),
          'ipdCharges.rmoDutyDoctorCharges': Number(rmo.general || 0),
          effectiveFrom: new Date(`${master.effectiveFrom || '2026-08-15'}T00:00:00.000Z`)
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await RateCard.updateOne({ _id: card._id }, { $set: { itemCount: await RateCardItem.countDocuments({ rateCardId: card._id, active: true }), status: 'active', 'quality.activationReady': true, 'quality.lastValidatedAt': new Date(), 'quality.validationVersion': 'hospital-basic-tariff-v1' } });
    }
  } finally { await close(); }
  const state = writeState(report, opts.statePath);
  console.log(JSON.stringify({ ...report, state }, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
