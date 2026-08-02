const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const PDFDocument = require('pdfkit');
const StoredFile = require('../models/StoredFile');
const PrintIdentityAsset = require('../models/PrintIdentityAsset');
const fileStorage = require('./fileStorage.service');

const mm = (value) => value * 2.834645669;
const PAGE = { width: mm(210), height: mm(297), margin: mm(5.5) };
const TYPO = {
  body: 8.9, bodyGap: 2.0, emphasis: 9.1, emphasisGap: 1.8,
  heading: 8.8, headingGap: 1.2, list: 8.2, table: 7.8, small: 7.2
};
// Lowest usable Y coordinate inside the fixed A4 print frame.
// ensureSpace() uses this boundary before adding continuation pages.
const CONTENT_BOTTOM = PAGE.height - PAGE.margin;
const COLORS = { ink: '#111111', border: '#111111', muted: '#333333', fill: '#F2F2F2' };

const LAYOUT_PROFILES = {
  default: { body: 8.9, bodyGap: 2.0, list: 8.2, table: 7.8, signatureHeader: 38, signatureRow: 60, signatureAnchor: true, signatureBottomReserve: 76 },
  'infectious-disease-screening-consent': { body: 9.05, bodyGap: 2.15, list: 8.25, table: 7.85, signatureHeader: 40, signatureRow: 68, signatureAnchor: false, signatureBottomReserve: 74 },
  'anaesthesia-consent': { body: 8.7, bodyGap: 1.8, list: 8.0, table: 7.7, choiceTitle: 9.1, choiceBody: 8.05, signatureHeader: 38, signatureRow: 55, signatureAnchor: true, signatureBottomReserve: 70 },
  'blood-transfusion-consent': { body: 8.85, bodyGap: 1.95, list: 8.1, table: 7.75, signatureHeader: 40, signatureRow: 64, signatureAnchor: true, signatureBottomReserve: 78 },
  'high-risk-consent': { body: 9.0, bodyGap: 2.2, list: 8.45, table: 7.9, signatureHeader: 40, signatureRow: 58, signatureAnchor: true, signatureBottomReserve: 76 },
  'lama-dor-consent': { body: 9.0, bodyGap: 2.1, list: 8.2, table: 7.6, signatureHeader: 34, signatureRow: 45, signatureAnchor: false, signatureBottomReserve: 58 },
  'mlc-refusal-consent': { body: 9.2, bodyGap: 2.35, list: 8.7, table: 8.0, signatureHeader: 42, signatureRow: 72, signatureAnchor: false, signatureBottomReserve: 58 },
  'restraint-consent': { body: 8.75, bodyGap: 1.9, list: 8.0, table: 7.65, signatureHeader: 38, signatureRow: 52, signatureAnchor: true, signatureBottomReserve: 70 },
  'surgery-consent': { body: 8.75, bodyGap: 1.9, list: 8.0, table: 7.7, signatureHeader: 38, signatureRow: 55, signatureAnchor: true, signatureBottomReserve: 70 }
};
function layoutProfile(template) { return { ...LAYOUT_PROFILES.default, ...(LAYOUT_PROFILES[template?.id] || {}) }; }


