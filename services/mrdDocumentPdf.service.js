'use strict';

const PDFDocument = require('pdfkit');
const Hospital = require('../models/Hospital');
const MRDBirthDeathRecord = require('../models/MRDBirthDeathRecord');
const MRDMedicalCertificate = require('../models/MRDMedicalCertificate');

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
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .text(hospital?.hospitalName || hospital?.name || 'HOSPITAL', { align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(8)
    .text(
      [hospital?.address, hospital?.city, hospital?.state, hospital?.pinCode]
        .filter(Boolean)
        .join(', '),
      { align: 'center' }
    );

  doc.moveDown(0.7);

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
    Hospital.findById(hospitalId).lean(),
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
    Hospital.findById(hospitalId).lean(),
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