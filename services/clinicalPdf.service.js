const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getTemplate, matchTemplate, normalizeLabTestName } = require('./labReportTemplate.service');

const mm = (value) => value * 2.834645669;
const PAGE = { width: mm(210), height: mm(297), margin: mm(10) };
const CONTENT_BOTTOM = PAGE.height - PAGE.margin - mm(9);

const COLORS = {
  ink: '#111827',
  muted: '#475569',
  border: '#94a3b8',
  lightBorder: '#cbd5e1',
  panel: '#f8fafc',
  header: '#e8f1fb',
  blue: '#1f5f9f',
  darkBlue: '#153f6b',
  paleBlue: '#eef6ff',
  high: '#dc2626',
  low: '#1666b2',
  borderline: '#d97706',
  normal: '#111827',
  white: '#ffffff'
};

const text = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) {
    const output = value.map((item) => text(item)).filter(Boolean).join(', ');
    return output || fallback;
  }
  if (typeof value === 'object') {
    const output = [
      value.line1, value.line2, value.address, value.street,
      value.city, value.district, value.state, value.pinCode || value.pincode
    ].filter(Boolean).join(', ');
    return output || fallback;
  }
  const output = String(value).trim();
  return output || fallback;
};

const firstText = (...values) => {
  for (const value of values) {
    if (value === 0) return '0';
    const output = text(value);
    if (output) return output;
  }
  return '';
};

const formatDate = (value, withTime = false) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value, '-');
  return new Intl.DateTimeFormat('en-IN', withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date);
};

const calculateAge = (dob) => {
  if (!dob) return '-';
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return '-';
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const month = now.getMonth() - date.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < date.getDate())) age -= 1;
  return `${Math.max(age, 0)} YRS`;
};

const fullName = (person, prefix = '') => {
  if (!person || typeof person !== 'object') return text(person);
  const name = [
    person.salutation,
    person.first_name || person.firstName,
    person.middle_name || person.middleName,
    person.last_name || person.lastName
  ].filter(Boolean).join(' ').trim();
  if (!name) return '';
  return `${prefix}${name}`.trim();
};

const hospitalName = (hospital) => text(hospital?.hospitalName || hospital?.name, 'HOSPITAL');
const hospitalAddress = (hospital) => [
  text(hospital?.address), text(hospital?.city), text(hospital?.state), text(hospital?.pinCode)
].filter(Boolean).join(', ');

function configureResponse(res, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
}

function createDocument() {
  return new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin },
    bufferPages: true,
    autoFirstPage: true,
    info: { Creator: 'MediQliq HIMS' }
  });
}

function ensureSpace(doc, required, onNewPage) {
  if (doc.y + required <= CONTENT_BOTTOM) return;
  doc.addPage();
  if (onNewPage) onNewPage();
}

function resolveLocalLogo(logo) {
  const source = text(logo);
  if (!source || /^https?:\/\//i.test(source) || /^data:/i.test(source)) return null;
  const candidates = [source, path.resolve(process.cwd(), source), path.resolve(__dirname, '..', source)];
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  }) || null;
}

function drawFallbackLogo(doc, x, y, size) {
  doc.save();
  doc.circle(x + size / 2, y + size / 2, size / 2).fill(COLORS.blue);
  doc.fillColor(COLORS.white)
    .rect(x + size * 0.42, y + size * 0.20, size * 0.16, size * 0.60).fill()
    .rect(x + size * 0.20, y + size * 0.42, size * 0.60, size * 0.16).fill();
  doc.restore();
}

function drawHospitalLogo(doc, hospital, x, y, size) {
  const logoPath = resolveLocalLogo(hospital?.logo);
  if (logoPath) {
    try {
      doc.image(logoPath, x, y, { fit: [size, size], align: 'center', valign: 'center' });
      return;
    } catch (_) {
      // Fall back to a vector mark if the configured image is unreadable.
    }
  }
  drawFallbackLogo(doc, x, y, size);
}

function barcodeBits(value) {
  const source = text(value, 'MEDIQLIQ');
  const bits = [1, 0, 1, 0, 1, 1, 0];
  for (let index = 0; index < source.length; index += 1) {
    let code = source.charCodeAt(index) + index * 17;
    for (let bit = 0; bit < 7; bit += 1) {
      bits.push((code >> bit) & 1);
    }
  }
  return bits.concat([1, 1, 0, 1, 0, 1, 1]);
}

function drawBarcode(doc, value, x, y, width, height, showValue = true) {
  const bits = barcodeBits(value);
  const barWidth = width / bits.length;
  doc.save().fillColor(COLORS.ink);
  bits.forEach((bit, index) => {
    if (!bit) return;
    const tall = index % 9 === 0 || index % 11 === 0;
    doc.rect(x + index * barWidth, y, Math.max(0.65, barWidth * 0.78), tall ? height : height * 0.84).fill();
  });
  doc.restore();
  if (showValue) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(5.5).text(
      text(value, '-'), x, y + height + 1, { width, align: 'center', lineBreak: false }
    );
  }
}

function addPageFooters(doc, label, options = {}) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const pageNo = index - range.start + 1;
    const y = PAGE.height - PAGE.margin - mm(5.5);
    doc.moveTo(PAGE.margin, y - 4).lineTo(PAGE.width - PAGE.margin, y - 4)
      .lineWidth(0.35).strokeColor(COLORS.lightBorder).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.2).text(
      label,
      PAGE.margin,
      y,
      { width: PAGE.width - PAGE.margin * 2 - mm(28), lineBreak: false }
    );
    doc.text(`Page ${pageNo} of ${range.count}`, PAGE.width - PAGE.margin - mm(28), y, {
      width: mm(28), align: 'right', lineBreak: false
    });
    if (options.blueRule) {
      doc.rect(PAGE.margin, PAGE.height - PAGE.margin + 1, PAGE.width - PAGE.margin * 2, 2)
        .fill(COLORS.blue);
    }
  }
}

function drawDocumentHeader(doc, hospital, documentTitle, subtitle = '', options = {}) {
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const startY = doc.y;
  const logoSize = mm(14);
  const titleBoxWidth = mm(52);
  const barcodeWidth = mm(48);
  const isPrescription = options.variant === 'prescription';

  drawHospitalLogo(doc, hospital, left, startY, logoSize);
  if (!isPrescription) {
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(17).text(
      hospitalName(hospital).toUpperCase(),
      left + logoSize + mm(3),
      startY + 1,
      { width: width - logoSize - barcodeWidth - mm(8), height: mm(8), ellipsis: true }
    );
  }
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(
    hospitalAddress(hospital),
    left + logoSize + mm(3),
    startY + mm(7),
    { width: width - logoSize - mm(5), height: mm(7), ellipsis: true }
  );

  const contactText = [hospital?.contact, hospital?.email].filter(Boolean).join(' | ');
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7).text(
    contactText,
    left + logoSize + mm(3),
    startY + mm(12.5),
    { width: width - logoSize - mm(5), height: mm(5), ellipsis: true }
  );

  if (isPrescription) {
    const titleX = left + mm(86);
    const prescriptionNameWidth = mm(68);
    fitSingleLineText(
      doc,
      hospitalName(hospital).toUpperCase(),
      left + logoSize + mm(3),
      startY + mm(1.2),
      prescriptionNameWidth,
      { font: 'Helvetica-Bold', fontSize: 13, minFontSize: 6.5 }
    );
    doc.roundedRect(titleX, startY - 1, titleBoxWidth, mm(13), 1.5)
      .lineWidth(0.7).strokeColor(COLORS.ink).stroke();
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(14).text(
      documentTitle,
      titleX,
      startY + mm(2.1),
      { width: titleBoxWidth, align: 'center', lineBreak: false }
    );
    drawBarcode(doc, options.barcodeValue, left + width - barcodeWidth, startY, barcodeWidth, mm(8), false);
  } else {
    doc.roundedRect(left + width - titleBoxWidth, startY, titleBoxWidth, mm(13), 1.5)
      .fillAndStroke(COLORS.paleBlue, COLORS.blue);
    doc.fillColor(COLORS.darkBlue).font('Helvetica-Bold').fontSize(11).text(
      documentTitle,
      left + width - titleBoxWidth,
      startY + mm(3),
      { width: titleBoxWidth, align: 'center', lineBreak: false }
    );
  }

  doc.rect(left, startY + mm(18), width, mm(4.7)).fill(COLORS.blue);
  if (hospital?.website) {
    doc.fillColor(COLORS.white).font('Helvetica').fontSize(6.5).text(
      text(hospital.website), left, startY + mm(19.25), { width, align: 'right', lineBreak: false }
    );
  }

  if (subtitle) {
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(isPrescription ? 10 : 11).text(
      subtitle.toUpperCase(), left, startY + mm(25), { width, align: 'center', lineBreak: false }
    );
    doc.moveTo(left, startY + mm(31)).lineTo(left + width, startY + mm(31))
      .lineWidth(0.45).strokeColor(COLORS.border).stroke();
    doc.y = startY + mm(33);
  } else {
    doc.y = startY + mm(25);
  }
}

