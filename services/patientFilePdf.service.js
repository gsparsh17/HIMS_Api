const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const OTRequest = require('../models/OTRequest');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const Hospital = require('../models/Hospital');
const DocumentSignature = require('../models/DocumentSignature');
const { renderOtFormPdf } = require('./otFormPdf.service');
const { generateLabReportPdf } = require('./clinicalPdf.service');
const { generateRadiologyReportPdf } = require('./radiologyPdf.service');
const { renderClinicalPatientFileDocument } = require('./clinicalPatientFilePdf.service');
const { PDFDocument: PDFLibDocument, degrees } = require('pdf-lib');

const hidden = new Set(['_id', '__v', 'hospitalId', 'hospital_id', 'patientId', 'admissionId', 'createdBy', 'updatedBy']);

class PdfBufferResponse extends Writable {
  constructor(resolve, reject) {
    super();
    this.chunks = [];
    this.headers = {};
    this.on('finish', () => resolve(Buffer.concat(this.chunks)));
    this.on('error', reject);
  }
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
  setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; }
  getHeader(name) { return this.headers[String(name).toLowerCase()]; }
}

function collectPipedPdf(render) {
  return new Promise((resolve, reject) => {
    const res = new PdfBufferResponse(resolve, reject);
    Promise.resolve(render(res)).catch(reject);
  });
}

function collectPdf(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 38, bufferPages: true, info: { Producer: 'HIMS Patient File Renderer' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Promise.resolve(build(doc)).then(() => {
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(i);
        doc.font('Helvetica').fontSize(7).fillColor('#64748b').text(`Page ${i + 1} of ${range.count}`, 38, 808, { width: 519, align: 'right' });
      }
      doc.end();
    }).catch(reject);
  });
}

function display(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return value.toLocaleString('en-IN');
  if (Array.isArray(value)) return value.map((item) => display(item)).filter((item) => item !== '—').join('; ');
  if (typeof value === 'object') return Object.entries(value)
    .filter(([key, item]) => !hidden.has(key) && item !== null && item !== undefined && item !== '')
    .map(([key, item]) => `${key.replace(/[_-]/g, ' ')}: ${display(item)}`).join('; ');
  return String(value);
}

function flattenContent(value, prefix = '', depth = 0, output = []) {
  if (value === null || value === undefined || value === '' || depth > 5) return output;
  if (Array.isArray(value)) {
    if (!value.length) return output;
    if (value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      output.push([prefix || 'Details', value.map(display).join(', ')]);
    } else {
      value.forEach((item, index) => flattenContent(item, `${prefix || 'Entry'} ${index + 1}`, depth + 1, output));
    }
    return output;
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    Object.entries(value).forEach(([key, item]) => {
      if (hidden.has(key) || item === null || item === undefined || item === '') return;
      const label = key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      flattenContent(item, prefix ? `${prefix} / ${label}` : label, depth + 1, output);
    });
    return output;
  }
  output.push([prefix || 'Details', display(value)]);
  return output;
}

