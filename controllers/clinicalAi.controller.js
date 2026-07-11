const NLEMMedicine = require('../models/NLEMMedicine');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const geminiClinical = require('../services/geminiClinical.service');
const nurseVitalsDictation = require('../services/nurseVitalsDictation.service');

const ALLOWED_ROLES = new Set([
  'doctor',
  'nurse',
  'staff',
  'admin',
  'mediqliq_super_admin',
]);

const MAX_TEXT_LENGTH = 12000;
const MAX_FIELDS = 60;

function assertClinicalAccess(req) {
  if (!req.user || !ALLOWED_ROLES.has(req.user.role)) {
    const error = new Error('Clinical dictation is available only to authenticated clinical or administrative users.');
    error.statusCode = 403;
    throw error;
  }
}

function cleanText(value, fieldName = 'text') {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${fieldName} is required.`);
    error.statusCode = 400;
    throw error;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    const error = new Error(`${fieldName} cannot exceed ${MAX_TEXT_LENGTH} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function sanitizeContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  const allowed = ['patientAge', 'patientGender', 'department', 'encounterType', 'section'];
  return allowed.reduce((out, key) => {
    const value = context[key];
    if (value !== undefined && value !== null && String(value).length <= 200) out[key] = value;
    return out;
  }, {});
}

function sanitizeFields(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > MAX_FIELDS) {
    const error = new Error(`fields must contain between 1 and ${MAX_FIELDS} allowed form fields.`);
    error.statusCode = 400;
    throw error;
  }

  const seen = new Set();
  return fields.map((field) => {
    const key = String(field?.key || '').trim();
    const label = String(field?.label || key).trim();
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key) || seen.has(key)) {
      const error = new Error(`Invalid or duplicate field key: ${key || '(empty)'}`);
      error.statusCode = 400;
      throw error;
    }
    seen.add(key);
    const type = ['string', 'number', 'boolean'].includes(field?.type) ? field.type : 'string';
    const enumValues = Array.isArray(field?.enum)
      ? field.enum.map((value) => String(value).slice(0, 100)).slice(0, 30)
      : undefined;
    return { key, label: label.slice(0, 120), type, enum: enumValues };
  });
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreCandidate(needle, candidateValues) {
  const query = normalize(needle);
  if (!query) return 0;
  let best = 0;
  candidateValues.filter(Boolean).forEach((value) => {
    const candidate = normalize(value);
    if (!candidate) return;
    if (candidate === query) best = Math.max(best, 100);
    else if (candidate.startsWith(query) || query.startsWith(candidate)) best = Math.max(best, 88);
    else if (candidate.includes(query) || query.includes(candidate)) best = Math.max(best, 76);
    else {
      const queryTokens = new Set(query.split(' '));
      const candidateTokens = new Set(candidate.split(' '));
      const common = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
      const ratio = common / Math.max(queryTokens.size, candidateTokens.size, 1);
      best = Math.max(best, Math.round(ratio * 70));
    }
  });
  return best;
}

function chooseBest(needle, docs, mapper, values) {
  const ranked = docs
    .map((doc) => ({ doc, score: scoreCandidate(needle, values(doc)) }))
    .sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  if (!winner || winner.score < 45) return null;
  return { ...mapper(winner.doc), matchScore: winner.score };
}

async function resolveMedicine(item) {
  const term = String(item.name || item.spoken || '').trim();
  if (!term) return { ...item, match: null };
  const regex = new RegExp(escapeRegex(term), 'i');
  const docs = await NLEMMedicine.find({
    is_active: true,
    $or: [
      { medicine_name: regex },
      { generic_name: regex },
      { brand_names: regex },
      ...(item.strength ? [{ strength: new RegExp(escapeRegex(item.strength), 'i') }] : []),
    ],
  }).limit(12).lean();

  const match = chooseBest(
    term,
    docs,
    (doc) => ({
      id: doc._id,
      type: 'medicine',
      name: doc.medicine_name,
      displayName: `${doc.medicine_name}${doc.strength ? ` ${doc.strength}` : ''}${doc.dosage_form ? ` (${doc.dosage_form})` : ''}`,
      genericName: doc.generic_name || doc.medicine_name,
      code: doc.nlem_code || '',
      strength: doc.strength || '',
      dosageForm: doc.dosage_form || '',
      route: doc.route_of_administration || '',
    }),
    (doc) => [doc.medicine_name, doc.generic_name, ...(doc.brand_names || [])]
  );
  return { ...item, match };
}

function tenantFilter(hospitalId) {
  if (!hospitalId) return {};
  return { $or: [{ hospitalId }, { hospitalId: { $exists: false } }, { hospitalId: null }] };
}