function drawLabelValue(doc, label, value, x, y, labelWidth, valueWidth, options = {}) {
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(options.fontSize || 7.2).text(
    `${label}:`, x, y, { width: labelWidth, lineBreak: false }
  );
  doc.font(options.boldValue ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.valueSize || 7.5).text(
    text(value, '-'), x + labelWidth, y, {
      width: valueWidth,
      height: options.height || mm(5),
      ellipsis: true,
      lineBreak: options.lineBreak !== false
    }
  );
}

function drawLabPatientBanner(doc, request, report) {
  const patient = request.patientId || {};
  const doctor = request.doctorId || {};
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const y = doc.y;
  const height = mm(33);
  const col1 = mm(68);
  const col2 = mm(67);
  const col3 = width - col1 - col2;
  const patientName = fullName(patient) || text(request.patientName, '-');
  const patientId = patient.patientId || patient.uhid || patient._id || request.patientId;
  const ageGender = `${calculateAge(patient.dob)} / ${text(patient.gender, '-').toUpperCase()}`;
  const refDoctor = fullName(doctor, 'Dr. ') || text(request.referringDoctor, '-');
  const collectedAt = request.sample_collected_at;
  const reportedAt = report.reportedAt || request.processing_completed_at || request.updatedAt;
  const registeredAt = request.requestedDate || request.createdAt;

  doc.rect(left, y, width, height).lineWidth(0.45).strokeColor(COLORS.border).stroke();
  doc.moveTo(left + col1, y).lineTo(left + col1, y + height).stroke();
  doc.moveTo(left + col1 + col2, y).lineTo(left + col1 + col2, y + height).stroke();

  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text(patientName, left + 4, y + 4, {
    width: col1 - 8, height: mm(5), ellipsis: true
  });
  drawLabelValue(doc, 'Age / Sex', ageGender, left + 4, y + mm(7), mm(18), col1 - mm(21));
  drawLabelValue(doc, 'Patient ID', patientId, left + 4, y + mm(12), mm(18), col1 - mm(21));
  const visitNumber = request.sourceType === 'IPD'
    ? firstText(request.admissionId?.admissionNumber, request.admissionNumber)
    : firstText(request.appointmentId?.token, request.prescriptionId?.appointment_id?.token, request.opdNumber);
  drawLabelValue(doc, `${text(request.sourceType, 'OPD').toUpperCase()} No.`, visitNumber, left + 4, y + mm(17), mm(18), col1 - mm(21));
  drawLabelValue(doc, 'Mobile', patient.phone || patient.mobile, left + 4, y + mm(22), mm(18), col1 - mm(21));
  drawLabelValue(doc, 'Address', firstText(patient.address, patient.city), left + 4, y + mm(26), mm(18), col1 - mm(21), {
    fontSize: 6.8, valueSize: 6.8, height: mm(4)
  });

  doc.font('Helvetica-Bold').fontSize(8.2).text('SAMPLE / REFERRAL DETAILS', left + col1 + 5, y + 4, {
    width: col2 - 10
  });
  drawLabelValue(doc, 'Collected At', report.collectionLocation || request.collectionLocation || hospitalAddress(request.hospitalId),
    left + col1 + 5, y + mm(7), mm(21), col2 - mm(24), { fontSize: 6.7, valueSize: 6.8, height: mm(8) });
  drawLabelValue(doc, 'Ref. By', refDoctor, left + col1 + 5, y + mm(16), mm(21), col2 - mm(24));
  drawLabelValue(doc, 'Specimen', report.specimenType || report.specimen || request.specimen_type,
    left + col1 + 5, y + mm(21), mm(21), col2 - mm(24));

  const barcodeValue = request.requestNumber || request.testCode || patientId || 'LAB';
  drawBarcode(doc, barcodeValue, left + col1 + col2 + 5, y + 3, col3 - 10, mm(7), true);
  drawLabelValue(doc, 'Registered', formatDate(registeredAt, true), left + col1 + col2 + 4, y + mm(12), mm(18), col3 - mm(20), {
    fontSize: 5.9, valueSize: 5.9
  });
  drawLabelValue(doc, 'Collected', formatDate(collectedAt, true), left + col1 + col2 + 4, y + mm(17), mm(18), col3 - mm(20), {
    fontSize: 5.9, valueSize: 5.9
  });
  drawLabelValue(doc, 'Reported', formatDate(reportedAt, true), left + col1 + col2 + 4, y + mm(22), mm(18), col3 - mm(20), {
    fontSize: 5.9, valueSize: 5.9
  });

  doc.y = y + height + mm(3);
}

function drawLabReportHeader(doc, request, hospital, report) {
  drawDocumentHeader(doc, hospital, 'LABORATORY REPORT', '', {
    variant: 'lab', barcodeValue: request.requestNumber
  });
  drawLabPatientBanner(doc, request, report);
  const title = report.templateName || request.reportTemplateName || request.testName || 'LABORATORY REPORT';
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(12).text(
    text(title).toUpperCase(), PAGE.margin, doc.y, {
      width: PAGE.width - PAGE.margin * 2, align: 'center'
    }
  );
  doc.moveTo(PAGE.margin, doc.y + 2).lineTo(PAGE.width - PAGE.margin, doc.y + 2)
    .lineWidth(0.4).strokeColor(COLORS.border).stroke();
  doc.y += mm(3);
}

function flagStyle(flagValue) {
  const flag = text(flagValue).toLowerCase();
  if (/very high|critical high|high|positive|reactive/.test(flag)) return { color: COLORS.high, bold: true };
  if (/very low|critical low|low|negative/.test(flag)) return { color: COLORS.low, bold: true };
  if (/borderline|equivocal|indeterminate/.test(flag)) return { color: COLORS.borderline, bold: true };
  return { color: COLORS.normal, bold: false };
}

function deriveObservationGroup(observation) {
  const explicit = firstText(observation.group, observation.section, observation.groupName);
  if (explicit) return explicit.toUpperCase();
  const name = text(observation.name).toLowerCase();
  const storage = text(observation.storageNote).toLowerCase();
  if (/hemoglobin/.test(name)) return 'HEMOGLOBIN';
  if (/total rbc|red blood cell/.test(name)) return 'RBC COUNT';
  if (/packed cell|hematocrit|mcv|mchc|\bmch\b|\brdw\b/.test(name) || storage.includes('blood index')) return 'BLOOD INDICES';
  if (/total wbc|total leucocyte|total leukocyte/.test(name)) return 'WBC COUNT';
  if (/^absolute /.test(name) || storage.includes('absolute count')) return 'ABSOLUTE COUNT';
  if (/platelet/.test(name)) return 'PLATELET COUNT';
  if (/neutrophil|lymphocyte|eosinophil|monocyte|basophil/.test(name) || storage.includes('differential')) return 'DIFFERENTIAL COUNT';
  return '';
}

