const PDFDocument = require('pdfkit');

const mm = (value) => value * 2.834645669;
const PAGE = { width: mm(210), height: mm(297), margin: mm(12) };
const COLORS = { ink: '#0f172a', muted: '#475569', border: '#cbd5e1', blue: '#1d4ed8', pale: '#eff6ff', white: '#ffffff' };

const clean = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  const result = String(value)
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return result || fallback;
};

const fullName = (person = {}) => [
  person.salutation,
  person.first_name || person.firstName,
  person.middle_name || person.middleName,
  person.last_name || person.lastName
].filter(Boolean).join(' ').trim();

const formatDate = (value, withTime = false) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-IN', withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date);
};

const age = (dob) => {
  if (!dob) return '-';
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return '-';
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  if (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate())) years -= 1;
  return `${Math.max(0, years)} years`;
};

function ensureSpace(doc, height, redrawHeader) {
  if (doc.y + height < PAGE.height - PAGE.margin - mm(12)) return;
  doc.addPage();
  redrawHeader?.();
}

function drawHeader(doc, hospital, request, report) {
  const width = PAGE.width - PAGE.margin * 2;
  const hospitalName = clean(hospital?.hospitalName || hospital?.name, 'HOSPITAL');
  const address = [hospital?.address, hospital?.city, hospital?.state, hospital?.pinCode].filter(Boolean).join(', ');
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(16).text(hospitalName.toUpperCase(), PAGE.margin, PAGE.margin, { width: width - mm(60) });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(address, PAGE.margin, PAGE.margin + mm(7), { width: width - mm(60) });
  doc.roundedRect(PAGE.width - PAGE.margin - mm(54), PAGE.margin, mm(54), mm(14), 2)
    .fillAndStroke(COLORS.pale, COLORS.blue);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(11).text('RADIOLOGY REPORT', PAGE.width - PAGE.margin - mm(54), PAGE.margin + mm(4), { width: mm(54), align: 'center' });
  doc.rect(PAGE.margin, PAGE.margin + mm(18), width, mm(4)).fill(COLORS.blue);
  doc.y = PAGE.margin + mm(26);

  const patient = request.patientId || {};
  const doctor = request.doctorId || {};
  const left = PAGE.margin;
  const y = doc.y;
  const col = width / 3;
  const height = mm(25);
  doc.rect(left, y, width, height).lineWidth(0.6).strokeColor(COLORS.border).stroke();
  doc.moveTo(left + col, y).lineTo(left + col, y + height).stroke();
  doc.moveTo(left + col * 2, y).lineTo(left + col * 2, y + height).stroke();

  const label = (x, yy, name, value, valueWidth = col - mm(25)) => {
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.5).text(`${name}:`, x, yy, { width: mm(22), lineBreak: false });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7).text(clean(value, '-'), x + mm(22), yy, { width: valueWidth, height: mm(5), ellipsis: true });
  };
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text(fullName(patient) || clean(request.patientName, '-'), left + 4, y + 4, { width: col - 8, ellipsis: true });
  label(left + 4, y + mm(7), 'UHID', patient.patientId || patient.uhid || patient._id);
  label(left + 4, y + mm(12), 'Age / Sex', `${age(patient.dob)} / ${clean(patient.gender, '-').toUpperCase()}`);
  label(left + 4, y + mm(17), 'Mobile', patient.phone || patient.mobile);

  label(left + col + 4, y + mm(2), 'Request No.', request.requestNumber);
  label(left + col + 4, y + mm(7), 'Ref. By', fullName(doctor) ? `Dr. ${fullName(doctor)}` : '-');
  label(left + col + 4, y + mm(12), 'Source', request.sourceType);
  label(left + col + 4, y + mm(17), 'Priority', request.priority);

  label(left + col * 2 + 4, y + mm(2), 'Registered', formatDate(request.requestedDate || request.createdAt, true));
  label(left + col * 2 + 4, y + mm(7), 'Performed', formatDate(request.performedAt, true));
  label(left + col * 2 + 4, y + mm(12), 'Reported', formatDate(report.reportedAt || request.reportedAt, true));
  label(left + col * 2 + 4, y + mm(17), 'Category', request.category);

  doc.y = y + height + mm(4);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(13).text(clean(report.templateName || request.testName, 'RADIOLOGY REPORT').toUpperCase(), PAGE.margin, doc.y, { width, align: 'center' });
  doc.moveTo(PAGE.margin, doc.y + 2).lineTo(PAGE.width - PAGE.margin, doc.y + 2).strokeColor(COLORS.border).lineWidth(0.5).stroke();
  doc.y += mm(5);
}

