const fs = require('fs');
const path = require('path');
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
    ['5. Consent Statement / सहमति वक्तव्य', 'I have been informed about the need, benefits, risks and alternatives of blood transfusion and voluntarily permit the medical and nursing staff to administer the above blood/blood components.\nमुझे रक्त चढ़ाने की आवश्यकता, लाभ, जोखिम तथा विकल्प समझाए गए हैं और मैं उपरोक्त रक्त/रक्त घटक देने हेतु चिकित्सा एवं नर्सिंग स्टाफ को स्वेच्छा से अनुमति देता/देती हूँ।']
  ],
  'high-risk-consent': [
    ['Diagnosis / प्राथमिक बीमारी', 'response:diagnosis'], ['Procedure Name (If Applicable) / प्रक्रिया का नाम (यदि लागू हो)', 'response:procedureName'],
    ['High-Risk Reasons / उच्च जोखिम के कारण', 'response:highRiskReasons'],
    ['Possible Risks / संभावित जोखिम', 'response:risksAccepted'],
    ['Declaration / घोषणा', 'The doctor has explained the illness, proposed treatment/procedure, benefits, limitations, alternatives and possible complications. I understand that despite best care the outcome cannot be guaranteed and voluntarily consent to treatment.\nडॉक्टर ने बीमारी, प्रस्तावित उपचार/प्रक्रिया, लाभ, सीमाएँ, विकल्प और संभावित जटिलताएँ समझाई हैं। मैं समझता/समझती हूँ कि सर्वोत्तम देखभाल के बावजूद परिणाम की गारंटी नहीं दी जा सकती और स्वेच्छा से उपचार हेतु सहमति देता/देती हूँ।']
  ],
  'mlc-refusal-consent': [
    ['Information Provided to Patient / रोगी को दी गई जानकारी', 'The attending doctor explained the meaning of MLC, why registration was advised, legal implications of registration/refusal, and possible effects on legal protection, insurance and medico-legal support.\nउपस्थित चिकित्सक ने MLC का अर्थ, पंजीकरण की आवश्यकता, पंजीकरण/अस्वीकृति के कानूनी प्रभाव तथा कानूनी सुरक्षा, बीमा और मेडिको-लीगल सहायता पर संभावित प्रभाव समझाए हैं।'],
    ['Reason MLC Was Recommended / MLC की सलाह का कारण', 'response:reasonMLCRecommended'],
    ["Patient's Statement of Refusal / रोगी का अस्वीकृति वक्तव्य", 'Despite being fully informed, I voluntarily refuse MLC registration without pressure, influence or coercion.\nपूरी जानकारी मिलने के बावजूद मैं बिना किसी दबाव, प्रभाव या जोर-जबरदस्ती के स्वेच्छा से MLC पंजीकरण से इंकार करता/करती हूँ।'],
    ['Reason for Refusal / अस्वीकृति का कारण', 'response:refusalReason'],
    ['Declaration of Responsibility / जिम्मेदारी की घोषणा', 'I understand that I may lose legal protection and accept responsibility for consequences arising from this refusal. The hospital and doctors will not be responsible for legal consequences caused by my decision.\nमैं समझता/समझती हूँ कि कानूनी सुरक्षा प्रभावित हो सकती है और इस निर्णय के परिणामों की जिम्मेदारी स्वीकार करता/करती हूँ। मेरे निर्णय से उत्पन्न कानूनी परिणामों के लिए अस्पताल और चिकित्सक जिम्मेदार नहीं होंगे।']
  ],
  'lama-dor-consent': [
    ['CONSENT - LAMA / DOR / चिकित्सकीय सलाह के विरुद्ध छुट्टी', 'I request discharge against medical advice/on request and take responsibility for this decision. The patient condition, recommended continued treatment and consequences of leaving have been explained.\nमैं चिकित्सकीय सलाह के विरुद्ध/अनुरोध पर छुट्टी चाहता/चाहती हूँ और इस निर्णय की जिम्मेदारी स्वीकार करता/करती हूँ। रोगी की स्थिति, आगे उपचार की आवश्यकता और अस्पताल छोड़ने के परिणाम मुझे समझाए गए हैं।'],
    ['Person Requesting Discharge / छुट्टी का अनुरोध करने वाला', 'response:requestingPersonName'],
    ['Relationship / संबंध', 'response:requestingPersonRelation'], ['Reason for Leaving / जाने का कारण', 'response:reasonForLeaving'],
    ['Doctor Certification / डॉक्टर का प्रमाणन', 'response:doctorCertification']
  ],
  'restraint-consent': [
    ['INFORMED CONSENT FOR RESTRICTION OF LIMBS IN AGITATED PATIENTS / उत्तेजित रोगी में अंग प्रतिबंध हेतु सूचित सहमति', 'I acknowledge that the medical and nursing team explained the need for temporary physical restraint because of agitation/aggressive behaviour.\nमैं स्वीकार करता/करती हूँ कि चिकित्सा एवं नर्सिंग टीम ने उत्तेजना/आक्रामक व्यवहार के कारण अस्थायी शारीरिक प्रतिबंध की आवश्यकता समझाई है।'],
    ['1. Reason for Containment / प्रतिबंध लगाने का कारण', 'response:reasonForRestraint'],
    ['2. Objective / उद्देश्य', 'Restraint is used to protect the patient, staff and others from injury and to safely perform necessary medical care.\nप्रतिबंध का उद्देश्य रोगी, स्टाफ और अन्य व्यक्तियों को चोट से बचाना तथा आवश्यक चिकित्सा देखभाल सुरक्षित रूप से करना है।'],
    ['3. Procedures and Care / प्रक्रिया एवं देखभाल', 'Restraint will be humane, use safe equipment, preserve dignity and comfort, include vital-sign and circulation monitoring, periodic reassessment and removal as soon as safe.\nप्रतिबंध मानवीय तरीके और सुरक्षित उपकरणों से लगाया जाएगा; गरिमा व आराम बनाए रखे जाएंगे; जीवन संकेत व रक्तसंचार की निगरानी, समय-समय पर पुनर्मूल्यांकन और सुरक्षित होते ही हटाना सुनिश्चित होगा।'],
    ['Monitoring Plan / निगरानी योजना', 'response:monitoringPlan'], ['Alternatives Attempted / पहले किए गए विकल्प', 'response:alternativesAttempted'],
    ['4. Clarifications and Consent / स्पष्टीकरण एवं सहमति', 'I understand the reasons, benefits, risks, alternatives and temporary nature of restraint and authorize its use according to the medical team assessment.\nमैं प्रतिबंध के कारण, लाभ, जोखिम, विकल्प और अस्थायी प्रकृति समझता/समझती हूँ तथा चिकित्सा दल के आकलन के अनुसार इसके उपयोग की अनुमति देता/देती हूँ।']
  ],
  'hiv-serology-consent': [
    ['INTRODUCTION / परिचय', 'HIV is a virus that can cause AIDS and may spread through unprotected sexual contact, shared needles, infected blood products, or from mother to child. The test detects the body response to HIV and does not directly detect the virus.\nएचआईवी एक वायरस है जो एड्स का कारण बन सकता है और असुरक्षित यौन संबंध, साझा सुई, संक्रमित रक्त उत्पाद या माँ से बच्चे में फैल सकता है। जांच शरीर की एचआईवी के प्रति प्रतिक्रिया पहचानती है, वायरस को सीधे नहीं।'],
    ['Reason for Test / जांच का कारण', 'response:reasonForTest'],
    ['WHAT THE TEST MEANS / जांच का अर्थ', 'A non-reactive result may not exclude recent infection during the window period and repeat testing may be needed. A reactive or unclear result requires confirmatory testing.\nनॉन-रिएक्टिव परिणाम विंडो पीरियड में हाल का संक्रमण पूरी तरह नकार नहीं सकता और दोबारा जांच आवश्यक हो सकती है। रिएक्टिव या अस्पष्ट परिणाम के लिए पुष्टि जांच आवश्यक है।'],
    ['BENEFIT OF BEING TESTED / जांच के लाभ', 'Knowing HIV status can reduce anxiety, guide medical care, support prevention and enable early access to treatment.\nएचआईवी स्थिति जानने से चिंता कम हो सकती है, चिकित्सा देखभाल का मार्गदर्शन होता है, रोकथाम में सहायता मिलती है और शीघ्र उपचार उपलब्ध हो सकता है।'],
    ['DECLARATION / घोषणा', 'The contents have been read and explained in a language I understand. I understand the implications, confidentiality, possible results and voluntary nature of testing and give consent.\nइस प्रपत्र की सामग्री मुझे समझ आने वाली भाषा में पढ़कर समझाई गई है। मैं प्रभाव, गोपनीयता, संभावित परिणाम और जांच की स्वैच्छिक प्रकृति समझकर सहमति देता/देती हूँ।']
  ]
};