function patientName(patient = {}) { return patient.name || [patient.first_name, patient.last_name].filter(Boolean).join(' ') || '—'; }
function header(doc, manifest, title) {
  const admission = manifest.admission || {}; const patient = admission.patient || {};
  doc.save().strokeColor('#0f172a').lineWidth(1).rect(38, 36, 519, 75).stroke();
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a').text('HOSPITAL INFORMATION MANAGEMENT SYSTEM', 48, 46, { width: 499, align: 'center' });
  doc.fontSize(11).text(title, 48, 69, { width: 499, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).text(`Patient: ${patientName(patient)} | UHID: ${patient.uhid || patient.patient_id || '—'} | IPD: ${admission.admissionNumber || admission.shipNumber || admission.id || '—'} | Age/Sex: ${patient.age || '—'} / ${patient.gender || '—'}`, 48, 91, { width: 499, align: 'center' });
  doc.restore(); doc.y = 124;
}

async function renderCoverAndIndex(manifest, documents, packetType, signatures = []) {
  return collectPdf(async (doc) => {
    const admission = manifest.admission || {}; const patient = admission.patient || {};
    header(doc, manifest, `${String(packetType || 'clinical').toUpperCase()} PATIENT FILE`);
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#0f172a').text('Complete Encounter Document Bundle', { align: 'center' });
    doc.moveDown().font('Helvetica').fontSize(9).fillColor('#334155').text(`Patient: ${patientName(patient)}`, { align: 'center' });
    doc.text(`UHID: ${patient.uhid || patient.patient_id || '—'} | IPD: ${admission.admissionNumber || admission.shipNumber || admission.id || '—'}`, { align: 'center' });
    doc.moveDown(2).fontSize(8).fillColor('#475569').text(`${documents.length} documents selected. Generated ${new Date().toLocaleString('en-IN')}. Source revisions and document keys are frozen in the rendered-document metadata.`, { align: 'center' });
    if (signatures.length) {
      const signature = signatures[0]; const assets = signature.assetSnapshots || [];
      const sig = assets.find((asset) => asset.assetType === 'signature'); const seal = assets.find((asset) => asset.assetType === 'seal');
      const y = 610; doc.save().strokeColor('#0f172a').rect(310, y, 247, 125).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text('AUTHORIZED DIGITAL SIGNATURE / SEAL', 320, y + 10, { width: 227, align: 'center' });
      if (!Array.isArray(signature.placements) || signature.placements.length === 0) {
        if (sig?.storagePath && fs.existsSync(sig.storagePath)) { try { doc.image(sig.storagePath, 325, y + 35, { fit: [120, 45] }); } catch {} }
        if (seal?.storagePath && fs.existsSync(seal.storagePath)) { try { doc.image(seal.storagePath, 460, y + 30, { fit: [70, 55] }); } catch {} }
      }
      doc.font('Helvetica').fontSize(7).text(`${signature.signerName || 'Authorized signatory'} · ${signature.signatoryRole || signature.signerRole || ''}`, 320, y + 88, { width: 227, align: 'center' });
      doc.text(`${new Date(signature.signedAt).toLocaleString('en-IN')} · Verify ${signature.verificationCode || '—'}`, 320, y + 102, { width: 227, align: 'center' });
    } else {
      doc.font('Helvetica').fontSize(8).fillColor('#64748b').text('UNSIGNED BUNDLE PREVIEW', 38, 690, { width: 519, align: 'center' });
    }
    doc.addPage(); header(doc, manifest, 'DOCUMENT INDEX');
    documents.forEach((item, index) => {
      if (doc.y > 770) { doc.addPage(); header(doc, manifest, 'DOCUMENT INDEX (CONTINUED)'); }
      doc.font('Helvetica').fontSize(8).fillColor('#111827').text(`${String(index + 1).padStart(2, '0')}. ${item.title}`, { continued: true, width: 420 });
      doc.fillColor('#475569').text(`${item.category} · ${item.status}`, { align: 'right' });
      doc.moveDown(0.25);
    });
  });
}

async function renderGenericDocument(manifest, item) {
  return collectPdf(async (doc) => {
    const renderHeader = (continued = false) => {
      header(doc, manifest, `${item.title || 'Clinical Document'}${continued ? ' (continued)' : ''}`);
      doc.font('Helvetica').fontSize(7.2).fillColor('#475569')
        .text(`${item.category || ''} · ${item.status || ''} · Source ${item.sourceModel || '—'} revision ${item.sourceRevision || 1}`);
      doc.moveDown(0.45);
    };
    renderHeader();
    const content = item.content || item.metadata || {};
    const entries = flattenContent(content).filter(([, value]) => value !== '—');
    if (!entries.length) {
      doc.fontSize(8.5).fillColor('#64748b').text('No structured source content is available in this record. Refer to the secured linked report or attachment in the HIMS.');
    } else {
      for (const [key, value] of entries) {
        const valueHeight = doc.font('Helvetica').fontSize(7.2).heightOfString(String(value), { width: 501, lineGap: 1 });
        const rowHeight = Math.max(24, valueHeight + 19);
        if (doc.y + rowHeight > 785) { doc.addPage(); renderHeader(true); }
        const top = doc.y;
        doc.save().strokeColor('#cbd5e1').lineWidth(0.5).rect(38, top, 519, rowHeight).stroke();
        doc.font('Helvetica-Bold').fontSize(7.4).fillColor('#0f172a').text(key, 44, top + 4, { width: 507 });
        doc.font('Helvetica').fontSize(7.2).fillColor('#111827').text(String(value), 44, top + 15, { width: 501, lineGap: 1 });
        doc.y = top + rowHeight + 3;
      }
    }
    if (item.signature) {
      if (doc.y > 750) { doc.addPage(); renderHeader(true); }
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(7.5).fillColor('#166534')
        .text(`Digitally signed by ${item.signature.signerName || 'Authorized user'} on ${new Date(item.signature.signedAt).toLocaleString('en-IN')} · Verification ${item.signature.verificationCode || '—'}`);
    }
  });
}

function localPdfFromUrl(fileUrl) {
  if (!fileUrl || !String(fileUrl).toLowerCase().includes('.pdf')) return null;
  const clean = String(fileUrl).split('?')[0];
  const candidates = [clean, clean.replace(/^\/?api\//, ''), clean.replace(/^\/?uploads\//, 'uploads/')].map((value) => path.resolve(value));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

async function remoteFileFromUrl(fileUrl, expected = 'pdf') {
  if (!fileUrl || !/^https?:\/\//i.test(String(fileUrl))) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(String(fileUrl), { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 25 * 1024 * 1024) return null;
    if (expected === 'pdf' && !type.includes('pdf') && !/\.pdf(?:\?|$)/i.test(String(fileUrl))) return null;
    if (expected === 'image' && !type.startsWith('image/') && !/\.(png|jpe?g|webp)(?:\?|$)/i.test(String(fileUrl))) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length <= 25 * 1024 * 1024 ? bytes : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function otExactDocument(item, hospitalId) {
  if (!item.formTemplate || !item.relatedCaseId || !item.sourceId) return null;
  const otCase = await OTRequest.findOne({ _id: item.relatedCaseId, hospitalId }).populate('patientId').populate('admissionId').lean();
  if (!otCase) return null;
  const sourceModel = item.sourceModel === 'OTClinicalForm' ? 'OTClinicalForm' : item.sourceModel;
  const signatures = await DocumentSignature.find({ hospitalId, sourceModel, sourceId: item.sourceId, status: 'signed' }).sort({ signedAt: 1 }).lean();
  return renderOtFormPdf({ template: item.formTemplate, record: item.content, otCase, signatures });
}

async function generatedLabReport(item, hospitalId) {
  if (item.sourceModel !== 'LabRequest' || !item.sourceId) return null;
  const request = await LabRequest.findOne({ _id: item.sourceId, hospitalId })
    .populate('patientId', 'first_name last_name patientId uhid dob gender phone address')
    .populate('doctorId', 'firstName lastName first_name last_name specialization department')
    .populate('admissionId', 'admissionNumber hospitalId')
    .populate('appointmentId', 'token')
    .populate({ path: 'prescriptionId', select: 'appointment_id', populate: { path: 'appointment_id', select: 'token' } });
  if (!request || request.report_mode !== 'manual' || !request.manual_report) return null;
  const hospital = await Hospital.findById(hospitalId).lean();
  return collectPipedPdf((res) => generateLabReportPdf({ res, request, hospital }));
}

async function generatedRadiologyReport(item, hospitalId) {
  if (item.sourceModel !== 'RadiologyRequest' || !item.sourceId) return null;
  const request = await RadiologyRequest.findOne({ _id: item.sourceId, hospitalId })
    .populate('patientId')
    .populate('doctorId')
    .populate('admissionId', 'admissionNumber hospitalId')
    .populate('appointmentId', 'token')
    .populate({ path: 'prescriptionId', select: 'appointment_id', populate: { path: 'appointment_id', select: 'token' } });
  if (!request || request.report_mode !== 'manual' || !request.manual_report) return null;
  const hospital = await Hospital.findById(hospitalId).lean();
  if (!hospital) return null;
  return collectPipedPdf((res) => generateRadiologyReportPdf({ request, hospital, res }));
}

function localImageFromUrl(fileUrl) {
  if (!fileUrl || !/\.(png|jpe?g|webp)(?:\?|$)/i.test(String(fileUrl))) return null;
  const clean = String(fileUrl).split('?')[0];
  const candidates = [clean, clean.replace(/^\/?api\//, ''), clean.replace(/^\/?uploads\//, 'uploads/')].map((value) => path.resolve(value));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

async function renderImageAttachment(manifest, item, imageSource) {
  return collectPdf(async (doc) => {
    header(doc, manifest, item.title || 'Clinical Attachment');
    try {
      doc.image(imageSource, 38, 128, { fit: [519, 640], align: 'center', valign: 'center' });
    } catch {
      doc.fontSize(9).text('The attached image could not be rendered.');
    }
  });
}

async function applyPdfSignaturePlacements(buffer, signatures = []) {
  const hasPlacements = signatures.some((signature) => Array.isArray(signature.placements) && signature.placements.length);
  if (!hasPlacements) return buffer;
  const pdf = await PDFLibDocument.load(buffer);
  const pages = pdf.getPages();
  for (const signature of signatures) {
    const assets = new Map((signature.assetSnapshots || []).map((asset) => [String(asset.assetId), asset]));
    for (const placement of signature.placements || []) {
      const pageIndex = Math.max(0, Number(placement.page || 1) - 1);
      if (!pages[pageIndex]) continue;
      const asset = assets.get(String(placement.assetId)) || (signature.assetSnapshots || []).find((item) => item.assetType === placement.assetType);
      if (!asset?.storagePath || !fs.existsSync(asset.storagePath)) continue;
      const bytes = fs.readFileSync(asset.storagePath);
      let image;
      try {
        if (String(asset.mimeType || '').includes('png') || String(asset.storagePath).toLowerCase().endsWith('.png')) image = await pdf.embedPng(bytes);
        else image = await pdf.embedJpg(bytes);
      } catch {
        continue;
      }
      const page = pages[pageIndex];
      const { width: pageWidth, height: pageHeight } = page.getSize();
      const width = Math.max(1, Number(placement.width || 0.2) * pageWidth);
      const height = Math.max(1, Number(placement.height || 0.1) * pageHeight);
      const x = Number(placement.x || 0) * pageWidth;
      const yFromTop = Number(placement.y || 0) * pageHeight;
      page.drawImage(image, {
        x,
        y: pageHeight - yFromTop - height,
        width,
        height,
        rotate: degrees(Number(placement.rotation || 0)),
        opacity: 1,
      });
    }
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function mergePdfBuffers(buffers) {
  const merged = await PDFLibDocument.create();
  for (const buffer of buffers) {
    if (!buffer?.length) continue;
    try {
      const source = await PDFLibDocument.load(buffer, { ignoreEncryption: true });
      const pages = await merged.copyPages(source, source.getPageIndices());
      pages.forEach((page) => merged.addPage(page));
    } catch (error) {
      // A corrupt external attachment must not prevent the remaining patient file from rendering.
      console.warn('Skipping unreadable PDF while building patient file:', error.message);
    }
  }
  return Buffer.from(await merged.save({ useObjectStreams: false }));
}

async function renderPatientFilePdf({ manifest, documents, packetType, hospitalId, signatures = [] }) {
  const buffers = [await renderCoverAndIndex(manifest, documents, packetType, signatures)];
  const hospital = await Hospital.findById(hospitalId).lean().catch(() => null);
  for (const item of documents) {
    let buffer = await otExactDocument(item, hospitalId).catch(() => null);
    if (!buffer) buffer = await generatedLabReport(item, hospitalId).catch(() => null);
    if (!buffer) buffer = await generatedRadiologyReport(item, hospitalId).catch(() => null);
    if (!buffer) buffer = await renderClinicalPatientFileDocument({ manifest, item, hospital }).catch(() => null);
    if (!buffer) {
      const local = localPdfFromUrl(item.fileUrl);
      if (local) buffer = fs.readFileSync(local);
    }
    if (!buffer && item.fileUrl) buffer = await remoteFileFromUrl(item.fileUrl, 'pdf');
    if (!buffer) {
      const image = localImageFromUrl(item.fileUrl);
      if (image) buffer = await renderImageAttachment(manifest, item, image);
    }
    if (!buffer && item.fileUrl) {
      const remoteImage = await remoteFileFromUrl(item.fileUrl, 'image');
      if (remoteImage) buffer = await renderImageAttachment(manifest, item, remoteImage);
    }
    if (!buffer) buffer = await renderGenericDocument(manifest, item);
    buffers.push(buffer);
  }
  const merged = await mergePdfBuffers(buffers);
  return applyPdfSignaturePlacements(merged, signatures);
}

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

module.exports = { renderPatientFilePdf, sha256 };