function firstExisting(paths) {
  return paths.filter(Boolean).find((candidate) => {
    try { return fs.existsSync(candidate); } catch (_) { return false; }
  });
}
function fontConfigMatch(pattern) {
  try {
    const result = execFileSync('fc-match', ['-f', '%{file}', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return result && fs.existsSync(result) ? result : undefined;
  } catch (_) { return undefined; }
}
const DEV_REG = firstExisting([
  process.env.DEVANAGARI_FONT_PATH,
  '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansDevanagariUI-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansDevanagari-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansDevanagariUI-Regular.ttf'
]) || fontConfigMatch('Noto Sans Devanagari');
const DEV_BOLD = firstExisting([
  process.env.DEVANAGARI_BOLD_FONT_PATH,
  '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansDevanagariUI-Bold.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansDevanagari-Bold.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansDevanagariUI-Bold.ttf'
]) || fontConfigMatch('Noto Sans Devanagari:style=Bold') || DEV_REG;

const clean = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.filter(Boolean).join(', ') || fallback;
  if (typeof value === 'boolean') return value ? 'Yes / हाँ' : 'No / नहीं';
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() || fallback;
};
const fullName = (person = {}) => person.name || [person.salutation, person.first_name || person.firstName, person.middle_name || person.middleName, person.last_name || person.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
const ageFromDob = (dob) => {
  if (!dob) return '';
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  let years = now.getFullYear() - date.getFullYear();
  if (now < new Date(now.getFullYear(), date.getMonth(), date.getDate())) years -= 1;
  return Math.max(0, years);
};
const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? clean(value) : date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function setupFonts(doc) {
  if (DEV_REG) {
    doc.registerFont('Native', DEV_REG);
    doc.registerFont('NativeBold', DEV_BOLD || DEV_REG);
  }
}
function useFont(doc, bold = false) { doc.font(DEV_REG ? (bold ? 'NativeBold' : 'Native') : (bold ? 'Helvetica-Bold' : 'Helvetica')); }
function text(doc, value, x, y, options = {}, bold = false, size = 8) {
  useFont(doc, bold);
  doc.fillColor(options.color || COLORS.ink).fontSize(size).text(clean(value), x, y, options);
}
function textHeight(doc, value, width, bold = false, size = 8, lineGap = 1.8) {
  useFont(doc, bold); doc.fontSize(size);
  return doc.heightOfString(clean(value), { width, lineGap });
}
function line(doc, x1, y1, x2, y2, width = 0.6) { doc.save().strokeColor(COLORS.border).lineWidth(width).moveTo(x1, y1).lineTo(x2, y2).stroke().restore(); }
function box(doc, x, y, width, height, fill) {
  doc.save().strokeColor(COLORS.border).lineWidth(0.65);
  if (fill) doc.fillColor(fill).rect(x, y, width, height).fillAndStroke(fill, COLORS.border);
  else doc.rect(x, y, width, height).stroke();
  doc.restore();
}
function check(doc, x, y, checked) {
  box(doc, x, y, 8, 8);
  if (checked) doc.save().strokeColor(COLORS.ink).lineWidth(1.2).moveTo(x + 1, y + 4).lineTo(x + 3.2, y + 7).lineTo(x + 7, y + 1).stroke().restore();
}

function doctorName(doctor = {}) { return fullName(doctor); }
function buildContext(consent, admission, hospital) {
  const print = consent.printSnapshot || {};
  const response = print.responses || consent.responses || {};
  const patientSnapshot = print.patientSnapshot || consent.patientSnapshot || {};
  const admissionSnapshot = print.admissionSnapshot || consent.admissionSnapshot || {};
  const hospitalSnapshot = print.hospitalSnapshot || consent.hospitalSnapshot || {};
  const patient = admission?.patientId || {};
  const doctor = admission?.primaryDoctorId || {};
  const ward = admission?.wardId || {};
  const room = admission?.roomId || {};
  const bed = admission?.bedId || {};
  const patientAge = patientSnapshot.age ?? patient.age ?? ageFromDob(patient.dob);
  const patientGender = patientSnapshot.gender || patient.gender || '';
  return {
    response,
    patient: {
      name: patientSnapshot.name || fullName(patient),
      uhid: patientSnapshot.uhid || patient.uhid || patient.patient_id || patient.patientId || '',
      age: patientAge,
      gender: patientGender,
      ageGender: [patientAge ? `${patientAge} Y` : '', patientGender].filter(Boolean).join(' / '),
      address: patientSnapshot.address || patient.address || ''
    },
    admission: {
      number: admissionSnapshot.admissionNumber || admission?.admissionNumber || admission?.shipNumber || '',
      admissionDateTime: formatDateTime(admissionSnapshot.admissionDate || admission?.admissionDate),
      wardBed: [admissionSnapshot.ward || ward.name || ward.wardName, admissionSnapshot.room || room.roomNumber || room.name, admissionSnapshot.bed || bed.bedNumber || bed.name].filter(Boolean).join(' / '),
      department: admissionSnapshot.department || admission?.departmentId?.name || admission?.departmentId?.departmentName || '',
      diagnosis: admissionSnapshot.diagnosis || admission?.provisionalDiagnosis || '',
      consultant: admissionSnapshot.consultantName || doctorName(doctor)
    },
    hospital: {
      name: hospitalSnapshot.hospitalName || hospital?.hospitalName || hospital?.name || 'HOSPITAL',
      address: [hospitalSnapshot.address || hospital?.address, hospitalSnapshot.city || hospital?.city, hospitalSnapshot.state || hospital?.state, hospitalSnapshot.pincode || hospital?.pincode].filter(Boolean).join(', '),
      phone: hospitalSnapshot.phone || hospital?.phone || hospital?.contact,
      email: hospitalSnapshot.email || hospital?.email
    }
  };
}
function valueFor(key, context, source = 'response') {
  if (source === 'admission') return context.admission[key] || '';
  if (source === 'patient') return context.patient[key] || '';
  if (source === 'responseOrAdmission') return context.response[key] || context.admission[key] || '';
  const aliases = {
    doctorName: context.response.doctorName || context.admission.consultant,
    consultant: context.admission.consultant,
    department: context.admission.department,
    diagnosis: context.response.diagnosis || context.admission.diagnosis,
    patientName: context.patient.name,
    guardianName: context.response.guardianName,
    patientNameForRestraint: context.response.patientNameForRestraint || context.patient.name,
    highRiskReasons: context.response.highRiskReasons,
    address: context.response.address || context.patient.address
  };
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : context.response[key];
}
function interpolate(value, context) {
  return clean(value).replace(/\{\{([^}]+)\}\}/g, (_match, key) => clean(valueFor(String(key).trim(), context), '__________'));
}
function isSelected(value, option) {
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase()).includes(String(option).toLowerCase());
  return String(value || '').toLowerCase() === String(option || '').toLowerCase();
}

