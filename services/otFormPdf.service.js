const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Hospital = require('../models/Hospital');

const A4 = { width: 595.28, height: 841.89, margin: 28 };
const COLORS = { ink: '#111827', light: '#F3F4F6', muted: '#6B7280', line: '#111827', accent: '#0F766E' };

function value(v, fallback = '') {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
function patientName(patient = {}) { return patient.name || [patient.salutation, patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') || '—'; }
function doctorName(person = {}) { return person.name || [person.first_name, person.firstName, person.last_name, person.lastName].filter(Boolean).join(' ') || '—'; }
function formatDate(v, withTime = false) { if (!v) return '—'; const d = new Date(v); if (Number.isNaN(d.getTime())) return value(v, '—'); return withTime ? d.toLocaleString('en-IN') : d.toLocaleDateString('en-IN'); }
function truncate(text, n = 70) { const s = value(text, '—'); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function collectPdf(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, bufferPages: true, info: { Producer: 'HIMS' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Promise.resolve(build(doc)).then(() => doc.end()).catch(reject);
  });
}
function addPage(doc, orientation = 'portrait') {
  doc.addPage({ size: 'A4', layout: orientation, margin: 0 });
  return { width: doc.page.width, height: doc.page.height, margin: A4.margin };
}
function rect(doc, x, y, w, h, opts = {}) {
  doc.save().lineWidth(opts.lineWidth || 0.8).strokeColor(opts.stroke || COLORS.line);
  if (opts.fill) doc.fillColor(opts.fill).rect(x, y, w, h).fillAndStroke(opts.fill, opts.stroke || COLORS.line);
  else doc.rect(x, y, w, h).stroke();
  doc.restore();
}
function text(doc, txt, x, y, w, opts = {}) {
  doc.fillColor(opts.color || COLORS.ink).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 8)
    .text(value(txt, opts.fallback || ''), x, y, { width: w, height: opts.height, align: opts.align || 'left', lineGap: opts.lineGap || 1, ellipsis: Boolean(opts.ellipsis) });
}
function line(doc, x1, y1, x2, y2, width = 0.6) { doc.save().lineWidth(width).strokeColor(COLORS.line).moveTo(x1, y1).lineTo(x2, y2).stroke().restore(); }
function checkbox(doc, x, y, checked, label, width = 150, opts = {}) {
  rect(doc, x, y + 1, 8, 8, { lineWidth: 0.6 });
  if (checked) { doc.save().lineWidth(1).moveTo(x + 1.5, y + 5).lineTo(x + 3.5, y + 7.5).lineTo(x + 7.5, y + 1.5).stroke().restore(); }
  text(doc, label, x + 12, y, width - 12, { size: opts.size || 7.2, bold: opts.bold });
}
function selected(data, key, option) { const v = data?.[key]; return Array.isArray(v) ? v.includes(option) : String(v || '').toLowerCase() === String(option).toLowerCase(); }
function header(doc, ctx, title, pageLabel = '') {
  const { width } = doc.page;
  const m = 28; const top = 24; const h = 86;
  rect(doc, m, top, width - m * 2, h, { lineWidth: 1.1 });
  rect(doc, m, top, 76, 48); text(doc, '✚', m + 22, top + 8, 32, { size: 24, bold: true, align: 'center' });
  const hospital = ctx.hospital || {};
  text(doc, hospital.hospitalName || hospital.name || 'HOSPITAL', m + 84, top + 8, width - 310, { size: 15, bold: true, align: 'center' });
  text(doc, [hospital.address, hospital.city, hospital.state, hospital.contact].filter(Boolean).join(' · '), m + 84, top + 29, width - 310, { size: 6.5, align: 'center', color: COLORS.muted });
  rect(doc, width - m - 210, top, 210, 48); text(doc, title, width - m - 204, top + 11, 198, { size: 12, bold: true, align: 'center' });
  if (pageLabel) text(doc, pageLabel, width - m - 204, top + 31, 198, { size: 6.5, align: 'center', color: COLORS.muted });
  const p = ctx.patient || {}; const a = ctx.admission || {};
  const fields = [
    ['Patient', patientName(p)], ['UHID', p.uhid || p.patient_id || p.patientId || '—'], ['IPD', a.admissionNumber || a.shipNumber || '—'],
    ['Age/Sex', `${p.age ?? '—'} / ${p.gender || '—'}`], ['Procedure', ctx.caseInfo?.procedureName || '—'], ['OT Case', ctx.caseInfo?.requestNumber || '—']
  ];
  const cellW = (width - m * 2) / 3; let y = top + 48;
  fields.forEach(([label, val], i) => { const row = Math.floor(i / 3); const col = i % 3; const x = m + col * cellW; if (col > 0) line(doc, x, y + row * 19, x, y + (row + 1) * 19); if (row === 1) line(doc, m, y + 19, width - m, y + 19); text(doc, `${label}:`, x + 4, y + row * 19 + 5, 42, { size: 6.5, bold: true }); text(doc, truncate(val, 48), x + 46, y + row * 19 + 5, cellW - 50, { size: 6.5 }); });
  return top + h + 10;
}
function footer(doc, template, signatures = [], pageNo = 1, pageCount = 1) {
  const y = doc.page.height - 24; line(doc, 28, y - 6, doc.page.width - 28, y - 6, 0.5);
  text(doc, `${template.id} · Template v${template.version}`, 28, y, 220, { size: 5.5, color: COLORS.muted });
  text(doc, `Page ${pageNo} of ${pageCount}`, doc.page.width / 2 - 50, y, 100, { size: 5.5, align: 'center', color: COLORS.muted });
  const codes = signatures.map((s) => s.verificationCode).filter(Boolean).join(', ');
  text(doc, codes ? `Verify: ${codes}` : 'Unsigned preview', doc.page.width - 250, y, 222, { size: 5.5, align: 'right', color: COLORS.muted });
}
function signatureBlock(doc, x, y, w, label, signature) {
  rect(doc, x, y, w, 58);
  text(doc, label, x + 4, y + 4, w - 8, { size: 7, bold: true, align: 'center' });
  if (signature) {
    const sigAsset = signature.assetSnapshots?.find((a) => a.assetType === 'signature');
    const sealAsset = signature.assetSnapshots?.find((a) => a.assetType === 'seal');
    // When the user supplied explicit drag/drop placements, the assets are rendered
    // at those exact normalized page coordinates by applySignaturePlacements().
    // The fixed role block still carries signer metadata and remains the fallback
    // for legacy signatures that predate placement support.
    if (!Array.isArray(signature.placements) || signature.placements.length === 0) {
      if (sigAsset?.storagePath && fs.existsSync(sigAsset.storagePath)) { try { doc.image(sigAsset.storagePath, x + 8, y + 17, { fit: [w * 0.52, 22], align: 'left', valign: 'center' }); } catch {} }
      if (sealAsset?.storagePath && fs.existsSync(sealAsset.storagePath)) { try { doc.image(sealAsset.storagePath, x + w - 48, y + 13, { fit: [40, 34] }); } catch {} }
    }
    text(doc, `${signature.signerName || ''}${signature.signerDesignation ? ` · ${signature.signerDesignation}` : ''}`, x + 4, y + 41, w - 8, { size: 5.8, align: 'center' });
    text(doc, formatDate(signature.signedAt, true), x + 4, y + 49, w - 8, { size: 5, align: 'center', color: COLORS.muted });
  } else text(doc, 'Signature / seal', x + 4, y + 38, w - 8, { size: 6, align: 'center', color: COLORS.muted });
}
function sigFor(signatures, role) { return signatures.find((s) => String(s.signatoryRole || s.metadata?.signatoryRole || '').toLowerCase() === String(role).toLowerCase()) || signatures[0]; }

function resolveAssetPath(storagePath) {
  if (!storagePath) return null;
  const candidates = [storagePath, path.resolve(storagePath), path.resolve(process.cwd(), storagePath)];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * Embed the exact signature/seal placement plan captured in the browser.
 * Coordinates and dimensions are normalized to the target PDF page so the
 * final immutable PDF matches the preview even when a form uses landscape.
 */
function applySignaturePlacements(doc, signatures = [], startPageIndex = 0, renderedPageCount) {
  if (!signatures.length) return;
  const range = doc.bufferedPageRange();
  const count = Number(renderedPageCount || (range.count - startPageIndex));
  signatures.forEach((signature) => {
    const assetMap = new Map((signature.assetSnapshots || []).map((asset) => [String(asset.assetId), asset]));
    (signature.placements || []).forEach((placement) => {
      const localPage = Math.max(1, Number(placement.page || 1));
      if (localPage > count) return;
      const targetPage = startPageIndex + localPage - 1;
      if (targetPage < range.start || targetPage >= range.start + range.count) return;
      const asset = assetMap.get(String(placement.assetId)) || (signature.assetSnapshots || []).find((item) => item.assetType === placement.assetType);
      const assetPath = resolveAssetPath(asset?.storagePath);
      if (!assetPath) return;
      doc.switchToPage(targetPage);
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const x = Number(placement.x || 0) * pageWidth;
      const y = Number(placement.y || 0) * pageHeight;
      const width = Math.max(1, Number(placement.width || 0.2) * pageWidth);
      const height = Math.max(1, Number(placement.height || 0.1) * pageHeight);
      try {
        doc.save();
        const rotation = Number(placement.rotation || 0);
        if (rotation) doc.rotate(rotation, { origin: [x + width / 2, y + height / 2] });
        doc.image(assetPath, x, y, { fit: [width, height], align: 'center', valign: 'center' });
        doc.restore();
      } catch {
        try { doc.restore(); } catch { /* no-op */ }
      }
    });
  });
  // Return to the final page so a following packet form is appended normally.
  const finalPage = startPageIndex + count - 1;
  if (finalPage >= range.start && finalPage < range.start + range.count) doc.switchToPage(finalPage);
}
function sectionTitle(doc, titleText, x, y, w) { rect(doc, x, y, w, 20, { fill: COLORS.light }); text(doc, titleText, x + 5, y + 5, w - 10, { size: 8.5, bold: true }); return y + 20; }
function kv(doc, label, val, x, y, w, h = 22) { rect(doc, x, y, w, h); text(doc, label, x + 4, y + 4, w * 0.34, { size: 6.5, bold: true }); text(doc, val, x + w * 0.34, y + 4, w * 0.64 - 4, { size: 6.5 }); }
function table(doc, x, y, widths, headers, rows, rowHeight = 18, opts = {}) {
  const total = widths.reduce((a, b) => a + b, 0); rect(doc, x, y, total, rowHeight, { fill: opts.headerFill || COLORS.light });
  let cx = x; headers.forEach((h, i) => { if (i) line(doc, cx, y, cx, y + rowHeight); text(doc, h, cx + 2, y + 4, widths[i] - 4, { size: opts.size || 6.3, bold: true, align: opts.align || 'left' }); cx += widths[i]; });
  let cy = y + rowHeight;
  rows.forEach((row) => {
    const hasImage = row.some((cell) => typeof cell === 'string' && cell.startsWith('data:image/'));
    const actualHeight = hasImage ? Math.max(rowHeight, 36) : rowHeight;
    rect(doc, x, cy, total, actualHeight); cx = x;
    row.forEach((cell, i) => {
      if (i) line(doc, cx, cy, cx, cy + actualHeight);
      if (typeof cell === 'string' && cell.startsWith('data:image/')) {
        try {
          const base64Data = cell.replace(/^data:image\/\w+;base64,/, '');
          const imgBuffer = Buffer.from(base64Data, 'base64');
          doc.image(imgBuffer, cx + 2, cy + 2, { fit: [widths[i] - 4, actualHeight - 4], align: 'center', valign: 'center' });
        } catch {
          text(doc, '[Sticker image]', cx + 2, cy + 3, widths[i] - 4, { size: opts.size || 6.1, align: 'left' });
        }
      } else {
        text(doc, cell, cx + 2, cy + 3, widths[i] - 4, { size: opts.size || 6.1, align: opts.align || 'left', height: actualHeight - 5, ellipsis: true });
      }
      cx += widths[i];
    });
    cy += actualHeight;
  });
  return cy;
}

function renderPreOpSafety(doc, ctx, template, data, signatures) {
  addPage(doc); let y = header(doc, ctx, template.title, template.sourceReference); const x = 28; const w = doc.page.width - 56;
  kv(doc, 'Date of Surgery', formatDate(data.dateOfSurgery), x, y, w / 3); kv(doc, 'Diagnosis', data.diagnosis, x + w / 3, y, w / 3); kv(doc, 'Surgery', data.surgery, x + 2 * w / 3, y, w / 3); y += 28;
  const colGap = 8; const colW = (w - colGap * 2) / 3; const sections = [
    ['To be done by Surgeon', 'surgeonItems', 'surgeonRemarks'], ['To be done by Staff Nurse', 'staffNurseItems', 'staffNurseRemarks'], ['To be done by Anaesthetist', 'anaesthetistItems', 'anaesthetistRemarks']
  ];
  sections.forEach(([titleText, key, remarks], idx) => {
    const cx = x + idx * (colW + colGap); rect(doc, cx, y, colW, 560); text(doc, titleText, cx + 4, y + 8, colW - 8, { size: 8.5, bold: true, align: 'center' }); line(doc, cx, y + 28, cx + colW, y + 28);
    const fieldDef = template.sections.find((s) => s.title === titleText)?.fields.find((f) => f.key === key); let iy = y + 38;
    (fieldDef?.options || []).forEach((item) => { checkbox(doc, cx + 8, iy, selected(data, key, item), item, colW - 16, { size: 6.4 }); iy += 30; });
    text(doc, 'Remarks:', cx + 8, y + 480, 50, { size: 6.5, bold: true }); text(doc, data[remarks], cx + 8, y + 493, colW - 16, { size: 6.2, height: 50 });
  });
  const sy = y + 570; signatureBlock(doc, x, sy, colW, 'Surgeon Sign', sigFor(signatures, 'surgeon')); signatureBlock(doc, x + colW + colGap, sy, colW, 'Staff Nurse Sign', sigFor(signatures, 'staff_nurse')); signatureBlock(doc, x + 2 * (colW + colGap), sy, colW, 'Anaesthetist Sign', sigFor(signatures, 'anaesthetist'));
  footer(doc, template, signatures, 1, 1);
}
function renderSurgicalSafety(doc, ctx, template, data, signatures) {
  addPage(doc); let y = header(doc, ctx, template.title, template.sourceReference); const x = 28; const w = doc.page.width - 56; const gap = 8; const cw = (w - gap * 2) / 3;
  const cols = [
    ['Before induction of anaesthesia', [
      ['identitySiteProcedureConsent', 'Identity, site, procedure and consent confirmed'], ['siteMarked', 'Site marked'], ['anaesthesiaMachineMedicationCheck', 'Anaesthesia machine and medication check'], ['pulseOximeterFunctioning', 'Pulse oximeter functioning'], ['knownAllergy', 'Known allergy'], ['difficultAirwayAspirationRisk', 'Difficult airway / aspiration risk'], ['bloodLossRisk', 'Risk of major blood loss']
    ]],
    ['Before skin incision', [['teamIntroduced', 'Team introduced'], ['patientProcedureIncisionSiteConfirmed', 'Patient / procedure / incision site confirmed'], ['antibioticProphylaxis', 'Antibiotic prophylaxis'], ['surgeonCriticalSteps', 'Critical/non-routine steps'], ['caseDuration', 'Expected duration'], ['anticipatedBloodLoss', 'Anticipated blood loss'], ['anaesthesiaSpecificConcerns', 'Anaesthesia concerns'], ['sterilityConfirmed', 'Sterility confirmed'], ['equipmentConcerns', 'Equipment concerns'], ['essentialImagingDisplayed', 'Essential imaging displayed']]],
    ['Before patient leaves operating room', [['procedureNameConfirmed', 'Procedure name confirmed'], ['countsComplete', 'Instrument/sponge/needle counts'], ['specimenLabellingComplete', 'Specimen labelling'], ['equipmentProblems', 'Equipment problems'], ['recoveryConcerns', 'Recovery concerns']]],
  ];
  cols.forEach(([heading, items], idx) => {
    const cx = x + idx * (cw + gap); rect(doc, cx, y, cw, 590); rect(doc, cx, y, cw, 42, { fill: '#E5E7EB' }); text(doc, heading, cx + 5, y + 7, cw - 10, { size: 9, bold: true, align: 'center' });
    let iy = y + 50; items.forEach(([key, label]) => { const v = data[key]; const check = v === true || ['yes', 'not applicable'].includes(String(v || '').toLowerCase()) || Boolean(v); checkbox(doc, cx + 7, iy, check, label, cw - 14, { size: 6.5 }); if (typeof v === 'string' && v && !['Yes','No','Not Applicable'].includes(v)) text(doc, truncate(v, 55), cx + 19, iy + 12, cw - 26, { size: 5.7, color: COLORS.muted }); iy += 40; });
  });
  const sy = y + 600; signatureBlock(doc, x, sy, cw, 'Anaesthetist Sign', sigFor(signatures, 'anaesthetist')); signatureBlock(doc, x + cw + gap, sy, cw, 'Surgeon Sign', sigFor(signatures, 'surgeon')); signatureBlock(doc, x + 2 * (cw + gap), sy, cw, 'Scrub Nurse Sign', sigFor(signatures, 'scrub_nurse'));
  footer(doc, template, signatures, 1, 1);
}
function renderPrePostVerification(doc, ctx, template, data, signatures) {
  addPage(doc); let y = header(doc, ctx, template.title, 'Page 1 - Pre OP verification'); const x = 28; const w = doc.page.width - 56;
  y = sectionTitle(doc, 'Pre OP verification - To be filled by ward staff', x, y, w);
  kv(doc, 'Proposed Operation', data.proposedOperation, x, y, w); y += 22; kv(doc, 'NPO status', data.npoStatus, x, y, w / 2); kv(doc, 'Blood Group / Height / Weight', `${value(data.bloodGroup)} / ${value(data.height)} / ${value(data.weight)}`, x + w / 2, y, w / 2); y += 26;
  const premedRows = (data.premedications || []).slice(0, 4).map((r) => [r.drug, r.dose, r.route, formatDate(r.dateTime, true), r.givenBy, r.checkedBy]);
  y = table(doc, x, y, [112,45,45,88,88,88], ['Premedication drug','Dose','Route','Time & date','Given by','Checked by'], premedRows.length ? premedRows : [['','','','','','']], 18);
  const checks = (data.preOpChecks || []).slice(0, 18); const rows = checks.length ? checks.map((r, i) => [String(i + 1), r.item, r.status, r.remarks]) : Array.from({ length: 18 }, (_, i) => [String(i + 1), '', '', '']);
  y += 8; y = table(doc, x, y, [24,230,75,210], ['No.','Pre-operative verification item','Status','Remarks'], rows, 20, { size: 5.8 });
  signatureBlock(doc, x, doc.page.height - 100, w / 2 - 4, 'Ward Nurse', sigFor(signatures, 'ward_nurse')); signatureBlock(doc, x + w / 2 + 4, doc.page.height - 100, w / 2 - 4, 'Surgeon', sigFor(signatures, 'surgeon')); footer(doc, template, signatures, 1, 2);
  addPage(doc); y = header(doc, ctx, template.title, 'Page 2 - Post OP verification and handover');
  y = sectionTitle(doc, 'To be filled by OT Staff', x, y, w);
  const details = [['Finance clearance', data.financeClearance], ['Procedure', data.procedure], ['Cath details', data.cathDetails], ['Angio No.', data.angioNumber], ['ECG seen by', data.ecgSeenBy], ['ECHO seen by', data.echoSeenBy], ['Relative', `${value(data.relativeName)} (${value(data.relativeRelation)})`], ['OT Staff', data.otStaffName]];
  details.forEach(([l,v],i) => { const cx = x + (i % 2) * w/2; const cy = y + Math.floor(i/2)*22; kv(doc,l,v,cx,cy,w/2); }); y += 92;
  y = sectionTitle(doc, 'Post OP Verification checklist - To be filled by OT Staff', x, y, w);
  const postRows = (data.postOpChecks || []).slice(0, 17).map((r,i)=>[String(i+1),r.item,r.details]);
  y = table(doc,x,y,[24,245,270],['No.','Post-operative verification item','Details / status'],postRows.length?postRows:Array.from({length:17},(_,i)=>[String(i+1),'','']),22,{size:6});
  text(doc,'Information for ITU / ICU staff:',x,y+6,150,{size:7,bold:true}); text(doc,data.icuInformation,x+150,y+6,w-150,{size:6.5,height:40});
  signatureBlock(doc,x,doc.page.height-100,w/2-4,'Handover given by - Operation Theatre',sigFor(signatures,'ot_staff')); signatureBlock(doc,x+w/2+4,doc.page.height-100,w/2-4,'Handover taken by - Post-operative ward',sigFor(signatures,'receiving_nurse')); footer(doc,template,signatures,2,2);
}
function renderAnesthesiaRecord(doc, ctx, template, data, signatures) {
  addPage(doc); let y = header(doc, ctx, template.title, 'Page 1 - Re-evaluation, induction and regional techniques'); const x=28,w=doc.page.width-56;
  y=sectionTitle(doc,'Immediate Pre-Operative Re-Evaluation',x,y,w);
  const re = [['Patient identified',data.patientIdentified],['NPO duration',data.npoDurationHours],['Dentures/contact lens',data.denturesContactLens],['Hearing aids/ornaments removed',data.hearingAidsOrnamentsRemoved],['Anaesthesia consent checked',data.anaesthesiaConsentChecked],['Surgery consent checked',data.surgeryConsentChecked],['Recent investigations checked',data.recentInvestigationsChecked],['Pre-anaesthetic state',data.preAnaestheticState],['Anaesthesia machine checked',data.anaesthesiaMachineChecked],['Pressure points checked',data.pressurePointsChecked],['Eye care',data.eyeCare]];
  re.forEach(([l,v],i)=>{const cx=x+(i%2)*w/2,cy=y+Math.floor(i/2)*22;kv(doc,l,v,cx,cy,w/2);}); y+=132;
  y=sectionTitle(doc,'Premedication and Induction (GA)',x,y,w);
  const meds=(data.premedication||[]).slice(0,8).map(r=>[r.drug,r.doseMg,r.time]); table(doc,x,y,[120,60,60],['Drug','Dose mg','Time'],meds.length?meds:[['','','']],18);
  const rx=x+250,rw=w-250; const induction=[['Induction agent',data.preoxygenationAgent],['Dose',data.inductionDoseMg],['Muscle relaxant',data.muscleRelaxantInduction],['Dose',data.muscleRelaxantDoseMg],['Intubation',`${value(data.intubationRoute)} ${value(data.tubeType)} ${value(data.tubeSize)} ${value(data.tubeCuff)} fixed ${value(data.tubeFixedAtCm)} cm`],['Ventilation',data.ventilation],['Maintenance',value(data.maintenanceAgents)],['Relaxant / reversal',`${value(data.maintenanceRelaxant)} / ${value(data.reversal)}`],['Analgesic',data.analgesic]]; induction.forEach(([l,v],i)=>kv(doc,l,v,rx,y+i*22,rw)); y+=190;
  y=sectionTitle(doc,'Spinal / Epidural / Regional Anaesthesia',x,y,w); const blocks=(data.regionalBlocks||[]).slice(0,5).map(r=>[r.technique,r.siteLevel,r.needleCatheter,r.drug,r.concentration,r.volume,r.effect,r.complications]); table(doc,x,y,[55,65,75,65,48,42,55,134],['Technique','Site/level','Needle/catheter','Drug','Conc.','Vol.','Effect','Complications'],blocks.length?blocks:[['','','','','','','','']],24,{size:5.6});
  signatureBlock(doc,x+w-180,doc.page.height-100,180,'Anaesthetist',sigFor(signatures,'anaesthetist')); footer(doc,template,signatures,1,2);

  // The monitoring sheet is intentionally landscape, but every element is kept
  // inside the 595pt A4 landscape height. This prevents PDFKit from silently
  // creating overflow pages when drug/fluid tables contain realistic data.
  addPage(doc,'landscape');
  const pageW=doc.page.width,pageH=doc.page.height;
  text(doc,'INTRA OPERATIVE ANAESTHESIA MONITORING',28,20,pageW-56,{size:13,bold:true,align:'center'});
  const timelineY=48;
  const timeline=(data.drugTimeline||[]).slice(0,6).map(r=>[r.drug,r.unit,r.time,r.dose,r.route]);
  table(doc,28,timelineY,[150,55,65,80,70],['Drug','Unit','Time','Dose/amount','Route'],timeline.length?timeline:Array.from({length:6},()=>['','','','','']),14,{size:5.8});
  const modalities=value(data.monitoringModalities,'');
  rect(doc,468,timelineY,346,98);
  text(doc,'Monitoring modalities',474,timelineY+6,334,{size:7,bold:true});
  text(doc,modalities,474,timelineY+20,334,{size:6.2,height:70});

  const graphX=68, graphY=166, graphW=746, graphH=215;
  rect(doc,graphX,graphY,graphW,graphH);
  for(let i=1;i<24;i++)line(doc,graphX+i*graphW/24,graphY,graphX+i*graphW/24,graphY+graphH,0.2);
  for(let i=1;i<12;i++)line(doc,graphX,graphY+i*graphH/12,graphX+graphW,graphY+i*graphH/12,0.2);
  [['240',graphY-2],['120',graphY+graphH/2-3],['0',graphY+graphH-5]].forEach(([label,py])=>text(doc,label,34,py,28,{size:6,align:'right'}));
  text(doc,'BP / Pulse / SpO2 / RR',28,graphY+graphH/2-8,35,{size:5.8,align:'center'});
  const obs=(data.observations||[]).slice(0,48);
  const point=(v,max=240)=>graphY+graphH-(Math.max(0,Math.min(max,Number(v)||0))/max)*graphH;
  const series=[['pulse','#111827'],['spo2','#0F766E'],['rr','#7C3AED']];
  series.forEach(([key,color])=>{doc.save().strokeColor(color).lineWidth(1.2);obs.forEach((r,i)=>{const px=graphX+(i/(Math.max(1,obs.length-1)))*graphW,py=point(r[key]);if(i===0)doc.moveTo(px,py);else doc.lineTo(px,py);});if(obs.length)doc.stroke();doc.restore();});
  text(doc,'Pulse',graphX,graphY+graphH+4,45,{size:5.5});text(doc,'SpO2',graphX+48,graphY+graphH+4,45,{size:5.5,color:'#0F766E'});text(doc,'RR',graphX+96,graphY+graphH+4,45,{size:5.5,color:'#7C3AED'});

  const fluids=(data.fluidBalance||[]).slice(0,5).map(r=>[r.time,r.rl,r.ns,r.dns,r.blood,r.ffp,r.platelet,r.albumin,r.colloid,r.bloodLoss,r.urineOutput]);
  table(doc,28,405,[48,48,48,48,48,48,48,48,48,62,68],['Time','RL','NS','DNS','Blood','FFP','Platelet','Albumin','Colloid','Blood loss','Urine output'],fluids.length?fluids:Array.from({length:5},()=>['','','','','','','','','','','']),14,{size:4.9});
  text(doc,'Critical events / complications:',28,500,130,{size:6.3,bold:true});
  rect(doc,155,494,430,52);text(doc,data.criticalEvents,160,500,420,{size:5.8,height:42});
  signatureBlock(doc,pageW-220,488,192,'Anaesthetist',sigFor(signatures,'anaesthetist'));
  footer(doc,template,signatures,2,2);
}
function renderOperationRecord(doc,ctx,template,data,signatures){
  addPage(doc);let y=header(doc,ctx,template.title,'Page 1 - Operation Record');const x=28,w=doc.page.width-56;
  const details=[['Date',formatDate(data.operationDate)],['Surgeon',data.surgeon],['Assistant Surgeon',data.assistantSurgeon],['Anaesthesiologist',data.anaesthesiologist],['Scrub Nurse',data.scrubNurse],['Pre-op Diagnosis',data.preOpDiagnosis],['Post-op Diagnosis',data.postOpDiagnosis],['Surgery',data.surgery],['Start / Stop',`${value(data.startTime)} / ${value(data.stopTime)}`]];
  details.forEach(([l,v],i)=>{const full=i>=5;const cx=full?x:x+(i%2)*w/2;const cy=y+(full?(Math.floor((i-5))*32+66):Math.floor(i/2)*22);kv(doc,l,v,cx,cy,full?w:w/2,full?30:22);});y+=170;
  y=sectionTitle(doc,'Surgical Notes',x,y,w);rect(doc,x,y,w,430);text(doc,data.surgicalNotes,x+8,y+8,w-16,{size:8,height:405});
  kv(doc,'Sample for HPE',data.sampleForHPE,x,y+435,w);signatureBlock(doc,x+w-190,doc.page.height-100,190,'Signature of Surgeon',sigFor(signatures,'surgeon'));footer(doc,template,signatures,1,2);
  addPage(doc);y=header(doc,ctx,template.title,'Page 2 - Critical Events / Findings / Plan');y=sectionTitle(doc,'Critical Events',x,y,w);rect(doc,x,y,w,190);text(doc,data.criticalEvents,x+8,y+8,w-16,{size:8,height:174});y+=200;y=sectionTitle(doc,'Operative Findings and Complications',x,y,w);rect(doc,x,y,w,170);text(doc,`Findings:\n${value(data.findings)}\n\nComplications:\n${value(data.complications)}`,x+8,y+8,w-16,{size:8,height:150});y+=180;y=sectionTitle(doc,'Post-Operative Plan / Diagram / Additional Notes',x,y,w);rect(doc,x,y,w,190);text(doc,`${value(data.postOpPlan)}\n\n${value(data.diagramNotes)}`,x+8,y+8,w-16,{size:8,height:170});signatureBlock(doc,x+w-190,doc.page.height-100,190,'Signature of Surgeon',sigFor(signatures,'surgeon'));footer(doc,template,signatures,2,2);
}
function renderPac(doc,ctx,template,data,signatures){
  addPage(doc);let y=header(doc,ctx,template.title,'Page 1 - Clinical assessment and examination');const x=28,w=doc.page.width-56;
  const details=[['Anesthesiologist',data.anesthesiologist],['Surgeon',data.surgeon],['Pre-op Diagnosis',data.preOpDiagnosis],['Anaesthesia Plan',data.anesthesiaPlan],['Surgery',data.surgery],['Elective/Emergency',data.electiveEmergency],['Co-morbidities',value(data.coMorbidities)],['Addiction',data.addiction],['Past anaesthesia/surgery',data.pastAnaesthesiaSurgery],['Current medications',data.currentMedications],['Drug allergies',data.drugAllergies],['IV access/site',`${value(data.ivAccess)} / ${value(data.ivAccessSite)}`]];
  details.forEach(([l,v],i)=>{const cy=y+i*24;kv(doc,l,v,x,cy,w,i>=2?24:22);});y+=300;
  const phys=(data.physicalExamination||[]).map(r=>[r.item,r.status]);const gen=(data.generalExamination||[]).map(r=>[r.item,r.value,r.unit]); table(doc,x,y,[115,150],['Physical Examination','Status / remarks'],phys.length?phys:[['','']],22);table(doc,x+275,y,[95,100,69],['General Examination','Value','Unit'],gen.length?gen:[['','','']],22);y+=170;
  y=sectionTitle(doc,'Systemic Examination',x,y,w);const systems=(data.systemicExamination||[]).map(r=>[r.system,r.findings]);table(doc,x,y,[100,w-100],['System','Findings'],systems.length?systems:[['CVS',''],['Chest',''],['CNS',''],['Abdomen','']],42);
  footer(doc,template,signatures,1,2);
  addPage(doc);y=header(doc,ctx,template.title,'Page 2 - Airway, investigations, advice and fitness');
  y=sectionTitle(doc,'Airway and Spine',x,y,w);const airway=[['ASA Grade',data.asaGrade],['Difficult Airway',data.difficultAirway],['Mouth Opening',data.mouthOpening],['Neck Movement',data.neckMovement],['Denture',data.denture],['Mallampati Grade',data.mallampatiGrade],['Spine History',data.spineHistory]];airway.forEach(([l,v],i)=>{const cx=x+(i%2)*w/2,cy=y+Math.floor(i/2)*24;kv(doc,l,v,cx,cy,w/2);});y+=100;
  y=sectionTitle(doc,'Investigations',x,y,w);const labs=(data.laboratoryInvestigations||[]).slice(0,10).map(r=>[r.test,r.result,formatDate(r.date),r.acceptable?'Yes':'']);table(doc,x,y,[130,160,100,80],['Laboratory test','Result','Date','Acceptable'],labs.length?labs:[['','','','']],20);const imgs=(data.imagingInvestigations||[]).slice(0,6).map(r=>[r.test,r.result,formatDate(r.date)]);table(doc,x+480,y,[75,120,65],['Imaging','Result','Date'],imgs.length?imgs:[['','','']],20,{size:5.5});y+=230;
  y=sectionTitle(doc,'Premedication / Pre-Op Advice / Fitness',x,y,w);const pre=(data.premedication||[]).slice(0,5).map(r=>[r.medicine,r.dose,r.route,r.time]);table(doc,x,y,[120,60,60,70],['Medicine','Dose','Route','Time'],pre.length?pre:[['','','','']],20);text(doc,'Advice / instructions:',x+325,y,100,{size:6.5,bold:true});let ay=y+16;(data.preOpAdvice||[]).forEach(item=>{checkbox(doc,x+325,ay,true,item,w-335,{size:6.2});ay+=17;});
  text(doc,'Risk summary / optimization:',x,y+125,130,{size:6.5,bold:true});text(doc,data.riskSummary,x+130,y+125,w-130,{size:6.5,height:45});kv(doc,'Fitness Status',data.fitnessStatus,x,y+175,w);
  signatureBlock(doc,x+w-200,doc.page.height-100,200,'Signature Anaesthetist',sigFor(signatures,'anaesthetist'));footer(doc,template,signatures,2,2);
}
function renderPostAnaesthesia(doc,ctx,template,data,signatures){
  addPage(doc);let y=header(doc,ctx,template.title,template.sourceReference);const x=28,w=doc.page.width-56;const left=w*0.52,right=w-left;
  y=sectionTitle(doc,'Post Operative Anaesthesia Instructions',x,y,w);
  kv(doc,'Transfer to',data.transferTo,x,y,left);kv(doc,'Monitoring',value(data.monitoring),x+left,y,right);y+=24;kv(doc,'NBM for',data.nbmHours,x,y,left);kv(doc,'Position',data.position,x+left,y,right);y+=24;kv(doc,'IVF / O2',`${value(data.ivFluids)} / O2: ${data.oxygenInhalation?'Yes':'No'}`,x,y,left);kv(doc,'Antibiotics / Orders',data.antibiotics,x+left,y,right,48);y+=52;
  text(doc,'Analgesics',x,y,80,{size:7,bold:true});const meds=(data.analgesics||[]).slice(0,6).map(r=>[r.medicine,r.dose,r.route,r.frequency]);table(doc,x,y+14,[100,55,55,75],['Medicine','Dose mg','Route','Frequency'],meds.length?meds:[['','','','']],20);
  text(doc,'Special Instructions',x,y+155,100,{size:7,bold:true});rect(doc,x,y+170,left,170);text(doc,data.specialInstructions,x+6,y+176,left-12,{size:7,height:75});text(doc,'Critical Events',x+6,y+260,80,{size:7,bold:true});text(doc,data.criticalEvents,x+6,y+275,left-12,{size:7,height:55});
  const ald=(data.aldrete||[]).map(r=>[r.criterion,r.assessment,r.points]);table(doc,x+left+8,y+14,[80,130,45],['Criterion','Selected characteristic','Points'],ald.length?ald:[['Activity','',''],['Respiration','',''],['Circulation','',''],['Consciousness','',''],['Oxygen saturation','','']],35,{size:5.8});kv(doc,'Total /10',data.aldreteTotal,x+left+8,y+205,255);
  const vitals=(data.shiftingVitals||[]).slice(0,7).map(r=>[r.time,r.bp,r.pulse,r.rr,r.spo2]);table(doc,x,y+350,[60,80,70,65,70],['Time','BP','Pulse','RR','SpO2'],vitals.length?vitals:Array.from({length:5},()=>['','','','','']),20);
  signatureBlock(doc,x+w-200,doc.page.height-100,200,'Signature Anaesthetist',sigFor(signatures,'anaesthetist'));footer(doc,template,signatures,1,1);
}
function renderGeneric(doc,ctx,template,data,signatures){
  addPage(doc);let y=header(doc,ctx,template.title,template.sourceReference);const x=28,w=doc.page.width-56;
  (template.sections||[]).forEach((section)=>{if(y>720){footer(doc,template,signatures,doc.bufferedPageRange().count,template.pageCount||1);addPage(doc);y=header(doc,ctx,template.title);};y=sectionTitle(doc,section.title,x,y,w);(section.fields||[]).forEach((f)=>{const v=data[f.key];if(f.type==='table'){const rows=(Array.isArray(v)?v:[]).slice(0,12);const widths=(f.columns||[]).map(()=>w/Math.max(1,(f.columns||[]).length));y=table(doc,x,y,widths,(f.columns||[]).map(c=>c.label),rows.map(r=>(f.columns||[]).map(c=>value(r[c.key]))),20);y+=4;}else{kv(doc,f.label,Array.isArray(v)?v.join(', '):value(v),x,y,w,f.type==='textarea'?48:22);y+=f.type==='textarea'?48:22;}});y+=8;});

  const pdfStickers = [];
  Object.values(data || {}).forEach((val) => {
    if (Array.isArray(val)) {
      val.forEach((row, idx) => {
        if (row && typeof row === 'object') {
          Object.entries(row).forEach(([colKey, colVal]) => {
            if (typeof colVal === 'string' && colVal.startsWith('data:image/')) {
              pdfStickers.push({
                title: row.itemName || row.item || row.name || `Implant Sticker #${idx + 1}`,
                lot: row.lotBatchNumber || row.lotNumber || '—',
                ref: row.catalogueNumber || '—',
                mfr: row.manufacturer || '—',
                image: colVal
              });
            }
          });
        }
      });
    }
  });

  if (pdfStickers.length > 0) {
    if (y > 550) {
      footer(doc, template, signatures, doc.bufferedPageRange().count, template.pageCount || 1);
      addPage(doc);
      y = header(doc, ctx, template.title, 'Attached Implant Traceability Stickers');
    }
    y = sectionTitle(doc, 'Attached Implant & Device Traceability Stickers', x, y, w);
    pdfStickers.forEach((st) => {
      if (y > 620) {
        footer(doc, template, signatures, doc.bufferedPageRange().count, template.pageCount || 1);
        addPage(doc);
        y = header(doc, ctx, template.title, 'Attached Implant Traceability Stickers');
      }
      rect(doc, x, y, w, 150);
      text(doc, `${st.title} (LOT: ${st.lot} | REF: ${st.ref} | Mfr: ${st.mfr})`, x + 6, y + 6, w - 12, { size: 7.5, bold: true });
      line(doc, x, y + 20, x + w, y + 20);
      try {
        const base64Data = st.image.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(base64Data, 'base64');
        doc.image(imgBuf, x + 10, y + 26, { fit: [w - 20, 115], align: 'center', valign: 'center' });
      } catch {}
      y += 158;
    });
  }

  footer(doc,template,signatures,1,1);
}

async function contextHospital(hospitalId){return Hospital.findById(hospitalId).lean();}
async function renderOtFormPdf({ template, record, otCase, signatures = [], hospital }) {
  const ctx={hospital:hospital||await contextHospital(otCase.hospitalId),patient:otCase.patientId||{},admission:otCase.admissionId||{},caseInfo:otCase}; const data=record?.formData||record||{};
  return collectPdf((doc)=>{
    const renderers={
      'pre-op-safety-checklist':renderPreOpSafety,'surgical-safety-checklist':renderSurgicalSafety,'pre-post-op-verification':renderPrePostVerification,
      'intra-post-anesthesia-record':renderAnesthesiaRecord,'operation-record':renderOperationRecord,'pac-record':renderPac,'post-anesthesia-instructions':renderPostAnaesthesia,
    };
    const startPageIndex = doc.bufferedPageRange().count;
    (renderers[template.rendererId]||renderGeneric)(doc,ctx,template,data,signatures);
    const endPageCount = doc.bufferedPageRange().count;
    applySignaturePlacements(doc, signatures, startPageIndex, endPageCount - startPageIndex);
  });
}
async function renderOtPacketPdf({ forms, otCase, hospital }) {
  return collectPdf(async(doc)=>{
    for(let index=0;index<forms.length;index+=1){
      const {template,record,signatures=[]}=forms[index];
      // Render every structured source into the same PDFKit document so the OT packet
      // is deterministic and does not depend on browser print output.
      const ctx={hospital,patient:otCase.patientId||{},admission:otCase.admissionId||{},caseInfo:otCase};const data=record?.formData||record||{};
      const renderers={'pre-op-safety-checklist':renderPreOpSafety,'surgical-safety-checklist':renderSurgicalSafety,'pre-post-op-verification':renderPrePostVerification,'intra-post-anesthesia-record':renderAnesthesiaRecord,'operation-record':renderOperationRecord,'pac-record':renderPac,'post-anesthesia-instructions':renderPostAnaesthesia};
      const startPageIndex = doc.bufferedPageRange().count;
      (renderers[template.rendererId]||renderGeneric)(doc,ctx,template,data,signatures);
      const endPageCount = doc.bufferedPageRange().count;
      applySignaturePlacements(doc, signatures, startPageIndex, endPageCount - startPageIndex);
    }
  });
}
function sha256(buffer){return crypto.createHash('sha256').update(buffer).digest('hex');}
function writeRenderedPdf(buffer,{hospitalId,caseId,templateId,revision}){const dir=path.resolve('uploads/rendered-documents',String(hospitalId),String(caseId));fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`${templateId}-r${revision}-${Date.now()}.pdf`);fs.writeFileSync(file,buffer);return file;}
module.exports={renderOtFormPdf,renderOtPacketPdf,sha256,writeRenderedPdf};
