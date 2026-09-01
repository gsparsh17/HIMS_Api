'use strict';

const FORM_ALIASES = new Map([
  ['tablet', 'Tab'], ['tab', 'Tab'], ['capsule', 'Cap'], ['cap', 'Cap'],
  ['injection', 'Inj'], ['inj', 'Inj'], ['syrup', 'Syp'], ['syp', 'Syp'],
  ['suspension', 'Susp'], ['susp', 'Susp'], ['ointment', 'Oint'], ['oint', 'Oint'],
  ['cream', 'Cream'], ['gel', 'Gel'], ['drops', 'Drops'], ['drop', 'Drops'],
  ['iv fluid', 'IV Fluid'], ['infusion', 'IV Fluid'], ['inhaler', 'Inhaler'], ['respule', 'Inhaler'],
  ['lotion', 'Lotion'], ['powder', 'Powder'], ['sachet', 'Sachet']
]);

const FREQUENCY_EXPANSIONS = new Map(Object.entries({
  OD: 'One time a day', QD: 'One time a day', DAILY: 'One time a day',
  'ONCE A DAY': 'One time a day', 'ONCE DAILY': 'One time a day', '1-0-0': 'One time a day (Morning)', '0-1-0': 'One time a day (Afternoon)', '0-0-1': 'One time a day (Night)',
  BD: 'Two times a day', BID: 'Two times a day', 'TWICE A DAY': 'Two times a day', 'TWICE DAILY': 'Two times a day', '1-0-1': 'Two times a day (Morning, Night)',
  TDS: 'Three times a day', TID: 'Three times a day', 'THREE TIMES A DAY': 'Three times a day', 'THRICE DAILY': 'Three times a day', '1-1-1': 'Three times a day (Morning, Afternoon, Night)',
  QID: 'Four times a day', QDS: 'Four times a day', 'FOUR TIMES A DAY': 'Four times a day', '1-1-1-1': 'Four times a day',
  SOS: 'As needed / When required', PRN: 'As needed / When required', 'AS NEEDED': 'As needed / When required',
  HS: 'Once at night', BEDTIME: 'Once at night', NIGHT: 'Once at night', 'AT NIGHT': 'Once at night',
  STAT: 'Immediately (Once)', IMMEDIATELY: 'Immediately (Once)', ONCE: 'One time only',
  Q4H: 'Every 4 hours', Q6H: 'Every 6 hours', Q8H: 'Every 8 hours', Q12H: 'Every 12 hours',
  WEEKLY: 'Once a week', QW: 'Once a week', EOD: 'Every alternate day', QOD: 'Every alternate day'
}));

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function formatMedicineName(value) {
  return clean(value).toUpperCase();
}

function medicineForm(item = {}) {
  const raw = clean(item.dosage_form || item.dosageForm || item.medicine_type || item.form || item.medicineForm || item.medicine_id?.dosage_form || item.medicineId?.dosage_form).toLowerCase();
  if (FORM_ALIASES.has(raw)) return FORM_ALIASES.get(raw);
  for (const [needle, label] of FORM_ALIASES.entries()) if (raw.includes(needle)) return label;
  const name = formatMedicineName(item.medicine_name || item.medicineName || item.name || item.item_name);
  if (/\bINJ(?:ECTION)?\b/.test(name)) return 'Inj';
  if (/\bTAB(?:LET)?\b/.test(name)) return 'Tab';
  if (/\bCAP(?:SULE)?\b/.test(name)) return 'Cap';
  if (/\bSYP|SYRUP\b/.test(name)) return 'Syp';
  if (/\bSUSP(?:ENSION)?\b/.test(name)) return 'Susp';
  if (/\bOINT(?:MENT)?\b/.test(name)) return 'Oint';
  if (/\bDROP(?:S)?\b/.test(name)) return 'Drops';
  return '';
}

function formatMedicationDosage(item = {}) {
  return clean(item.strength || item.dosage || item.dose || item.doseText || item.medicine_id?.strength || item.medicineId?.strength);
}

