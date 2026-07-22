const PDFDocument = require('pdfkit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const OTRequest = require('../models/OTRequest');
const DocumentSignature = require('../models/DocumentSignature');
const { renderOtFormPdf } = require('./otFormPdf.service');
const { PDFDocument: PDFLibDocument, degrees } = require('pdf-lib');

const execFileAsync = promisify(execFile);
const hidden = new Set(['_id', '__v', 'hospitalId', 'hospital_id', 'patientId', 'admissionId', 'createdBy', 'updatedBy']);

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
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('\n');
  if (typeof value === 'object') return Object.entries(value).filter(([key, item]) => !hidden.has(key) && item !== null && item !== undefined && item !== '').map(([key, item]) => `${key.replace(/[_-]/g, ' ')}: ${typeof item === 'object' ? JSON.stringify(item) : item}`).join('\n');
  return String(value);
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
    header(doc, manifest, item.title || 'Clinical Document');
    doc.font('Helvetica').fontSize(7.5).fillColor('#475569').text(`${item.category || ''} · ${item.status || ''} · Source ${item.sourceModel || '—'} revision ${item.sourceRevision || 1}`);
    doc.moveDown(0.6);
    const content = item.content || item.metadata || {};
    const entries = Object.entries(content).filter(([key, value]) => !hidden.has(key) && value !== null && value !== undefined && value !== '');
    if (!entries.length) {
      doc.fontSize(9).fillColor('#64748b').text('No structured source content is available in this record. Refer to the secured linked report or attachment in the HIMS.');
    } else {
      entries.forEach(([key, value]) => {
        const rendered = display(value);
        if (doc.y > 735) { doc.addPage(); header(doc, manifest, `${item.title} (continued)`); }
        doc.save().strokeColor('#cbd5e1').rect(38, doc.y, 519, Math.max(32, Math.min(145, doc.heightOfString(rendered, { width: 497 }) + 25))).stroke();
        const y = doc.y + 5;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a').text(key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), 44, y, { width: 507 });
        doc.font('Helvetica').fontSize(7.3).fillColor('#111827').text(rendered, 44, y + 13, { width: 507, height: 120, ellipsis: true });
        doc.y = y + Math.max(32, Math.min(145, doc.heightOfString(rendered, { width: 497 }) + 25)) + 5;
      });
    }
    if (item.signature) {
      if (doc.y > 730) doc.addPage();
      doc.moveDown().font('Helvetica-Bold').fontSize(8).fillColor('#166534').text(`Digitally signed by ${item.signature.signerName || 'Authorized user'} on ${new Date(item.signature.signedAt).toLocaleString('en-IN')} · Verification ${item.signature.verificationCode || '—'}`);
    }
  });
}

function localPdfFromUrl(fileUrl) {
  if (!fileUrl || !String(fileUrl).toLowerCase().includes('.pdf')) return null;
  const clean = String(fileUrl).split('?')[0];
  const candidates = [clean, clean.replace(/^\/?api\//, ''), clean.replace(/^\/?uploads\//, 'uploads/')].map((value) => path.resolve(value));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

async function otExactDocument(item, hospitalId) {
  if (!item.formTemplate || !item.relatedCaseId || !item.sourceId) return null;
  const otCase = await OTRequest.findOne({ _id: item.relatedCaseId, hospitalId }).populate('patientId').populate('admissionId').lean();
  if (!otCase) return null;
  const sourceModel = item.sourceModel === 'OTClinicalForm' ? 'OTClinicalForm' : item.sourceModel;
  const signatures = await DocumentSignature.find({ hospitalId, sourceModel, sourceId: item.sourceId, status: 'signed' }).sort({ signedAt: 1 }).lean();
  return renderOtFormPdf({ template: item.formTemplate, record: item.content, otCase, signatures });
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
  if (buffers.length === 1) return buffers[0];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hims-patient-file-'));
  try {
    const inputs = buffers.map((buffer, index) => { const file = path.join(tempDir, `${String(index).padStart(4, '0')}.pdf`); fs.writeFileSync(file, buffer); return file; });
    const output = path.join(tempDir, 'bundle.pdf');
    await execFileAsync('gs', ['-dBATCH', '-dNOPAUSE', '-dSAFER', '-q', '-sDEVICE=pdfwrite', `-sOutputFile=${output}`, ...inputs], { maxBuffer: 10 * 1024 * 1024 });
    return fs.readFileSync(output);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

async function renderPatientFilePdf({ manifest, documents, packetType, hospitalId, signatures = [] }) {
  const buffers = [await renderCoverAndIndex(manifest, documents, packetType, signatures)];
  for (const item of documents) {
    let buffer = await otExactDocument(item, hospitalId).catch(() => null);
    if (!buffer) {
      const local = localPdfFromUrl(item.fileUrl);
      if (local) buffer = fs.readFileSync(local);
    }
    if (!buffer) buffer = await renderGenericDocument(manifest, item);
    buffers.push(buffer);
  }
  const merged = await mergePdfBuffers(buffers);
  return applyPdfSignaturePlacements(merged, signatures);
}

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function writePatientBundle(buffer, { hospitalId, admissionId, packetType, revision }) {
  const dir = path.resolve('uploads/rendered-documents', String(hospitalId), 'patient-files', String(admissionId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${packetType}-patient-file-r${revision}-${Date.now()}.pdf`);
  fs.writeFileSync(file, buffer); return file;
}

module.exports = { renderPatientFilePdf, writePatientBundle, sha256 };