const ANA = [
  ['General Anaesthesia / सामान्य एनेस्थीसिया', 'Patient is fully unconscious / रोगी पूरी तरह बेहोश रहता है', 'Complete pain relief; no memory; suitable for major surgery. / पूर्ण दर्द राहत; प्रक्रिया की स्मृति नहीं; बड़ी सर्जरी के लिए उपयुक्त।', 'Nausea, vomiting, sore throat, breathing/cardiac issues, rare awareness. / मतली, उल्टी, गले में खराश, सांस/हृदय समस्या, दुर्लभ जागरूकता।', 'General Anaesthesia'],
  ['Regional Anaesthesia / क्षेत्रीय एनेस्थीसिया', 'A specific region is numbed / शरीर का विशेष भाग सुन्न किया जाता है', 'Avoids full unconsciousness; faster recovery; good pain control. / पूरी बेहोशी से बचाव; तेज रिकवरी; प्रभावी दर्द नियंत्रण।', 'Headache, rare nerve injury, incomplete block, low BP. / सिरदर्द, दुर्लभ नस चोट, अधूरा ब्लॉक, कम रक्तचाप।', 'Regional Anaesthesia'],
  ['Local Anaesthesia / स्थानीय एनेस्थीसिया', 'A small area is numbed / छोटा क्षेत्र सुन्न किया जाता है', 'Minimal systemic effect; quick recovery. / शरीर पर कम प्रभाव; तेज रिकवरी।', 'Allergy, inadequate pain control, swelling/bruising. / एलर्जी, दर्द नियंत्रण में कमी, सूजन/नील।', 'Local Anaesthesia'],
  ['Sedation / MAC / शिथिलीकरण', 'Relaxed, semi-conscious and monitored / शांत, आंशिक रूप से सचेत और निगरानी में', 'Reduced anxiety; breathing maintained; faster recovery. / चिंता कम; स्वयं सांस; तेज रिकवरी।', 'Over-sedation, allergy, incomplete sedation. / अधिक शिथिलीकरण, एलर्जी, अधूरा शिथिलीकरण।', 'Sedation / MAC'],
  ['Invasive Procedure (Spinal/Epidural/Nerve Block) / इनवेसिव प्रक्रिया', 'Targeted anaesthesia by injection / इंजेक्शन द्वारा लक्षित एनेस्थीसिया', 'Targeted pain relief; less systemic medicine. / लक्षित दर्द राहत; पूरे शरीर में कम दवा।', 'Infection, bleeding/hematoma, rare nerve damage, spinal headache. / संक्रमण, रक्तस्राव, दुर्लभ नस क्षति, स्पाइनल सिरदर्द।', 'Invasive Procedure']
];

