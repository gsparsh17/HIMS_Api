const NURSE_VITALS_ENCOUNTER = 'ipd nursing vital observation';
const NURSE_VITALS_SECTION = 'nurse vitals and clinical observations';

const FIELD_EVIDENCE = {
  temperature: [/\btemp(?:erature)?\b/i],
  pulse: [/\bpulse\b/i, /\bheart\s*rate\b/i, /\bhr\b/i],
  respiratoryRate: [/\brespiratory\s*rate\b/i, /\brespiration(?:s)?\b/i, /\brr\b/i],
  spo2: [/\bspo\s*2\b/i, /\boxygen\s*saturation\b/i, /\bsaturation\b/i],
  'bloodPressure.systolic': [/\bblood\s*pressure\b/i, /\bbp\b/i, /\bsystolic\b/i],
  'bloodPressure.diastolic': [/\bblood\s*pressure\b/i, /\bbp\b/i, /\bdiastolic\b/i],
  bloodSugar: [/\bblood\s*(?:sugar|glucose)\b/i, /\bglucose\b/i, /\brbs\b/i, /\bfbs\b/i],
  painScore: [/\bpain\s*(?:score|level)?\b/i],
  weight: [/\bweight\b/i, /\bbody\s*weight\b/i, /\bkilograms?\b/i, /\bkgs?\b/i],
  height: [/\bheight\b/i, /\bcentimet(?:er|re)s?\b/i, /\bcms?\b/i],
  consciousnessResponse: [
    /\bconscious(?:ness)?\b/i,
    /\bpatient\s+(?:is\s+)?(?:alert|unresponsive|confused)\b/i,
    /\bresponds?\s+to\s+(?:voice|pain)\b/i,
  ],
  onOxygen: [/\bon\s+oxygen\b/i, /\boxygen\s+(?:support|therapy)\b/i, /\broom\s+air\b/i],
  oxygenDevice: [/\boxygen\s*device\b/i, /\bnasal\s*cannula\b/i, /\boxygen\s*mask\b/i, /\bface\s*mask\b/i],
  oxygenFlowLpm: [/\boxygen\s*flow\b/i, /\bo2\s*flow\b/i, /\blit(?:er|re)s?\s*(?:per\s*minute|\/\s*min)\b/i],
  ivFluidsMl: [/\biv\s*fluids?\b/i, /\bintravenous\s*fluids?\b/i],
  oralRtMl: [/\boral\s*(?:\/|and)?\s*rt\s*intake\b/i, /\boral\s*intake\b/i, /\brt\s*intake\b/i],
  urineMl: [/\burine\s*(?:output)?\b/i],
  rtOutputMl: [/\brt\s*output\b/i],
  vomitMl: [/\bvomit(?:ing)?\s*(?:output)?\b/i],
  bowelMovement: [/\bbowel\s*movement\b/i, /\bpassed\s*stool\b/i],
  noUrineOverSixHours: [/\bno\s+urine\b/i, /\bno\s+urine\s+for\s+(?:more\s+than\s+)?6\s*hours?\b/i],
  outputNotes: [/\boutput\s*notes?\b/i],
  remarks: [/\bclinical\s*remarks?\b/i, /\bremarks?\b/i],
};

const NUMBER_PATTERN = '(-?\\d+(?:\\.\\d+)?)(?:\\s*(?:point|dot)\\s*(\\d+))?';

function normalizeContextValue(value) {
  return String(value || '').trim().toLowerCase();
}

function isNurseVitalsContext(context = {}) {
  return (
    normalizeContextValue(context.encounterType) === NURSE_VITALS_ENCOUNTER &&
    normalizeContextValue(context.section) === NURSE_VITALS_SECTION
  );
}