function drawSection(doc, label, value, redrawHeader) {
  const text = clean(value);
  if (!text) return;
  ensureSpace(doc, mm(16), redrawHeader);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2 });
  doc.y += 2;
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(text, PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2, lineGap: 2 });
  doc.y += mm(3);
}

function drawTable(doc, table, redrawHeader) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  if (!columns.length || !rows.length) return;
  ensureSpace(doc, mm(24), redrawHeader);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9).text(clean(table.label, 'Table').toUpperCase(), PAGE.margin, doc.y);
  doc.y += mm(2);
  const width = PAGE.width - PAGE.margin * 2;
  const cellWidth = width / columns.length;
  const rowHeight = mm(8);
  const drawRow = (items, isHeader = false) => {
    ensureSpace(doc, rowHeight + 2, redrawHeader);
    const y = doc.y;
    items.forEach((item, index) => {
      const x = PAGE.margin + index * cellWidth;
      doc.rect(x, y, cellWidth, rowHeight).fillAndStroke(isHeader ? COLORS.pale : COLORS.white, COLORS.border);
      doc.fillColor(COLORS.ink).font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).text(clean(item, '-'), x + 3, y + 3, { width: cellWidth - 6, height: rowHeight - 4, ellipsis: true });
    });
    doc.y = y + rowHeight;
  };
  drawRow(columns, true);
  rows.forEach((row) => drawRow(Array.isArray(row) ? row : columns.map((column) => row?.[column] || '')));
  doc.y += mm(3);
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

async function drawImages(doc, images, redrawHeader) {
  const valid = Array.isArray(images) ? images.filter((image) => image?.url) : [];
  if (!valid.length) return;
  ensureSpace(doc, mm(20), redrawHeader);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9).text('ATTACHED IMAGES', PAGE.margin, doc.y);
  doc.y += mm(3);
  for (const image of valid) {
    let buffer = null;
    try { buffer = await fetchImageBuffer(image.url); } catch (_) { buffer = null; }
    if (!buffer) continue;
    ensureSpace(doc, mm(85), redrawHeader);
    const y = doc.y;
    try {
      doc.image(buffer, PAGE.margin, y, { fit: [PAGE.width - PAGE.margin * 2, mm(78)], align: 'center', valign: 'center' });
      doc.y = y + mm(79);
      if (image.caption) {
        doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(7).text(image.caption, PAGE.margin, doc.y, { width: PAGE.width - PAGE.margin * 2, align: 'center' });
        doc.y += mm(5);
      }
    } catch (_) {
      // Ignore unsupported image encodings in generated preview.
    }
  }
}

function addFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const y = PAGE.height - PAGE.margin - mm(5);
    doc.moveTo(PAGE.margin, y - 3).lineTo(PAGE.width - PAGE.margin, y - 3).strokeColor(COLORS.border).lineWidth(0.4).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5).text('Generated by MediQliq HIMS', PAGE.margin, y, { width: mm(70) });
    doc.text(`Page ${index - range.start + 1} of ${range.count}`, PAGE.width - PAGE.margin - mm(35), y, { width: mm(35), align: 'right' });
  }
}

async function generateRadiologyReportPdf({ request, hospital, res }) {
  const report = request.manual_report?.toObject?.() || request.manual_report || {};
  const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin }, bufferPages: true, info: { Creator: 'MediQliq HIMS' } });
  const filename = `${clean(request.requestNumber, 'radiology-report')}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);
  const redrawHeader = () => drawHeader(doc, hospital, request, report);
  redrawHeader();
  for (const section of report.sections || []) drawSection(doc, section.label, section.text, redrawHeader);
  for (const table of report.tables || []) drawTable(doc, table, redrawHeader);
  await drawImages(doc, report.images, redrawHeader);
  const signY = doc.y;
  ensureSpace(doc, mm(25), redrawHeader);
  doc.y = Math.max(doc.y, signY);
  doc.moveTo(PAGE.margin, doc.y + mm(12)).lineTo(PAGE.margin + mm(55), doc.y + mm(12)).strokeColor(COLORS.border).stroke();
  doc.moveTo(PAGE.width - PAGE.margin - mm(55), doc.y + mm(12)).lineTo(PAGE.width - PAGE.margin, doc.y + mm(12)).stroke();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(clean(report.technicianName, 'Radiologic Technologist'), PAGE.margin, doc.y + mm(14), { width: mm(55), align: 'center' });
  doc.text(clean(report.radiologistName, 'Radiologist'), PAGE.width - PAGE.margin - mm(55), doc.y + mm(14), { width: mm(55), align: 'center' });
  addFooters(doc);
  doc.end();
}

module.exports = { generateRadiologyReportPdf };
