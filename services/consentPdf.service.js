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
const PAGE = { width: mm(210), height: mm(297), margin: mm(8) };
const COLORS = { ink: '#111111', border: '#222222', muted: '#555555', fill: '#F5F5F5' };

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
function textHeight(doc, value, width, bold = false, size = 8, lineGap = 1.3) {
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

function drawDocumentHeader(doc, template, context, pageNumber, totalPages) {
  const x = PAGE.margin; const width = PAGE.width - PAGE.margin * 2; const top = PAGE.margin;
  box(doc, x, top, width, mm(24));
  text(doc, context.hospital.name, x + 6, top + 5, { width: width * 0.62, align: 'center' }, true, 11.5);
  text(doc, context.hospital.address, x + 6, top + 21, { width: width * 0.62, align: 'center' }, false, 6.5);
  const contact = [context.hospital.phone, context.hospital.email].filter(Boolean).join(' | ');
  if (contact) text(doc, contact, x + 6, top + 33, { width: width * 0.62, align: 'center' }, false, 6.2);
  line(doc, x + width * 0.64, top, x + width * 0.64, top + mm(24));
  text(doc, template.name, x + width * 0.65, top + 8, { width: width * 0.34, align: 'center' }, true, 11);
  if (template.bilingualName) text(doc, template.bilingualName, x + width * 0.65, top + 25, { width: width * 0.34, align: 'center' }, true, 9.5);
  text(doc, `Page ${pageNumber} of ${totalPages}`, x + width * 0.65, top + 45, { width: width * 0.34, align: 'center', color: COLORS.muted }, false, 5.8);
  return top + mm(25.5);
}
function drawPatientHeader(doc, context, y) {
  const x = PAGE.margin; const width = PAGE.width - PAGE.margin * 2; const row = 17;
  box(doc, x, y, width, row * 3);
  line(doc, x, y + row, x + width, y + row);
  line(doc, x, y + row * 2, x + width, y + row * 2);
  const columns = [0, 0.34, 0.55, 0.75, 1].map((ratio) => x + width * ratio);
  for (let index = 1; index < columns.length - 1; index += 1) line(doc, columns[index], y, columns[index], y + row * 2);
  const fields = [
    ['Patient Name / रोगी का नाम', context.patient.name, columns[0], columns[1] - columns[0]],
    ['Age / Gender / आयु / लिंग', context.patient.ageGender, columns[1], columns[2] - columns[1]],
    ['UHID', context.patient.uhid, columns[0], columns[1] - columns[0]],
    ['IPD', context.admission.number, columns[1], columns[2] - columns[1]],
    ['Ward / Bed No.', context.admission.wardBed, columns[2], columns[4] - columns[2]]
  ];
  fields.forEach(([label, value, left, cellWidth], index) => {
    const top = y + (index < 2 ? 0 : row);
    text(doc, `${label}:`, left + 4, top + 4, { width: cellWidth * 0.43 }, true, 6.5);
    text(doc, value, left + cellWidth * 0.43, top + 4, { width: cellWidth * 0.55, ellipsis: true }, false, 6.8);
  });
  text(doc, 'Diagnosis / डायग्नोसिस:', x + 4, y + row * 2 + 4, { width: width * 0.2 }, true, 6.5);
  text(doc, context.response.diagnosis || context.admission.diagnosis, x + width * 0.2, y + row * 2 + 4, { width: width * 0.79, ellipsis: true }, false, 6.8);
  return y + row * 3 + 7;
}
function addNativePage(doc, template, context, state, pageIndex, totalPages, includePatientHeader = true) {
  doc.addPage({ size: 'A4', margin: 0 });
  state.currentPage += 1;
  let y = drawDocumentHeader(doc, template, context, pageIndex + 1, totalPages);
  if (includePatientHeader) y = drawPatientHeader(doc, context, y);
  state.y = y;
}
function ensureSpace(doc, template, context, state, required, totalPages) {
  if (state.y + required <= PAGE.height - PAGE.margin - 18) return;
  addNativePage(doc, template, context, state, state.currentPage, totalPages, false);
  text(doc, `${template.name} - Continued`, PAGE.margin, state.y, { width: PAGE.width - PAGE.margin * 2, align: 'center' }, true, 8);
  state.y += 16;
}
function sectionHeading(doc, state, heading, headingHi, width) {
  const title = [clean(heading), clean(headingHi)].filter(Boolean).join(' / ');
  if (!title) return;
  box(doc, PAGE.margin, state.y, width, 18, COLORS.fill);
  text(doc, title, PAGE.margin + 5, state.y + 4, { width: width - 10 }, true, 7.8);
  state.y += 21;
}
function renderParagraph(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  const heading = interpolate(section.heading, context); const headingHi = interpolate(section.headingHi, context);
  const en = interpolate(section.en, context); const hi = interpolate(section.hi, context);
  const headingHeight = (heading || headingHi) ? 20 : 0;
  const bodyHeight = [en, hi].filter(Boolean).reduce((sum, value) => sum + textHeight(doc, value, width - 10, false, section.emphasis ? 7.4 : 7, 1.2) + 4, 0);
  ensureSpace(doc, template, context, state, headingHeight + bodyHeight + 8, totalPages);
  if (heading || headingHi) sectionHeading(doc, state, heading, headingHi, width);
  if (en) { text(doc, en, PAGE.margin + 5, state.y, { width: width - 10, lineGap: 1.2 }, Boolean(section.emphasis), section.emphasis ? 7.4 : 7); state.y += textHeight(doc, en, width - 10, Boolean(section.emphasis), section.emphasis ? 7.4 : 7, 1.2) + 4; }
  if (hi) { text(doc, hi, PAGE.margin + 5, state.y, { width: width - 10, lineGap: 1.2 }, Boolean(section.emphasis), section.emphasis ? 7.4 : 7); state.y += textHeight(doc, hi, width - 10, Boolean(section.emphasis), section.emphasis ? 7.4 : 7, 1.2) + 5; }
}
function renderList(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  ensureSpace(doc, template, context, state, 30, totalPages);
  sectionHeading(doc, state, interpolate(section.heading, context), interpolate(section.headingHi, context), width);
  (section.items || []).forEach((item, index) => {
    const prefix = section.ordered ? `${Number(section.start || 1) + index}.` : '•';
    const en = interpolate(item.en, context); const hi = interpolate(item.hi, context);
    const body = [en, hi].filter(Boolean).join('\n');
    const height = textHeight(doc, body, width - 28, false, 6.8, 1) + 5;
    ensureSpace(doc, template, context, state, height, totalPages);
    text(doc, prefix, PAGE.margin + 6, state.y, { width: 18 }, true, 6.8);
    text(doc, body, PAGE.margin + 24, state.y, { width: width - 30, lineGap: 1 }, false, 6.8);
    state.y += height;
  });
  state.y += 3;
}
function renderTwoColumnList(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2; const half = width / 2;
  const rows = section.items || [];
  const rowHeights = rows.map((item) => Math.max(textHeight(doc, interpolate(item.en, context), half - 22, false, 6.5, 1), textHeight(doc, interpolate(item.hi, context), half - 22, false, 6.5, 1)) + 8);
  const totalHeight = 22 + rowHeights.reduce((sum, value) => sum + value, 0);
  ensureSpace(doc, template, context, state, Math.min(totalHeight, PAGE.height / 2), totalPages);
  sectionHeading(doc, state, section.heading, section.headingHi, width);
  rows.forEach((item, index) => {
    const h = rowHeights[index];
    ensureSpace(doc, template, context, state, h, totalPages);
    box(doc, PAGE.margin, state.y, width, h);
    line(doc, PAGE.margin + half, state.y, PAGE.margin + half, state.y + h);
    text(doc, `${index + 1}. ${interpolate(item.en, context)}`, PAGE.margin + 5, state.y + 4, { width: half - 10, lineGap: 1 }, false, 6.5);
    text(doc, `${index + 1}. ${interpolate(item.hi, context)}`, PAGE.margin + half + 5, state.y + 4, { width: half - 10, lineGap: 1 }, false, 6.5);
    state.y += h;
  });
  state.y += 5;
}
function renderChoiceCards(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  (section.choices || []).forEach((choice) => {
    const selected = isSelected(context.response[section.responseKey], choice.value);
    const bodyLines = [
      `${choice.description || ''}${choice.descriptionHi ? ` / ${choice.descriptionHi}` : ''}`,
      `Benefits / लाभ: ${(choice.benefits || []).map((item) => `${item.en} / ${item.hi}`).join('; ')}`,
      `Risks / जोखिम: ${(choice.risks || []).map((item) => `${item.en} / ${item.hi}`).join('; ')}`
    ];
    const h = 28 + bodyLines.reduce((sum, value) => sum + textHeight(doc, value, width - 32, false, 6.4, 1), 0) + 10;
    ensureSpace(doc, template, context, state, h, totalPages);
    box(doc, PAGE.margin, state.y, width, h);
    check(doc, PAGE.margin + 7, state.y + 7, selected);
    text(doc, `${choice.title} / ${choice.titleHi}`, PAGE.margin + 20, state.y + 5, { width: width - 25 }, true, 7.5);
    let y = state.y + 24;
    bodyLines.forEach((lineValue, index) => {
      text(doc, lineValue, PAGE.margin + 8, y, { width: width - 16, lineGap: 1 }, index > 0, 6.4);
      y += textHeight(doc, lineValue, width - 16, index > 0, 6.4, 1) + 3;
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
    const y = state.y + row * 20;
    check(doc, x + 5, y + 3, isSelected(context.response[section.responseKey], choice.value));
    const suffix = choice.value === 'Other' && context.response[section.otherKey] ? `: ${context.response[section.otherKey]}` : '';
    text(doc, `${choice.en} / ${choice.hi}${suffix}`, x + 17, y + 1, { width: cellWidth - 20 }, false, 6.4);
  });
  state.y += 43;
  text(doc, `Blood Group / रक्त समूह: ${clean(context.response[section.groupKey], '________')}`, PAGE.margin + 5, state.y, { width: width / 2 }, true, 6.8);
  text(doc, `Rh Type: ${clean(context.response[section.rhKey], '________')}`, PAGE.margin + width / 2, state.y, { width: width / 2 - 5 }, true, 6.8);
  state.y += 20;
}
function renderResponseLine(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  ensureSpace(doc, template, context, state, 35, totalPages);
  text(doc, `${section.label} / ${section.labelHi}`, PAGE.margin + 3, state.y, { width }, true, 7.2);
  state.y += 13;
  const value = clean(valueFor(section.key, context), '');
  text(doc, value, PAGE.margin + 7, state.y, { width: width - 14, height: 28, ellipsis: true }, false, 7);
  line(doc, PAGE.margin + 5, state.y + 20, PAGE.margin + width - 5, state.y + 20);
  state.y += 28;
}
function renderClinicalDetails(doc, section, context, state, template, totalPages) {
  const width = PAGE.width - PAGE.margin * 2;
  ensureSpace(doc, template, context, state, 48, totalPages);
  const fields = section.fields || [];
  const cellWidth = width / 2;
  fields.forEach((field, index) => {
    const row = Math.floor(index / 2); const column = index % 2;
    const x = PAGE.margin + column * cellWidth; const y = state.y + row * 23;
    text(doc, `${field.label}:`, x + 4, y + 3, { width: cellWidth * 0.35 }, true, 6.4);
    text(doc, valueFor(field.key, context, field.source), x + cellWidth * 0.35, y + 3, { width: cellWidth * 0.62, ellipsis: true }, false, 6.5);
    line(doc, x + cellWidth * 0.35, y + 17, x + cellWidth - 5, y + 17, 0.4);
  });
  state.y += Math.ceil(fields.length / 2) * 23 + 4;
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
  const headerHeight = 28; const rowHeight = 45; const rows = section.roles || [];
  const totalHeight = headerHeight + rows.length * rowHeight;
  ensureSpace(doc, template, context, state, totalHeight + 5, totalPages);
  box(doc, PAGE.margin, state.y, width, totalHeight);
  columns.slice(1, -1).forEach((x) => line(doc, x, state.y, x, state.y + totalHeight));
  line(doc, PAGE.margin, state.y + headerHeight, PAGE.margin + width, state.y + headerHeight);
  const headers = ['Details Required\nआवश्यक विवरण', 'Name & Relation\nनाम एवं संबंध', 'Signature / thumb Impression (left)\nहस्ताक्षर / अंगूठे का निशान (बाएं)', 'Date & Time\nदिनांक एवं समय'];
  headers.forEach((header, index) => text(doc, header, columns[index] + 4, state.y + 4, { width: columns[index + 1] - columns[index] - 8, align: 'center' }, true, 6.1));
  rows.forEach((role, index) => {
    const top = state.y + headerHeight + index * rowHeight;
    if (index) line(doc, PAGE.margin, top, PAGE.margin + width, top);
    const labels = roleLabel(role); const values = roleValues(role, context);
    text(doc, labels.filter(Boolean).join('\n'), columns[0] + 4, top + 4, { width: columns[1] - columns[0] - 8 }, true, 6.1);
    text(doc, [values[0], values[1] ? `Relation: ${values[1]}` : ''].filter(Boolean).join('\n'), columns[1] + 4, top + 4, { width: columns[2] - columns[1] - 8 }, false, 6.2);
    text(doc, '', columns[2] + 4, top + 4, { width: columns[3] - columns[2] - 8 }, false, 6.2);
    text(doc, [values[2], values[3]].filter(Boolean).join(' '), columns[3] + 4, top + 4, { width: columns[4] - columns[3] - 8, align: 'center' }, false, 6.2);
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
    const h = Math.max(textHeight(doc, leftText, half - 12, false, 6.3, 1), textHeight(doc, rightText, half - 12, false, 6.3, 1)) + 8;
    rows.push([leftText, rightText, h]);
  }
  box(doc, PAGE.margin, state.y, width, 20, COLORS.fill);
  line(doc, PAGE.margin + half, state.y, PAGE.margin + half, state.y + 20);
  text(doc, 'Benefits / लाभ', PAGE.margin + 4, state.y + 5, { width: half - 8, align: 'center' }, true, 6.8);
  text(doc, 'Risks / जोखिम', PAGE.margin + half + 4, state.y + 5, { width: half - 8, align: 'center' }, true, 6.8);
  state.y += 20;
  rows.forEach(([leftText, rightText, h]) => {
    ensureSpace(doc, template, context, state, h, totalPages);
    box(doc, PAGE.margin, state.y, width, h);
    line(doc, PAGE.margin + half, state.y, PAGE.margin + half, state.y + h);
    text(doc, leftText, PAGE.margin + 5, state.y + 4, { width: half - 10, lineGap: 1 }, false, 6.3);
    text(doc, rightText, PAGE.margin + half + 5, state.y + 4, { width: half - 10, lineGap: 1 }, false, 6.3);
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
      text(doc, section.en, PAGE.margin, state.y, { width: PAGE.width - PAGE.margin * 2, align: 'center' }, true, 6.5); state.y += 17; break;
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
  const state = { y: 0, currentPage: 0 };
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