function header(doc, hospital, admission, template, showInfo = true) {
  const x = PAGE.margin, w = PAGE.width - 2 * x, top = PAGE.margin, titleW = mm(74), patient = admission.patientId || {};
  doc.rect(x, top, w, mm(25)).lineWidth(.8).stroke(C.border);
  t(doc, clean(hospital?.hospitalName || hospital?.name, 'HOSPITAL').toUpperCase(), x + mm(3), top + mm(4), { width: w - titleW - mm(8), height: mm(8), ellipsis: true }, true, 13);
  t(doc, [hospital?.address, hospital?.city, hospital?.state, hospital?.pinCode].filter(Boolean).join(', '), x + mm(3), top + mm(13), { width: w - titleW - mm(8), height: mm(8), ellipsis: true }, false, 6.8);
  doc.moveTo(x + w - titleW, top + mm(2)).lineTo(x + w - titleW, top + mm(23)).stroke();
  t(doc, `${template.name}\n${template.bilingualName || ''}`, x + w - titleW + mm(3), top + mm(4), { width: titleW - mm(6), align: 'left', lineGap: 1 }, true, 11.5);
  doc.y = top + mm(25);
  if (!showInfo) return;
  const wardName =
    admission.wardId?.name ||
    admission.wardId?.wardName ||
    '-';

  const bedNumber =
    admission.bedId?.bedNumber ||
    admission.bedId?.name ||
    '-';
  const y = doc.y, h = mm(31), labelW = mm(42), leftW = w - labelW;
  doc.rect(x, y, w, h).stroke(); doc.moveTo(x + leftW, y).lineTo(x + leftW, y + h).stroke();
  t(doc, 'Affix Patient Label here\nमरीज का लेबल यहाँ लगाएँ', x + leftW + mm(3), y + mm(9), { width: labelW - mm(6), align: 'center' }, false, 8);
  const line = (label, hi, value, lx, ly, lw) => { t(doc, `${label}  ${clean(value, '-')}`, lx, ly, { width: lw, height: mm(6), ellipsis: true }, false, 7.7); t(doc, hi, lx, ly + mm(4.2), { width: lw, height: mm(4), ellipsis: true }, false, 6.3); };
  line('Patient Name:', 'रोगी का नाम', fullName(patient), x + mm(3), y + mm(4), mm(105)); line('Age/Gender:', 'आयु / लिंग', `${age(patient.dob)} / ${clean(patient.gender, '-')}`, x + mm(111), y + mm(4), leftW - mm(114));
  line(
    'Patient UHID:',
    'यूनिक हेल्थ आईडी',
    patient.patientId || patient.uhid,
    x + mm(3),
    y + mm(13),
    mm(72)
  );

  line(
    'IPD:',
    'आई. पी. डी.',
    admission.admissionNumber,
    x + mm(78),
    y + mm(13),
    leftW - mm(81)
  );

  line(
    'Ward/Bed No.:',
    'वार्ड / बेड नं.',
    `${wardName} / ${bedNumber}`,
    x + mm(3),
    y + mm(22),
    mm(82)
  );

  line(
    'Diagnosis:',
    'डायग्नोसिस',
    admission.finalDiagnosis || admission.provisionalDiagnosis,
    x + mm(88),
    y + mm(22),
    leftW - mm(91)
  );
  doc.y = y + h;
}