function deriveObservationReference(observation = {}, template = null, request = null) {
  // 1. Direct fields on observation
  const explicit = firstText(
    observation.referenceText,
    observation.reference_text,
    observation.referenceRange,
    observation.reference_range,
    observation.referenceValue,
    observation.reference_value,
    observation.referenceInterval,
    observation.reference_interval,
    observation.normalRange,
    observation.normal_range,
    observation.refRange,
    observation.ref_range,
    observation.reference
  );
  if (explicit) return explicit;

  // 2. Low / High or Min / Max combination
  const low = firstText(
    observation.referenceLow,
    observation.reference_low,
    observation.referenceMin,
    observation.min_value,
    observation.normal_min
  );
  const high = firstText(
    observation.referenceHigh,
    observation.reference_high,
    observation.referenceMax,
    observation.max_value,
    observation.normal_max
  );
  if (low && high) return `${low} - ${high}`;
  if (low && !high) return `>= ${low}`;
  if (!low && high) return `<= ${high}`;

  // 3. Handle unit-scaled reference intervals for WBC/TLC and Platelets when unit is 10^3/uL
  const unitText = firstText(observation.unit, observation.units);
  const isThousands = /10\^?3|10³|thous/i.test(unitText);
  if (isThousands) {
    const obsNorm = normalizeLabTestName(observation.name);
    if (/total (leucocyte|leukocyte|wbc)|tlc\b|wbc count/.test(obsNorm)) {
      return '4.0 - 11.0';
    }
    if (/platelet/.test(obsNorm)) {
      return '150 - 450';
    }
  }

  // 4. Fallback to matched template observation from catalog
  if (template?.observations?.length) {
    const obsNameNorm = normalizeLabTestName(observation.name);
    const matchedObs = template.observations.find((item) => {
      if (item.analyteCode && observation.analyteCode && item.analyteCode === observation.analyteCode) return true;
      const itemNameNorm = normalizeLabTestName(item.name);
      return itemNameNorm === obsNameNorm
        || (itemNameNorm && obsNameNorm && (itemNameNorm.includes(obsNameNorm) || obsNameNorm.includes(itemNameNorm)));
    });
    if (matchedObs) {
      const templateRef = firstText(
        matchedObs.referenceText,
        matchedObs.referenceRange,
        matchedObs.normalRange,
        (matchedObs.referenceLow && matchedObs.referenceHigh) ? `${matchedObs.referenceLow} - ${matchedObs.referenceHigh}` : ''
      );
      if (templateRef) return templateRef;
    }
  }

  // 5. Fallback to master test normal range
  const testNormalRange = firstText(
    request?.normal_range_used,
    request?.labTestId?.normal_range,
    request?.normal_range
  );
  if (testNormalRange && (!template?.observations || template.observations.length <= 1)) {
    return testNormalRange;
  }

  return '';
}

function deriveObservationUnit(observation = {}, template = null, request = null) {
  let direct = firstText(observation.unit, observation.units, observation.unit_name);
  if (!direct && template?.observations?.length) {
    const obsNameNorm = normalizeLabTestName(observation.name);
    const matchedObs = template.observations.find((item) => {
      if (item.analyteCode && observation.analyteCode && item.analyteCode === observation.analyteCode) return true;
      const itemNameNorm = normalizeLabTestName(item.name);
      return itemNameNorm === obsNameNorm || (itemNameNorm && obsNameNorm && (itemNameNorm.includes(obsNameNorm) || obsNameNorm.includes(itemNameNorm)));
    });
    if (matchedObs?.unit) direct = matchedObs.unit;
  }
  if (!direct) direct = firstText(request?.labTestId?.units, '');
  if (direct) {
    return direct.replace(/10\^3\s*\/?\s*uL/gi, '10³/µL').replace(/10\^3/g, '10³').replace(/\buL\b/gi, 'µL');
  }
  return '';
}

function parseResultValueToObservations(resultValue = '', template = null) {
  if (!resultValue || typeof resultValue !== 'string') return [];
  const parts = resultValue.split(';').map((p) => p.trim()).filter(Boolean);
  return parts.map((part) => {
    const colonIndex = part.indexOf(':');
    if (colonIndex === -1) return { name: part, resultText: '' };
    const name = part.slice(0, colonIndex).trim();
    const rest = part.slice(colonIndex + 1).trim();
    const match = rest.match(/^([<>=≤≥]*)?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(.*)$/);
    if (match) {
      return {
        name,
        comparator: match[1] || '',
        resultNumeric: match[2] || '',
        resultText: match[2] || '',
        unit: match[3] ? match[3].trim() : ''
      };
    }
    return {
      name,
      resultText: rest
    };
  });
}

function drawLabObservationTable(doc, observations, report, onNewPage, template = null, request = null) {
  const left = PAGE.margin;
  const totalWidth = PAGE.width - PAGE.margin * 2;
  const widths = [mm(72), mm(27), mm(22), mm(43), totalWidth - mm(164)];
  const headers = ['INVESTIGATION', 'RESULT', 'FLAG', 'REFERENCE VALUE', 'UNIT'];

  const drawHeader = () => {
    ensureSpace(doc, mm(10), onNewPage);
    const y = doc.y;
    let x = left;
    headers.forEach((header, index) => {
      doc.rect(x, y, widths[index], mm(8)).fillAndStroke(COLORS.header, COLORS.border);
      doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.2).text(
        header, x + 3, y + mm(2.1), {
          width: widths[index] - 6,
          align: index === 0 ? 'left' : 'center',
          lineBreak: false
        }
      );
      x += widths[index];
    });
    doc.y = y + mm(8);
    if (report?.specimenType || report?.specimen) {
      const specimenY = doc.y;
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.5).text('Primary Sample Type:', left + 3, specimenY + 4, {
        width: widths[0] - 6
      });
      doc.font('Helvetica-Bold').text(text(report.specimenType || report.specimen), left + widths[0] + 3, specimenY + 4, {
        width: widths[1] + widths[2] + widths[3] + widths[4] - 6
      });
      doc.moveTo(left, specimenY + mm(7)).lineTo(left + totalWidth, specimenY + mm(7))
        .lineWidth(0.3).strokeColor(COLORS.lightBorder).stroke();
      doc.y += mm(7);
    }
  };

  drawHeader();
  let currentGroup = null;
  (observations || []).forEach((observation) => {
    const group = deriveObservationGroup(observation);
    if (group && group !== currentGroup) {
      if (doc.y + mm(7) > CONTENT_BOTTOM) {
        doc.addPage();
        onNewPage();
        drawHeader();
      }
      doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.8).text(group, left, doc.y + 2, {
        width: totalWidth
      });
      doc.y += mm(5.5);
      currentGroup = group;
    }

    const result = `${firstText(observation.comparator)}${firstText(
      observation.resultText,
      observation.resultNumeric,
      observation.result,
      observation.value
    )}`;
    const flag = firstText(observation.printedFlag, observation.derivedFlag, observation.flag);
    const reference = deriveObservationReference(observation, template, request);
    const unit = deriveObservationUnit(observation, template, request);
    const values = [
      text(observation.name),
      result,
      flag,
      reference,
      unit
    ];
    const method = text(observation.method);
    const nameHeight = doc.heightOfString(values[0] || ' ', { width: widths[0] - 6 });
    const methodHeight = method ? doc.heightOfString(method, { width: widths[0] - 6 }) + 2 : 0;
    const rowHeight = Math.max(mm(7), nameHeight + methodHeight + 5);
    if (doc.y + rowHeight > CONTENT_BOTTOM) {
      doc.addPage();
      onNewPage();
      drawHeader();
      if (group) {
        doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.8).text(`${group} (CONTINUED)`, left, doc.y + 2, {
          width: totalWidth
        });
        doc.y += mm(5.5);
      }
    }

    const y = doc.y;
    let x = left;
    const style = flagStyle(flag);
    values.forEach((value, index) => {
      const color = index === 1 || index === 2 ? style.color : COLORS.ink;
      const font = index === 0 || ((index === 1 || index === 2) && style.bold) ? 'Helvetica-Bold' : 'Helvetica';
      doc.fillColor(color).font(font).fontSize(index === 0 ? 7.8 : 7.6).text(
        value || '-', x + 3, y + 2, {
          width: widths[index] - 6,
          height: rowHeight - 4,
          align: index === 0 ? 'left' : 'center',
          ellipsis: true
        }
      );
      if (index === 0 && method) {
        doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(5.8).text(
          method, x + 3, y + 2 + nameHeight, { width: widths[index] - 6, height: methodHeight + 2, ellipsis: true }
        );
      }
      x += widths[index];
    });
    doc.moveTo(left, y + rowHeight).lineTo(left + totalWidth, y + rowHeight)
      .lineWidth(0.28).strokeColor(COLORS.lightBorder).stroke();
    doc.y = y + rowHeight;
  });
  doc.y += mm(2);
}

