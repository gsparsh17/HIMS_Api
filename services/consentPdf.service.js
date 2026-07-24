const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const PDFDocument = require('pdfkit');

const mm = (v) => v * 2.834645669;
const PAGE = { width: mm(210), height: mm(297), margin: mm(7) };
const C = { ink: '#111111', border: '#222222', muted: '#444444', pale: '#f7f7f7' };

function firstExisting(paths) {
  return paths.filter(Boolean).find((candidate) => {
    try { return fs.existsSync(candidate); } catch (_) { return false; }
  });
}

function fontConfigMatch(pattern) {
  try {
    const result = execFileSync('fc-match', ['-f', '%{file}', pattern], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return result && fs.existsSync(result) ? result : undefined;
  } catch (_) {
    return undefined;
  }
}

const DEV_REG = firstExisting([
  process.env.DEVANAGARI_FONT_PATH,
  path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansDevanagari-Regular.ttf'),
  path.join(process.cwd(), 'assets', 'fonts', 'NotoSansDevanagari-Regular.ttf'),
  '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansDevanagariUI-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansDevanagari-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansDevanagariUI-Regular.ttf',
  '/usr/local/share/fonts/NotoSansDevanagari-Regular.ttf'
]) || fontConfigMatch('Noto Sans Devanagari');

const DEV_BOLD = firstExisting([
  process.env.DEVANAGARI_BOLD_FONT_PATH,
  path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansDevanagari-Bold.ttf'),
  path.join(process.cwd(), 'assets', 'fonts', 'NotoSansDevanagari-Bold.ttf'),
  '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansDevanagariUI-Bold.ttf',
  '/usr/share/opentype/noto/NotoSansDevanagari-Bold.ttf',
  '/usr/share/opentype/noto/NotoSansDevanagariUI-Bold.ttf',
  '/usr/local/share/fonts/NotoSansDevanagari-Bold.ttf'
]) || fontConfigMatch('Noto Sans Devanagari:style=Bold') || DEV_REG;

function assertFontsAvailable() {
  if (!DEV_REG) {
    throw new Error(
      'Devanagari font is required for consent PDFs. Install Noto Sans Devanagari or set DEVANAGARI_FONT_PATH.'
    );
  }
}

const clean = (v, fallback = '') => {
  if (v === null || v === undefined) return fallback;
  if (Array.isArray(v)) return v.filter(Boolean).join(', ') || fallback;
  if (typeof v === 'boolean') return v ? 'Yes / हाँ' : 'No / नहीं';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() || fallback;
};

const fullName = (p = {}) => [p.first_name || p.firstName, p.middle_name || p.middleName, p.last_name || p.lastName].filter(Boolean).join(' ');
const age = (dob) => { if (!dob) return '-'; const d = new Date(dob); if (Number.isNaN(d.getTime())) return '-'; const n = new Date(); let y = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) y--; return `${Math.max(0, y)}`; };
const dateText = (v) => { if (!v) return '-'; const d = new Date(v); return Number.isNaN(d.getTime()) ? clean(v, '-') : d.toLocaleString('en-IN'); };

function setupFonts(doc) {
  assertFontsAvailable();
  doc.registerFont('Dev', DEV_REG);
  doc.registerFont('DevBold', DEV_BOLD || DEV_REG);
}
function font(doc, bold = false) { doc.font(bold ? 'DevBold' : 'Dev'); }
function t(doc, text, x, y, opts = {}, bold = false, size = 8.2) { font(doc, bold); doc.fillColor(C.ink).fontSize(size).text(clean(text), x, y, opts); }
function fitHeight(doc, text, width, size = 8.2, bold = false, lineGap = 1.5) { font(doc, bold); doc.fontSize(size); return doc.heightOfString(clean(text), { width, lineGap }); }
function ensure(doc, h, redraw) { if (doc.y + h <= PAGE.height - PAGE.margin - mm(5)) return; doc.addPage(); redraw(false); }