function section(doc, title, body, redraw) {
  const x = PAGE.margin, w = PAGE.width - 2 * x;
  if (body && typeof body === 'object' && body.columns) {
    const colW = w / 2, heads = body.columns;
    const titleH = Math.max(mm(8), fitHeight(doc, title, w - mm(6), 8.8, true, 1) + mm(4));
    const available = PAGE.height - PAGE.margin - mm(8) - PAGE.margin - titleH;
    let bodySize = 7.4;
    let lineGap = 1.1;
    let heights;
    let h;
    do {
      heights = heads.map(([hd, b]) => fitHeight(doc, hd, colW - mm(6), 8.1, true, 1) + fitHeight(doc, b, colW - mm(8), bodySize, false, lineGap) + mm(11));
      h = Math.max(...heights);
      if (h <= available || bodySize <= 6.1) break;
      bodySize -= 0.2;
      lineGap = Math.max(0.4, lineGap - 0.1);
    } while (true);
    ensure(doc, h + titleH + mm(2), redraw);
    t(doc, title, x + mm(3), doc.y + mm(1.5), { width: w - mm(6), height: titleH - mm(2) }, true, 8.8);
    doc.y += titleH;
    const y = doc.y;
    doc.rect(x, y, w, h).stroke();
    doc.moveTo(x + colW, y).lineTo(x + colW, y + h).stroke();
    heads.forEach(([hd, b], i) => {
      const cx = x + i * colW;
      const hh = fitHeight(doc, hd, colW - mm(6), 8.1, true, 1);
      t(doc, hd, cx + mm(3), y + mm(3), { width: colW - mm(6), lineGap: 1 }, true, 8.1);
      t(doc, b, cx + mm(3), y + mm(5) + hh, { width: colW - mm(6), height: h - hh - mm(8), lineGap }, false, bodySize);
    });
    doc.y = y + h + mm(2);
    return;
  }
  const txt = String(body || '');
  let bodySize = 7.6;
  let lineGap = 1.3;
  let h = fitHeight(doc, txt, w - mm(10), bodySize, false, lineGap) + mm(15);
  const maxBlock = PAGE.height - (2 * PAGE.margin) - mm(14);
  while (h > maxBlock && bodySize > 6.2) { bodySize -= 0.2; lineGap = Math.max(0.5, lineGap - 0.1); h = fitHeight(doc, txt, w - mm(10), bodySize, false, lineGap) + mm(15); }
  ensure(doc, h, redraw);
  const y = doc.y;
  doc.rect(x, y, w, h).stroke();
  t(doc, title, x + mm(4), y + mm(3), { width: w - mm(8) }, true, 8.8);
  t(doc, txt, x + mm(5), y + mm(11), { width: w - mm(10), height: h - mm(14), lineGap }, false, bodySize);
  doc.y = y + h;
}