function splitTextToHeight(doc, content, width, maxHeight, options = {}) {
  const source = text(content).replace(/\r/g, '');
  if (!source) return { chunk: '', remainder: '' };
  const words = source.split(/(\s+)/);
  let chunk = '';
  let lastGood = 0;
  for (let index = 0; index < words.length; index += 1) {
    const candidate = chunk + words[index];
    const height = doc.heightOfString(candidate || ' ', {
      width,
      lineGap: options.lineGap || 1
    });
    if (height > maxHeight && chunk.trim()) break;
    chunk = candidate;
    lastGood = index + 1;
  }
  if (!lastGood) return { chunk: source.slice(0, 250), remainder: source.slice(250).trimStart() };
  return { chunk: chunk.trimEnd(), remainder: words.slice(lastGood).join('').trimStart() };
}

function drawReportSectionHeading(doc, title) {
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8.3).text(
    `${text(title, 'COMMENTS')}:`, left, doc.y, { width }
  );
  doc.y += mm(5);
}

function drawReportNarrative(doc, title, content, onNewPage) {
  let remaining = text(content);
  if (!remaining) return;
  let continued = false;
  do {
    ensureSpace(doc, mm(12), onNewPage);
    drawReportSectionHeading(doc, continued ? `${title} (continued)` : title);
    const available = CONTENT_BOTTOM - doc.y - mm(2);
    const { chunk, remainder } = splitTextToHeight(doc, remaining, PAGE.width - PAGE.margin * 2 - 4, available, { lineGap: 1.5 });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.6).text(
      chunk, PAGE.margin + 2, doc.y, {
        width: PAGE.width - PAGE.margin * 2 - 4,
        lineGap: 1.5,
        paragraphGap: 2
      }
    );
    doc.y += mm(2);
    remaining = remainder;
    if (remaining) {
      doc.addPage();
      onNewPage();
      continued = true;
    }
  } while (remaining);
}

function normalizeTableRows(table) {
  const headers = Array.isArray(table?.headers) ? table.headers.map((item) => text(item)) : [];
  const rows = Array.isArray(table?.rows) ? table.rows.map((row) => (
    Array.isArray(row) ? row.map((item) => text(item)) : [text(row)]
  )) : [];
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  return {
    headers: headers.length ? [...headers, ...Array(Math.max(0, columnCount - headers.length)).fill('')] : [],
    rows: rows.map((row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill('')]),
    columnCount
  };
}

function drawAdditionalTable(doc, table, onNewPage) {
  const left = PAGE.margin;
  const totalWidth = PAGE.width - PAGE.margin * 2;
  const { headers, rows, columnCount } = normalizeTableRows(table);
  if (!rows.length && !headers.length) return;
  const widths = Array(columnCount).fill(totalWidth / columnCount);

  const drawHeading = (continued = false) => {
    drawReportSectionHeading(doc, continued ? `${table.title || 'Reference table'} (continued)` : (table.title || 'Reference table'));
    if (!headers.length) return;
    const y = doc.y;
    const headerHeight = Math.max(mm(7), ...headers.map((value, index) => (
      doc.heightOfString(value || ' ', { width: widths[index] - 6 }) + 6
    )));
    let x = left;
    headers.forEach((value, index) => {
      doc.rect(x, y, widths[index], headerHeight).fillAndStroke(COLORS.header, COLORS.border);
      doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(6.8).text(
        value || '-', x + 3, y + 3, { width: widths[index] - 6, align: 'center' }
      );
      x += widths[index];
    });
    doc.y = y + headerHeight;
  };

  ensureSpace(doc, mm(18), onNewPage);
  drawHeading(false);
  rows.forEach((row) => {
    const rowHeight = Math.max(mm(7), ...row.map((value, index) => (
      doc.heightOfString(value || ' ', { width: widths[index] - 6, lineGap: 1 }) + 6
    )));
    if (doc.y + rowHeight > CONTENT_BOTTOM) {
      doc.addPage();
      onNewPage();
      drawHeading(true);
    }
    const y = doc.y;
    let x = left;
    row.forEach((value, index) => {
      doc.rect(x, y, widths[index], rowHeight).lineWidth(0.3).strokeColor(COLORS.border).stroke();
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7).text(
        value || '-', x + 3, y + 3, {
          width: widths[index] - 6, height: rowHeight - 6, lineGap: 1
        }
      );
      x += widths[index];
    });
    doc.y = y + rowHeight;
  });
  doc.y += mm(2);
}

function drawLabSignatures(doc, request, report, onNewPage) {
  // The signature block itself needs only ~18-20 mm. Reserving 31 mm forced
  // otherwise-complete CBC reports onto a second page containing nothing but
  // the repeated lab header and three signature columns. Keep the signatures
  // with the result body whenever the actual remaining A4 space can hold them.
  ensureSpace(doc, mm(20), onNewPage);
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const columnWidth = width / 3;
  const y = doc.y + mm(5);
  const technician = fullName(request.processed_by || request.sample_collected_by) || text(report.technicianName, 'Medical Lab Technician');
  const pathologist = text(report.pathologistName, 'Pathologist');
  const authorized = text(report.authorizedSignatoryName, 'Authorized Signatory');
  const roles = [
    [technician, text(report.technicianQualification, 'LAB TECHNICIAN / STAFF')],
    [pathologist, text(report.pathologistQualification, 'PATHOLOGIST')],
    [authorized, text(report.authorizedSignatoryQualification, 'AUTHORIZED SIGNATORY')]
  ];

  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.35).strokeColor(COLORS.lightBorder).stroke();
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.3).text('Thanks for Reference', left, doc.y + 4, {
    width: columnWidth
  });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(6.5).text('**** End of Report ****', left + columnWidth, doc.y + 4, {
    width: columnWidth, align: 'center'
  });

  roles.forEach(([name, role], index) => {
    const x = left + index * columnWidth;
    doc.moveTo(x + mm(8), y).lineTo(x + columnWidth - mm(8), y)
      .lineWidth(0.45).strokeColor(COLORS.ink).stroke();
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.2).text(name, x + 3, y + 4, {
      width: columnWidth - 6, align: 'center', height: mm(5), ellipsis: true
    });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.2).text(role, x + 3, y + mm(5.5), {
      width: columnWidth - 6, align: 'center', height: mm(5), ellipsis: true
    });
  });
  doc.y = y + mm(11);
}

function generateLabReportPdf({ res, request, hospital }) {
  const report = request.manual_report || request.manualReport || {};
  const filename = `${request.requestNumber || 'lab-report'}-${request.testCode || 'test'}.pdf`;
  configureResponse(res, filename);
  const doc = createDocument();
  doc.pipe(res);

  const template = getTemplate(report.templateId || request.reportTemplateId || request.labTestId?.report_template_id)
    || matchTemplate(request.testName || report.templateName || request.labTestId?.name, request.testCode || request.labTestId?.code, report.templateId);

  const rawObservations = Array.isArray(report.observations) && report.observations.length
    ? report.observations
    : parseResultValueToObservations(request.result_value, template);

  const header = () => drawLabReportHeader(doc, request, hospital, report);
  header();
  drawLabObservationTable(doc, rawObservations, report, header, template, request);

  (report.additionalTables || []).forEach((table) => {
    if (!table?.title || table.displayInReport === false) return;
    drawAdditionalTable(doc, table, header);
  });
  (report.narrativeSections || []).forEach((section) => {
    drawReportNarrative(doc, section.label || 'Comments', section.text ?? section.defaultText ?? '', header);
  });
  if (report.instrument) drawReportNarrative(doc, 'Instrument', report.instrument, header);
  if (report.technicianNotes) drawReportNarrative(doc, 'Technician Notes', report.technicianNotes, header);
  if (report.pathologistNotes) drawReportNarrative(doc, 'Pathologist Notes', report.pathologistNotes, header);
  if (report.disclaimer) drawReportNarrative(doc, 'Report Note', report.disclaimer, header);

  drawLabSignatures(doc, request, report, header);
  addPageFooters(doc, 'Reference intervals are method and patient-context dependent. Clinically correlate this report.', {
    blueRule: true
  });
  doc.end();
}