function formatMedicationRoute(valueOrItem = {}) {
  const raw = typeof valueOrItem === 'string'
    ? valueOrItem
    : (valueOrItem.route_of_administration || valueOrItem.route || valueOrItem.medicine_id?.route || valueOrItem.medicineId?.route || '');
  const source = clean(raw);
  const normalized = source.toUpperCase().replace(/[\/\.\s_-]+/g, '');
  if (!normalized) {
    const form = medicineForm(typeof valueOrItem === 'object' ? valueOrItem : {});
    if (form === 'Inj') return 'IV / IM';
    if (['Oint', 'Cream', 'Gel', 'Lotion'].includes(form)) return 'Topical';
    if (form === 'IV Fluid') return 'IV';
    if (form === 'Inhaler') return 'Inhalation';
    return ['Tab', 'Cap', 'Syp', 'Susp', 'Powder'].includes(form) ? 'P/O' : '';
  }
  if (['PO', 'ORAL', 'BYMOUTH'].includes(normalized) || normalized.includes('ORAL')) return 'P/O';
  if (normalized === 'IV' || normalized.includes('INTRAVENOUS')) return 'IV';
  if (normalized === 'IM' || normalized.includes('INTRAMUSCULAR')) return 'IM';
  if (['SC', 'SQ'].includes(normalized) || normalized.includes('SUBCUTANEOUS')) return 'SC';
  if (normalized === 'PV' || normalized.includes('VAGINAL')) return 'P/V';
  if (normalized === 'PR' || normalized.includes('RECTAL')) return 'P/R';
  if (normalized === 'SL' || normalized.includes('SUBLINGUAL')) return 'S/L';
  if (normalized.includes('TOPICAL') || normalized.includes('EXTERNAL')) return 'Topical';
  if (normalized.includes('INHAL') || normalized.includes('NEB')) return 'Inhalation';
  if (normalized.includes('OPHTHALMIC') || normalized.includes('EYE')) return 'Eye';
  if (normalized.includes('OTIC') || normalized.includes('EAR')) return 'Ear';
  if (normalized.includes('NASAL')) return 'Nasal';
  return source;
}

function formatMedicationFrequency(value) {
  const raw = clean(value);
  if (!raw) return '';
  const normalized = raw.toUpperCase().replace(/\s+/g, ' ');
  if (FREQUENCY_EXPANSIONS.has(normalized)) return FREQUENCY_EXPANSIONS.get(normalized);
  if (/(^|[\s,;/()-])(?:OD|QD)(?=$|[\s,;/()-])/.test(normalized)) return 'One time a day';
  if (/(^|[\s,;/()-])(?:BD|BID)(?=$|[\s,;/()-])/.test(normalized)) return 'Two times a day';
  if (/(^|[\s,;/()-])(?:TDS|TID)(?=$|[\s,;/()-])/.test(normalized)) return 'Three times a day';
  if (/(^|[\s,;/()-])(?:QID|QDS)(?=$|[\s,;/()-])/.test(normalized)) return 'Four times a day';
  if (/(^|[\s,;/()-])HS(?=$|[\s,;/()-])/.test(normalized)) return 'Once at night';
  if (/(^|[\s,;/()-])(?:SOS|PRN)(?=$|[\s,;/()-])/.test(normalized)) return 'As needed / When required';
  if (/(^|[\s,;/()-])STAT(?=$|[\s,;/()-])/.test(normalized)) return 'Immediately (Once)';
  return raw;
}

function formatMedication(item = {}) {
  const form = medicineForm(item);
  const name = formatMedicineName(item.medicine_name || item.medicineName || item.name || item.item_name);
  const dosage = formatMedicationDosage(item);
  const route = formatMedicationRoute(item);
  const frequency = formatMedicationFrequency(item.frequency || item.freq || item.timing);
  return { form, name, dosage, route, frequency, label: [form, name, dosage].filter(Boolean).join(' ') };
}

module.exports = { formatMedicineName, medicineForm, formatMedicationDosage, formatMedicationRoute, formatMedicationFrequency, formatMedication };