function responseValue(spec, responses) { if (typeof spec === 'string' && spec.startsWith('response:')) return clean(responses[spec.slice(9)], '-'); return spec; }
function responseTable(doc, template, responses, redraw) {
  const fields = (template.fields || []).filter(f => !['patientOrRepresentativeName', 'relationship', 'patientSignature', 'doctorName', 'doctorSignature', 'witnessName', 'witnessSignature', 'interpreterName', 'signedDate', 'signedTime'].includes(f.key));
  if (!fields.length) return; section(doc, 'Recorded Form Responses / दर्ज किए गए उत्तर', 'The following values were recorded in the electronic consent form. / इलेक्ट्रॉनिक सहमति प्रपत्र में निम्न जानकारी दर्ज की गई है।', redraw);
  const x = PAGE.margin, w = PAGE.width - 2 * x, lw = mm(78);
  fields.forEach(f => { const v = responses[f.key]; if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return; const value = clean(v, '-'); const h = Math.max(mm(12), fitHeight(doc, value, w - lw - mm(8), 7.6, false, 1) + mm(6), fitHeight(doc, f.label, lw - mm(7), 7.2, true, 1) + mm(6)); ensure(doc, h, redraw); const y = doc.y; doc.rect(x, y, w, h).stroke(); doc.moveTo(x + lw, y).lineTo(x + lw, y + h).stroke(); t(doc, f.label, x + mm(3), y + mm(3), { width: lw - mm(6), lineGap: 1 }, true, 7.2); t(doc, value, x + lw + mm(3), y + mm(3), { width: w - lw - mm(6), lineGap: 1 }, false, 7.6); doc.y = y + h; });
}
function signatures(doc, responses, templateId, redraw) {
  const x = PAGE.margin, w = PAGE.width - 2 * x, cols = [mm(52), mm(64), mm(49), w - mm(165)], headH = mm(17), rowH = mm(22);
  const clinician = templateId === 'anaesthesia-consent' ? 'Anaesthetist / एनेस्थेटिस्ट' : templateId === 'surgery-consent' || templateId === 'restraint-consent' ? 'Surgeon / शल्य चिकित्सक' : 'Doctor / चिकित्सक';
  const rows = [['Patient / Authorized Representative\nमरीज / अधिकृत प्रतिनिधि', responses.patientOrRepresentativeName || responses.requestingPersonName || responses.guardianName], [clinician, responses.doctorName], ['Witness / गवाह', responses.witnessName]];
  if (templateId !== 'mlc-refusal-consent' && templateId !== 'blood-transfusion-consent') rows.push(['Interpreter / अनुवादक', responses.interpreterName]);
  const total = headH + rows.length * rowH + mm(23); ensure(doc, total, redraw); const y = doc.y; doc.rect(x, y, w, total).stroke(); let cx = x; cols.slice(0, -1).forEach(c => { cx += c; doc.moveTo(cx, y).lineTo(cx, y + headH + rows.length * rowH).stroke(); }); doc.moveTo(x, y + headH).lineTo(x + w, y + headH).stroke(); for (let i = 1; i < rows.length; i++)doc.moveTo(x, y + headH + i * rowH).lineTo(x + w, y + headH + i * rowH).stroke();
  const hs = ['Details Required\nआवश्यक विवरण', 'Name & Relation\nनाम एवं संबंध', 'Signature / thumb Impression (left)\nहस्ताक्षर / अंगूठे का निशान (बाएँ)', 'Date & Time\nदिनांक एवं समय']; cx = x; hs.forEach((h, i) => { t(doc, h, cx + mm(2), y + mm(2), { width: cols[i] - mm(4), lineGap: .5 }, true, 7.4); cx += cols[i]; });
  rows.forEach((r, i) => { const ry = y + headH + i * rowH; t(doc, r[0], x + mm(2), ry + mm(3), { width: cols[0] - mm(4), lineGap: .5 }, true, 7.2); t(doc, clean(r[1], ''), x + cols[0] + mm(2), ry + mm(3), { width: cols[1] - mm(4) }, false, 7.4); if (i === 0) t(doc, `${clean(responses.signedDate, '')} ${clean(responses.signedTime, '')}`, x + cols[0] + cols[1] + cols[2] + mm(2), ry + mm(3), { width: cols[3] - mm(4) }, false, 7.2); });
  const ny = y + headH + rows.length * rowH; t(doc, 'Note / टिप्पणी:', x + mm(5), ny + mm(3), {}, true, 7.5); t(doc, '1. If patient cannot consent or is a minor, an authorized representative may consent. / रोगी असमर्थ या नाबालिग होने पर अधिकृत प्रतिनिधि सहमति दे सकता है।\n2. A witness must be an adult of sound mind. / गवाह वयस्क और स्वस्थ मस्तिष्क का होना चाहिए।', x + mm(11), ny + mm(8), { width: w - mm(16), lineGap: 1 }, false, 6.7); doc.y = y + total;
}

