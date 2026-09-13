'use strict';

const Medicine = require('../models/Medicine');
const NLEMMedicine = require('../models/NLEMMedicine');
const LabTest = require('../models/LabTest');
const Procedure = require('../models/Procedure');
const { requestHospitalId } = require('../utils/hospitalScope');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeLimit(value, fallback = 30) {
  return Math.min(100, Math.max(1, Number(value) || fallback));
}

function dosageFormExpression(raw) {
  const value = String(raw || '').trim();
  if (!value || /^other(s)?$/i.test(value)) return null;

  // The doctor UI intentionally groups uncommon forms under "Other".  For the
  // common forms, tolerate normal catalogue spelling variants instead of relying
  // on one exact string from imported master data.
  const aliases = {
    Tablet: ['tablet', 'tablets', 'tab'],
    Capsule: ['capsule', 'capsules', 'cap'],
    Syrup: ['syrup', 'syrups'],
    Injection: ['injection', 'injectable', 'inj', 'vial', 'ampoule'],
    Drops: ['drop', 'drops']
  };
  const matchedKey = Object.keys(aliases).find((key) => key.toLowerCase() === value.toLowerCase());
  const values = matchedKey ? aliases[matchedKey] : [value];
  return new RegExp(`^(?:${values.map(escapeRegex).join('|')})$`, 'i');
}

function normalizeMedicineRow(row, source) {
  if (source === 'hospital') {
    return {
      _id: row._id,
      medicine_id: row._id,
      medicine_name: row.name,
      generic_name: row.generic_name || row.composition || row.name || '',
      nlem_code: row.nlem_code || '',
      strength: row.strength || '',
      dosage_form: row.dosage_form || row.category || '',
      route_of_administration: '',
      brand: row.brand || '',
      composition: row.composition || '',
      source: 'hospital'
    };
  }

  return {
    _id: row._id,
    medicine_id: null,
    medicine_name: row.medicine_name,
    generic_name: row.generic_name || row.medicine_name || '',
    nlem_code: row.nlem_code || '',
    strength: row.strength || '',
    dosage_form: row.dosage_form || '',
    route_of_administration: row.route_of_administration || '',
    brand: Array.isArray(row.brand_names) ? row.brand_names[0] || '' : '',
    composition: row.generic_name || '',
    source: 'nlem'
  };
}

function medicineDedupeKey(row) {
  return [row.medicine_name, row.strength, row.dosage_form]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('|');
}

exports.searchMedicines = async (req, res) => {
  try {
    const hospitalId = requestHospitalId(req);
    const q = String(req.query.q || req.query.query || '').trim();
    const limit = safeLimit(req.query.limit, 30);
    const dosageForm = dosageFormExpression(req.query.dosage_form || req.query.dosageForm);
    const searchRegex = q ? new RegExp(escapeRegex(q), 'i') : null;

    const hospitalFilter = { hospitalId, is_active: true };
    if (dosageForm) {
      hospitalFilter.$and = [
        {
          $or: [
            { dosage_form: dosageForm },
            { category: dosageForm }
          ]
        }
      ];
    }
    if (searchRegex) {
      hospitalFilter.$and = [
        ...(hospitalFilter.$and || []),
        {
          $or: [
            { name: searchRegex },
            { generic_name: searchRegex },
            { brand: searchRegex },
            { composition: searchRegex },
            { strength: searchRegex },
            { nlem_code: searchRegex }
          ]
        }
      ];
    }

    const nlemFilter = { is_active: true };
    if (dosageForm) nlemFilter.dosage_form = dosageForm;
    if (searchRegex) {
      nlemFilter.$or = [
        { medicine_name: searchRegex },
        { generic_name: searchRegex },
        { brand_names: searchRegex },
        { nlem_code: searchRegex },
        { strength: searchRegex }
      ];
    }

    // Prefer the hospital formulary/master because it carries the inventory mapping,
    // then fill any remaining slots from NLEM. Prescribing remains possible even if
    // the item is not stocked locally.
    const [hospitalRows, nlemRows] = await Promise.all([
      Medicine.find(hospitalFilter)
        .sort({ name: 1 })
        .limit(limit)
        .select('_id name generic_name nlem_code strength dosage_form category brand composition')
        .lean(),
      NLEMMedicine.find(nlemFilter)
        .sort({ medicine_name: 1 })
        .limit(limit)
        .select('_id medicine_name generic_name nlem_code strength dosage_form route_of_administration brand_names')
        .lean()
    ]);

    const merged = [];
    const seen = new Set();
    for (const row of [
      ...hospitalRows.map((value) => normalizeMedicineRow(value, 'hospital')),
      ...nlemRows.map((value) => normalizeMedicineRow(value, 'nlem'))
    ]) {
      const key = medicineDedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length >= limit) break;
    }

    return res.json({ success: true, data: merged, count: merged.length });
  } catch (error) {
    console.error('IPD clinical medicine catalogue search failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to search medicine catalogue', error: error.message });
  }
};

async function searchOrderableMaster(Model, req, searchableFields) {
  const hospitalId = requestHospitalId(req);
  const q = String(req.query.q || req.query.search || '').trim();
  const limit = safeLimit(req.query.limit, 30);
  const filter = { hospitalId, is_active: true, is_billable: true };
  if (q) {
    const expression = new RegExp(escapeRegex(q), 'i');
    filter.$or = searchableFields.map((field) => ({ [field]: expression }));
  }
  return Model.find(filter)
    .sort({ category: 1, name: 1 })
    .limit(limit)
    .lean();
}

exports.searchLabTests = async (req, res) => {
  try {
    const rows = await searchOrderableMaster(
      LabTest,
      req,
      ['code', 'name', 'category', 'subCategory', 'description', 'aliases', 'specimen_detail']
    );
    return res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    console.error('IPD clinical lab catalogue search failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to search lab-test catalogue', error: error.message });
  }
};

exports.searchProcedures = async (req, res) => {
  try {
    const rows = await searchOrderableMaster(
      Procedure,
      req,
      ['code', 'name', 'category', 'subcategory', 'specialty', 'description', 'aliases', 'tags']
    );
    return res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    console.error('IPD clinical procedure catalogue search failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to search procedure catalogue', error: error.message });
  }
};
