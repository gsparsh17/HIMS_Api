'use strict';

const PDFDocument = require('pdfkit');
const MRDBirthDeathRecord = require('../models/MRDBirthDeathRecord');
const MRDMedicalCertificate = require('../models/MRDMedicalCertificate');
const { getHospitalPrintIdentity } = require('./hospitalPrintIdentity.service');

// ============================================
// Helper Functions
// ============================================

function name(patient) {
  return [patient?.salutation, patient?.first_name, patient?.middle_name, patient?.last_name]
    .filter(Boolean)
    .join(' ') || '-';
}

function doctorName(doctor) {
  return [doctor?.firstName, doctor?.lastName]
    .filter(Boolean)
    .join(' ') || '-';
}

function formatDate(value, includeTime = false) {
  if (!value) return '-';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('en-IN', includeTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }
  );
}

// ============================================
// PDF Document Helpers
// ============================================

function createDocument(res, filename) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    bufferPages: true,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

  doc.pipe(res);

  return doc;
}

function renderHeader(doc, hospital, title) {
  const logoBuffer = hospital?._logoBuffer || hospital?.logoBuffer;
  const top = doc.y;
  if (logoBuffer) {
    try { doc.image(logoBuffer, 42, top, { fit: [48, 48], align: 'center', valign: 'center' }); } catch (_) { /* validated upstream */ }
  }
  const textX = logoBuffer ? 98 : 42;
  const textWidth = logoBuffer ? 455 : 510;

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .text(hospital.hospitalName, textX, top, { width: textWidth, align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(8)
    .text(hospital.hospitalAddress, textX, doc.y + 2, { width: textWidth, align: 'center' });

  if (hospital.hospitalContact) {
    doc.text(hospital.hospitalContact, textX, doc.y + 2, { width: textWidth, align: 'center' });
  }
  doc.y = Math.max(doc.y + 8, top + 52);
  doc.moveDown(0.3);

  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(title, { align: 'center' });

  doc.moveDown(1);
}

function renderRows(doc, pairs) {
  const startX = 50;
  const valueX = 205;
  const width = 340;

  pairs.forEach(([label, value]) => {
    const y = doc.y;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(label, startX, y, { width: 145 });

    doc
      .font('Helvetica')
      .fontSize(9)
      .text(String(value ?? '-'), valueX, y, { width });

    doc.moveDown(0.65);
  });
}

function renderFooter(doc) {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    doc
      .font('Helvetica')
      .fontSize(7)
      .text(
        `Page ${i - range.start + 1} of ${range.count}`,
        42,
        805,
        {
          align: 'right',
          width: 510,
        }
      );
  }
}

// ============================================
// Birth / Death PDF
// ============================================

async function birthDeathPdf({ res, hospitalId, id }) {
  const [hospital, row] = await Promise.all([
    getHospitalPrintIdentity({ includeLogoBuffer: true }),
    MRDBirthDeathRecord.findOne({ _id: id, hospitalId })
      .populate('patientId motherPatientId babyPatientId attendingDoctorId departmentId wardId bedId')
      .lean(),
  ]);

  if (!row) {
    const error = new Error('Birth/death record not found');
    error.statusCode = 404;
    throw error;
  }

  const title = row.recordType === 'birth' ? 'BIRTH RECORD' : 'DEATH RECORD';
  const doc = createDocument(res, `${row.recordNumber}.pdf`);

  renderHeader(doc, hospital, title);

  renderRows(doc, [
    ['Record No.', row.recordNumber],
    ['Event Date / Time', formatDate(row.eventDateTime, true)],
    ['Patient / Baby', name(row.babyPatientId || row.patientId)],
    ['Mother', name(row.motherPatientId)],
    ['UHID', (row.patientId || row.babyPatientId)?.uhid || (row.patientId || row.babyPatientId)?.patientId || '-'],
    ['Department', row.departmentId?.name || '-'],
    ['Attending Doctor', doctorName(row.attendingDoctorId)],
    ['Ward / Bed', [row.wardId?.name, row.bedId?.bedNumber].filter(Boolean).join(' / ') || '-'],
    ['Gender', row.gender || '-'],
    ['Birth Weight', row.birthWeightGrams ? `${row.birthWeightGrams} g` : '-'],
    ['Mode of Delivery', row.modeOfDelivery || '-'],
    ['Cause of Death', row.causeOfDeath || '-'],
    ['Underlying Cause', row.underlyingCause || '-'],
    ['MLC', row.isMlc ? `Yes${row.mlcNumber ? ` (${row.mlcNumber})` : ''}` : 'No'],
    ['Certificate No.', row.certificateNumber || '-'],
    ['Registration Status', row.registrationStatus || '-'],
  ]);

  doc.moveDown(2);

  doc.text(
    'Authorized MRD / Medical Officer Signature: ______________________________',
    { align: 'right' }
  );

  renderFooter(doc);
  doc.end();
}

// ============================================
// Certificate PDF
// ============================================

async function certificatePdf({ res, hospitalId, id }) {
  const [hospital, row] = await Promise.all([
    getHospitalPrintIdentity({ includeLogoBuffer: true }),
    MRDMedicalCertificate.findOne({ _id: id, hospitalId })
      .populate('patientId admissionId appointmentId authorizedByDoctorId')
      .lean(),
  ]);

  if (!row) {
    const error = new Error('Medical certificate not found');
    error.statusCode = 404;
    throw error;
  }

  const doc = createDocument(res, `${row.certificateNumber}.pdf`);

  renderHeader(doc, hospital, 'MEDICAL CERTIFICATE');

  doc
    .font('Helvetica')
    .fontSize(10)
    .text(
      `This is to certify that ${name(row.patientId)} (UHID: ${row.patientId?.uhid || row.patientId?.patientId || '-'}) was examined/treated at this hospital.`,
      { align: 'justify' }
    );

  doc.moveDown(1);

  renderRows(doc, [
    ['Certificate No.', row.certificateNumber],
    ['Certificate Type', String(row.certificateType || '').replace(/_/g, ' ')],
    ['Issue Date', formatDate(row.issueDate)],
    ['Valid From', formatDate(row.validFrom)],
    ['Valid To', formatDate(row.validTo)],
    ['Purpose', row.purpose || '-'],
    ['Clinical / Diagnosis Summary', row.diagnosisSummary || '-'],
    ['Remarks', row.remarks || '-'],
    ['Authorized Doctor', doctorName(row.authorizedByDoctorId)],
    ['Status', row.status],
  ]);

  doc.moveDown(3);

  doc
    .font('Helvetica')
    .fontSize(9)
    .text('Doctor / Authorized Signatory', 390, doc.y, {
      width: 150,
      align: 'center',
    });

  doc.moveDown(0.5);

  doc.text('Signature & Stamp', 390, doc.y, {
    width: 150,
    align: 'center',
  });

  renderFooter(doc);
  doc.end();
}

module.exports = {
  birthDeathPdf,
  certificatePdf,
};