function toNumber(integerPart, decimalPart) {
  if (integerPart === undefined || integerPart === null || integerPart === '') return undefined;
  const text = decimalPart ? `${integerPart}.${decimalPart}` : String(integerPart);
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function extractNumberAfter(transcript, aliases) {
  for (const alias of aliases) {
    const regex = new RegExp(`${alias}\\s*(?:(?:level|value|reading)\\s*)?(?:is|was|of|at|=|:)?\\s*${NUMBER_PATTERN}`, 'i');
    const match = transcript.match(regex);
    if (match) return toNumber(match[1], match[2]);
  }
  return undefined;
}

function extractFirstNumber(transcript) {
  const match = String(transcript || '').match(new RegExp(NUMBER_PATTERN, 'i'));
  return match ? toNumber(match[1], match[2]) : undefined;
}

function cleanCapturedText(value) {
  return String(value || '')
    .replace(/^[\s:=-]+/, '')
    .replace(/[\s,;:.]+$/, '')
    .trim();
}

function extractTextAfter(transcript, aliases) {
  for (const alias of aliases) {
    const regex = new RegExp(`${alias}\\s*(?:is|are|was|were|=|:)?\\s*([^.!?;]+)`, 'i');
    const match = transcript.match(regex);
    const value = cleanCapturedText(match?.[1]);
    if (value) return value;
  }
  return undefined;
}

function extractBloodPressure(transcript) {
  const pair = transcript.match(/(?:\bblood\s*pressure\b|\bbp\b)\s*(?:is|was|of|at|=|:)?\s*(\d{2,3})\s*(?:\/|over|by|slash)\s*(\d{2,3})/i);
  if (pair) {
    return {
      systolic: Number(pair[1]),
      diastolic: Number(pair[2]),
    };
  }

  return {
    systolic: extractNumberAfter(transcript, ['\\bsystolic(?:\\s+blood\\s*pressure)?\\b']),
    diastolic: extractNumberAfter(transcript, ['\\bdiastolic(?:\\s+blood\\s*pressure)?\\b']),
  };
}

function extractConsciousness(transcript, targetLocked = false) {
  const text = String(transcript || '').toLowerCase();
  if (/\b(?:patient\s+(?:is\s+)?)?alert\b/.test(text)) return 'Alert';
  if (/\b(?:responds?|responsive)\s+to\s+voice\b|\bconsciousness\s+(?:is\s+)?voice\b/.test(text)) return 'Voice';
  if (/\b(?:responds?|responsive)\s+to\s+pain\b|\bconsciousness\s+(?:is\s+)?pain\b/.test(text)) return 'Pain';
  if (/\b(?:patient\s+(?:is\s+)?)?unresponsive\b/.test(text)) return 'Unresponsive';
  if (/\b(?:patient\s+(?:is\s+)?)?confus(?:ed|ion)\b/.test(text)) return 'Confusion';
  if (targetLocked) {
    if (/^\s*voice\s*$/i.test(text)) return 'Voice';
    if (/^\s*pain\s*$/i.test(text)) return 'Pain';
  }
  return undefined;
}

function extractOnOxygen(transcript, targetLocked = false) {
  const text = String(transcript || '').toLowerCase();
  if (/\broom\s+air\b|\bnot\s+on\s+oxygen\b|\bwithout\s+oxygen\b/.test(text)) return false;
  if (/\bon\s+oxygen\b|\breceiving\s+oxygen\b|\boxygen\s+(?:support|therapy)\b/.test(text)) return true;
  if (targetLocked) {
    if (/^\s*(?:yes|true|on)\s*$/i.test(text)) return true;
    if (/^\s*(?:no|false|off)\s*$/i.test(text)) return false;
  }
  return undefined;
}

function extractYesNo(transcript, positivePatterns, negativePatterns, targetLocked = false) {
  const text = String(transcript || '');
  if (positivePatterns.some((pattern) => pattern.test(text))) return true;
  if (negativePatterns.some((pattern) => pattern.test(text))) return false;
  if (targetLocked) {
    if (/^\s*(?:yes|true)\s*$/i.test(text)) return true;
    if (/^\s*(?:no|false)\s*$/i.test(text)) return false;
  }
  return undefined;
}

function getFieldByKey(fields, key) {
  return (fields || []).find((field) => field.key === key);
}

function fieldAllowed(fields, key) {
  return Boolean(getFieldByKey(fields, key));
}

function setIfAllowed(out, fields, key, value, sourceByField, source = 'deterministic') {
  if (!fieldAllowed(fields, key)) return;
  if (value === undefined || value === null || value === '') return;
  out[key] = value;
  sourceByField[key] = source;
}

function parseTargetLockedField(transcript, field) {
  if (!field) return undefined;
  const key = field.key;

  if (field.type === 'number') return extractFirstNumber(transcript);
  if (key === 'consciousnessResponse') return extractConsciousness(transcript, true);
  if (key === 'onOxygen') return extractOnOxygen(transcript, true);
  if (key === 'noUrineOverSixHours') {
    return extractYesNo(
      transcript,
      [/\bno\s+urine\b/i, /^\s*(?:yes|true)\s*$/i],
      [/\burine\s+(?:present|passed|normal)\b/i, /^\s*(?:no|false)\s*$/i],
      true
    );
  }
  if (key === 'bowelMovement') {
    if (/\b(?:yes|passed\s*stool|bowel\s*movement\s+(?:yes|present))\b/i.test(transcript)) return 'Yes';
    if (/\b(?:no|no\s+bowel\s*movement|not\s+passed\s*stool)\b/i.test(transcript)) return 'No';
  }

  const text = cleanCapturedText(transcript);
  return text || undefined;
}

function parseDeterministicNurseVitals({ transcript, fields }) {
  const text = String(transcript || '');
  const out = {};
  const sourceByField = {};

  if ((fields || []).length === 1) {
    const field = fields[0];
    const lockedValue = parseTargetLockedField(text, field);
    setIfAllowed(out, fields, field.key, lockedValue, sourceByField, 'target_locked');
    if (Object.keys(out).length) return { fields: out, sourceByField };
  }

  setIfAllowed(out, fields, 'temperature', extractNumberAfter(text, ['\\btemp(?:erature)?\\b']), sourceByField);
  setIfAllowed(out, fields, 'pulse', extractNumberAfter(text, ['\\bpulse\\b', '\\bheart\\s*rate\\b', '\\bhr\\b']), sourceByField);
  setIfAllowed(out, fields, 'respiratoryRate', extractNumberAfter(text, ['\\brespiratory\\s*rate\\b', '\\brespiration(?:s)?\\b', '\\brr\\b']), sourceByField);
  setIfAllowed(out, fields, 'spo2', extractNumberAfter(text, ['\\bspo\\s*2(?:\\s*level)?\\b', '\\boxygen\\s*saturation\\b', '\\bsaturation\\b']), sourceByField);

  const bp = extractBloodPressure(text);
  setIfAllowed(out, fields, 'bloodPressure.systolic', bp.systolic, sourceByField);
  setIfAllowed(out, fields, 'bloodPressure.diastolic', bp.diastolic, sourceByField);

  setIfAllowed(out, fields, 'bloodSugar', extractNumberAfter(text, ['\\bblood\\s*(?:sugar|glucose)\\b', '\\bglucose\\b', '\\brbs\\b', '\\bfbs\\b']), sourceByField);
  setIfAllowed(out, fields, 'painScore', extractNumberAfter(text, ['\\bpain\\s*(?:score|level)\\b']), sourceByField);
  setIfAllowed(out, fields, 'weight', extractNumberAfter(text, ['\\b(?:body\\s*)?weight\\b']), sourceByField);
  setIfAllowed(out, fields, 'height', extractNumberAfter(text, ['\\bheight\\b']), sourceByField);
  setIfAllowed(out, fields, 'consciousnessResponse', extractConsciousness(text), sourceByField);
  setIfAllowed(out, fields, 'onOxygen', extractOnOxygen(text), sourceByField);
  setIfAllowed(out, fields, 'oxygenFlowLpm', extractNumberAfter(text, ['\\boxygen\\s*flow\\b', '\\bo2\\s*flow\\b']), sourceByField);
  setIfAllowed(out, fields, 'ivFluidsMl', extractNumberAfter(text, ['\\biv\\s*fluids?\\b', '\\bintravenous\\s*fluids?\\b']), sourceByField);
  setIfAllowed(out, fields, 'oralRtMl', extractNumberAfter(text, ['\\boral\\s*(?:\\/|and)?\\s*rt\\s*intake\\b', '\\boral\\s*intake\\b', '\\brt\\s*intake\\b']), sourceByField);
  setIfAllowed(out, fields, 'urineMl', extractNumberAfter(text, ['\\burine\\s*(?:output)?\\b']), sourceByField);
  setIfAllowed(out, fields, 'rtOutputMl', extractNumberAfter(text, ['\\brt\\s*output\\b']), sourceByField);
  setIfAllowed(out, fields, 'vomitMl', extractNumberAfter(text, ['\\bvomit(?:ing)?\\s*(?:output)?\\b']), sourceByField);

  if (fieldAllowed(fields, 'bowelMovement')) {
    let bowel;
    if (/\bbowel\s*movement\s*(?:is|was|:)?\s*yes\b|\bpassed\s*stool\b/i.test(text)) bowel = 'Yes';
    if (/\bbowel\s*movement\s*(?:is|was|:)?\s*no\b|\bno\s+bowel\s*movement\b|\bnot\s+passed\s*stool\b/i.test(text)) bowel = 'No';
    setIfAllowed(out, fields, 'bowelMovement', bowel, sourceByField);
  }

  setIfAllowed(
    out,
    fields,
    'noUrineOverSixHours',
    extractYesNo(
      text,
      [/\bno\s+urine\s+for\s+(?:more\s+than\s+)?(?:6|six)\s*hours?\b/i],
      [/\burine\s+(?:output\s+)?(?:present|normal|adequate)\b/i]
    ),
    sourceByField
  );

  setIfAllowed(out, fields, 'oxygenDevice', extractTextAfter(text, ['\\boxygen\\s*device\\b']), sourceByField);
  setIfAllowed(out, fields, 'outputNotes', extractTextAfter(text, ['\\boutput\\s*notes?\\b']), sourceByField);
  setIfAllowed(out, fields, 'remarks', extractTextAfter(text, ['\\bclinical\\s*remarks?\\b', '\\bremarks?\\b']), sourceByField);

  return { fields: out, sourceByField };
}

function hasEvidenceForField(key, transcript, targetLocked = false) {
  if (targetLocked) return true;
  const patterns = FIELD_EVIDENCE[key] || [];
  return patterns.some((pattern) => pattern.test(String(transcript || '')));
}

function coerceAiValue(field, value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (field.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (/^(true|yes|1)$/i.test(String(value))) return true;
    if (/^(false|no|0)$/i.test(String(value))) return false;
    return undefined;
  }
  if (Array.isArray(field.enum) && field.enum.length) {
    const match = field.enum.find((option) => String(option).toLowerCase() === String(value).trim().toLowerCase());
    return match;
  }
  return String(value).trim();
}

function validateAiNurseVitalsFields({ aiFields, fields, transcript, deterministicFields = {} }) {
  const allowed = new Map((fields || []).map((field) => [field.key, field]));
  const accepted = {};
  const rejectedFields = [];
  const targetLocked = allowed.size === 1;

  Object.entries(aiFields || {}).forEach(([key, rawValue]) => {
    const field = allowed.get(key);
    if (!field || Object.prototype.hasOwnProperty.call(deterministicFields, key)) return;

    if (!hasEvidenceForField(key, transcript, targetLocked)) {
      rejectedFields.push({
        key,
        value: rawValue,
        reason: `Ignored ${field.label || key}: no matching phrase for this field was dictated.`,
      });
      return;
    }

    const value = coerceAiValue(field, rawValue);
    if (value === undefined || value === null || value === '') {
      rejectedFields.push({
        key,
        value: rawValue,
        reason: `Ignored ${field.label || key}: the extracted value did not match the expected ${field.type || 'field'} format.`,
      });
      return;
    }
    accepted[key] = value;
  });

  return { fields: accepted, rejectedFields };
}

function getAiEligibleFields({ fields, transcript, deterministicFields }) {
  const targetLocked = (fields || []).length === 1;
  return (fields || []).filter((field) => (
    !Object.prototype.hasOwnProperty.call(deterministicFields || {}, field.key) &&
    hasEvidenceForField(field.key, transcript, targetLocked)
  ));
}

module.exports = {
  isNurseVitalsContext,
  parseDeterministicNurseVitals,
  validateAiNurseVitalsFields,
  getAiEligibleFields,
};