function drawPrescriptionInfoGrid(doc, prescription) {
  const patient = prescription.patient_id || {};
  const doctor = prescription.doctor_id || {};
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const y = doc.y;
  const height = mm(50);
  const colWidth = width / 3;
  const rowGap = mm(6.1);
  const patientName = fullName(patient);
  const consultant = fullName(doctor, 'Dr. ');
  const department = doctor.department?.name || doctor.specialization;
  const patientAddress = [patient.address, patient.city, patient.state, patient.zipCode || patient.pinCode].filter(Boolean).join(', ');
  const rows = [
    [
      ['NAME', patientName], ['Age/Gender', `${calculateAge(patient.dob)} / ${text(patient.gender, '-').toUpperCase()}`], ['Reg Dt', formatDate(patient.registered_at || prescription.issue_date)]
    ],
    [
      ['UMR No', patient.patientId || patient.uhid || patient._id], ['Occupation', patient.occupation], ['Nationality', patient.nationality]
    ],
    [
      ['Father Name', patient.father_name || patient.fatherName], ['Marital Status', patient.marital_status || patient.maritalStatus], ['Mobile No', patient.phone || patient.mobile]
    ],
    [
      ['Mother Name', patient.mother_name || patient.motherName], ['Consultation Fee', prescription.consultation_fee], ['Token', prescription.appointment_id?.token]
    ],
    [
      ['Patient Type', text(patient.patient_type, prescription.source_type).toUpperCase()], ['Consult Date', formatDate(prescription.issue_date)], ['Rx No', prescription.prescription_number]
    ]
  ];

  doc.rect(left, y, width, height).lineWidth(0.5).strokeColor(COLORS.ink).stroke();
  rows.forEach((row, rowIndex) => {
    row.forEach(([label, value], colIndex) => {
      const x = left + colIndex * colWidth + 4;
      const rowY = y + 4 + rowIndex * rowGap;
      drawLabelValue(doc, label, value, x, rowY, mm(24), colWidth - mm(26), {
        fontSize: 7, valueSize: 7.2, height: mm(5)
      });
    });
  });

  const lineY = y + mm(34.5);
  doc.moveTo(left, lineY).lineTo(left + width, lineY).lineWidth(0.35).strokeColor(COLORS.border).stroke();
  drawLabelValue(doc, 'ADDRESS', patientAddress, left + 4, lineY + mm(2), mm(24), width - mm(28), {
    fontSize: 7, valueSize: 7.1, height: mm(5)
  });
  drawLabelValue(doc, 'Consultant', consultant, left + 4, lineY + mm(8), mm(24), colWidth * 1.35 - mm(28), {
    fontSize: 7, valueSize: 7.1
  });
  drawLabelValue(doc, 'Department', department, left + colWidth * 1.45, lineY + mm(8), mm(24), width - colWidth * 1.45 - mm(28), {
    fontSize: 7, valueSize: 7.1
  });

  doc.y = y + height;
}

function drawPainScale(doc, x, y, width, height, selectedValue) {
  doc.rect(x, y, width, height).lineWidth(0.4).strokeColor(COLORS.ink).stroke();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.2).text('PAIN SCALE', x + 4, y + 3, {
    width: width - 8
  });
  const value = Number(selectedValue);
  const centerY = y + mm(11.5);
  const circleRadius = mm(3.4);
  const count = 6;
  const spacing = (width - mm(17)) / (count - 1);
  const labels = ['0', '2', '4', '6', '8', '10'];
  for (let index = 0; index < count; index += 1) {
    const cx = x + mm(8.5) + index * spacing;
    const numeric = Number(labels[index]);
    const selected = Number.isFinite(value) && Math.abs(value - numeric) <= 1;
    doc.circle(cx, centerY, circleRadius)
      .fillAndStroke(selected ? COLORS.blue : COLORS.white, COLORS.ink);
    doc.fillColor(selected ? COLORS.white : COLORS.ink).font('Helvetica-Bold').fontSize(6.5).text(
      labels[index], cx - circleRadius, centerY - 3, { width: circleRadius * 2, align: 'center', lineBreak: false }
    );
  }
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(5.8).text(
    'No pain', x + 3, y + height - mm(5), { width: mm(25), align: 'center' }
  );
  doc.text('Moderate', x + width / 2 - mm(15), y + height - mm(5), { width: mm(30), align: 'center' });
  doc.text('Unbearable', x + width - mm(30), y + height - mm(5), { width: mm(27), align: 'center' });
}

function drawVitalsPanel(doc, x, y, width, height, patient, vitals, allergySnapshot, options = {}) {
  doc.rect(x, y, width, height).lineWidth(0.4).strokeColor(COLORS.ink).stroke();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.2).text('ALLERGY:', x + 4, y + 3, {
    width: mm(20), lineBreak: false
  });
  const emptyClinicalFields = Boolean(options.emptyClinicalFields);
  doc.font('Helvetica').text(
    text(allergySnapshot || patient.allergies, emptyClinicalFields ? '' : 'None reported'),
    x + mm(22),
    y + 3,
    {
      width: width - mm(24), height: mm(5), ellipsis: true
    }
  );
  doc.font('Helvetica-Bold').text('VITALS:', x + 4, y + mm(8), { width: width - 8 });
  const cells = [
    ['BP', vitals?.bp], ['TEMP', vitals?.temperature], ['PULSE', vitals?.pulse], ['RR', vitals?.respiratory_rate],
    ['HT', vitals?.height], ['WT', vitals?.weight], ['SpO2', vitals?.spo2]
  ];
  const cellWidth = (width - 8) / 4;
  cells.forEach(([label, value], index) => {
    const row = Math.floor(index / 4);
    const col = index % 4;
    const cellX = x + 4 + col * cellWidth;
    const cellY = y + mm(13) + row * mm(6);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(6.7).text(`${label}:`, cellX, cellY, {
      width: mm(10), lineBreak: false
    });
    doc.font('Helvetica').fontSize(7).text(
      text(value, emptyClinicalFields ? '' : '-'),
      cellX + mm(9),
      cellY,
      {
        width: cellWidth - mm(9), lineBreak: false, ellipsis: true
      }
    );
  });
}

function fitSingleLineText(doc, value, x, y, width, options = {}) {
  const content = text(value);
  if (!content) return;
  const font = options.font || 'Helvetica';
  let fontSize = options.fontSize || 10;
  const minFontSize = options.minFontSize || 6;
  doc.font(font);
  while (fontSize > minFontSize && doc.fontSize(fontSize).widthOfString(content) > width) fontSize -= 0.25;
  doc.fillColor(options.color || COLORS.ink).font(font).fontSize(fontSize).text(
    content, x, y, { width, align: options.align || 'left', lineBreak: false }
  );
}

function fitTextInBox(doc, value, x, y, width, height, options = {}) {
  const content = text(value);
  if (!content) return;
  let fontSize = options.fontSize || 8;
  const minFontSize = options.minFontSize || 6.3;
  while (fontSize > minFontSize && doc.heightOfString(content, { width, lineGap: 1 }) > height) fontSize -= 0.3;
  doc.fillColor(options.color || COLORS.ink).font(options.font || 'Helvetica').fontSize(fontSize).text(
    content, x, y, { width, height, lineGap: 1, ellipsis: true }
  );
}

function drawClinicalBox(doc, title, content, x, y, width, height) {
  doc.rect(x, y, width, height).lineWidth(0.4).strokeColor(COLORS.ink).stroke();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.5).text(
    `${title}:`, x + 4, y + 3, { width: width - 8, lineBreak: false }
  );
  fitTextInBox(doc, content, x + 4, y + mm(7), width - 8, height - mm(8), { fontSize: 7.7 });
}

