'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function personName(person) {
  if (!person) return '';
  if (typeof person === 'string') return clean(person);
  return [
    person.salutation,
    person.first_name || person.firstName,
    person.middle_name || person.middleName,
    person.last_name || person.lastName
  ].filter(Boolean).map(clean).filter(Boolean).join(' ').trim() || clean(person.name || person.fullName);
}

function formatDoctorName(person) {
  const raw = personName(person).replace(/^\s*dr\.?\s*/i, '').trim();
  return raw ? `Dr. ${raw}` : '';
}

function resolveDepartmentName(...sources) {
  for (const source of sources) {
    if (!source) continue;
    if (typeof source === 'string') {
      const value = clean(source);
      if (value && !/^[0-9a-f]{24}$/i.test(value)) return value;
      continue;
    }
    const value = clean(
      source.name || source.departmentName || source.department_name || source.department ||
      source.department?.name || source.department_id?.name || source.departmentId?.name || source.specialization
    );
    if (value && !/^[0-9a-f]{24}$/i.test(value)) return value;
  }
  return '';
}

const COMPUTER_GENERATED_BILL_EN = 'This is a computer-generated bill and does not require a signature.';
const COMPUTER_GENERATED_BILL_HI = 'यह एक कंप्यूटर जनित बिल है और इसमें हस्ताक्षर की आवश्यकता नहीं है।';

let cachedDevanagariFont;
function resolveDevanagariFont() {
  if (cachedDevanagariFont !== undefined) return cachedDevanagariFont || null;
  const candidates = [
    process.env.DEVANAGARI_FONT_PATH,
    path.join(__dirname, '../assets/fonts/NotoSansDevanagari-Regular.ttf'),
    path.join(__dirname, '../../assets/fonts/NotoSansDevanagari-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansDevanagariUI-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansDevanagari-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansDevanagariUI-Regular.ttf'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) {
        cachedDevanagariFont = resolved;
        return resolved;
      }
    } catch (_) { /* ignore invalid candidate */ }
  }
  try {
    const match = execFileSync('fc-match', ['-f', '%{file}', 'Noto Sans Devanagari'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (match && fs.existsSync(match)) {
      cachedDevanagariFont = match;
      return match;
    }
  } catch (_) { /* fontconfig may not be installed */ }
  cachedDevanagariFont = '';
  return null;
}

function registerDocumentFonts(doc) {
  const devanagari = resolveDevanagariFont();
  if (devanagari) {
    try { doc.registerFont('MediQliqDevanagari', devanagari); } catch (_) { /* already registered / unsupported */ }
  }
  return { devanagari: Boolean(devanagari) };
}

function useHindiFont(doc) {
  const devanagari = resolveDevanagariFont();
  if (devanagari) {
    try { doc.font('MediQliqDevanagari'); return true; } catch (_) { /* fall through */ }
  }
  doc.font('Helvetica');
  return false;
}


module.exports = {
  personName,
  formatDoctorName,
  resolveDepartmentName,
  COMPUTER_GENERATED_BILL_EN,
  COMPUTER_GENERATED_BILL_HI,
  resolveDevanagariFont,
  registerDocumentFonts,
  useHindiFont
};