async function fetchImageBuffer(urlOrData) {
  if (!urlOrData || typeof urlOrData !== 'string') return null;
  const trimmed = urlOrData.trim();
  if (trimmed.startsWith('data:image/png;base64,') || trimmed.startsWith('data:image/jpeg;base64,') || trimmed.startsWith('data:image/jpg;base64,')) {
    try {
      const b64 = trimmed.split(',')[1];
      return Buffer.from(b64, 'base64');
    } catch (_) { return null; }
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return new Promise((resolve) => {
      const client = trimmed.startsWith('https://') ? https : http;
      client.get(trimmed, (res) => {
        if (res.statusCode !== 200) return resolve(null);
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    });
  }
  if (fs.existsSync(trimmed)) {
    try { return fs.readFileSync(trimmed); } catch (_) { return null; }
  }
  return null;
}

function header(doc, hospital, admission, template, showDetails = true) {
  const x = PAGE.margin, w = PAGE.width - 2 * x;
  doc.rect(x, doc.y || x, w, mm(28)).stroke();
  const y = doc.y || x;
  t(doc, hospital?.name || hospital?.hospitalName || 'CITY MULTI-SPECIALTY HOSPITAL', x + mm(4), y + mm(3), { width: w - mm(8) }, true, 12);
  t(doc, hospital?.address || 'Plot 45, Sector 12, Dwarka, New Delhi', x + mm(4), y + mm(9), { width: w - mm(8) }, false, 8);
  t(doc, template.name || 'Consent Form', x + mm(4), y + mm(16), { width: w - mm(8) }, true, 11);
  if (template.bilingualName) t(doc, template.bilingualName, x + mm(4), y + mm(21), { width: w - mm(8) }, false, 8.5);
  doc.y = y + mm(29);
  if (showDetails && admission) {
    const pt = admission.patientId || {};
    const h = mm(16);
    doc.rect(x, doc.y, w, h).stroke();
    const cy = doc.y;
    const c1 = mm(65), c2 = mm(55), c3 = mm(45);
    t(doc, `Patient: ${fullName(pt) || pt.name || '-'}`, x + mm(3), cy + mm(2), { width: c1 - mm(4) }, true, 8);
    t(doc, `Age/Gender: ${age(pt.dob)} Y / ${clean(pt.gender, '-')}`, x + mm(3), cy + mm(8), { width: c1 - mm(4) }, false, 7.8);
    t(doc, `UHID: ${clean(pt.uhid, '-')}`, x + c1 + mm(2), cy + mm(2), { width: c2 - mm(4) }, true, 8);
    t(doc, `Admission: ${clean(admission.admissionNumber, '-')}`, x + c1 + mm(2), cy + mm(8), { width: c2 - mm(4) }, false, 7.8);
    t(doc, `Ward/Room: ${clean(admission.wardId?.name, '-')} / ${clean(admission.bedId?.bedNumber, '-')}`, x + c1 + c2 + mm(2), cy + mm(2), { width: c3 - mm(4) }, false, 7.8);
    t(doc, `Doctor: ${clean(admission.primaryDoctorId?.name || admission.primaryDoctorId?.firstName, '-')}`, x + c1 + c2 + mm(2), cy + mm(8), { width: c3 - mm(4) }, false, 7.8);
    doc.y = cy + h + mm(2);
  }
}

function section(doc, title, txt, redraw, lineGap = 1.2, bodySize = 7.8) {
  const x = PAGE.margin, w = PAGE.width - 2 * x;
  const h = fitHeight(doc, txt, w - mm(10), bodySize, false, lineGap) + mm(15);
  ensure(doc, h, redraw);
  const y = doc.y;
  doc.rect(x, y, w, h).stroke();
  t(doc, title, x + mm(4), y + mm(3), { width: w - mm(8) }, true, 8.8);
  t(doc, txt, x + mm(5), y + mm(11), { width: w - mm(10), height: h - mm(14), lineGap }, false, bodySize);
  doc.y = y + h;
}

function responseValue(spec, responses) { if (typeof spec === 'string' && spec.startsWith('response:')) return clean(responses[spec.slice(9)], '-'); return spec; }

function responseTable(doc, template, responses, redraw) {
  const fields = (template.fields || []).filter(f => !['patientOrRepresentativeName', 'relationship', 'patientSignature', 'patientSignatureUrl', 'doctorName', 'doctorSignature', 'doctorSignatureUrl', 'doctorSealUrl', 'witnessName', 'witnessSignature', 'witnessSignatureUrl', 'interpreterName', 'signedDate', 'signedTime'].includes(f.key));
  if (!fields.length) return;
  section(doc, 'Recorded Form Responses / दर्ज किए गए उत्तर', 'The following values were recorded in the electronic consent form. / इलेक्ट्रॉनिक सहमति प्रपत्र में निम्न जानकारी दर्ज की गई है।', redraw);
  const x = PAGE.margin, w = PAGE.width - 2 * x, lw = mm(78);
  fields.forEach(f => {
    const v = responses[f.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    const value = clean(v, '-');
    const h = Math.max(mm(12), fitHeight(doc, value, w - lw - mm(8), 7.6, false, 1) + mm(6), fitHeight(doc, f.label, lw - mm(7), 7.2, true, 1) + mm(6));
    ensure(doc, h, redraw);
    const y = doc.y;
    doc.rect(x, y, w, h).stroke();
    doc.moveTo(x + lw, y).lineTo(x + lw, y + h).stroke();
    t(doc, f.label, x + mm(3), y + mm(3), { width: lw - mm(6), lineGap: 1 }, true, 7.2);
    t(doc, value, x + lw + mm(3), y + mm(3), { width: w - lw - mm(6), lineGap: 1 }, false, 7.6);
    doc.y = y + h;
  });
}

function signatures(doc, responses, templateId, redraw, sigBuffers = {}) {
  const x = PAGE.margin, w = PAGE.width - 2 * x, cols = [mm(52), mm(64), mm(49), w - mm(165)], headH = mm(17), rowH = mm(24);
  const clinician = templateId === 'anaesthesia-consent' ? 'Anaesthetist / एनेस्थेटिस्ट' : templateId === 'surgery-consent' || templateId === 'restraint-consent' ? 'Surgeon / शल्य चिकित्सक' : 'Doctor / चिकित्सक';
  const rows = [
    ['Patient / Authorized Representative\nमरीज / अधिकृत प्रतिनिधि', responses.patientOrRepresentativeName || responses.requestingPersonName || responses.guardianName, sigBuffers.patient],
    [clinician, responses.doctorName, sigBuffers.doctor, sigBuffers.doctorSeal],
    ['Witness / गवाह', responses.witnessName, sigBuffers.witness]
  ];
  if (templateId !== 'mlc-refusal-consent' && templateId !== 'blood-transfusion-consent') rows.push(['Interpreter / अनुवादक', responses.interpreterName, null]);
  
  const total = headH + rows.length * rowH + mm(23);
  ensure(doc, total, redraw);
  const y = doc.y;
  doc.rect(x, y, w, total).stroke();
  let cx = x;
  cols.slice(0, -1).forEach(c => { cx += c; doc.moveTo(cx, y).lineTo(cx, y + headH + rows.length * rowH).stroke(); });
  doc.moveTo(x, y + headH).lineTo(x + w, y + headH).stroke();
  for (let i = 1; i < rows.length; i++) doc.moveTo(x, y + headH + i * rowH).lineTo(x + w, y + headH + i * rowH).stroke();
  
  const hs = ['Details Required\nआवश्यक विवरण', 'Name & Relation\nनाम एवं संबंध', 'Signature / Seal / Thumb Impression\nहस्ताक्षर / मुहर / अंगूठा निशान', 'Date & Time\nदिनांक एवं समय'];
  cx = x;
  hs.forEach((h, i) => { t(doc, h, cx + mm(2), y + mm(2), { width: cols[i] - mm(4), lineGap: .5 }, true, 7.4); cx += cols[i]; });
  
  rows.forEach((r, i) => {
    const ry = y + headH + i * rowH;
    t(doc, r[0], x + mm(2), ry + mm(3), { width: cols[0] - mm(4), lineGap: .5 }, true, 7.2);
    t(doc, clean(r[1], ''), x + cols[0] + mm(2), ry + mm(3), { width: cols[1] - mm(4) }, false, 7.4);
    
    const sigBuf = r[2];
    const sealBuf = r[3];
    const sigX = x + cols[0] + cols[1] + mm(2);
    const sigW = cols[2] - mm(4);
    
    if (sigBuf) {
      try {
        doc.image(sigBuf, sigX, ry + mm(2), { fit: [sealBuf ? mm(24) : sigW, rowH - mm(4)] });
      } catch (e) {
        console.error('PDFKit signature render error:', e);
      }
    }
    if (sealBuf) {
      try {
        doc.image(sealBuf, sigX + mm(25), ry + mm(2), { fit: [mm(20), rowH - mm(4)] });
      } catch (e) {
        console.error('PDFKit seal render error:', e);
      }
    }
    
    if (i === 0) t(doc, `${clean(responses.signedDate, '')} ${clean(responses.signedTime, '')}`, x + cols[0] + cols[1] + cols[2] + mm(2), ry + mm(3), { width: cols[3] - mm(4) }, false, 7.2);
  });
  
  const ny = y + headH + rows.length * rowH;
  t(doc, 'Note / टिप्पणी:', x + mm(5), ny + mm(3), {}, true, 7.5);
  t(doc, '1. If patient cannot consent or is a minor, an authorized representative may consent. / रोगी असमर्थ या नाबालिग होने पर अधिकृत प्रतिनिधि सहमति दे सकता है।\n2. A witness must be an adult of sound mind. / गवाह वयस्क और स्वस्थ मस्तिष्क का होना चाहिए।', x + mm(11), ny + mm(8), { width: w - mm(16), lineGap: 1 }, false, 6.7);
  doc.y = y + total;
}

const BODY = {
  'surgery-consent': [
    ['1. Procedure Name / प्रक्रिया का नाम', 'response:procedureName'],
    ['2. Benefits & Risks / लाभ एवं जोखिम', {
      columns: [
        ['Benefits / लाभ', '1. Improves or corrects the medical condition for which surgery is performed.\n2. May prevent worsening and life-threatening complications.\n3. Can relieve pain, improve function and quality of life.\n4. In some cases surgery is the only effective treatment.\n\n1. जिस बीमारी के लिए शल्य चिकित्सा की जा रही है, उसमें सुधार या उपचार।\n2. बीमारी बिगड़ने और जानलेवा जटिलताओं से बचाव।\n3. दर्द में राहत, कार्यक्षमता और जीवन की गुणवत्ता में सुधार।\n4. कुछ मामलों में यही एकमात्र प्रभावी उपचार होता है।'],
        ['Risks / जोखिम', '1. Bleeding during or after surgery.\n2. Infection.\n3. Anaesthesia reaction.\n4. Injury to nearby organs, tissues or blood vessels.\n5. Incomplete cure or recurrence.\n6. Further surgery may be required.\n7. Pain, swelling or delayed healing.\n8. Disability or death (rare).\n\n1. ऑपरेशन के दौरान या बाद में रक्तस्राव।\n2. संक्रमण।\n3. एनेस्थीसिया से प्रतिक्रिया।\n4. आसपास के अंगों/ऊतकों को चोट।\n5. बीमारी पूरी तरह ठीक न होना या दोबारा होना।\n6. पुनः सर्जरी की आवश्यकता।\n7. दर्द, सूजन या घाव भरने में देरी।\n8. विकलांगता या मृत्यु (दुर्लभ)।']
      ]
    }],
    ['3. Consent Statement / सहमति वक्तव्य', 'I have had the opportunity to ask questions. I understand that every operation/procedure involves risks and voluntarily consent to the proposed operation/procedure, including medically necessary additional procedures arising from unforeseen conditions.\n\nमुझे प्रश्न पूछने का अवसर दिया गया और संतोषजनक उत्तर मिले। मैं समझता/समझती हूँ कि प्रत्येक ऑपरेशन/प्रक्रिया में जोखिम होते हैं और प्रस्तावित प्रक्रिया तथा अप्रत्याशित स्थिति में चिकित्सकीय रूप से आवश्यक अतिरिक्त प्रक्रिया के लिए स्वेच्छा से सहमति देता/देती हूँ।']
  ],
  'blood-transfusion-consent': [
    ['1. Type of Blood / रक्त का प्रकार', 'response:bloodComponents'],
    ['Blood Group / रक्त समूह', 'response:bloodGroup'], ['Rh Type / आरएच प्रकार', 'response:rhType'],
    ['2. Benefits / लाभ', 'Transfusion may restore blood volume, improve oxygen delivery, correct anaemia, control bleeding and support recovery.\nरक्त चढ़ाने से रक्त की मात्रा और ऑक्सीजन आपूर्ति सुधर सकती है, एनीमिया तथा रक्तस्राव नियंत्रित हो सकता है और स्वस्थ होने में सहायता मिलती है।'],
    ['3. Possible Risks & Complications / संभावित जोखिम एवं जटिलताएँ', 'Allergic reaction, fever, chills, breathing difficulty, low blood pressure, infection despite screening, iron overload, lung injury and vein-puncture risks. Rare severe reactions may lead to kidney failure, shock, anaphylaxis, sepsis, multi-organ failure or death.\nएलर्जी, बुखार, कंपकंपी, सांस में कठिनाई, कम रक्तचाप, जांच के बावजूद संक्रमण, आयरन की अधिकता, फेफड़ों की चोट तथा नस में सुई लगाने के जोखिम हो सकते हैं। दुर्लभ गंभीर प्रतिक्रिया से गुर्दा विफलता, शॉक, एनाफिलैक्सिस, सेप्सिस, बहु-अंग विफलता या मृत्यु हो सकती है।'],
    ['5. Consent Statement / सहमति वक्तव्य', 'I have been informed about the need, benefits, risks and alternatives of blood transfusion and voluntarily permit the medical and nursing staff to administer the above blood/blood components.\nमुझे रक्त चढ़ाने की आवश्यकता, लाभ, जोखिम तथा विकल्प समझाए गए हैं और मैं उपरोक्त रक्त/रक्त घटक देने हेतु सहमति देता/देती हूँ।']
  ],
  'high-risk-consent': [
    ['Diagnosis / प्राथमिक बीमारी', 'response:diagnosis'], ['Procedure Name (If Applicable) / प्रक्रिया का नाम (यदि लागू हो)', 'response:procedureName'],
    ['High-Risk Reasons / उच्च जोखिम के कारण', 'response:highRiskReasons'],
    ['Possible Risks / संभावित जोखिम', 'response:risksAccepted'],
    ['Declaration / घोषणा', 'The doctor has explained the illness, proposed treatment/procedure, benefits, limitations, alternatives and possible complications. I understand that despite best care the outcome cannot be guaranteed and voluntarily consent to treatment.\nडॉक्टर ने बीमारी, प्रस्तावित उपचार/प्रक्रिया, लाभ, सीमाएँ, विकल्प और संभावित जटिलताएँ समझाई हैं। मैं समझता/समझती हूँ कि सर्वोत्तम देखभाल के बावजूद परिणाम की गारंटी नहीं दी जा सकती और स्वेच्छा से उपचार हेतु सहमति देता/देती हूँ।']
  ]
};

async function generateConsentPdf({ consent, template, admission, hospital, res }) {
  const responses = consent.responses || {};
  const [patientSig, doctorSig, doctorSeal, witnessSig] = await Promise.all([
    fetchImageBuffer(responses.patientSignatureUrl || responses.patientSignature),
    fetchImageBuffer(responses.doctorSignatureUrl || responses.doctorSignature),
    fetchImageBuffer(responses.doctorSealUrl || responses.doctorSeal),
    fetchImageBuffer(responses.witnessSignatureUrl || responses.witnessSignature)
  ]);
  const sigBuffers = { patient: patientSig, doctor: doctorSig, doctorSeal: doctorSeal, witness: witnessSig };

  const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin }, bufferPages: true, info: { Creator: 'MediQliq HIMS' } });
  setupFonts(doc);
  const filename = `${admission.admissionNumber || 'IPD'}-${template.id}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);

  const redraw = (show = true) => header(doc, hospital, admission, template, show);
  redraw(true);

  if (template.id === 'anaesthesia-consent') anaesthesia(doc, responses, () => redraw(false));
  else (BODY[template.id] || []).forEach(([title, b]) => section(doc, title, responseValue(b, responses), () => redraw(false)));

  responseTable(doc, template, responses, () => redraw(false));
  if (consent.notes) section(doc, 'Additional Notes / अतिरिक्त टिप्पणी', clean(consent.notes), () => redraw(false));
  signatures(doc, responses, template.id, () => redraw(false), sigBuffers);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    font(doc, false);
    doc.fillColor(C.muted).fontSize(5.8).text(
      `Consent status: ${clean(consent.status, '-')} | Recorded: ${dateText(consent.completedAt || consent.updatedAt)} | Page ${i - range.start + 1} of ${range.count}`,
      PAGE.margin,
      PAGE.height - PAGE.margin - mm(3.5),
      { width: PAGE.width - 2 * PAGE.margin, height: mm(3), align: 'right', lineBreak: false }
    );
  }
  doc.end();
}

module.exports = { generateConsentPdf };