function drawPrescriptionPageOne(doc, prescription, hospital, vitals) {
  const patient = prescription.patient_id || {};
  const doctor = prescription.doctor_id || {};
  const department = doctor.department?.name || doctor.specialization || '';
  drawDocumentHeader(doc, hospital, 'Prescription', department ? `DEPARTMENT OF (${department})` : 'PRESCRIPTION', {
    variant: 'prescription', barcodeValue: prescription.prescription_number
  });
  drawPrescriptionInfoGrid(doc, prescription);

  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const painWidth = mm(82);
  const panelHeight = mm(26);
  const panelY = doc.y;
  drawPainScale(doc, left, panelY, painWidth, panelHeight, prescription.pain_score ?? vitals?.pain_score);
  drawVitalsPanel(
    doc,
    left + painWidth,
    panelY,
    width - painWidth,
    panelHeight,
    patient,
    vitals,
    prescription.allergy_snapshot,
    { emptyClinicalFields: Boolean(prescription.is_blank_manual_form) }
  );
  doc.y = panelY + panelHeight;

  const chiefY = doc.y;
  drawClinicalBox(doc, 'CHIEF COMPLAINTS', prescription.presenting_complaint || prescription.symptoms,
    left, chiefY, width, mm(36));
  doc.y = chiefY + mm(36);

  const halfWidth = width / 2;
  const historyY = doc.y;
  drawClinicalBox(doc, 'PAST MEDICAL & MEDICATION HISTORY',
    patient.medical_history || prescription.history_of_presenting_complaint,
    left, historyY, halfWidth, mm(50));
  drawClinicalBox(doc, 'PHYSICAL EXAMINATION', prescription.physical_examination,
    left + halfWidth, historyY, halfWidth, mm(50));
  doc.y = historyY + mm(50);

  const structuredInvestigations = [
    ...(prescription.lab_test_requests || []).map((item) => item.lab_test_name),
    ...(prescription.radiology_test_requests || []).map((item) => item.imaging_test_name),
    ...(prescription.procedure_requests || []).map((item) => item.procedure_name)
  ].filter(Boolean);
  const investigationNotes = text(prescription.investigation);
  const investigations = [
    structuredInvestigations.length ? `Ordered: ${structuredInvestigations.join(', ')}` : '',
    investigationNotes ? `${structuredInvestigations.length ? 'Additional notes: ' : ''}${investigationNotes}` : ''
  ].filter(Boolean).join('\n');
  const investigationY = doc.y;
  const remainingHeight = Math.max(mm(25), CONTENT_BOTTOM - investigationY - mm(2));
  drawClinicalBox(doc, 'INVESTIGATIONS ADVISED', investigations, left, investigationY, width, remainingHeight);
  doc.y = investigationY + remainingHeight;
}

function drawCompactPrescriptionHeader(doc, prescription, hospital) {
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const y = doc.y;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(12).text(
    hospitalName(hospital).toUpperCase(), left, y, { width: width * 0.56, height: mm(7), ellipsis: true }
  );
  doc.roundedRect(left + width * 0.56, y - 1, width * 0.22, mm(9), 1)
    .lineWidth(0.5).strokeColor(COLORS.ink).stroke();
  doc.fontSize(10).text('PRESCRIPTION', left + width * 0.56, y + mm(1.5), {
    width: width * 0.22, align: 'center', lineBreak: false
  });
  drawBarcode(doc, prescription.prescription_number, left + width * 0.80, y, width * 0.20, mm(6), false);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5).text(
    `Rx No: ${text(prescription.prescription_number, '-')} | ${formatDate(prescription.issue_date, true)}`,
    left, y + mm(8), { width, align: 'right', lineBreak: false }
  );
  doc.moveTo(left, y + mm(12)).lineTo(left + width, y + mm(12))
    .lineWidth(0.5).strokeColor(COLORS.ink).stroke();
  doc.y = y + mm(14);
}

function drawCompactField(doc, label, value, height = mm(10)) {
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const y = doc.y;
  doc.rect(left, y, width, height).lineWidth(0.4).strokeColor(COLORS.ink).stroke();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.3).text(
    `${label}:`, left + 4, y + 3, { width: mm(58) }
  );
  fitTextInBox(doc, value, left + mm(58), y + 3, width - mm(60), height - 6, { fontSize: 7.3, minFontSize: 6 });
  doc.y = y + height;
}

function drawMedicationTable(doc, items) {
  const left = PAGE.margin;
  const totalWidth = PAGE.width - PAGE.margin * 2;
  const widths = [mm(10), mm(67), mm(18), mm(20), mm(17), mm(24), totalWidth - mm(156)];
  const headers = ['SR.NO', 'NAME OF MEDICATION', 'ROA', 'DOSE', 'DAYS', 'TIME', 'SPECIAL REMARK'];
  const headerY = doc.y;
  let x = left;
  headers.forEach((header, index) => {
    doc.rect(x, headerY, widths[index], mm(8)).fillAndStroke(COLORS.header, COLORS.ink);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(6.2).text(
      header, x + 2, headerY + mm(2.1), { width: widths[index] - 4, align: 'center', lineBreak: false }
    );
    x += widths[index];
  });
  doc.y += mm(8);

  const rowCount = 15;
  const rowHeight = mm(8.3);
  for (let index = 0; index < rowCount; index += 1) {
    const item = items?.[index] || {};
    const medicineName = [item.medicine_name, item.generic_name ? `(${item.generic_name})` : ''].filter(Boolean).join(' ');
    const values = [
      String(index + 1), medicineName, item.route_of_administration,
      item.dosage, item.duration, item.frequency || item.timing, item.instructions
    ];
    const y = doc.y;
    x = left;
    values.forEach((value, colIndex) => {
      doc.rect(x, y, widths[colIndex], rowHeight).lineWidth(0.35).strokeColor(COLORS.ink).stroke();
      if (value && colIndex !== 0) {
        fitTextInBox(doc, value, x + 2, y + 2, widths[colIndex] - 4, rowHeight - 4, {
          fontSize: colIndex === 1 ? 6.8 : 6.5,
          minFontSize: 5.5,
          font: colIndex === 1 ? 'Helvetica-Bold' : 'Helvetica'
        });
      }
      if (colIndex === 0) {
        doc.fillColor(COLORS.ink).font('Helvetica').fontSize(6.5).text(
          String(index + 1), x + 2, y + mm(2.2), { width: widths[colIndex] - 4, align: 'center', lineBreak: false }
        );
      }
      x += widths[colIndex];
    });
    doc.y = y + rowHeight;
  }
}

function drawPrescriptionPageTwo(doc, prescription, hospital) {
  drawCompactPrescriptionHeader(doc, prescription, hospital);
  const primaryDiagnosis = text(prescription.diagnosis);
  const differentialDiagnosis = text(prescription.provisional_diagnosis);
  const diagnoses = [
    primaryDiagnosis ? `Primary: ${primaryDiagnosis}` : '',
    differentialDiagnosis && differentialDiagnosis.toLowerCase() !== primaryDiagnosis.toLowerCase()
      ? `Differential / additional: ${differentialDiagnosis}`
      : ''
  ].filter(Boolean).join('\n');
  drawCompactField(doc, 'DIAGNOSIS', diagnoses, mm(14));
  drawCompactField(doc, 'TREATMENT PLAN', prescription.treatment_plan || prescription.notes, mm(11));

  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const titleY = doc.y;
  doc.rect(left, titleY, width, mm(8)).fillAndStroke(COLORS.panel, COLORS.ink);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(
    'MEDICATION ADVISED:', left + 4, titleY + mm(2.2), { width: width - 8, lineBreak: false }
  );
  doc.y += mm(8);
  drawMedicationTable(doc, prescription.items || []);
  drawCompactField(doc, 'OUTCOME EXPECTED', prescription.outcome_expected, mm(10));

  const bottomY = doc.y;
  const third = width / 3;
  const fields = [
    ['DIET', prescription.diet_advice],
    ['FOLLOW UP DUE ON', formatDate(prescription.follow_up_date)],
    ['EMERGENCY CONTACT NO', hospital?.contact]
  ];
  fields.forEach(([label, value], index) => {
    const x = left + index * third;
    doc.rect(x, bottomY, third, mm(18)).lineWidth(0.4).strokeColor(COLORS.ink).stroke();
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.3).text(
      `${label}:`, x + 4, bottomY + 3, { width: third - 8 }
    );
    fitTextInBox(doc, value, x + 4, bottomY + mm(7), third - 8, mm(9), { fontSize: 7.2, minFontSize: 6 });
  });

  const signatureY = bottomY + mm(28);
  const doctorName = fullName(prescription.doctor_id, 'Dr. ') || 'Consultant';
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text('SIGNATURE', left + mm(10), signatureY, {
    width: mm(62)
  });
  doc.moveTo(left + mm(7), signatureY + mm(6)).lineTo(left + mm(70), signatureY + mm(6))
    .lineWidth(0.5).strokeColor(COLORS.ink).stroke();
  doc.font('Helvetica-Bold').fontSize(7.5).text(doctorName, left + mm(7), signatureY + mm(8), {
    width: mm(65), align: 'center', height: mm(5), ellipsis: true
  });
  doc.font('Helvetica').fontSize(6.5).text('NAME OF CONSULTANT (AUTOMATIC)', left + mm(7), signatureY + mm(13), {
    width: mm(65), align: 'center'
  });

  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(
    `DATE & TIME: ${formatDate(prescription.issue_date, true)}`,
    left + width - mm(82), signatureY + mm(8), { width: mm(82), align: 'right' }
  );
}