function drawDocumentHeader(doc, template, context, pageNumber, totalPages, profile = LAYOUT_PROFILES.default) {
  const x = PAGE.margin; const width = PAGE.width - PAGE.margin * 2; const top = PAGE.margin;
  box(doc, x, top, width, mm(26));
  text(doc, context.hospital.name, x + 6, top + 5, { width: width * 0.62, align: 'center' }, true, 12);
  text(doc, context.hospital.address, x + 6, top + 21, { width: width * 0.62, align: 'center' }, false, profile.table);
  const contact = [context.hospital.phone, context.hospital.email].filter(Boolean).join(' | ');
  if (contact) text(doc, contact, x + 6, top + 33, { width: width * 0.62, align: 'center' }, false, profile.table);
  line(doc, x + width * 0.64, top, x + width * 0.64, top + mm(26));
  text(doc, template.name, x + width * 0.65, top + 8, { width: width * 0.34, align: 'center' }, true, 11.8);
  if (template.bilingualName) text(doc, template.bilingualName, x + width * 0.65, top + 25, { width: width * 0.34, align: 'center' }, true, 10);
  text(doc, `Page ${pageNumber} of ${totalPages}`, x + width * 0.65, top + 45, { width: width * 0.34, align: 'center', color: COLORS.muted }, false, 6.8);
  return top + mm(27.5);
}
function drawPatientHeader(doc, context, y) {
  const x = PAGE.margin; const width = PAGE.width - PAGE.margin * 2;
  const row = 22; const labelSize = 6.5; const valueSize = 8.1;
  box(doc, x, y, width, row * 3);
  line(doc, x, y + row, x + width, y + row);
  line(doc, x, y + row * 2, x + width, y + row * 2);

  // Reference forms use stable, roomy cells. Labels sit above values so bilingual
  // labels can wrap without colliding with patient data.
  const row1 = [0, 0.50, 0.74, 1].map((ratio) => x + width * ratio);
  const row2 = [0, 0.34, 0.56, 1].map((ratio) => x + width * ratio);
  row1.slice(1, -1).forEach((cx) => line(doc, cx, y, cx, y + row));
  row2.slice(1, -1).forEach((cx) => line(doc, cx, y + row, cx, y + row * 2));

  const cell = (left, top, cellWidth, label, value) => {
    text(doc, label, left + 4, top + 2.5, { width: cellWidth - 8, height: 9, ellipsis: true }, true, labelSize);
    text(doc, value, left + 4, top + 11.5, { width: cellWidth - 8, height: 10, ellipsis: true }, false, valueSize);
  };
  cell(row1[0], y, row1[1] - row1[0], 'Patient Name / रोगी का नाम', context.patient.name);
  cell(row1[1], y, row1[2] - row1[1], 'Age / Gender / आयु / लिंग', context.patient.ageGender);
  cell(row1[2], y, row1[3] - row1[2], 'UHID', context.patient.uhid);
  cell(row2[0], y + row, row2[1] - row2[0], 'IPD', context.admission.number);
  cell(row2[1], y + row, row2[2] - row2[1], 'Department', context.admission.department);
  cell(row2[2], y + row, row2[3] - row2[2], 'Ward / Bed No.', context.admission.wardBed);

  text(doc, 'Diagnosis / डायग्नोसिस', x + 4, y + row * 2 + 2.5, { width: width - 8, height: 9, ellipsis: true }, true, labelSize);
  text(doc, context.response.diagnosis || context.admission.diagnosis, x + 4, y + row * 2 + 11.5, { width: width - 8, height: 10, ellipsis: true }, false, valueSize);
  return y + row * 3 + 5;
}
function addNativePage(doc, template, context, state, pageIndex, totalPages, includePatientHeader = true) {
  doc.addPage({ size: 'A4', margin: 0 });
  state.currentPage += 1;
  let y = drawDocumentHeader(doc, template, context, pageIndex + 1, totalPages, state.profile);
  if (includePatientHeader) y = drawPatientHeader(doc, context, y);
  state.y = y;
}
function ensureSpace(doc, template, context, state, required, totalPages) {
  if (state.y + required <= CONTENT_BOTTOM) return;
  addNativePage(doc, template, context, state, state.currentPage, totalPages, false);
  text(doc, `${template.name} - Continued`, PAGE.margin, state.y, { width: PAGE.width - PAGE.margin * 2, align: 'center' }, true, 8.2);
  state.y += 17;
}
function headingMetrics(doc, heading, headingHi, width) {
  const title = [clean(heading), clean(headingHi)].filter(Boolean).join(' / ');
  if (!title) return { title: '', height: 0 };
  const bodyHeight = textHeight(doc, title, width - 10, true, TYPO.heading, TYPO.headingGap);
  return { title, height: Math.max(21, bodyHeight + 8) };
}
function sectionHeading(doc, state, heading, headingHi, width) {
  const metrics = headingMetrics(doc, heading, headingHi, width);
  if (!metrics.title) return 0;
  box(doc, PAGE.margin, state.y, width, metrics.height, COLORS.fill);
  text(doc, metrics.title, PAGE.margin + 5, state.y + 3.5, { width: width - 10, lineGap: TYPO.headingGap }, true, TYPO.heading);
  state.y += metrics.height + 3;
  return metrics.height + 3;
}
function renderParagraph(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  const heading = interpolate(section.heading, context); const headingHi = interpolate(section.headingHi, context);
  const en = interpolate(section.en, context); const hi = interpolate(section.hi, context);
  const profile = state.profile || LAYOUT_PROFILES.default;
  const fontSize = section.emphasis ? Math.max(profile.body, TYPO.emphasis) : profile.body;
  const lineGap = section.emphasis ? Math.max(profile.bodyGap, TYPO.emphasisGap) : profile.bodyGap;
  const hm = headingMetrics(doc, heading, headingHi, width);
  const enHeight = en ? textHeight(doc, en, width - 10, Boolean(section.emphasis), fontSize, lineGap) : 0;
  const hiHeight = hi ? textHeight(doc, hi, width - 10, Boolean(section.emphasis), fontSize, lineGap) : 0;
  ensureSpace(doc, template, context, state, hm.height + enHeight + hiHeight + 20, totalPages);
  if (hm.title) sectionHeading(doc, state, heading, headingHi, width);
  if (en) {
    text(doc, en, PAGE.margin + 5, state.y, { width: width - 10, lineGap }, Boolean(section.emphasis), fontSize);
    state.y += enHeight + 6;
  }
  if (hi) {
    text(doc, hi, PAGE.margin + 5, state.y, { width: width - 10, lineGap }, Boolean(section.emphasis), fontSize);
    state.y += hiHeight + 7;
  }
}
function renderList(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  ensureSpace(doc, template, context, state, 30, totalPages);
  sectionHeading(doc, state, interpolate(section.heading, context), interpolate(section.headingHi, context), width);
  (section.items || []).forEach((item, index) => {
    const prefix = section.ordered ? `${Number(section.start || 1) + index}.` : '•';
    const en = interpolate(item.en, context); const hi = interpolate(item.hi, context);
    const body = [en, hi].filter(Boolean).join('\n');
    const listSize = (state.profile || LAYOUT_PROFILES.default).list;
    const height = textHeight(doc, body, width - 28, false, listSize, 1.9) + 6;
    ensureSpace(doc, template, context, state, height, totalPages);
    text(doc, prefix, PAGE.margin + 6, state.y, { width: 18 }, true, listSize);
    text(doc, body, PAGE.margin + 24, state.y, { width: width - 30, lineGap: 1.9 }, false, listSize);
    state.y += height;
  });
  state.y += 3;
}
function renderTwoColumnList(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2; const half = width / 2;
  const rows = section.items || [];
  const rowHeights = rows.map((item) => Math.max(textHeight(doc, interpolate(item.en, context), half - 22, false, 7.8, 1.45), textHeight(doc, interpolate(item.hi, context), half - 22, false, 7.8, 1.45)) + 8);
  const totalHeight = 22 + rowHeights.reduce((sum, value) => sum + value, 0);
  ensureSpace(doc, template, context, state, Math.min(totalHeight, PAGE.height / 2), totalPages);
  sectionHeading(doc, state, section.heading, section.headingHi, width);
  rows.forEach((item, index) => {
    const h = rowHeights[index];
    ensureSpace(doc, template, context, state, h, totalPages);
    box(doc, PAGE.margin, state.y, width, h);
    line(doc, PAGE.margin + half, state.y, PAGE.margin + half, state.y + h);
    text(doc, `${index + 1}. ${interpolate(item.en, context)}`, PAGE.margin + 5, state.y + 4, { width: half - 10, lineGap: 1.45 }, false, 7.8);
    text(doc, `${index + 1}. ${interpolate(item.hi, context)}`, PAGE.margin + half + 5, state.y + 4, { width: half - 10, lineGap: 1.45 }, false, 7.8);
    state.y += h;
  });
  state.y += 5;
}
function renderChoiceCards(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  const profile = state.profile || LAYOUT_PROFILES.default;
  const choiceBody = profile.choiceBody || 7.8;
  const choiceTitle = profile.choiceTitle || 9;
  (section.choices || []).forEach((choice) => {
    const selected = isSelected(context.response[section.responseKey], choice.value);
    const bodyLines = [
      `${choice.description || ''}${choice.descriptionHi ? ` / ${choice.descriptionHi}` : ''}`,
      `Benefits / लाभ: ${(choice.benefits || []).map((item) => `${item.en} / ${item.hi}`).join('; ')}`,
      `Risks / जोखिम: ${(choice.risks || []).map((item) => `${item.en} / ${item.hi}`).join('; ')}`
    ];
    const h = 28 + bodyLines.reduce((sum, value) => sum + textHeight(doc, value, width - 32, false, choiceBody, 1.8), 0) + 10;
    ensureSpace(doc, template, context, state, h, totalPages);
    box(doc, PAGE.margin, state.y, width, h);
    check(doc, PAGE.margin + 7, state.y + 7, selected);
    text(doc, `${choice.title} / ${choice.titleHi}`, PAGE.margin + 20, state.y + 5, { width: width - 25 }, true, choiceTitle);
    let y = state.y + 24;
    bodyLines.forEach((lineValue, index) => {
      text(doc, lineValue, PAGE.margin + 8, y, { width: width - 16, lineGap: 1.8 }, index > 0, choiceBody);
      y += textHeight(doc, lineValue, width - 16, index > 0, choiceBody, 1.8) + 3;
    });
    state.y += h + 4;
  });
}
function renderComponentChoices(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  ensureSpace(doc, template, context, state, 88, totalPages);
  sectionHeading(doc, state, '1. Type of Blood', 'रक्त का प्रकार', width);
  const choices = section.choices || [];
  choices.forEach((choice, index) => {
    const column = index % 3; const row = Math.floor(index / 3);
    const cellWidth = width / 3;
    const x = PAGE.margin + column * cellWidth;
    const y = state.y + row * 25;
    check(doc, x + 5, y + 5, isSelected(context.response[section.responseKey], choice.value));
    const suffix = choice.value === 'Other' && context.response[section.otherKey] ? `: ${context.response[section.otherKey]}` : '';
    text(doc, `${choice.en} / ${choice.hi}${suffix}`, x + 19, y + 2, { width: cellWidth - 22 }, false, 7.6);
  });
  state.y += 54;
  text(doc, `Blood Group / रक्त समूह: ${clean(context.response[section.groupKey], '________')}`, PAGE.margin + 5, state.y, { width: width / 2 }, true, 7.8);
  text(doc, `Rh Type: ${clean(context.response[section.rhKey], '________')}`, PAGE.margin + width / 2, state.y, { width: width / 2 - 5 }, true, 7.8);
  state.y += 24;
}
function renderResponseLine(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  ensureSpace(doc, template, context, state, 35, totalPages);
  text(doc, `${section.label} / ${section.labelHi}`, PAGE.margin + 3, state.y, { width }, true, 8.7);
  state.y += 16;
  const value = clean(valueFor(section.key, context), '');
  text(doc, value, PAGE.margin + 7, state.y, { width: width - 14, height: 28, ellipsis: true }, false, 8.4);
  line(doc, PAGE.margin + 5, state.y + 24, PAGE.margin + width - 5, state.y + 24);
  state.y += 33;
}
function renderClinicalDetails(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  ensureSpace(doc, template, context, state, 48, totalPages);
  const fields = section.fields || [];
  const cellWidth = width / 2;
  fields.forEach((field, index) => {
    const row = Math.floor(index / 2); const column = index % 2;
    const x = PAGE.margin + column * cellWidth; const y = state.y + row * 29;
    text(doc, `${field.label}:`, x + 4, y + 3, { width: cellWidth * 0.35 }, true, 7.7);
    text(doc, valueFor(field.key, context, field.source), x + cellWidth * 0.35, y + 3, { width: cellWidth * 0.62, ellipsis: true }, false, 7.9);
    line(doc, x + cellWidth * 0.35, y + 22, x + cellWidth - 5, y + 22, 0.4);
  });
  state.y += Math.ceil(fields.length / 2) * 29 + 6;
}
function roleLabel(role) {
  const labels = {
    patient: ['Patient / Authorized Representative', 'मरीज / अधिकृत प्रतिनिधि'],
    authorizedRepresentative: ['Authorized Representative / Relationship', 'अधिकृत प्रतिनिधि / संबंध'],
    doctor: ['Doctor', 'चिकित्सक'],
    surgeon: ['Surgeon', 'शल्य चिकित्सक'],
    anaesthetist: ['Anaesthetist', 'एनेस्थेटिस्ट'],
    witness: ['Witness', 'गवाह'],
    interpreter: ['Interpreter', 'अनुवादक']
  };
  return labels[role] || [role, ''];
}
function roleValues(role, context) {
  const response = context.response;
  const map = {
    patient: [response.patientOrRepresentativeName || context.patient.name, response.relationship, response.signedDate, response.signedTime],
    authorizedRepresentative: [response.authorizedRepresentativeName || response.patientOrRepresentativeName, response.relationship, response.signedDate, response.signedTime],
    doctor: [response.doctorName || context.admission.consultant, '', response.doctorSignedDate, response.doctorSignedTime],
    surgeon: [response.doctorName || context.admission.consultant, '', response.doctorSignedDate, response.doctorSignedTime],
    anaesthetist: [response.doctorName || context.admission.consultant, '', response.doctorSignedDate, response.doctorSignedTime],
    witness: [response.witnessName, '', response.witnessSignedDate, response.witnessSignedTime],
    interpreter: [response.interpreterName, '', response.interpreterSignedDate, response.interpreterSignedTime]
  };
  return map[role] || ['', '', '', ''];
}
function renderSignatureTable(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  const columns = [0, 0.24, 0.52, 0.78, 1].map((ratio) => PAGE.margin + width * ratio);
  const profile = state.profile || LAYOUT_PROFILES.default;
  const headerHeight = profile.signatureHeader; const rowHeight = profile.signatureRow; const rows = section.roles || [];
  const totalHeight = headerHeight + rows.length * rowHeight;
  ensureSpace(doc, template, context, state, totalHeight + 5, totalPages);
  // Reference forms place acknowledgement tables near the lower page region.
  // Anchoring avoids a visually compressed upper half while preserving fixed A4 geometry.
  if (profile.signatureAnchor) {
    const anchoredY = CONTENT_BOTTOM - totalHeight - profile.signatureBottomReserve;
    if (anchoredY > state.y && anchoredY - state.y < mm(72)) state.y = anchoredY;
  }
  box(doc, PAGE.margin, state.y, width, totalHeight);
  columns.slice(1, -1).forEach((x) => line(doc, x, state.y, x, state.y + totalHeight));
  line(doc, PAGE.margin, state.y + headerHeight, PAGE.margin + width, state.y + headerHeight);
  const headers = ['Details Required\nआवश्यक विवरण', 'Name & Relation\nनाम एवं संबंध', 'Signature / thumb Impression (left)\nहस्ताक्षर / अंगूठे का निशान (बाएं)', 'Date & Time\nदिनांक एवं समय'];
  headers.forEach((header, index) => text(doc, header, columns[index] + 4, state.y + 4, { width: columns[index + 1] - columns[index] - 8, align: 'center' }, true, Math.max(7.1, profile.table - 0.5)));
  rows.forEach((role, index) => {
    const top = state.y + headerHeight + index * rowHeight;
    if (index) line(doc, PAGE.margin, top, PAGE.margin + width, top);
    const labels = roleLabel(role); const values = roleValues(role, context);
    text(doc, labels.filter(Boolean).join('\n'), columns[0] + 4, top + 4, { width: columns[1] - columns[0] - 8 }, true, Math.max(7.4, profile.table - 0.2));
    text(doc, [values[0], values[1] ? `Relation: ${values[1]}` : ''].filter(Boolean).join('\n'), columns[1] + 4, top + 4, { width: columns[2] - columns[1] - 8 }, false, 7.8);
    text(doc, '', columns[2] + 4, top + 4, { width: columns[3] - columns[2] - 8 }, false, 7.8);
    text(doc, [values[2], values[3]].filter(Boolean).join(' '), columns[3] + 4, top + 4, { width: columns[4] - columns[3] - 8, align: 'center' }, false, 7.8);
  });
  state.y += totalHeight + 6;
}
function renderNotes(doc, section, context, state, template, totalPages) {
  renderList(doc, { heading: section.title, headingHi: section.titleHi, items: section.items, ordered: true }, context, state, template, totalPages);
}
function renderBenefitRiskColumns(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2; const half = width / 2;
  ensureSpace(doc, template, context, state, 35, totalPages);
  sectionHeading(doc, state, section.heading, section.headingHi, width);
  const maxRows = Math.max(section.benefits?.length || 0, section.risks?.length || 0);
  const rows = [];
  for (let index = 0; index < maxRows; index += 1) {
    const left = section.benefits?.[index]; const right = section.risks?.[index];
    const leftText = left ? `${index + 1}. ${left.en}\n${left.hi}` : '';
    const rightText = right ? `${index + 1}. ${right.en}\n${right.hi}` : '';
    const h = Math.max(textHeight(doc, leftText, half - 12, false, 7.8, 1.5), textHeight(doc, rightText, half - 12, false, 7.8, 1.5)) + 8;
    rows.push([leftText, rightText, h]);
  }
  box(doc, PAGE.margin, state.y, width, 20, COLORS.fill);
  line(doc, PAGE.margin + half, state.y, PAGE.margin + half, state.y + 24);
  text(doc, 'Benefits / लाभ', PAGE.margin + 4, state.y + 5, { width: half - 8, align: 'center' }, true, 7.8);
  text(doc, 'Risks / जोखिम', PAGE.margin + half + 4, state.y + 5, { width: half - 8, align: 'center' }, true, 7.8);
  state.y += 24;
  rows.forEach(([leftText, rightText, h]) => {
    ensureSpace(doc, template, context, state, h, totalPages);
    box(doc, PAGE.margin, state.y, width, h);
    line(doc, PAGE.margin + half, state.y, PAGE.margin + half, state.y + h);
    text(doc, leftText, PAGE.margin + 5, state.y + 4, { width: half - 10, lineGap: 1.5 }, false, 7.8);
    text(doc, rightText, PAGE.margin + half + 5, state.y + 4, { width: half - 10, lineGap: 1.5 }, false, 7.8);
    state.y += h;
  });
  state.y += 5;
}
function renderDeclarantDetails(doc, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  const en = `I, ${clean(context.response.patientOrRepresentativeName, '__________')} (patient name/relative) son/daughter/wife of ${clean(context.response.guardianName, '__________')}, aged ${clean(context.response.declarantAge, '____')} years, resident of ${clean(context.response.address || context.patient.address, '________________')}, hereby declare that:`;
  const hi = `मैं, ${clean(context.response.patientOrRepresentativeName, '__________')} (रोगी का नाम/रिश्तेदार) पुत्र/पुत्री/पत्नी ${clean(context.response.guardianName, '__________')}, आयु ${clean(context.response.declarantAge, '____')} वर्ष, निवासी ${clean(context.response.address || context.patient.address, '________________')}, यह घोषणा करता/करती हूँ कि:`;
  renderParagraph(doc, { type: 'paragraph', en, hi }, context, state, template, totalPages);
}
function renderLamaStatement(doc, section, context, state, template, totalPages) {
  const response = context.response;
  const patientBeingDischarged = response.patientBeingDischarged || context.patient.name;
  const templateText = section.en || 'I, Mr. / Ms. / Dr. {{requestingPersonName}}, Son / Daughter / Wife of {{requestingPersonParentSpouse}}, take full responsibility in having Mr. / Ms. / Dr. {{patientBeingDischarged}} to {{dischargeDestination}}, Son / Daughter / Wife of {{patientParentSpouse}}, discharged against medical advice at his/her own risk. The condition of the patient and the consequences have been explained to me and no one (not even the patient) will ever hold Hospital or its staff in any way responsible for any outcome whatsoever.';
  const localContext = { ...context, response: { ...response, patientBeingDischarged } };
  renderParagraph(doc, { type: 'paragraph', en: templateText, hi: section.hi }, localContext, state, template, totalPages);
}
function renderSection(doc, section, context, state, template, totalPages) {
  switch (section.type) {
    case 'documentSubTitle':
      ensureSpace(doc, template, context, state, 18, totalPages);
      text(doc, section.en, PAGE.margin, state.y, { width: PAGE.width - PAGE.margin * 2, align: 'center' }, true, 7.8); state.y += 17; break;
    case 'clinicalDetails': renderClinicalDetails(doc, section, context, state, template, totalPages); break;
    case 'paragraph': renderParagraph(doc, section, context, state, template, totalPages); break;
    case 'list': renderList(doc, section, context, state, template, totalPages); break;
    case 'twoColumnList': renderTwoColumnList(doc, section, context, state, template, totalPages); break;
    case 'choiceCards': renderChoiceCards(doc, section, context, state, template, totalPages); break;
    case 'componentChoices': renderComponentChoices(doc, section, context, state, template, totalPages); break;
    case 'responseLine': renderResponseLine(doc, section, context, state, template, totalPages); break;
    case 'signatureTable': renderSignatureTable(doc, section, context, state, template, totalPages); break;
    case 'notes': renderNotes(doc, section, context, state, template, totalPages); break;
    case 'benefitRiskColumns': renderBenefitRiskColumns(doc, section, context, state, template, totalPages); break;
    case 'declarantDetails': renderDeclarantDetails(doc, context, state, template, totalPages); break;
    case 'lamaStatement': renderLamaStatement(doc, section, context, state, template, totalPages); break;
    default: break;
  }
}