function anaesthesia(doc, responses, redraw) {
  const x = PAGE.margin, w = PAGE.width - 2 * x, left = mm(58), right = w - left;
  section(doc, 'Declaration / घोषणा', 'I confirm that the anaesthesia procedure, benefits, risks and alternatives have been explained to me. / मैं पुष्टि करता/करती हूँ कि एनेस्थीसिया प्रक्रिया, लाभ, जोखिम और विकल्प मुझे समझाए गए हैं।', redraw);
  ANA.forEach(([name, desc, benefits, risks, key]) => {
    const selected = (Array.isArray(responses.plannedAnaesthesia) ? responses.plannedAnaesthesia : []).includes(key);
    const leftH = fitHeight(doc, `${selected ? '☒' : '☐'} ${name}`, left - mm(4), 7.4, true, 0.8) + mm(7);
    const descH = fitHeight(doc, desc, right - mm(6), 7.2, false, 0.8) + mm(6);
    const benefitsText = `Benefits / लाभ:\n${benefits}`;
    const risksText = `Risks / जोखिम:\n${risks}`;
    const benefitH = fitHeight(doc, benefitsText, right - mm(6), 6.9, false, 0.7) + mm(6);
    const riskH = fitHeight(doc, risksText, right - mm(6), 6.9, false, 0.7) + mm(6);
    const h = Math.max(leftH, descH + benefitH + riskH);
    ensure(doc, h, redraw);
    const y = doc.y;
    const y1 = y + descH;
    const y2 = y + descH + benefitH;
    doc.rect(x, y, w, h).stroke();
    doc.moveTo(x + left, y).lineTo(x + left, y + h).stroke();
    doc.moveTo(x + left, y1).lineTo(x + w, y1).stroke();
    doc.moveTo(x + left, y2).lineTo(x + w, y2).stroke();
    t(doc, `${selected ? '☒' : '☐'} ${name}`, x + mm(2), y + mm(3), { width: left - mm(4), height: h - mm(6), lineGap: .8 }, true, 7.4);
    t(doc, desc, x + left + mm(3), y + mm(3), { width: right - mm(6), height: descH - mm(5), lineGap: .8 }, false, 7.2);
    t(doc, benefitsText, x + left + mm(3), y1 + mm(2), { width: right - mm(6), height: benefitH - mm(4), lineGap: .7 }, false, 6.9);
    t(doc, risksText, x + left + mm(3), y2 + mm(2), { width: right - mm(6), height: riskH - mm(4), lineGap: .7 }, false, 6.9);
    doc.y = y + h;
  });
  section(doc, 'Patient Declaration / रोगी घोषणा', 'I voluntarily consent to administration of anaesthesia as explained. I understand the type, benefits and risks and my questions have been answered.\nमैं समझाए गए अनुसार एनेस्थीसिया देने हेतु स्वेच्छा से सहमति देता/देती हूँ। मैं प्रकार, लाभ और जोखिम समझता/समझती हूँ तथा मेरे प्रश्नों के उत्तर दिए गए हैं।', redraw);
}

function generateConsentPdf({ consent, template, admission, hospital, res }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin }, bufferPages: true, info: { Creator: 'MediQliq HIMS' } }); setupFonts(doc); const filename = `${admission.admissionNumber || 'IPD'}-${template.id}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_'); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${filename}"`); res.setHeader('Cache-Control', 'private, no-store'); doc.pipe(res);
  const redraw = (show = true) => header(doc, hospital, admission, template, show); redraw(true); const responses = consent.responses || {};
  if (template.id === 'anaesthesia-consent') anaesthesia(doc, responses, () => redraw(false));
  else (BODY[template.id] || []).forEach(([title, b]) => section(doc, title, responseValue(b, responses), () => redraw(false)));
  responseTable(doc, template, responses, () => redraw(false)); if (consent.notes) section(doc, 'Additional Notes / अतिरिक्त टिप्पणी', clean(consent.notes), () => redraw(false)); signatures(doc, responses, template.id, () => redraw(false));
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