function generatePrescriptionPdf({ res, prescription, hospital, vitals }) {
  const filename = `${prescription.prescription_number || 'prescription'}.pdf`;
  configureResponse(res, filename);
  const doc = createDocument();
  doc.pipe(res);
  drawPrescriptionPageOne(doc, prescription, hospital, vitals);
  doc.addPage();
  drawPrescriptionPageTwo(doc, prescription, hospital);
  addPageFooters(doc, 'Computer-generated clinical document', { blueRule: true });
  doc.end();
}


function userDisplayName(user) {
  if (!user) return '-';
  const output = [user.firstName || user.first_name, user.lastName || user.last_name].filter(Boolean).join(' ');
  return output || text(user.name || user.email, '-');
}

function drawOpdField(doc, label, value, x, y, labelWidth = mm(27), width = mm(86)) {
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7).text(`${label}:`, x, y, {
    width: labelWidth,
    continued: true,
    lineBreak: false
  });
  doc.font('Helvetica').text(` ${text(value, '-')}`, { width: width - labelWidth, ellipsis: true });
}

function vitalDisplay(vitals, key, suffix = '') {
  const value = vitals?.[key];
  return value === null || value === undefined || value === '' ? '-' : `${value}${suffix}`;
}

function drawOpdMedicationTable(doc, prescription, y) {
  const left = PAGE.margin;
  const totalWidth = PAGE.width - PAGE.margin * 2;
  const widths = [mm(8), mm(66), mm(24), mm(25), mm(18), totalWidth - mm(141)];
  const labels = ['#', 'Medicine', 'Dose', 'Frequency', 'Days', 'Instructions'];
  let x = left;
  labels.forEach((label, index) => {
    doc.rect(x, y, widths[index], mm(8)).fillAndStroke(COLORS.header, COLORS.ink);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(6.4).text(label, x + 2, y + mm(2.2), {
      width: widths[index] - 4,
      align: 'center',
      lineBreak: false
    });
    x += widths[index];
  });
  y += mm(8);
  const items = Array.isArray(prescription.items) ? prescription.items : [];
  if (!items.length) {
    doc.rect(left, y, totalWidth, mm(12)).strokeColor(COLORS.ink).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text('No medicines documented.', left + 4, y + mm(3), { width: totalWidth - 8 });
    return y + mm(12);
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const medicine = [item.medicine_name, item.generic_name && item.generic_name !== item.medicine_name ? `(${item.generic_name})` : ''].filter(Boolean).join(' ');
    const values = [index + 1, medicine, item.dosage || '-', item.frequency || '-', item.duration || '-', item.instructions || '-'];
    const height = Math.max(mm(9), Math.min(mm(18), Math.max(...values.map((value, col) => doc.heightOfString(String(value), { width: widths[col] - 5 }))) + mm(3)));
    if (y + height > CONTENT_BOTTOM - mm(10)) {
      doc.addPage();
      y = PAGE.margin;
      x = left;
      labels.forEach((label, col) => {
        doc.rect(x, y, widths[col], mm(8)).fillAndStroke(COLORS.header, COLORS.ink);
        doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(6.4).text(label, x + 2, y + mm(2.2), { width: widths[col] - 4, align: 'center', lineBreak: false });
        x += widths[col];
      });
      y += mm(8);
    }
    x = left;
    values.forEach((value, col) => {
      doc.rect(x, y, widths[col], height).lineWidth(0.35).strokeColor(COLORS.ink).stroke();
      doc.fillColor(COLORS.ink).font(col === 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.4).text(String(value), x + 2, y + mm(2), {
        width: widths[col] - 4,
        height: height - mm(3),
        align: col === 0 ? 'center' : 'left',
        ellipsis: true
      });
      x += widths[col];
    });
    y += height;
  }
  return y;
}

function generateOpdSlipPdf({ res, prescription, hospital, vitals, receipt, printedBy }) {
  const patient = prescription.patient_id || {};
  const doctor = prescription.doctor_id || {};
  const appointment = prescription.appointment_id || {};
  const token = appointment.token || appointment.serial_number || prescription.prescription_number || prescription._id;
  const filename = `opd-slip-${text(token, 'prescription')}.pdf`;
  configureResponse(res, filename);
  const doc = createDocument();
  doc.pipe(res);

  drawDocumentHeader(
    doc,
    hospital,
    'OPD SLIP / PRESCRIPTION',
    doctor.department?.name || doctor.specialization || 'Out Patient Department',
    { barcodeValue: prescription.prescription_number || token }
  );

  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const half = width / 2;
  let y = doc.y;
  drawOpdField(doc, 'Patient Name', fullName(patient), left, y, mm(29), half - mm(3));
  drawOpdField(doc, 'Age / Sex', `${calculateAge(patient.dob)} / ${text(patient.gender, '-')}`, left + half, y, mm(24), half); y += mm(7);
  drawOpdField(doc, 'Consultant', fullName(doctor, 'Dr. '), left, y, mm(29), half - mm(3));
  drawOpdField(doc, 'Mobile No.', patient.phone, left + half, y, mm(24), half); y += mm(7);
  drawOpdField(doc, 'Department', doctor.department?.name || doctor.specialization, left, y, mm(29), half - mm(3));
  drawOpdField(doc, 'Token No.', appointment.token || appointment.serial_number, left + half, y, mm(24), half); y += mm(7);
  drawOpdField(doc, 'Address', [text(patient.address), patient.city, patient.state, patient.zipCode].filter(Boolean).join(', '), left, y, mm(29), width); y += mm(10);

  const vitalsY = y;
  doc.rect(left, vitalsY, width, mm(25)).lineWidth(0.4).strokeColor(COLORS.ink).stroke();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7).text('VITALS', left + 4, vitalsY + 4);
  const vitalItems = [
    ['BP', vitals?.bp || '-'],
    ['SpO2', vitalDisplay(vitals, 'spo2', '%')],
    ['Pulse', vitalDisplay(vitals, 'pulse', '/min')],
    ['RR', vitalDisplay(vitals, 'respiratory_rate', '/min')],
    ['RBS', vitalDisplay(vitals, 'random_blood_sugar')],
    ['Temp', vitalDisplay(vitals, 'temperature')],
    ['Height', vitalDisplay(vitals, 'height', ' cm')],
    ['Weight', vitalDisplay(vitals, 'weight', ' kg')]
  ];
  const cellWidth = width / 4;
  vitalItems.forEach(([label, value], index) => {
    const row = Math.floor(index / 4);
    const col = index % 4;
    drawOpdField(doc, label, value, left + col * cellWidth + 4, vitalsY + mm(8) + row * mm(7), mm(11), cellWidth - 6);
  });
  y = vitalsY + mm(29);

  const opDate = appointment.appointment_date || prescription.createdAt || prescription.issue_date;
  drawOpdField(doc, 'Receipt No.', receipt?.transactionNumber, left, y, mm(29), half - mm(3));
  drawOpdField(doc, 'OP Date', formatDate(opDate, true), left + half, y, mm(24), half); y += mm(7);
  drawOpdField(doc, 'OP No.', appointment.token || prescription.prescription_number, left, y, mm(29), half - mm(3));
  drawOpdField(doc, 'OP Slip UHID No.', patient.uhid || patient.patientId, left + half, y, mm(35), half); y += mm(7);
  drawOpdField(doc, 'Printed By', userDisplayName(printedBy), left, y, mm(29), half - mm(3));
  drawOpdField(doc, 'Created By', userDisplayName(prescription.created_by), left + half, y, mm(24), half); y += mm(10);

  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(COLORS.ink).stroke();
  y += mm(3);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.5).text('Diagnosis / Clinical Notes', left, y, { width });
  y += mm(5);
  const diagnosis = prescription.diagnosis || prescription.provisional_diagnosis || '';
  const diagnosisHeight = Math.max(mm(9), Math.min(mm(20), doc.heightOfString(text(diagnosis, '-'), { width }) + mm(2)));
  doc.font('Helvetica').fontSize(7).text(text(diagnosis, '-'), left, y, { width, height: diagnosisHeight, ellipsis: true });
  y += diagnosisHeight + mm(3);

  doc.font('Helvetica-Bold').fontSize(7.5).text('Prescription', left, y, { width });
  y += mm(5);
  y = drawOpdMedicationTable(doc, prescription, y);
  y += mm(5);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7).text('Doctor Signature: ______________________________', left + width - mm(78), Math.min(y, CONTENT_BOTTOM - mm(8)), { width: mm(78), align: 'right' });
  addPageFooters(doc, 'Computer-generated OPD slip / prescription', { blueRule: true });
  doc.end();
}