async function resolveMasterItem(item, Model, type, hospitalId) {
  const term = String(item.code || item.name || item.spoken || '').trim();
  if (!term) return { ...item, match: null };
  const regex = new RegExp(escapeRegex(term), 'i');
  const query = {
    is_active: { $ne: false },
    $and: [
      tenantFilter(hospitalId),
      { $or: [{ code: regex }, { name: regex }] },
    ],
  };
  if (Model === Procedure) {
    delete query.$and;
    delete query.is_active;
    query.is_active = { $ne: false };
    query.$or = [{ code: regex }, { name: regex }];
  }

  const docs = await Model.find(query).limit(12).lean();
  const match = chooseBest(
    term,
    docs,
    (doc) => ({
      id: doc._id,
      type,
      code: doc.code || '',
      name: doc.name || '',
      displayName: `${doc.code ? `${doc.code} - ` : ''}${doc.name || ''}`.trim(),
      category: doc.category || '',
      basePrice: doc.base_price || 0,
    }),
    (doc) => [doc.code, doc.name]
  );
  return { ...item, match };
}

async function resolveOrders(parsed, hospitalId) {
  const [medicines, labTests, radiologyTests, procedures] = await Promise.all([
    Promise.all((parsed.medicines || []).map(resolveMedicine)),
    Promise.all((parsed.labTests || []).map((item) => resolveMasterItem(item, LabTest, 'lab', hospitalId))),
    Promise.all((parsed.radiologyTests || []).map((item) => resolveMasterItem(item, ImagingTest, 'radiology', hospitalId))),
    Promise.all((parsed.procedures || []).map((item) => resolveMasterItem(item, Procedure, 'procedure', hospitalId))),
  ]);
  return { medicines, labTests, radiologyTests, procedures };
}

function sendError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error('Clinical AI error:', error);
  return res.status(status).json({ success: false, message: error.message || 'Clinical AI request failed.' });
}

exports.formatField = async (req, res) => {
  try {
    assertClinicalAccess(req);
    const text = cleanText(req.body?.text);
    const fieldType = String(req.body?.fieldType || 'clinical note').trim().slice(0, 120);
    const data = await geminiClinical.formatField({ text, fieldType, context: sanitizeContext(req.body?.context) });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.parseSection = async (req, res) => {
  try {
    assertClinicalAccess(req);
    const transcript = cleanText(req.body?.transcript, 'transcript');
    const fields = sanitizeFields(req.body?.fields);
    const context = sanitizeContext(req.body?.context);

    if (nurseVitalsDictation.isNurseVitalsContext(context)) {
      const deterministic = nurseVitalsDictation.parseDeterministicNurseVitals({
        transcript,
        fields,
      });
      const aiEligibleFields = nurseVitalsDictation.getAiEligibleFields({
        fields,
        transcript,
        deterministicFields: deterministic.fields,
      });

      let aiAccepted = {};
      let rejectedFields = [];
      const warnings = [];

      if (aiEligibleFields.length > 0) {
        try {
          const aiData = await geminiClinical.parseSection({
            transcript,
            fields: aiEligibleFields,
            context,
          });
          const validated = nurseVitalsDictation.validateAiNurseVitalsFields({
            aiFields: aiData.fields,
            fields: aiEligibleFields,
            transcript,
            deterministicFields: deterministic.fields,
          });
          aiAccepted = validated.fields;
          rejectedFields = validated.rejectedFields;
        } catch (aiError) {
          warnings.push(
            'AI fallback was unavailable. Explicitly labelled nurse-vital values were still extracted locally.'
          );
          console.warn('Nurse vitals AI fallback error:', aiError.message);
        }
      }

      const mergedFields = {
        ...aiAccepted,
        ...deterministic.fields,
      };
      const sourceByField = {
        ...Object.fromEntries(Object.keys(aiAccepted).map((key) => [key, 'ai_validated'])),
        ...deterministic.sourceByField,
      };

      return res.json({
        success: true,
        data: {
          fields: mergedFields,
          meta: {
            parser: 'nurse_vitals_hybrid_v1',
            sourceByField,
            rejectedFields,
            warnings,
          },
        },
      });
    }

    const data = await geminiClinical.parseSection({ transcript, fields, context });
    const allowed = new Set(fields.map((field) => field.key));
    const filtered = Object.entries(data.fields || {}).reduce((out, [key, value]) => {
      if (allowed.has(key) && value !== undefined && value !== null && value !== '') out[key] = value;
      return out;
    }, {});
    res.json({ success: true, data: { fields: filtered } });
  } catch (error) {
    sendError(res, error);
  }
};

exports.parseOrders = async (req, res) => {
  try {
    assertClinicalAccess(req);
    const transcript = cleanText(req.body?.transcript, 'transcript');
    const parsed = await geminiClinical.parseOrders({ transcript, context: sanitizeContext(req.body?.context) });
    const hospitalId = req.user?.hospital_id || req.user?.hospitalId || null;
    const data = await resolveOrders(parsed, hospitalId);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
};
