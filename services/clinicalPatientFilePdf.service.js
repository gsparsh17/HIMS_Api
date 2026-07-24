const PDFDocument = require('pdfkit');

const PAGE = { width: 595.28, height: 841.89, margin: 22 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const BOTTOM = PAGE.height - 28;
const COLORS = { ink: '#111827', muted: '#475569', border: '#64748b', light: '#cbd5e1', panel: '#f1f5f9', accent: '#0f766e', danger: '#b91c1c' };

const hidden = new Set(['_id', '__v', 'hospitalId', 'hospital_id', 'patientId', 'admissionId', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt']);

function clean(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return value.toLocaleString('en-IN');
  if (Array.isArray(value)) {
    const rendered = value.map((item) => clean(item, '')).filter(Boolean).join(', ');
    return rendered || fallback;
  }
  if (typeof value === 'object') {
    const rendered = Object.entries(value)
      .filter(([key, item]) => !hidden.has(key) && item !== null && item !== undefined && item !== '' && item !== false)
      .map(([key, item]) => `${title(key)}: ${clean(item, '')}`)
      .filter(Boolean)
      .join('; ');
    return rendered || fallback;
  }
  return String(value).trim() || fallback;
}

function title(value = '') {
  return String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function pathValue(object, path, fallback = '—') {
  const value = String(path).split('.').reduce((cursor, key) => cursor?.[key], object);
  return clean(value, fallback);
}

function personName(person = {}) {
  return person.name || [person.salutation, person.first_name || person.firstName, person.middle_name || person.middleName, person.last_name || person.lastName].filter(Boolean).join(' ') || '—';
}

function formatDate(value, withTime = true) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  return date.toLocaleString('en-IN', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

function collect(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin }, bufferPages: true, info: { Producer: 'HIMS Clinical Template Renderer' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    Promise.resolve(build(doc)).then(() => {
      const range = doc.bufferedPageRange();
      for (let index = range.start; index < range.start + range.count; index += 1) {
        doc.switchToPage(index);
        doc.moveTo(PAGE.margin, PAGE.height - 18).lineTo(PAGE.width - PAGE.margin, PAGE.height - 18).lineWidth(0.4).strokeColor(COLORS.light).stroke();
        doc.font('Helvetica').fontSize(6.2).fillColor(COLORS.muted).text('Generated from HIMS clinical record', PAGE.margin, PAGE.height - 14, { width: 250 });
        doc.text(`Page ${index - range.start + 1} of ${range.count}`, PAGE.width - PAGE.margin - 90, PAGE.height - 14, { width: 90, align: 'right' });
      }
      doc.end();
    }).catch(reject);
  });
}

function drawHeader(doc, { manifest, item, hospital, continued = false }) {
  const admission = manifest.admission || {};
  const patient = admission.patient || {};
  const hospitalName = hospital?.hospitalName || hospital?.name || 'HOSPITAL INFORMATION MANAGEMENT SYSTEM';
  const headerHeight = 76;
  const left = PAGE.margin;
  const top = PAGE.margin;
  const titleWidth = 190;
  doc.lineWidth(0.8).strokeColor(COLORS.ink).rect(left, top, CONTENT_WIDTH, headerHeight).stroke();
  doc.moveTo(left + 36, top).lineTo(left + 36, top + 42).stroke();
  doc.moveTo(PAGE.width - PAGE.margin - titleWidth, top).lineTo(PAGE.width - PAGE.margin - titleWidth, top + 42).stroke();
  doc.font('Helvetica-Bold').fontSize(17).fillColor(COLORS.accent).text('+', left + 7, top + 10, { width: 22, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.ink).text(String(hospitalName).toUpperCase(), left + 42, top + 7, { width: CONTENT_WIDTH - titleWidth - 50, height: 16, ellipsis: true });
  const hospitalAddress = [hospital?.address, hospital?.city, hospital?.state, hospital?.pinCode].filter(Boolean).join(', ');
  doc.font('Helvetica').fontSize(6.8).fillColor(COLORS.muted).text(hospitalAddress || 'Electronic Hospital Information Management System', left + 42, top + 23, { width: CONTENT_WIDTH - titleWidth - 50, height: 13, ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.ink).text(`${item.title || 'Clinical Document'}${continued ? ' (CONTINUED)' : ''}`, PAGE.width - PAGE.margin - titleWidth + 4, top + 9, { width: titleWidth - 8, align: 'center', height: 24, ellipsis: true });
  doc.font('Helvetica').fontSize(6.5).fillColor(COLORS.muted).text(`${String(item.category || 'clinical').toUpperCase()} · ${item.status || ''}`, PAGE.width - PAGE.margin - titleWidth + 4, top + 31, { width: titleWidth - 8, align: 'center' });

  const y = top + 42;
  const columns = [0, 0.29, 0.49, 0.68, 1].map((ratio) => left + CONTENT_WIDTH * ratio);
  columns.slice(1, -1).forEach((x) => doc.moveTo(x, y).lineTo(x, top + headerHeight).stroke());
  const cell = (index, label, value) => {
    const x = columns[index] + 4;
    const width = columns[index + 1] - columns[index] - 8;
    doc.font('Helvetica-Bold').fontSize(6.2).fillColor(COLORS.muted).text(`${label}:`, x, y + 4, { width });
    doc.font('Helvetica').fontSize(7.2).fillColor(COLORS.ink).text(clean(value), x, y + 13, { width, height: 15, ellipsis: true });
  };
  cell(0, 'PATIENT', personName(patient));
  cell(1, 'UHID', patient.uhid || patient.patient_id || patient.patientId);
  cell(2, 'IPD NO.', admission.admissionNumber || admission.shipNumber || admission.id);
  cell(3, 'AGE / SEX', `${patient.age || '—'} / ${patient.gender || '—'}`);
  doc.y = top + headerHeight + 5;
}

function ensureSpace(doc, needed, context) {
  if (doc.y + needed <= BOTTOM) return;
  doc.addPage();
  drawHeader(doc, { ...context, continued: true });
}

function sectionTitle(doc, label, context) {
  ensureSpace(doc, 22, context);
  const y = doc.y;
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, 17).fillAndStroke(COLORS.panel, COLORS.ink);
  doc.font('Helvetica-Bold').fontSize(7.6).fillColor(COLORS.ink).text(String(label).toUpperCase(), PAGE.margin + 5, y + 5, { width: CONTENT_WIDTH - 10 });
  doc.y = y + 17;
}

function drawGrid(doc, fields, context, columns = 2) {
  const colWidth = CONTENT_WIDTH / columns;
  for (let index = 0; index < fields.length; index += columns) {
    const row = fields.slice(index, index + columns);
    const heights = row.map(([label, value]) => {
      const rendered = clean(value);
      return Math.max(28, 15 + doc.font('Helvetica').fontSize(7).heightOfString(rendered, { width: colWidth - 10, lineGap: 1 }));
    });
    const height = Math.max(...heights, 28);
    ensureSpace(doc, height, context);
    const y = doc.y;
    for (let cellIndex = 0; cellIndex < columns; cellIndex += 1) {
      const field = row[cellIndex];
      const x = PAGE.margin + cellIndex * colWidth;
      doc.lineWidth(0.45).strokeColor(COLORS.border).rect(x, y, colWidth, height).stroke();
      if (!field) continue;
      const [label, value] = field;
      doc.font('Helvetica-Bold').fontSize(6.3).fillColor(COLORS.muted).text(String(label).toUpperCase(), x + 4, y + 4, { width: colWidth - 8, height: 10, ellipsis: true });
      doc.font('Helvetica').fontSize(7).fillColor(COLORS.ink).text(clean(value), x + 4, y + 14, { width: colWidth - 8, lineGap: 1 });
    }
    doc.y = y + height;
  }
}

function drawNarrative(doc, label, value, context, minimum = 34) {
  const rendered = clean(value);
  const height = Math.max(minimum, doc.font('Helvetica').fontSize(7.2).heightOfString(rendered, { width: CONTENT_WIDTH - 10, lineGap: 1 }) + 20);
  ensureSpace(doc, Math.min(height, 300), context);
  const y = doc.y;
  doc.lineWidth(0.45).strokeColor(COLORS.border).rect(PAGE.margin, y, CONTENT_WIDTH, height).stroke();
  doc.font('Helvetica-Bold').fontSize(6.3).fillColor(COLORS.muted).text(String(label).toUpperCase(), PAGE.margin + 5, y + 4, { width: CONTENT_WIDTH - 10 });
  doc.font('Helvetica').fontSize(7.2).fillColor(COLORS.ink).text(rendered, PAGE.margin + 5, y + 15, { width: CONTENT_WIDTH - 10, lineGap: 1 });
  doc.y = y + height;
}

function drawTable(doc, columns, rows, context, options = {}) {
  const widths = options.widths || columns.map(() => CONTENT_WIDTH / columns.length);
  const normalized = widths.map((width) => width <= 1 ? width * CONTENT_WIDTH : width);
  const headerHeight = 19;
  const drawTableHeader = () => {
    ensureSpace(doc, headerHeight + 24, context);
    let x = PAGE.margin;
    const y = doc.y;
    columns.forEach((column, index) => {
      doc.rect(x, y, normalized[index], headerHeight).fillAndStroke(COLORS.panel, COLORS.ink);
      doc.font('Helvetica-Bold').fontSize(6.3).fillColor(COLORS.ink).text(column, x + 2, y + 5, { width: normalized[index] - 4, align: 'center', height: 10, ellipsis: true });
      x += normalized[index];
    });
    doc.y = y + headerHeight;
  };
  drawTableHeader();
  (rows.length ? rows : [columns.map(() => '—')]).forEach((row) => {
    const values = row.map(clean);
    const height = Math.max(20, ...values.map((value, index) => doc.font('Helvetica').fontSize(6.5).heightOfString(value, { width: normalized[index] - 5, lineGap: 0.6 }) + 7));
    if (doc.y + height > BOTTOM) { doc.addPage(); drawHeader(doc, { ...context, continued: true }); drawTableHeader(); }
    let x = PAGE.margin;
    const y = doc.y;
    values.forEach((value, index) => {
      doc.rect(x, y, normalized[index], height).lineWidth(0.4).strokeColor(COLORS.border).stroke();
      doc.font('Helvetica').fontSize(6.5).fillColor(COLORS.ink).text(value, x + 2.5, y + 3, { width: normalized[index] - 5, lineGap: 0.6 });
      x += normalized[index];
    });
    doc.y = y + height;
  });
}

function drawSignatures(doc, context, labels = ['Prepared by', 'Reviewed by', 'Authorized signature / date']) {
  ensureSpace(doc, 50, context);
  const y = doc.y + 25;
  const width = CONTENT_WIDTH / labels.length;
  labels.forEach((label, index) => {
    const x = PAGE.margin + width * index;
    doc.moveTo(x + 10, y).lineTo(x + width - 10, y).lineWidth(0.5).strokeColor(COLORS.ink).stroke();
    doc.font('Helvetica').fontSize(6.5).fillColor(COLORS.muted).text(label, x + 4, y + 4, { width: width - 8, align: 'center' });
  });
  doc.y = y + 20;
}

function drawBodyFigure(doc, x, y, back, burnChart) {
  const areas = new Map((burnChart?.burnAreas || []).map((row) => [row.area, Number(row.percentage || 0)]));
  const active = (area) => areas.get(area) > 0;
  const fill = (area) => active(area) ? '#fee2e2' : '#ffffff';
  const center = x + 46;
  doc.font('Helvetica-Bold').fontSize(6).fillColor(COLORS.ink).text(back ? 'POSTERIOR' : 'ANTERIOR', x, y, { width: 92, align: 'center' });
  doc.circle(center, y + 22, 11).fillAndStroke(fill('Head / Neck'), COLORS.ink);
  doc.polygon([center - 8, y + 34], [center + 8, y + 34], [center + 16, y + 83], [center + 9, y + 110], [center - 9, y + 110], [center - 16, y + 83]).fillAndStroke(fill(back ? 'Posterior Trunk' : 'Anterior Trunk'), COLORS.ink);
  doc.polygon([center - 15, y + 39], [center - 32, y + 48], [center - 42, y + 94], [center - 32, y + 97], [center - 20, y + 58]).fillAndStroke(fill('Right Arm'), COLORS.ink);
  doc.polygon([center + 15, y + 39], [center + 32, y + 48], [center + 42, y + 94], [center + 32, y + 97], [center + 20, y + 58]).fillAndStroke(fill('Left Arm'), COLORS.ink);
  doc.polygon([center - 8, y + 110], [center - 22, y + 174], [center - 9, y + 177], [center + 1, y + 118]).fillAndStroke(fill('Right Leg'), COLORS.ink);
  doc.polygon([center + 8, y + 110], [center + 22, y + 174], [center + 9, y + 177], [center - 1, y + 118]).fillAndStroke(fill('Left Leg'), COLORS.ink);
}

function drawBurnChart(doc, burnChart, context) {
  const height = 205;
  ensureSpace(doc, height, context);
  const y = doc.y;
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, height).lineWidth(0.5).strokeColor(COLORS.border).stroke();
  drawBodyFigure(doc, PAGE.margin + 12, y + 9, false, burnChart || {});
  drawBodyFigure(doc, PAGE.margin + 112, y + 9, true, burnChart || {});
  const total = burnChart?.totalScore ?? (burnChart?.burnAreas || []).reduce((sum, row) => sum + Number(row.percentage || 0), 0);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.ink).text('BURN CHART / TBSA', PAGE.margin + 220, y + 10, { width: CONTENT_WIDTH - 230 });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(COLORS.danger).text(`${Number(total || 0)}%`, PAGE.margin + 220, y + 28, { width: 90 });
  let rowY = y + 59;
  (burnChart?.burnAreas || []).filter((row) => Number(row.percentage || 0) > 0).forEach((row) => {
    doc.font('Helvetica').fontSize(7).fillColor(COLORS.ink).text(row.area || 'Area', PAGE.margin + 220, rowY, { width: 170 });
    doc.font('Helvetica-Bold').text(`${row.percentage}%`, PAGE.margin + 390, rowY, { width: 55, align: 'right' });
    doc.moveTo(PAGE.margin + 220, rowY + 10).lineTo(PAGE.width - PAGE.margin - 8, rowY + 10).lineWidth(0.3).strokeColor(COLORS.light).stroke();
    rowY += 14;
  });
  doc.font('Helvetica-Bold').fontSize(6.4).fillColor(COLORS.muted).text('CAUSE / MECHANISM', PAGE.margin + 220, y + 154, { width: 150 });
  doc.font('Helvetica').fontSize(7).fillColor(COLORS.ink).text(clean(burnChart?.causeOfBurn || burnChart?.allegedCause), PAGE.margin + 220, y + 165, { width: CONTENT_WIDTH - 230, height: 28 });
  doc.y = y + height;
}

function genericRows(record) {
  return Object.entries(record || {})
    .filter(([key, value]) => !hidden.has(key) && value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [title(key), clean(value)]);
}

function doctorAssessment(doc, record, context) {
  const g = record.generalExamination || {};
  const vitals = g.vitals || record.vitals || {};
  const triage = record.triageAndTrauma || {};
  const plan = record.planAndDisposition || {};
  sectionTitle(doc, 'History and allergies', context);
  drawGrid(doc, [
    ['Encounter', record.encounterContext || 'IPD'], ['Arrival / Assessment', formatDate(record.arrivalDateTime || record.assessmentAt)],
    ['Case type', record.caseType || 'Non-MLC'], ['Admitted by / Relation', [record.admittedBy, record.relation].filter(Boolean).join(' / ')],
  ], context);
  drawNarrative(doc, 'Chief complaints', record.chiefComplaints, context);
  drawNarrative(doc, 'History of present illness', record.historyOfPresentingIllness || record.historyOfPresentIllness, context);
  drawNarrative(doc, 'Past / personal / family history', [clean(record.pastHistoryMedical, ''), clean(record.personalHistory, ''), clean(record.familyHistory, '')].filter(Boolean).join('\n'), context);
  drawNarrative(doc, 'Allergies', record.allergies, context, 30);
  sectionTitle(doc, 'General and systemic examination', context);
  drawGrid(doc, [
    ['Height', clean(g.height)], ['Weight', clean(g.weight)], ['Consciousness', g.levelOfConsciousness], ['GCS', clean(g.gcs)],
    ['Temperature', vitals.temp || vitals.temperature], ['Pulse', vitals.pulse], ['Blood pressure', vitals.bp || [vitals.systolic, vitals.diastolic].filter(Boolean).join('/')], ['RR / SpO2 / RBS', [vitals.rr, vitals.spo2, vitals.rbs].filter(Boolean).join(' / ')],
  ], context, 4);
  drawNarrative(doc, 'Physical signs / orientation / psychological assessment', [clean(g.physicalSigns, ''), clean(g.orientation, ''), clean(g.psychological, '')].filter(Boolean).join('\n'), context);
  drawNarrative(doc, 'Pain assessment', record.painScore, context, 30);
  drawNarrative(doc, 'Systemic examination', record.systemicExamination, context);
  sectionTitle(doc, 'Triage, trauma and burns', context);
  drawGrid(doc, [['Airway', triage.airway], ['Breathing', triage.breathing], ['Circulation', triage.circulation], ['Triage category', triage.triageCategory]], context, 4);
  drawBurnChart(doc, triage.burnChart || {}, context);
  drawNarrative(doc, 'External injuries / identification marks', [clean(triage.externalInjuries, ''), clean(triage.identificationMarks, '')].filter(Boolean).join('\n'), context);
  sectionTitle(doc, 'Investigations, diagnosis and plan', context);
  drawNarrative(doc, 'Investigations advised', record.investigationAdvised, context);
  drawNarrative(doc, 'Provisional diagnosis', plan.provisionalDiagnosis, context);
  drawNarrative(doc, 'Procedures / treatment / follow-up', [clean(plan.proceduresPerformedInER, ''), clean(plan.treatmentPlanned, ''), clean(plan.otherPlan, ''), clean(plan.followUpInstructions, '')].filter(Boolean).join('\n'), context);
  drawGrid(doc, [['Disposition', plan.patientStatus], ['Intended discharge', formatDate(plan.intendedDischargeDate, false)]], context);
  drawSignatures(doc, context, ['Medical officer / resident', 'Consultant', 'Doctor signature / date']);
}

function nursingAssessment(doc, record, context) {
  const sections = [
    ['Admission details', [['Assessment date', formatDate(record.assessmentAt || record.createdAt)], ['Mode of arrival', pathValue(record, 'admissionDetails.modeOfArrival')], ['Accompanied by', pathValue(record, 'admissionDetails.accompaniedBy')], ['Source', pathValue(record, 'admissionDetails.source')]]],
    ['Initial nursing assessment', [['Consciousness', pathValue(record, 'generalAssessment.levelOfConsciousness')], ['Orientation', pathValue(record, 'generalAssessment.orientation')], ['Mobility', pathValue(record, 'generalAssessment.mobility')], ['Fall risk', pathValue(record, 'riskAssessment.fallRisk')]]],
  ];
  sections.forEach(([label, fields]) => { sectionTitle(doc, label, context); drawGrid(doc, fields, context); });
  drawNarrative(doc, 'Present complaints / nursing observations', record.presentComplaints || record.nursingObservations || record.chiefComplaints, context);
  drawNarrative(doc, 'Past history / allergies / medication history', [clean(record.pastHistory, ''), clean(record.allergies, ''), clean(record.medicationHistory, '')].filter(Boolean).join('\n'), context);
  drawNarrative(doc, 'Skin, pressure injury and wound assessment', record.skinAssessment || record.pressureUlcerAssessment || record.woundAssessment, context);
  drawNarrative(doc, 'Nutrition, elimination, sleep and psychosocial assessment', [clean(record.nutritionAssessment, ''), clean(record.eliminationAssessment, ''), clean(record.sleepAssessment, ''), clean(record.psychosocialAssessment, '')].filter(Boolean).join('\n'), context);
  drawNarrative(doc, 'Nursing care plan / education / special needs', [clean(record.nursingCarePlan, ''), clean(record.patientEducation, ''), clean(record.specialNeeds, '')].filter(Boolean).join('\n'), context);
  drawSignatures(doc, context, ['Assessing nurse', 'Receiving nurse', 'Signature / date']);
}

function vitalsChart(doc, record, context) {
  const rows = Array.isArray(record.chartRows) ? record.chartRows : [record];
  sectionTitle(doc, 'Vitals with Early Warning Score', context);
  drawTable(doc,
    ['Date / Time', 'Temp', 'Pulse', 'BP', 'RR', 'SpO2', 'O2', 'RBS', 'Pain', 'EWS', 'Recorded by'],
    rows.map((row) => [formatDate(row.recordedAt || row.createdAt), row.temperature ?? row.temp, row.pulse, row.bloodPressure || row.bp || [row.systolic, row.diastolic].filter(Boolean).join('/'), row.respiratoryRate ?? row.rr, row.spo2, row.oxygenSupport || row.oxygen, row.rbs, row.painScore, row.ewsScore ?? row.earlyWarningScore, row.recordedByName || row.nurseName]),
    context,
    { widths: [0.14, 0.065, 0.065, 0.09, 0.055, 0.065, 0.09, 0.065, 0.065, 0.065, 0.12] }
  );
  drawNarrative(doc, 'Escalation / clinical remarks', rows.map((row) => [formatDate(row.recordedAt), row.escalationAction || row.remarks || row.notes].filter(Boolean).join(' — ')).filter(Boolean).join('\n'), context, 32);
  drawSignatures(doc, context, ['Nurse', 'Duty doctor', 'Review date / time']);
}

function medicationChart(doc, record, context) {
  sectionTitle(doc, 'Medication Prescription and Administration Chart', context);
  const administrations = record.administrations || record.administrationRecords || record.doses || [];
  drawGrid(doc, [
    ['Medicine', record.medicineName || record.medicationName || record.drugName], ['Dose / Strength', record.dose || record.dosage || record.strength],
    ['Route', record.route], ['Frequency', record.frequency], ['Start date', formatDate(record.startDate, false)], ['Stop date', formatDate(record.stopDate || record.endDate, false)],
    ['Instructions', record.instructions], ['Status', record.status],
  ], context);
  drawTable(doc, ['Scheduled', 'Administered', 'Dose', 'Status', 'Given by', 'Remarks'], administrations.map((row) => [formatDate(row.scheduledAt || row.scheduledTime), formatDate(row.administeredAt || row.givenAt), row.dose || record.dose, row.status, row.administeredByName || row.givenByName, row.remarks || row.reason]), context, { widths: [0.17, 0.17, 0.12, 0.12, 0.18, 0.24] });
  drawSignatures(doc, context, ['Prescribing doctor', 'Administering nurse', 'Pharmacy / verification']);
}

function progressNote(doc, record, context) {
  sectionTitle(doc, context.item.rendererKey === 'nursing-note' ? 'Nursing Progress Note' : 'Clinical Progress / Doctor Round', context);
  drawGrid(doc, [['Date / time', formatDate(record.roundDateTime || record.noteDateTime || record.createdAt)], ['Clinician', record.doctorName || record.nurseName || record.createdByName], ['Type', record.roundType || record.noteType], ['Status', record.status]], context);
  drawNarrative(doc, 'Subjective / complaints', record.subjective || record.complaints || record.patientCondition, context);
  drawNarrative(doc, 'Objective / examination / observations', record.objective || record.examination || record.observations || record.note, context);
  drawNarrative(doc, 'Assessment / diagnosis', record.assessment || record.diagnosis || record.clinicalAssessment, context);
  drawNarrative(doc, 'Plan / orders / advice', record.plan || record.orders || record.advice || record.instructions, context);
  drawSignatures(doc, context, ['Recorded by', 'Consultant review', 'Signature / date']);
}

function procedureRecord(doc, record, context) {
  sectionTitle(doc, 'Procedure Record', context);
  drawGrid(doc, [['Procedure', record.procedureName], ['Code', record.procedureCode], ['Date / time', formatDate(record.completedAt || record.scheduledDate || record.requestedDate)], ['Status', record.status], ['Performed by', record.performedByName || record.doctorName], ['Anaesthesia', record.anesthesiaType]], context);
  drawNarrative(doc, 'Indication / pre-procedure diagnosis', record.indication || record.clinicalIndication || record.preProcedureDiagnosis, context);
  drawNarrative(doc, 'Procedure details / technique', record.procedureDetails || record.notes || record.description, context);
  drawNarrative(doc, 'Findings', record.findings || record.result, context);
  drawNarrative(doc, 'Complications / post-procedure condition', [clean(record.complications, ''), clean(record.postProcedureCondition, '')].filter(Boolean).join('\n'), context);
  drawNarrative(doc, 'Post-procedure orders / advice', record.postProcedureOrders || record.advice, context);
  drawSignatures(doc, context, ['Operator', 'Assistant / nurse', 'Signature / date']);
}

function dischargeSummary(doc, record, context) {
  sectionTitle(doc, 'Discharge Summary', context);
  drawGrid(doc, [['Admission date', formatDate(record.admissionDate, false)], ['Discharge date', formatDate(record.dischargeDate, false)], ['Discharge status', record.status || record.dischargeStatus], ['Consultant', record.consultantName || record.doctorName]], context);
  drawNarrative(doc, 'Final diagnosis', record.finalDiagnosis || record.diagnosis, context);
  drawNarrative(doc, 'Reason for admission / history', record.reasonForAdmission || record.presentingComplaints || record.history, context);
  drawNarrative(doc, 'Examination and investigation summary', record.investigationSummary || record.significantFindings || record.examinationSummary, context);
  drawNarrative(doc, 'Hospital course and treatment', record.hospitalCourse || record.treatmentGiven || record.courseInHospital, context);
  drawNarrative(doc, 'Procedures / surgery performed', record.proceduresPerformed || record.surgeryDetails || record.operationDetails, context);
  drawNarrative(doc, 'Condition at discharge', record.conditionAtDischarge, context);
  const medicines = record.dischargeMedications || record.medications || record.prescription || [];
  if (Array.isArray(medicines)) drawTable(doc, ['Medicine', 'Dose', 'Route', 'Frequency', 'Duration', 'Instructions'], medicines.map((row) => [row.medicineName || row.medicine_name || row.drugName, row.dose || row.dosage, row.route, row.frequency, row.duration, row.instructions]), context, { widths: [0.22, 0.12, 0.1, 0.13, 0.13, 0.3] });
  else drawNarrative(doc, 'Discharge medication', medicines, context);
  drawNarrative(doc, 'Advice, diet, activity and warning signs', [clean(record.advice, ''), clean(record.dietAdvice, ''), clean(record.activityAdvice, ''), clean(record.warningSigns, '')].filter(Boolean).join('\n'), context);
  drawGrid(doc, [['Follow-up date', formatDate(record.followUpDate, false)], ['Follow-up instructions', record.followUpInstructions]], context);
  drawSignatures(doc, context, ['Prepared by', 'Treating consultant', 'Patient / attendant acknowledgement']);
}

function consentRecord(doc, record, context) {
  sectionTitle(doc, record.templateName || 'Consent Form', context);
  drawNarrative(doc, 'Consent statement', record.consentText || record.statement || record.content || record.responses, context, 90);
  drawGrid(doc, [['Patient / attendant', record.patientName || record.attendantName], ['Relationship', record.relationship], ['Language explained', record.language], ['Date / time', formatDate(record.completedAt || record.updatedAt)]], context);
  drawNarrative(doc, 'Risks, benefits, alternatives and questions', [clean(record.risksExplained, ''), clean(record.benefitsExplained, ''), clean(record.alternativesExplained, ''), clean(record.questionsAnswered, '')].filter(Boolean).join('\n'), context);
  drawSignatures(doc, context, ['Patient / attendant', 'Doctor', 'Witness']);
}

function otRecord(doc, record, context) {
  sectionTitle(doc, context.item.title || 'OT / Surgery Record', context);
  const rows = genericRows(record);
  rows.forEach(([label, value]) => drawNarrative(doc, label, value, context, 28));
  drawSignatures(doc, context, ['Surgeon / anaesthetist', 'OT nurse / technician', 'Signature / date']);
}

function admissionRecord(doc, record, context) {
  sectionTitle(doc, context.item.title || 'Admission Record', context);
  drawGrid(doc, [['Admission no.', record.admissionNumber || record.shipNumber], ['Admission date', formatDate(record.admissionDate)], ['Department', clean(record.departmentId || record.department)], ['Consultant', clean(record.primaryDoctorId || record.primaryDoctor)], ['Ward / Room / Bed', [clean(record.wardId || record.ward, ''), clean(record.roomId || record.room, ''), clean(record.bedId || record.bed, '')].filter(Boolean).join(' / ')], ['Status', record.status]], context);
  drawNarrative(doc, 'Reason for admission / provisional diagnosis', record.reasonForAdmission || record.provisionalDiagnosis || record.diagnosis, context);
  if (Array.isArray(record.transferTimeline)) drawTable(doc, ['From', 'To', 'Start', 'End', 'Reason'], record.transferTimeline.map((row) => [row.from || row.fromLocation, row.to || row.toLocation, formatDate(row.startAt || row.start), formatDate(row.endAt || row.end), row.reason]), context, { widths: [0.18, 0.18, 0.2, 0.2, 0.24] });
  drawSignatures(doc, context, ['Registrar', 'Receiving unit', 'Patient / attendant']);
}

const renderers = {
  'admission-slip': admissionRecord,
  'accommodation-transfer-history': admissionRecord,
  'doctor-initial-assessment': doctorAssessment,
  'nursing-admission-assessment': nursingAssessment,
  'vitals-ews': vitalsChart,
  'medication-chart': medicationChart,
  'consultant-round': progressNote,
  'doctors-note': progressNote,
  'nursing-note': progressNote,
  'procedure-record': procedureRecord,
  'discharge-summary': dischargeSummary,
  'ipd-consent': consentRecord,
  'ot-case-summary': otRecord,
  'ot-schedule': otRecord,
  'ot-specimen': otRecord,
  'ot-readiness': otRecord,
  'ot-safety-checklist': otRecord,
  'ot-pac': otRecord,
  'ot-anesthesia-record': otRecord,
  'ot-operative-note': otRecord,
  'ot-recovery': otRecord,
  'ot-inventory-usage': otRecord,
};

async function renderClinicalPatientFileDocument({ manifest, item, hospital }) {
  const renderer = renderers[item?.rendererKey];
  if (!renderer) return null;
  return collect(async (doc) => {
    const context = { manifest, item, hospital };
    drawHeader(doc, context);
    renderer(doc, item.content || item.metadata || {}, context);
  });
}

module.exports = { renderClinicalPatientFileDocument };