async function readLocalFile(filePath) {
  try { return filePath && fs.existsSync(filePath) ? await fs.promises.readFile(filePath) : null; } catch (_) { return null; }
}
async function fetchImageBuffer(urlOrData, options = {}) {
  if (!urlOrData || typeof urlOrData !== 'string') return null;
  const trimmed = urlOrData.trim(); const hospitalId = options.hospitalId || null;
  if (/^data:image\/(png|jpe?g);base64,/i.test(trimmed)) {
    try { return Buffer.from(trimmed.split(',')[1], 'base64'); } catch (_) { return null; }
  }
  const storedFileMatch = trimmed.match(/^\/?api\/files\/([a-fA-F0-9]{24})(?:[/?#]|$)/);
  if (storedFileMatch) {
    const filter = { _id: storedFileMatch[1], status: 'active' }; if (hospitalId) filter.hospitalId = hospitalId;
    const record = await StoredFile.findOne(filter).lean();
    return record ? readLocalFile(fileStorage.absolutePath(record.storageKey)) : null;
  }
  const printAssetMatch = trimmed.match(/^\/?api\/print-identities\/assets\/([a-fA-F0-9]{24})\/content(?:[/?#]|$)/);
  if (printAssetMatch) {
    const filter = { _id: printAssetMatch[1], status: { $ne: 'retired' } }; if (hospitalId) filter.hospitalId = hospitalId;
    const asset = await PrintIdentityAsset.findOne(filter).lean();
    if (!asset) return null;
    if (/^https?:\/\//i.test(String(asset.cloudinaryUrl || ''))) return fetchImageBuffer(asset.cloudinaryUrl, options);
    const localPath = path.isAbsolute(asset.storagePath || '') ? asset.storagePath : fileStorage.absolutePath(asset.storagePath || '');
    return readLocalFile(localPath);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return new Promise((resolve) => {
      const client = trimmed.startsWith('https://') ? https : http;
      client.get(trimmed, (response) => {
        if (response.statusCode !== 200) return resolve(null);
        const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    });
  }
  if (trimmed.startsWith('hospitals/')) return readLocalFile(fileStorage.absolutePath(trimmed));
  return fs.existsSync(trimmed) ? readLocalFile(trimmed) : null;
}
async function placementImageBuffers(documentSignature, imageOptions) {
  if (!documentSignature?.placements?.length) return new Map();
  const snapshots = new Map((documentSignature.assetSnapshots || []).map((snapshot) => [String(snapshot.assetId), snapshot]));
  const uniqueIds = [...new Set(documentSignature.placements.map((placement) => String(placement.assetId || '')).filter(Boolean))];
  const entries = await Promise.all(uniqueIds.map(async (assetId) => {
    const snapshot = snapshots.get(assetId); if (!snapshot) return [assetId, null];
    return [assetId, await fetchImageBuffer(snapshot.storagePath || snapshot.cloudinaryUrl, imageOptions)];
  }));
  return new Map(entries.filter(([, buffer]) => buffer));
}
function drawPlacementOverlays(doc, documentSignature, buffers, pageRange) {
  if (!documentSignature?.placements?.length || !buffers?.size) return;
  documentSignature.placements.forEach((placement) => {
    const pageNumber = Math.max(1, Number(placement.page || 1));
    if (pageNumber > pageRange.count) return;
    const image = buffers.get(String(placement.assetId || '')); if (!image) return;
    const width = Math.max(mm(2), Math.min(PAGE.width, Number(placement.width || 0.2) * PAGE.width));
    const height = Math.max(mm(2), Math.min(PAGE.height, Number(placement.height || 0.1) * PAGE.height));
    const x = Math.max(0, Math.min(PAGE.width - width, Number(placement.x || 0) * PAGE.width));
    const y = Math.max(0, Math.min(PAGE.height - height, Number(placement.y || 0) * PAGE.height));
    doc.switchToPage(pageRange.start + pageNumber - 1); doc.save();
    const rotation = Number(placement.rotation || 0); if (rotation) doc.rotate(rotation, { origin: [x + width / 2, y + height / 2] });
    try { doc.image(image, x, y, { fit: [width, height], align: 'center', valign: 'center' }); } catch (_) { /* skip invalid historical image */ }
    doc.restore();
  });
}

async function generateConsentPdf({ consent, template, admission, hospital, documentSignature = null, res }) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: false, info: { Creator: 'MediQliq HIMS', Title: template.name } });
  setupFonts(doc);
  const filename = `${admission.admissionNumber || admission.shipNumber || 'IPD'}-${template.id}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);

  const context = buildContext(consent, admission, hospital);
  const pages = Array.isArray(template.contentPages) && template.contentPages.length ? template.contentPages : [{ sections: template.printSections || [] }];
  const state = { y: 0, currentPage: 0, profile: layoutProfile(template) };
  pages.forEach((page, pageIndex) => {
    addNativePage(doc, template, context, state, pageIndex, pages.length, pageIndex === 0 || page.repeatPatientHeader === true);
    (page.sections || []).forEach((section) => renderSection(doc, section, context, state, template, pages.length));
  });

  const range = doc.bufferedPageRange();
  const buffers = await placementImageBuffers(documentSignature, { hospitalId: hospital?._id || admission?.hospitalId });
  drawPlacementOverlays(doc, documentSignature, buffers, range);
  doc.end();
}

module.exports = { generateConsentPdf };