async function renderStructuredReportPdf({
  hospital = {},
  title = 'Hospital Report',
  subtitle = '',
  filters = {},
  metrics = [],
  rows = [],
  columns = [],
  generatedAt = new Date(),
  footerLabel = 'Computer-generated hospital report',
  preparedBy = 'MIS / MRD Desk'
}) {
  const discoveredColumns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const resolvedColumns = (columns.length ? columns : discoveredColumns).map((column) => (
    typeof column === 'string' ? { key: column, label: column } : column
  ));
  // MIS/MRD reports are standardised to A4 portrait. Wide source datasets are
  // grouped into concise presentation columns before reaching this renderer.
  const pageSize = { width: mm(210), height: mm(297) };
  const margin = mm(7);
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: margin, right: margin, bottom: mm(11), left: margin },
    bufferPages: true,
    info: { Creator: 'MediQliq HIMS', Title: title }
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const usableWidth = pageSize.width - margin * 2;
  const bottom = pageSize.height - mm(13);
  const period = `${filters.startDate || filters.from || 'All'} to ${filters.endDate || filters.to || 'All'}`;
  const generated = formatDate(generatedAt, true);
  const label = (value) => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const columnKey = (column) => column?.key || String(column || '');
  const columnLabel = (column) => column?.label || label(columnKey(column));
  const scalar = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    if (value instanceof Date) return formatDate(value, true);
    if (typeof value === 'object') return text(value, '—');
    return String(value);
  };

  function drawReportHeader(continued = false) {
    const top = margin;
    const logoSize = mm(12);
    drawHospitalLogo(doc, hospital, margin, top, logoSize);
    const name = hospitalName(hospital);
    const address = text(hospital?.address) || [hospital?.city, hospital?.state].filter(Boolean).join(', ');
    const contact = [hospital?.contact || hospital?.phone || hospital?.phoneNumber, hospital?.email].filter(Boolean).join(' | ');
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(12).text(name, margin + logoSize + mm(2), top + 1, { width: usableWidth * 0.53, ellipsis: true });
    doc.font('Helvetica').fontSize(6.5).fillColor(COLORS.muted).text(address || 'Hospital Management System', margin + logoSize + mm(2), top + mm(5.5), { width: usableWidth * 0.53, ellipsis: true });
    if (contact) doc.text(contact, margin + logoSize + mm(2), top + mm(9), { width: usableWidth * 0.53, ellipsis: true });
    const titleX = margin + usableWidth * 0.66;
    doc.rect(titleX, top, usableWidth * 0.34, mm(14)).lineWidth(0.5).strokeColor(COLORS.ink).stroke();
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8.5).text(String(title).toUpperCase(), titleX + 3, top + mm(3), { width: usableWidth * 0.34 - 6, align: 'center', ellipsis: true });
    doc.font('Helvetica').fontSize(6).text(continued ? 'CONTINUED' : (subtitle || 'HOSPITAL REPORT'), titleX + 3, top + mm(8), { width: usableWidth * 0.34 - 6, align: 'center', ellipsis: true });
    const infoY = top + mm(16);
    const infoH = mm(8);
    const cells = [
      `Period: ${period}`,
      `Grouping: ${filters.grain || filters.period || '—'}`,
      `Generated: ${generated}`,
      `Total records: ${rows.length}`
    ];
    const cellW = usableWidth / 4;
    cells.forEach((value, index) => {
      const x = margin + index * cellW;
      doc.rect(x, infoY, cellW, infoH).lineWidth(0.35).strokeColor(COLORS.border).stroke();
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(6.2).text(value, x + 3, infoY + 4, { width: cellW - 6, height: infoH - 6, ellipsis: true });
    });
    doc.y = infoY + infoH + mm(2);
  }

  function drawMetrics() {
    const visibleMetrics = metrics.filter((metric) => !(metrics.length === 1 && /total\s*records?/i.test(String(metric?.label || ''))));
    if (!visibleMetrics.length) return;
    const values = visibleMetrics.slice(0, 8);
    const cols = Math.min(4, values.length);
    const cellW = usableWidth / cols;
    const rowsCount = Math.ceil(values.length / cols);
    for (let r = 0; r < rowsCount; r += 1) {
      const y = doc.y;
      for (let c = 0; c < cols; c += 1) {
        const metric = values[r * cols + c];
        if (!metric) continue;
        const x = margin + c * cellW;
        doc.rect(x, y, cellW, mm(10)).fillAndStroke(COLORS.panel, COLORS.lightBorder);
        doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(5.8).text(String(metric.label || '').toUpperCase(), x + 4, y + 3, { width: cellW - 8, ellipsis: true });
        doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9).text(scalar(metric.value), x + 4, y + mm(5), { width: cellW - 8, ellipsis: true });
      }
      doc.y = y + mm(10);
    }
    doc.y += mm(2);
  }

  const weights = resolvedColumns.map((column) => {
    const preferredWidth = Number(column?.width || column?.weight || 0);
    return preferredWidth > 0 ? preferredWidth : Math.max(9, Math.min(24, columnLabel(column).length + 3));
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || 1;
  const widths = weights.map((value) => usableWidth * value / weightTotal);

  function drawTableHeader() {
    const y = doc.y;
    const height = mm(9);
    let x = margin;
    doc.save().fillColor(COLORS.header).rect(margin, y, usableWidth, height).fill().restore();
    resolvedColumns.forEach((column, index) => {
      doc.rect(x, y, widths[index], height).lineWidth(0.35).strokeColor(COLORS.border).stroke();
      doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(6.1).text(columnLabel(column), x + 2.5, y + 3, { width: widths[index] - 5, height: height - 5, ellipsis: true });
      x += widths[index];
    });
    doc.y = y + height;
  }

  function newPage() {
    doc.addPage();
    drawReportHeader(true);
    drawTableHeader();
  }

  drawReportHeader(false);
  drawMetrics();
  if (resolvedColumns.length) drawTableHeader();
  if (!rows.length || !resolvedColumns.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('No detailed records for the selected report and filters.', margin, doc.y + mm(8), { width: usableWidth, align: 'center' });
  } else {
    rows.forEach((row, rowIndex) => {
      const values = resolvedColumns.map((column) => scalar(row?.[columnKey(column)]));
      const rowHeight = Math.max(mm(7), Math.min(mm(18), ...values.map((value, index) => doc.font('Helvetica').fontSize(6).heightOfString(value, { width: widths[index] - 5 }) + 5)));
      if (doc.y + rowHeight > bottom) newPage();
      const y = doc.y;
      let x = margin;
      if (rowIndex % 2 === 1) doc.save().fillColor('#fbfdff').rect(margin, y, usableWidth, rowHeight).fill().restore();
      values.forEach((value, index) => {
        doc.rect(x, y, widths[index], rowHeight).lineWidth(0.25).strokeColor(COLORS.lightBorder).stroke();
        doc.fillColor(COLORS.ink).font('Helvetica').fontSize(6).text(value, x + 2.5, y + 3, { width: widths[index] - 5, height: rowHeight - 5, ellipsis: true });
        x += widths[index];
      });
      doc.y = y + rowHeight;
    });
  }

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const pageNo = index - range.start + 1;
    const footerY = pageSize.height - mm(8);
    doc.moveTo(margin, footerY - 4).lineTo(pageSize.width - margin, footerY - 4).lineWidth(0.35).strokeColor(COLORS.lightBorder).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(5.8).text(`${footerLabel} · Prepared by ${preparedBy}`, margin, footerY, { width: usableWidth - mm(35), lineBreak: false });
    doc.text(`Page ${pageNo} of ${range.count}`, pageSize.width - margin - mm(35), footerY, { width: mm(35), align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { generateLabReportPdf, generatePrescriptionPdf, generateOpdSlipPdf, renderStructuredReportPdf };
