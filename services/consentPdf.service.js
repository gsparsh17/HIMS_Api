const PDFDocument = require('pdfkit');

const mm = (value) => value * 2.834645669;
const PAGE = { width: mm(210), height: mm(297), margin: mm(12) };
const COLORS = { ink: '#111827', muted: '#475569', border: '#94a3b8', pale: '#f8fafc', blue: '#1f5f9f', white: '#ffffff' };

const clean = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.filter(Boolean).join(', ') || fallback;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const output = String(value)
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return output || fallback;
};

const fullName = (person = {}) => [person.first_name || person.firstName, person.middle_name || person.middleName, person.last_name || person.lastName].filter(Boolean).join(' ').trim();
const formatDate = (value, withTime = false) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value, '-');
  return new Intl.DateTimeFormat('en-IN', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
};
const calculateAge = (dob) => {
  if (!dob) return '-';
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return '-';
  const now = new Date();
  let years = now.getFullYear() - date.getFullYear();
  if (now < new Date(now.getFullYear(), date.getMonth(), date.getDate())) years -= 1;
  return `${Math.max(0, years)} years`;
};

function ensure(doc, height, header) {
  if (doc.y + height < PAGE.height - PAGE.margin - mm(12)) return;
  doc.addPage();
  header();
}

function drawHeader(doc, hospital, admission, template) {
  const width = PAGE.width - PAGE.margin * 2;
  const patient = admission.patientId || {};
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(15).text(clean(hospital?.hospitalName || hospital?.name, 'HOSPITAL').toUpperCase(), PAGE.margin, PAGE.margin, { width: width - mm(65) });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text([hospital?.address, hospital?.city, hospital?.state, hospital?.pinCode].filter(Boolean).join(', '), PAGE.margin, PAGE.margin + mm(7), { width: width - mm(65) });
  doc.roundedRect(PAGE.width - PAGE.margin - mm(62), PAGE.margin, mm(62), mm(17), 2).fillAndStroke('#eef6ff', COLORS.blue);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(9.5).text(template.name, PAGE.width - PAGE.margin - mm(60), PAGE.margin + mm(3), { width: mm(58), align: 'center', height: mm(8), ellipsis: true });
  doc.font('Helvetica').fontSize(7).text(clean(template.bilingualName || ''), PAGE.width - PAGE.margin - mm(60), PAGE.margin + mm(10.5), { width: mm(58), align: 'center', height: mm(5), ellipsis: true });
  doc.rect(PAGE.margin, PAGE.margin + mm(21), width, mm(4)).fill(COLORS.blue);
  doc.y = PAGE.margin + mm(29);

  const y = doc.y;
  const rowH = mm(18);
  doc.rect(PAGE.margin, y, width, rowH).strokeColor(COLORS.border).lineWidth(0.5).stroke();
  const col = width / 4;
  for (let i = 1; i < 4; i += 1) doc.moveTo(PAGE.margin + col * i, y).lineTo(PAGE.margin + col * i, y + rowH).stroke();
  const cell = (index, label, value) => {
    const x = PAGE.margin + col * index + 4;
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.5).text(label, x, y + 4, { width: col - 8 });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8).text(clean(value, '-'), x, y + mm(6), { width: col - 8, height: mm(9), ellipsis: true });
  };
  cell(0, 'Patient Name', fullName(patient));
  cell(1, 'UHID / IPD', `${clean(patient.patientId || patient.uhid)} / ${clean(admission.admissionNumber)}`);
  cell(2, 'Age / Gender', `${calculateAge(patient.dob)} / ${clean(patient.gender, '-')}`);
  cell(3, 'Ward / Bed', `${clean(admission.wardId?.name || admission.wardId)} / ${clean(admission.bedId?.bedNumber || admission.bedId)}`);
  doc.y = y + rowH + mm(4);
}

function addFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const y = PAGE.height - PAGE.margin - mm(5);
    doc.moveTo(PAGE.margin, y - 3).lineTo(PAGE.width - PAGE.margin, y - 3).strokeColor(COLORS.border).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6).text('MediQliq HIMS - IPD Consent Record', PAGE.margin, y, { width: mm(90) });
    doc.text(`Page ${index - range.start + 1} of ${range.count}`, PAGE.width - PAGE.margin - mm(35), y, { width: mm(35), align: 'right' });
  }
}

function generateConsentPdf({ consent, template, admission, hospital, res }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin }, bufferPages: true, info: { Creator: 'MediQliq HIMS' } });
  const filename = `${admission.admissionNumber || 'IPD'}-${template.id}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);
  const header = () => drawHeader(doc, hospital, admission, template);
  header();

  if (admission.provisionalDiagnosis || admission.finalDiagnosis) {
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text('Diagnosis:', PAGE.margin, doc.y, { width: mm(22), continued: true });
    doc.font('Helvetica').text(` ${clean(admission.finalDiagnosis || admission.provisionalDiagnosis)}`, { width: PAGE.width - PAGE.margin * 2 - mm(22) });
    doc.y += mm(3);
  }

  for (const block of template.printSections || []) {
    ensure(doc, mm(20), header);
    doc.rect(PAGE.margin, doc.y, PAGE.width - PAGE.margin * 2, mm(7)).fill(COLORS.pale);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9).text(clean(block.title).replace(/\s*\/\s*$/, ''), PAGE.margin + 4, doc.y + 4, { width: PAGE.width - PAGE.margin * 2 - 8 });
    doc.y += mm(9);
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8.5).text(clean(block.text), PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2, lineGap: 2 });
    doc.y += mm(4);
  }

  ensure(doc, mm(18), header);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(10).text('FORM RESPONSES', PAGE.margin, doc.y);
  doc.y += mm(4);
  const responses = consent.responses || {};
  for (const field of template.fields || []) {
    const value = responses[field.key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    ensure(doc, mm(12), header);
    const y = doc.y;
    doc.rect(PAGE.margin, y, PAGE.width - PAGE.margin * 2, mm(10)).strokeColor(COLORS.border).lineWidth(0.35).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.8).text(field.label, PAGE.margin + 4, y + 3, { width: mm(68), height: mm(8), ellipsis: true });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.8).text(clean(value, '-'), PAGE.margin + mm(72), y + 3, { width: PAGE.width - PAGE.margin * 2 - mm(76), height: mm(8), ellipsis: true });
    doc.y = y + mm(10);
  }

  ensure(doc, mm(34), header);
  doc.y += mm(5);
  const signatories = [
    ['Patient / Representative', responses.patientOrRepresentativeName || responses.requestingPersonName || responses.guardianName],
    ['Doctor', responses.doctorName],
    ['Witness', responses.witnessName],
    ['Interpreter', responses.interpreterName]
  ];
  const width = PAGE.width - PAGE.margin * 2;
  const col = width / 4;
  const y = doc.y;
  signatories.forEach(([role, name], index) => {
    const x = PAGE.margin + index * col;
    doc.moveTo(x + 3, y + mm(13)).lineTo(x + col - 3, y + mm(13)).strokeColor(COLORS.border).stroke();
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7).text(clean(name, ' '), x + 3, y + mm(14), { width: col - 6, align: 'center', height: mm(5), ellipsis: true });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5).text(role, x + 3, y + mm(19), { width: col - 6, align: 'center' });
  });
  doc.y = y + mm(25);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(`Consent status: ${consent.status} | Recorded: ${formatDate(consent.completedAt || consent.updatedAt, true)}`, PAGE.margin, doc.y, { width, align: 'right' });
  addFooters(doc);
  doc.end();
}

module.exports = { generateConsentPdf };
