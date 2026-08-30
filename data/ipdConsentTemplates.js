const doctorField = {
  key: 'doctorId',
  label: 'Responsible Doctor / चिकित्सक',
  type: 'doctor-selector',
  required: true,
  helpText: 'The verified doctor profile is used for the responsible-doctor name and signed-print workflow.'
};
const patientField = { key: 'patientOrRepresentativeName', label: 'Patient / Authorized Representative Name / मरीज या अधिकृत प्रतिनिधि', type: 'text', required: true };
const relationshipField = { key: 'relationship', label: 'Relationship with Patient / संबंध', type: 'text' };
const witnessField = { key: 'witnessName', label: 'Witness Name / गवाह का नाम', type: 'text', required: true };
const interpreterField = { key: 'interpreterName', label: 'Interpreter Name (if applicable) / अनुवादक', type: 'text' };
const consentDateFields = [
  { key: 'signedDate', label: 'Patient / Representative Signature Date', type: 'auto-date', required: true },
  { key: 'signedTime', label: 'Patient / Representative Signature Time', type: 'auto-time', required: true },
  { key: 'doctorSignedDate', label: 'Doctor / Surgeon / Anaesthetist Signature Date', type: 'auto-date' },
  { key: 'doctorSignedTime', label: 'Doctor / Surgeon / Anaesthetist Signature Time', type: 'auto-time' },
  { key: 'witnessSignedDate', label: 'Witness Signature Date', type: 'auto-date' },
  { key: 'witnessSignedTime', label: 'Witness Signature Time', type: 'auto-time' }
];
const interpreterDateFields = [
  { key: 'interpreterSignedDate', label: 'Interpreter Signature Date', type: 'auto-date' },
  { key: 'interpreterSignedTime', label: 'Interpreter Signature Time', type: 'auto-time' }
];
const acknowledgement = (label) => ({ key: 'contentAcknowledged', label, type: 'checkbox', required: true, uiOnly: true });
const paragraph = (heading, headingHi, en, hi, extra = {}) => ({ type: 'paragraph', heading, headingHi, en, hi, ...extra });
const list = (heading, headingHi, items, extra = {}) => ({ type: 'list', heading, headingHi, items, ...extra });
const responseLine = (label, labelHi, key, extra = {}) => ({ type: 'responseLine', label, labelHi, key, ...extra });
const signatureTable = (roles) => ({ type: 'signatureTable', roles });
const standardNotes = {
  type: 'notes',
  title: 'Note',
  titleHi: 'टिप्पणी',
  items: [
    {
      en: 'If patient is unable to consent or in case of minor, authorized representative can give consent.',
      hi: 'यदि रोगी सहमति देने में असमर्थ है या नाबालिग के मामले में अधिकृत प्रतिनिधि सहमति दे सकता है।'
    },
    {
      en: 'A witness must be at least eighteen years old and must possess sound mind.',
      hi: 'गवाह कम से कम अठारह वर्ष का होना चाहिए और उसका दिमाग स्वस्थ होना चाहिए।'
    }
  ]
};

const templates = [
  {
    id: 'general-consent',
    rendererId: 'native-consent-document',
    name: 'General Consent Form',
    bilingualName: 'सामान्य सहमति पत्र',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 1,
    description: 'General admission and treatment consent retained for hospitals using the existing workflow.',
    fields: [
      { key: 'admissionAndCareConsent', label: 'Consent to admission and routine hospital care', type: 'checkbox', required: true },
      { key: 'examinationInvestigationConsent', label: 'Consent to examination and clinically required investigations', type: 'checkbox', required: true },
      { key: 'medicineTreatmentConsent', label: 'Consent to medicines, injections, IV treatment and supportive care', type: 'checkbox', required: true },
      { key: 'specialLimitations', label: 'Special limitations / remarks', type: 'textarea' },
      patientField, relationshipField, doctorField, witnessField, ...consentDateFields
    ],
    contentPages: [{ sections: [
      paragraph('General Authorization', 'सामान्य अनुमति', 'I authorize admission, clinical examination, appropriate investigations, medicines, injections, intravenous fluids and other supportive care considered necessary by the treating team.', 'मैं अस्पताल में भर्ती, चिकित्सकीय परीक्षण, आवश्यक जांच, दवाइयों, इंजेक्शन, अंतःशिरा द्रव तथा उपचार टीम द्वारा आवश्यक समझी गई सहायक चिकित्सा की अनुमति देता/देती हूँ।'),
      paragraph('Acknowledgement', 'स्वीकृति', 'The proposed care, possible limitations and my opportunity to ask questions have been explained in a language I understand.', 'प्रस्तावित उपचार, उसकी सीमाएँ तथा प्रश्न पूछने के अवसर के बारे में मुझे मेरी समझ की भाषा में समझाया गया है।'),
      signatureTable(['patient', 'doctor', 'witness'])
    ] }]
  },
  {
    id: 'infectious-disease-screening-consent',
    rendererId: 'native-consent-document',
    name: 'Informed Consent for HIV Testing',
    bilingualName: 'एच.आई.वी. जांच हेतु सूचित सहमति',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent Serology HIV.pdf',
    description: 'Complete two-page bilingual HIV testing consent transcribed as searchable native text.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis / डायग्नोसिस', type: 'textarea' },
      { key: 'clinicalReason', label: 'Reason for Test / जांच का कारण', type: 'textarea', required: true },
      { key: 'counsellorName', label: 'Doctor / Technician / Counsellor Name', type: 'text' },
      acknowledgement('I confirm that the complete English and Hindi introduction, meaning of the test, window period, possible results, benefits and declaration were read and explained.'),
      patientField, relationshipField, doctorField, witnessField, ...consentDateFields
    ],
    contentPages: [
      { sections: [
        { type: 'documentSubTitle', en: 'To be filled by Doctor / Technician / Counsellor' },
        { type: 'clinicalDetails', fields: [
          { label: 'Diagnosis', key: 'diagnosis', source: 'responseOrAdmission' },
          { label: 'Consultant Incharge', key: 'consultant', source: 'admission' },
          { label: 'Department', key: 'department', source: 'admission' },
          { label: 'Reason for test', key: 'clinicalReason', source: 'response' }
        ] },
        paragraph(
          'INTRODUCTION',
          'परिचय',
          'A virus called HIV (Human Immunodeficiency Virus) cause AIDS (Acquired Immunodeficiency Syndrome). Any one with HIV can spread it to others. It spread through unsafe sex, sharing needles or receiving blood or blood products or other tissues infected with HIV. Infected mothers can spread HIV to their babies at the time of delivery and through their breast milk. The test for HIV detects the body\'s reaction to the virus (antibody). It does not detect the virus itself. You should know the risk and benefits before you decided to undergo the investigation.',
          'एच.आई.वी. वायरस एक प्रकार का विषाणु है जिसके द्वारा एड्स का रोग होता है। यदि किसी को भी एच.आई.वी. है तो उसका संक्रमण दूसरे व्यक्ति को भी हो सकता है। यह असुरक्षित यौन सम्बन्धों, असुरक्षित इंजेक्शन, नीडल (सुई) या संक्रमित रक्त और रक्त उत्पादों या अन्य शारीरिक ऊतकों को लेने से फैलता है। एच.आई.वी. से संक्रमित महिला द्वारा प्रसूति के समय और मां के दूध से बच्चे को भी एच.आई.वी. हो सकता है। एच.आई.वी. टेस्ट से शरीर में होने वाले रिएक्शन जो कि एच.आई.वी. से संघर्ष करते हैं का पता चलता है, न कि वायरस का।'
        ),
        paragraph(
          'Please read this consent form with care so that you can make an informed choice about having the blood test.',
          'कृपया इस सहमति पत्र को ध्यानपूर्वक पढ़िए ताकि आप रक्त जांच के सूचित विवरण पर विचार कर सकें।',
          '',
          '',
          { emphasis: true }
        ),
        paragraph(
          'WHAT THE TEST MEANS',
          'रक्त परीक्षण क्या है?',
          'If the test is Negative, you probably do not have the HIV virus. It may mean that you have the virus, but your body has not yet produced antibody to fight the virus; it could take up to 8-12 weeks after infection for the test to turn positive. False results are rare. Unclear results are also rare. When a test result does not seem to make sense, we repeat the test and might do another kind of blood test for confirmation.',
          'अगर जांच में रिपोर्ट निगेटिव (नकारात्मक) है तब सम्भवतः आप एच.आई.वी. से पीड़ित हैं। इसका मतलब यह भी हो सकता है कि आपके शरीर में विषाणु है लेकिन आपने शरीर ने उक्त वायरस से लड़ने वाले एंटीबॉडीज नहीं बनाए हैं। इस तरह संक्रमण के 8 से 12 हफ्ते के बाद टेस्ट में पॉजिटिव परिणाम आ सकते हैं। अगर टेस्ट परिणाम पॉजिटिव आया है तो आप एच.आई.वी. वायरस की गिरफ्त में हैं। इसका मतलब कि अब आपसे यह संक्रमण किसी दूसरे के शरीर में भी प्रवेश हो सकता है। एच.आई.वी. टेस्ट से आपको पता चल सकता है कि इस वायरस से आप कब से संक्रमित हैं, इसका मतलब यह नहीं है कि आपको एड्स हो चुका क्योंकि एड्स एच.आई.वी. की अंतिम अवस्था होती है। आमतौर पर एच.आई.वी. परीक्षण परिणाम साधारणतः गलत नहीं होते। इसके परिणाम कुछ न बता पाने वाली स्थिति में भी नहीं होते। उस स्थिति में जबकि टेस्ट रिजल्ट सही-सही कुछ भी नहीं बता पाते की स्थिति में होते तो हम मरीज का पुनर्परीक्षण करते हैं, हम इसके लिए आपका अन्य तरीके से भी परीक्षण कर सकते हैं जिसमें रिजल्ट निकलता है।'
        )
      ] },
      { sections: [
        paragraph(
          'BENEFIT OF BEING TESTED',
          'एच.आई.वी. टेस्ट के फायदे',
          'The benefits of being tested are very personal. If you are worried about AIDS, you might feel better if you have a negative test. In some cases the results may help diagnosis a medical problem to guide your health care.',
          'एच.आई.वी. टेस्ट के फायदे व्यक्तिगत हैं। अगर आप एड्स को लेकर चिंतित हैं तो टेस्ट के बाद आप बेहतर महसूस कर सकते हैं। आप अपने नजदीकी सेक्स सहयोगी के साथ सेक्स से पहले जानने के इच्छुक हो सकते हैं कि आप एड्स से पीड़ित हैं या नहीं। कुछ लोगों में जांच के परिणाम चिकित्सा संबंधी समस्याओं को सुलझाने अथवा आपके स्वास्थ्य संबंधी जानकारी में सहायक साबित हुए हैं।'
        ),
        paragraph(
          'DECLARATION',
          'घोषणा',
          'I certify that the statements made in this consent form have been read over and explained to me in a language I easily understand. I have fully understood the implications of the consent and further submit that the statements therein referred to were filled in and any inapplicable paragraphs stricken off, before I signed/applied my thumb.',
          'मैं घोषणा करता हूँ कि मैंने सहमति प्रपत्र में दिए गए सभी तथ्यों को सावधानीपूर्वक पढ़ लिया है और मुझे मेरी ही भाषा में विस्तारपूर्वक समझा भी दिया गया है। मैं इस प्रपत्र में दिए गए सभी तथ्यों से पूर्णरूप से अवगत हूँ और अपने हस्ताक्षर अथवा अंगूठे के निशान से पहले मैंने अयोग्य बिंदुओं को काट दिया है।'
        ),
        signatureTable(['patient', 'doctor', 'witness']),
        standardNotes
      ] }
    ]
  },
  {
    id: 'anaesthesia-consent',
    rendererId: 'native-consent-document',
    name: 'Anaesthesia Consent Form',
    bilingualName: 'एनेस्थीसिया सहमति प्रपत्र',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent Anaesthesia Simple.pdf',
    description: 'Complete bilingual anaesthesia consent rendered from native text and structured choices.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis / डायग्नोसिस', type: 'textarea' },
      { key: 'plannedAnaesthesia', label: 'Type of Anaesthesia / प्रकार', type: 'checkbox-group', required: true, options: [
        'General Anaesthesia', 'Regional Anaesthesia', 'Local Anaesthesia', 'Sedation / MAC', 'Invasive Procedure (Spinal/Epidural/Nerve Block)'
      ] },
      acknowledgement('I confirm that all printed benefits, risks and the patient declaration in English and Hindi were read and explained.'),
      patientField, relationshipField, doctorField, witnessField, interpreterField, ...consentDateFields, ...interpreterDateFields
    ],
    contentPages: [
      { sections: [
        paragraph('', '', 'I, Undersigned, hereby confirm that I have been explained the below mentioned anaesthesia procedure.', 'मैं अधोहस्ताक्षरित, इसके द्वारा पुष्टि करता हूँ कि मुझे निम्न एनेस्थीसिया प्रक्रिया की व्याख्या का उल्लेख किया गया है।'),
        { type: 'choiceCards', responseKey: 'plannedAnaesthesia', choices: [
          {
            value: 'General Anaesthesia', title: 'General Anaesthesia', titleHi: 'सामान्य एनेस्थीसिया',
            description: 'Patient is fully unconscious', descriptionHi: 'रोगी पूरी तरह से बेहोश रहता है',
            benefits: [
              { en: 'Complete pain relief', hi: 'पूर्ण दर्द से राहत' },
              { en: 'No memory of procedure', hi: 'प्रक्रिया की कोई स्मृति नहीं' },
              { en: 'Suitable for major surgeries', hi: 'बड़ी शल्य चिकित्सा के लिए उपयुक्त' }
            ],
            risks: [
              { en: 'Nausea, vomiting', hi: 'मतली, उल्टी' },
              { en: 'Sore throat (intubation)', hi: 'गले में खराश' },
              { en: 'Breathing/cardiac issues', hi: 'सांस/हृदय संबंधी समस्याएं' },
              { en: 'Rare awareness during surgery', hi: 'दुर्लभ स्थिति में प्रक्रिया के दौरान चेतना' }
            ]
          },
          {
            value: 'Regional Anaesthesia', title: 'Regional Anaesthesia', titleHi: 'क्षेत्रीय एनेस्थीसिया',
            description: 'Numbs a specific region of the body', descriptionHi: 'शरीर के एक विशेष भाग को सुन्न करता है',
            benefits: [
              { en: 'Avoids full unconsciousness', hi: 'पूरी बेहोशी से बचाव' },
              { en: 'Faster recovery', hi: 'तेज रिकवरी' },
              { en: 'Effective pain control', hi: 'प्रभावी दर्द नियंत्रण' }
            ],
            risks: [
              { en: 'Headache', hi: 'सिरदर्द' },
              { en: 'Nerve injury (rare)', hi: 'नस की चोट (दुर्लभ)' },
              { en: 'Incomplete block', hi: 'ब्लॉक अधूरा रहना' },
              { en: 'Low blood pressure', hi: 'रक्तचाप में गिरावट' }
            ]
          },
          {
            value: 'Local Anaesthesia', title: 'Local Anaesthesia', titleHi: 'स्थानीय एनेस्थीसिया',
            description: 'Numbs a small area', descriptionHi: 'एक छोटे क्षेत्र को सुन्न करता है',
            benefits: [
              { en: 'Minimal systemic effect', hi: 'शरीर पर न्यूनतम प्रभाव' },
              { en: 'Quick recovery', hi: 'तेज रिकवरी' },
              { en: 'No hospital stay needed', hi: 'अस्पताल में भर्ती की आवश्यकता नहीं' }
            ],
            risks: [
              { en: 'Allergic reaction', hi: 'एलर्जी प्रतिक्रिया' },
              { en: 'Inadequate pain control', hi: 'दर्द नियंत्रण में कमी' },
              { en: 'Local swelling/bruising', hi: 'स्थानीय सूजन/खरोंच' }
            ]
          }
        ] }
      ] },
      { sections: [
        { type: 'choiceCards', responseKey: 'plannedAnaesthesia', choices: [
          {
            value: 'Sedation / MAC', title: 'Sedation / MAC', titleHi: 'शिथिलीकरण / एमएसी',
            description: 'Relaxed, semi-conscious, monitored', descriptionHi: 'शांत, आंशिक रूप से सचेत, निगरानी में',
            benefits: [
              { en: 'Reduced anxiety', hi: 'चिंता में कमी' },
              { en: 'Maintains breathing', hi: 'स्वयं सांस लेना' },
              { en: 'Faster recovery', hi: 'तेज रिकवरी' }
            ],
            risks: [
              { en: 'Over-sedation', hi: 'अत्यधिक शिथिलीकरण' },
              { en: 'Allergic reaction', hi: 'एलर्जी प्रतिक्रिया' },
              { en: 'Incomplete sedation', hi: 'अधूरा शिथिलीकरण' }
            ]
          },
          {
            value: 'Invasive Procedure (Spinal/Epidural/Nerve Block)', title: 'Invasive Procedure (Spinal/Epidural/Nerve Block)', titleHi: 'इनवेसिव प्रक्रिया (स्पाइनल/एपिड्यूरल/नर्व ब्लॉक)',
            description: 'Targeted anaesthesia via injection', descriptionHi: 'इंजेक्शन द्वारा लक्षित एनेस्थीसिया',
            benefits: [
              { en: 'Targeted pain relief', hi: 'लक्षित दर्द से राहत' },
              { en: 'Reduced systemic drug use', hi: 'पूरे शरीर में दवाओं की आवश्यकता कम' },
              { en: 'Effective for lower body surgeries', hi: 'निचले शरीर की शल्य चिकित्सा के लिए प्रभावी' }
            ],
            risks: [
              { en: 'Infection at injection site', hi: 'इंजेक्शन स्थल पर संक्रमण' },
              { en: 'Bleeding or hematoma', hi: 'रक्तस्राव या हेमेटोमा' },
              { en: 'Nerve damage (rare)', hi: 'नस की क्षति (दुर्लभ)' },
              { en: 'Spinal headache', hi: 'स्पाइनल सिरदर्द' }
            ]
          }
        ] },
        paragraph('Patient Declaration', 'रोगी घोषणा', 'I hereby give my consent for the administration of anaesthesia as explained to me. I understand the type, benefits, and risks involved. I have had the opportunity to ask questions and all my queries have been answered to my satisfaction.', 'मैं यहां एनेस्थीसिया देने की सहमति देता/देती हूँ जैसा कि मुझे समझाया गया है। मैं इसके प्रकार, लाभ और जोखिमों को समझता/समझती हूँ। मुझे प्रश्न पूछने का अवसर मिला है और मेरे सभी प्रश्नों के उत्तर संतोषजनक रूप से दिए गए हैं।'),
        signatureTable(['patient', 'anaesthetist', 'witness', 'interpreter']),
        standardNotes
      ] }
    ]
  },
  {
    id: 'blood-transfusion-consent',
    rendererId: 'native-consent-document',
    name: 'Blood Transfusion Consent Form',
    bilingualName: 'रक्त चढ़ाने की सहमति पत्र',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent Blood Transfusion Simple.pdf',
    description: 'Complete bilingual blood-component consent rendered from native text.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis / डायग्नोसिस', type: 'textarea' },
      { key: 'bloodComponents', label: 'Type of Blood / रक्त का प्रकार', type: 'checkbox-group', required: true, options: ['Whole Blood', 'Packed Red Cells', 'Platelets', 'Cryoprecipitate', 'Fresh Frozen Plasma (FFP)', 'Other'] },
      { key: 'otherBloodComponent', label: 'Other Blood Component / अन्य', type: 'text' },
      { key: 'bloodGroup', label: 'Blood Group / रक्त समूह', type: 'select', required: true, options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
      { key: 'rhType', label: 'Rh Type', type: 'select', required: true, options: ['Positive', 'Negative'] },
      acknowledgement('I confirm that the complete benefits, possible risks and complications, severe outcomes and consent statement in English and Hindi were read and explained.'),
      patientField, relationshipField, doctorField, witnessField, ...consentDateFields
    ],
    contentPages: [
      { sections: [
        { type: 'componentChoices', responseKey: 'bloodComponents', otherKey: 'otherBloodComponent', groupKey: 'bloodGroup', rhKey: 'rhType', choices: [
          { value: 'Whole Blood', en: 'Whole Blood', hi: 'संपूर्ण रक्त' },
          { value: 'Packed Red Cells', en: 'Packed Red Cells', hi: 'पैक्ड रेड सेल्स' },
          { value: 'Platelets', en: 'Platelets', hi: 'प्लेटलेट्स' },
          { value: 'Cryoprecipitate', en: 'Cryoprecipitate', hi: 'क्रायोप्रेसिपिटेट' },
          { value: 'Fresh Frozen Plasma (FFP)', en: 'Fresh Frozen Plasma (FFP)', hi: 'फ्रेश फ्रोजन प्लाज्मा' },
          { value: 'Other', en: 'Other (Specify)', hi: 'अन्य (उल्लेख करें)' }
        ] },
        { type: 'twoColumnList', heading: 'Benefits', headingHi: 'लाभ', items: [
          { en: 'Restores lost blood volume and improves oxygen delivery to tissues.', hi: 'खोए हुए रक्त की मात्रा को पूरा करना और ऊतकों तक ऑक्सीजन की आपूर्ति को बेहतर बनाना।' },
          { en: 'Helps control bleeding and correct anaemia.', hi: 'रक्तस्राव को नियंत्रित करना और एनीमिया को ठीक करना।' },
          { en: 'Supports recovery in surgery, injury, or severe illness.', hi: 'सर्जरी, चोट या गंभीर बीमारी में स्वस्थ होने में सहायता करना।' }
        ] },
        { type: 'twoColumnList', heading: 'Possible Risks & Complications', headingHi: 'संभावित जोखिम एवं जटिलताएँ', items: [
          { en: 'Mild allergic reactions (rash, itching, fever).', hi: 'हल्की एलर्जी प्रतिक्रिया (चकत्ते, खुजली, बुखार)।' },
          { en: 'Transfusion reaction (chills, breathing difficulty, low blood pressure).', hi: 'ट्रांसफ्यूजन रिएक्शन (कंपकंपी, सांस लेने में कठिनाई, लो ब्लड प्रेशर)।' },
          { en: 'Transmission of infections (very rare, due to screening).', hi: 'संक्रमण का प्रसार (बहुत दुर्लभ, स्क्रीनिंग के कारण)।' },
          { en: 'Iron overload with repeated transfusions.', hi: 'बार-बार रक्त चढ़ाने पर आयरन की अधिकता।' },
          { en: 'Lung injury related to transfusion (rare).', hi: 'ट्रांसफ्यूजन से संबंधित फेफड़ों की चोट (दुर्लभ)।' },
          { en: 'Risk related to vein puncture.', hi: 'नस में सुई लगाने से संबंधित जोखिम।' }
        ] },
        { type: 'twoColumnList', heading: 'Severe Outcomes', headingHi: 'गंभीर परिणाम', items: [
          { en: 'Acute hemolysis → kidney failure, shock', hi: 'तीव्र हीमोलाइसिस - गुर्दे की विफलता, शॉक' },
          { en: 'Severe allergic (anaphylaxis) → airway obstruction, cardiac arrest', hi: 'गंभीर एलर्जी (एनाफिलेक्सिस) - श्वसन मार्ग अवरोध, हृदयाघात रुकना' },
          { en: 'Sepsis → multi-organ failure', hi: 'सेप्सिस - बहु-अंग विफलता' },
          { en: 'In rare cases, transfusion reactions can lead to death.', hi: 'दुर्लभ मामलों में, रक्त चढ़ाने की प्रतिक्रिया मृत्यु का कारण बन सकती है।' }
        ] }
      ] },
      { sections: [
        list('Consent Statement', 'सहमति वक्तव्य', [
          { en: 'I have been explained the need for blood transfusion, its benefits, possible risks, and alternatives. I understand the information and give my voluntary consent to receive the above-mentioned blood/blood components.', hi: 'मुझे रक्त चढ़ाने की आवश्यकता, इसके लाभ, संभावित जोखिम तथा अन्य विकल्पों के बारे में बताया गया है। मैंने सारी जानकारी समझ ली है और मैं अपनी इच्छा से उपरोक्त रक्त / रक्त घटक लेने के लिए सहमति देता/देती हूँ।' },
          { en: 'I understand, that transfusion of blood products has been advised as a form of treatment and / or may be required during or after surgery / procedure / or during the course of medical management during my present admission till my discharge.', hi: 'मैं अधोहस्ताक्षरी समझता/समझती हूँ कि ब्लड उत्पादों के ट्रांसफ्यूजन की, उपचार के रूप में सलाह दी गई है और / या मेरी सर्जरी प्रक्रिया के बीच में या बाद में आवश्यकता हो या दाखिले से डिस्चार्ज होने तक के मेडिकल कोर्स के दौरान आवश्यकता हो सकती है।' },
          { en: 'My relatives and I have been explained about the risks transfusion which includes but not limited to possibility of infections and immune reactions even after performance of all mandatory tests on the blood.', hi: 'मेरे रिश्तेदार और मुझे ब्लड ट्रांसफ्यूजन के बारे में भी समझाया गया है जिसमें ब्लड के सभी अनिवार्य परीक्षण के प्रदर्शन के बाद भी संक्रमण और प्रतिरक्षा प्रतिक्रियाओं की संभावना शामिल है।' },
          { en: 'I have been provided all explanations and clarification from my doctor on transfusion and its alternatives as well as the opportunity of refusing transfusion.', hi: 'मुझे डॉक्टर द्वारा ट्रांसफ्यूजन के सभी स्पष्टीकरण प्रदान किए गए हैं और इसके साथ-साथ ट्रांसफ्यूजन से मना करने का अवसर भी दिया गया है।' },
          { en: 'I hereby give my consent to blood transfusion and permit the medical and nursing staff to administer the same.', hi: 'मैं ब्लड ट्रांसफ्यूजन करने के लिए चिकित्सक एवं नर्सिंग स्टॉफ को अपनी अनुमति एवं सहमति देता/देती हूँ।' }
        ]),
        signatureTable(['patient', 'doctor', 'witness']),
        standardNotes
      ] }
    ]
  },
  {
    id: 'high-risk-consent',
    rendererId: 'native-consent-document',
    name: 'High Risk Consent Form',
    bilingualName: 'उच्च-जोखिम सहमति पत्र',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent High Risk Procedure.pdf',
    description: 'Complete bilingual high-risk consent rendered from native text.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis / Primary Illness', type: 'textarea', required: true },
      { key: 'procedureName', label: 'Procedure Name (if applicable)', type: 'textarea' },
      { key: 'guardianName', label: 'Son / Daughter / Wife of', type: 'text' },
      { key: 'declarantAge', label: 'Declarant Age', type: 'number' },
      { key: 'address', label: 'Resident Address', type: 'textarea' },
      { key: 'highRiskReasons', label: 'Reasons This Is a HIGH-RISK Case', type: 'textarea', required: true },
      acknowledgement('I confirm that all six declarations, listed complications and non-guarantee of outcome in English and Hindi were read and explained.'),
      patientField, relationshipField, doctorField, witnessField, interpreterField, ...consentDateFields, ...interpreterDateFields
    ],
    contentPages: [
      { sections: [
        responseLine('Diagnosis / Primary Illness', 'डायग्नोसिस / प्राथमिक बीमारी', 'diagnosis'),
        responseLine('Procedure Name (If Applicable)', 'प्रक्रिया का नाम (यदि लागू हो)', 'procedureName'),
        { type: 'declarantDetails' },
        list('', '', [
          { en: 'I have been explained in detail by Dr. {{doctorName}} about my present illness, the procedure/surgery if advised, its benefits, limitations, and alternative options.', hi: 'मुझे डॉ. {{doctorName}} द्वारा मेरी वर्तमान बीमारी, सुझाई गई प्रक्रिया/शल्यक्रिया अगर कोई, उसके लाभ, सीमाएँ और वैकल्पिक विकल्पों के बारे में विस्तार से समझाया गया है।' },
          { en: 'I have been informed that this is a HIGH-RISK case due to: {{highRiskReasons}}', hi: 'मुझे बताया गया है कि यह एक उच्च-जोखिम मामला है क्योंकि: {{highRiskReasons}}' },
          { en: 'I have understood the possible risks and complications, which may include but are not limited to: Bleeding; Infection; Damage to surrounding organs; Anaesthesia-related risks; Worsening of current condition; Permanent disability; Death.', hi: 'मैंने संभावित जोखिमों और जटिलताओं को समझ लिया है, जिनमें शामिल हो सकते हैं लेकिन सीमित नहीं हैं: रक्तस्राव; संक्रमण; आसपास के अंगों को क्षति; एनेस्थीसिया से संबंधित जोखिम; वर्तमान स्थिति का बिगड़ना; स्थायी विकलांगता; मृत्यु।' }
        ], { ordered: true })
      ] },
      { sections: [
        list('', '', [
          { en: 'I have been given an opportunity to ask questions, and all my queries have been answered to my satisfaction.', hi: 'मुझे प्रश्न पूछने का अवसर दिया गया है और मेरी सभी शंकाओं का समाधान किया गया है।' },
          { en: 'I understand that despite the best possible care and efforts, complications may occur, and the outcome cannot be guaranteed.', hi: 'मैं समझता/समझती हूँ कि सर्वोत्तम देखभाल और प्रयासों के बावजूद जटिलताएँ हो सकती हैं और परिणाम की गारंटी नहीं दी जा सकती।' },
          { en: 'I voluntarily give my consent for the treatment or procedure/surgery, understanding the above risks.', hi: 'उपरोक्त जोखिमों को समझते हुए मैं स्वेच्छा से इलाज या प्रक्रिया/शल्यक्रिया के लिए अपनी सहमति देता/देती हूँ।' }
        ], { ordered: true, start: 4 }),
        signatureTable(['patient', 'doctor', 'witness', 'interpreter']),
        standardNotes
      ] }
    ]
  },
  {
    id: 'lama-dor-consent',
    rendererId: 'native-consent-document',
    name: 'Consent - LAMA / DOR',
    bilingualName: 'चिकित्सकीय सलाह के विरुद्ध छुट्टी',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent LAMA DOR.pdf',
    description: 'English and Hindi LAMA/DOR pages rendered as native searchable text.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis', type: 'textarea' },
      { key: 'requestingPersonName', label: 'Mr. / Ms. / Dr. Requesting Discharge', type: 'text', required: true },
      { key: 'requestingPersonParentSpouse', label: 'Requesting Person - Son / Daughter / Wife of', type: 'text' },
      { key: 'patientBeingDischarged', label: 'Patient Being Discharged', type: 'text', required: true },
      { key: 'dischargeDestination', label: 'Discharged / Taken To', type: 'text' },
      { key: 'patientParentSpouse', label: 'Patient - Son / Daughter / Wife of', type: 'text' },
      { key: 'authorizedRepresentativeName', label: 'Authorized Representative Name', type: 'text' },
      acknowledgement('I confirm that the present condition, need for continued admission, consequences and responsibility statements on both English and Hindi pages were explained.'),
      patientField, relationshipField, doctorField, witnessField, interpreterField, ...consentDateFields, ...interpreterDateFields
    ],
    contentPages: [
      { language: 'en', sections: [
        { type: 'lamaStatement', language: 'en', en: 'I, Mr. / Ms. / Dr. {{requestingPersonName}}, Son / Daughter / Wife of {{requestingPersonParentSpouse}}, take full responsibility in having Mr. / Ms. / Dr. {{patientBeingDischarged}} to {{dischargeDestination}}, Son / Daughter / Wife of {{patientParentSpouse}}, discharged against medical advice at his/her own risk. The condition of the patient and the consequences have been explained to me and no one (not even the patient) will ever hold Hospital or its staff in any way responsible for any outcome whatsoever.' },
        signatureTable(['patient']),
        paragraph('', '', 'If Patient is unable to consent or in case of minor authorized representative can give consent. If I am the authorized representative (relative/Parent or Guardian in case of Minor) I agree that I have read this form, understood the information and have no further questions.', ''),
        signatureTable(['authorizedRepresentative']),
        paragraph('CERTIFICATION OF DOCTOR', '', 'I hereby certify that I have discussed risk, benefits, possibility of complications with my patient / authorized representative.', ''),
        signatureTable(['doctor', 'witness', 'interpreter']),
        paragraph('', '', 'A Witness must be at least eighteen year old and must possess sound mind.', '')
      ] },
      { language: 'hi', sections: [
        paragraph('', '', '', 'हमें हमारे मरीज के बारे में डॉक्टर साहब ने बताया है कि मरीज की स्थिति अभी ठीक नहीं है, मरीज को आगे भी अस्पताल में रहकर इलाज करवाने की जरूरत है। इन सब बातों से अवगत होते हुए भी हम आगे भर्ती नहीं रखना चाहते।'),
        paragraph('', '', '', 'मरीज की स्थिति एवं सभी बातों से अवगत होते हुए मरीज को अपने साथ ले जाना चाहते हैं। मरीज से संबंधित सभी स्थिति एवं खतरों की जवाबदारी हमारी होगी, डॉक्टर या अस्पताल की नहीं।'),
        signatureTable(['patient']),
        paragraph('', '', '', 'यदि मरीज सहमति देने में असमर्थ है या नाबालिग के मामले में अधिकृत प्रतिनिधि सहमति देते हैं। यदि मैं अधिकृत प्रतिनिधि हूँ (रिश्तेदार / माता-पिता या नाबालिग के मामले में अभिभावक) मैं मानता हूँ कि मैंने इस फॉर्म को पढ़ा है, जानकारी को समझा है और मेरे कोई सवाल नहीं हैं।'),
        signatureTable(['authorizedRepresentative']),
        paragraph('डॉक्टर का प्रमाण', '', '', 'मैं इसके द्वारा प्रमाणित करता हूँ कि मैंने प्रक्रिया जोखिम, लाभ, अपने मरीजों / अधिकृत प्रतिनिधियों के साथ जटिलताओं की संभावना के विषय पर चर्चा की है।'),
        signatureTable(['doctor', 'witness', 'interpreter']),
        paragraph('', '', '', 'गवाह कम से कम 18 वर्ष का होना चाहिए तथा दिमागी रूप से बिल्कुल स्वस्थ होना चाहिए।')
      ] }
    ]
  },
  {
    id: 'mlc-refusal-consent',
    rendererId: 'native-consent-document',
    name: 'Medical Legal Case (MLC) Refusal Consent Form',
    bilingualName: 'मेडिकल लीगल केस (MLC) अस्वीकृति सहमति प्रपत्र',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent Refusal for MLC.pdf',
    description: 'Complete bilingual MLC refusal declaration rendered from native text.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis', type: 'textarea' },
      { key: 'reasonForRefusal', label: 'Additional Reason / Remarks for MLC Refusal', type: 'textarea' },
      acknowledgement('I confirm that the MLC meaning, qualification, legal implications, refusal statement and declaration of responsibility in English and Hindi were read and explained.'),
      patientField, relationshipField, doctorField, witnessField, ...consentDateFields
    ],
    contentPages: [
      { sections: [
        list('Information Provided to Patient', 'रोगी को दी गई जानकारी', [
          { en: 'What an MLC (Medical Legal Case) means.', hi: 'MLC (मेडिकल लीगल केस) का अर्थ क्या है।' },
          { en: 'Why my case qualifies for MLC registration.', hi: 'मेरा मामला MLC पंजीकरण के लिए क्यों योग्य है।' },
          { en: 'The legal implications of registering or refusing MLC.', hi: 'MLC दर्ज करने या अस्वीकार करने के कानूनी प्रभाव।' },
          { en: 'Possible consequences of refusal, including limitation of legal protection, insurance claims, and medico-legal support.', hi: 'अस्वीकृति के संभावित परिणाम, जैसे कानूनी सुरक्षा, बीमा दावा और मेडिको-लीगल सहायता की सीमाएँ।' }
        ]),
        paragraph('Patient\'s Statement of Refusal', 'रोगी का अस्वीकृति वक्तव्य', 'I, the undersigned, acknowledge that I have been fully informed about the requirement and implications of registering this case as MLC. Despite being informed, I voluntarily refuse MLC registration. This refusal is made of my own free will, without any pressure, influence, or coercion.', 'मैं, हस्ताक्षरकर्ता, स्वीकार करता/करती हूँ कि मुझे इस मामले को MLC के रूप में दर्ज करने की आवश्यकता और उसके प्रभावों के बारे में पूरी तरह से सूचित किया गया है। सूचित किए जाने के बावजूद, मैं स्वेच्छा से MLC पंजीकरण से इनकार करता/करती हूँ। यह अस्वीकृति मेरी स्वतंत्र इच्छा से है, बिना किसी दबाव, प्रभाव या जोर-जबरदस्ती के।'),
        list('Declaration of Responsibility', 'जिम्मेदारी की घोषणा', [
          { en: 'I may lose certain legal protections.', hi: 'मुझे कुछ कानूनी सुरक्षा का लाभ नहीं मिलेगा।' },
          { en: 'The hospital and doctors will not be held responsible for any legal consequences arising from this refusal.', hi: 'इस अस्वीकृति से उत्पन्न किसी भी कानूनी परिणाम के लिए अस्पताल और चिकित्सक जिम्मेदार नहीं होंगे।' },
          { en: 'I take full responsibility for all outcomes resulting from my decision.', hi: 'मैं अपने निर्णय से उत्पन्न सभी परिणामों की पूरी जिम्मेदारी लेता/लेती हूँ।' }
        ])
      ] },
      { sections: [signatureTable(['patient', 'doctor', 'witness'])] }
    ]
  },
  {
    id: 'restraint-consent',
    rendererId: 'native-consent-document',
    name: 'Restraint Consent',
    bilingualName: 'अंग प्रतिबंधित सहमति प्रपत्र',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent Restrain.pdf',
    description: 'Complete bilingual restraint consent rendered from native text.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis', type: 'textarea' },
      { key: 'guardianName', label: 'Legal Guardian / Authorized Representative', type: 'text', required: true },
      { key: 'patientNameForRestraint', label: 'Patient Name for Restraint Authorization', type: 'text', required: true },
      { key: 'reasonForRestraint', label: 'Reason for Containment / Restraint', type: 'textarea', required: true },
      { key: 'restraintType', label: 'Restraint Type / Limbs or Sites', type: 'textarea' },
      { key: 'additionalRemarks', label: 'Additional Remarks', type: 'textarea' },
      acknowledgement('I confirm that the objective, procedures and care, clarifications and authorization in English and Hindi were read and explained.'),
      patientField, relationshipField, doctorField, witnessField, interpreterField, ...consentDateFields, ...interpreterDateFields
    ],
    contentPages: [
      { sections: [
        paragraph('INFORMED CONSENT FORM FOR RESTRICTION OF MEMBERS IN AGITATED PATIENTS', 'उत्तेजित (आक्रामक) रोगियों में अंगों को प्रतिबंधित करने हेतु सूचित सहमति प्रपत्र', 'I, {{guardianName}}, legal guardian of patient {{patientNameForRestraint}}, declare that I was informed by the medical and nursing team about the need to use measures of physical restraint (limb restriction) due to the state of agitation presented by the patient.', 'मैं, {{guardianName}}, रोगी {{patientNameForRestraint}} का वैधानिक अभिभावक/अधिकृत प्रतिनिधि, यह घोषित करता/करती हूँ कि मुझे चिकित्सा एवं नर्सिंग टीम द्वारा रोगी की उत्तेजित (आक्रामक) अवस्था के कारण शारीरिक प्रतिबंध (अंगों को नियंत्रित/बांधने) की आवश्यकता के बारे में पूर्ण जानकारी दी गई है।'),
        paragraph('1. Reason for the Containment', 'प्रतिबंध लगाने का कारण', 'Physical restraint will be applied to ensure the safety of the patient and the team, health and that of third parties, avoiding injuries resulting from agitated behaviors, aggressive.', 'रोगी, स्वास्थ्य सेवा दल तथा अन्य व्यक्तियों की सुरक्षा सुनिश्चित करने एवं रोगी के उत्तेजित एवं आक्रामक व्यवहार से होने वाली संभावित चोटों से बचाव हेतु शारीरिक प्रतिबंध लगाया जाएगा।'),
        list('2. Objective of the Measure', 'इस उपाय का उद्देश्य', [
          { en: 'Protect the patient from possible accidents and injuries.', hi: 'रोगी को संभावित दुर्घटनाओं एवं चोटों से सुरक्षित रखना।' },
          { en: 'Ensure the physical integrity of the people around.', hi: 'आसपास उपस्थित व्यक्तियों की शारीरिक सुरक्षा सुनिश्चित करना।' },
          { en: 'Facilitate the performance of necessary medical procedures.', hi: 'आवश्यक चिकित्सकीय प्रक्रियाओं को सुरक्षित एवं प्रभावी ढंग से संपन्न करना।' }
        ]),
        list('3. Procedures and Care', 'प्रक्रिया एवं देखभाल', [
          { en: 'The containment will be carried out in a humane manner, respecting dignity and the comfort of the patient.', hi: 'प्रतिबंध की प्रक्रिया मानवीय तरीके से की जाएगी तथा रोगी की गरिमा एवं आराम का पूरा सम्मान किया जाएगा।' },
          { en: 'Appropriate and safe equipment will be used, ensuring integrity, physical examination of the patient.', hi: 'उपयुक्त एवं सुरक्षित उपकरणों का उपयोग किया जाएगा ताकि रोगी की शारीरिक सुरक्षा सुनिश्चित की जा सके।' },
          { en: 'The health team will carry out continuous monitoring, observing vital signs and circulation conditions of immobilized limbs.', hi: 'स्वास्थ्य सेवा दल द्वारा रोगी की निरंतर निगरानी की जाएगी तथा उसके महत्वपूर्ण जीवन संकेत एवं प्रतिबंधित अंगों में रक्त परिसंचरण की नियमित जांच की जाएगी।' },
          { en: 'The need for containment will be reassessed periodically, being suspended, as soon as possible.', hi: 'प्रतिबंध की आवश्यकता का समय-समय पर पुनर्मूल्यांकन किया जाएगा तथा आवश्यकता समाप्त होते ही इसे यथाशीघ्र हटा दिया जाएगा।' }
        ])
      ] },
      { sections: [
        list('4. Clarifications Received', 'प्राप्त स्पष्टीकरण', [
          { en: 'The reason why containment is necessary.', hi: 'प्रतिबंध आवश्यक होने का कारण।' },
          { en: 'The possible consequences of the absence of this measure.', hi: 'यदि यह उपाय न किया जाए तो उसके संभावित परिणाम।' },
          { en: 'The risks and benefits associated with the use of member restriction.', hi: 'अंगों को प्रतिबंधित करने से जुड़े संभावित जोखिम एवं लाभ।' },
          { en: 'The alternatives assessed before the decision for containment.', hi: 'प्रतिबंध लगाने का निर्णय लेने से पहले विचार किए गए वैकल्पिक उपाय।' },
          { en: 'The right to request clarification and to discuss the continuation or suspension of the measure.', hi: 'इस उपाय के संबंध में स्पष्टीकरण प्राप्त करने तथा इसे जारी रखने या समाप्त करने पर चर्चा करने का मेरा अधिकार।' }
        ]),
        paragraph('5. Consent', 'सहमति', 'I am aware that restraint will only be used as long as it is absolutely necessary and in the shortest time possible. I authorize the use of limb restraints on the patient {{patientNameForRestraint}}, according to the assessment of the medical team.', 'मैं समझता/समझती हूँ कि शारीरिक प्रतिबंध केवल उतनी ही अवधि के लिए लगाया जाएगा जितनी अवधि तक इसकी पूर्णतः आवश्यकता होगी तथा इसे यथासंभव कम समय के लिए रखा जाएगा। मैं रोगी {{patientNameForRestraint}} पर चिकित्सा दल के मूल्यांकन के अनुसार अंगों को प्रतिबंधित करने की अनुमति प्रदान करता/करती हूँ।'),
        responseLine('Additional Remarks', 'अतिरिक्त टिप्पणी', 'additionalRemarks'),
        signatureTable(['patient', 'surgeon', 'witness', 'interpreter']),
        standardNotes
      ] }
    ]
  },
  {
    id: 'surgery-consent',
    rendererId: 'native-consent-document',
    name: 'Surgery Consent Form',
    bilingualName: 'शल्य चिकित्सा सहमति पत्र',
    version: '4.0',
    contentVersion: '2026-08-02.1',
    pageCount: 2,
    sourceDocument: 'Consent Surgery Simple.pdf',
    description: 'Complete bilingual surgery consent rendered from native text.',
    fields: [
      { key: 'diagnosis', label: 'Diagnosis', type: 'textarea' },
      { key: 'procedureName', label: 'Procedure Name', type: 'textarea', required: true },
      acknowledgement('I confirm that the complete benefits, risks, additional procedure, scientific/education use, tissue disposal, resterilised-item, indemnity and voluntary-consent clauses in English and Hindi were read and explained.'),
      patientField, relationshipField, doctorField, witnessField, interpreterField, ...consentDateFields, ...interpreterDateFields
    ],
    contentPages: [
      { sections: [
        responseLine('1. Procedure Name', 'प्रक्रिया का नाम', 'procedureName'),
        { type: 'benefitRiskColumns', heading: '2. Benefits & Risks', headingHi: 'लाभ एवं जोखिम', benefits: [
          { en: 'Improves or corrects the medical condition for which the surgery is performed.', hi: 'उस चिकित्सा समस्या को सुधारना या ठीक करना जिसके लिए शल्य चिकित्सा की जा रही है।' },
          { en: 'May prevent worsening of the condition and avoid life-threatening complications.', hi: 'बीमारी को बिगड़ने से रोकना और जानलेवा जटिलताओं से बचाव।' },
          { en: 'Can relieve pain, improve function, and enhance quality of life.', hi: 'दर्द में राहत, कार्यक्षमता में सुधार और जीवन की गुणवत्ता बढ़ाना।' },
          { en: 'In some cases, surgery is the only effective treatment available.', hi: 'कुछ मामलों में, यह एकमात्र प्रभावी उपचार होता है।' }
        ], risks: [
          { en: 'Bleeding during or after the surgery.', hi: 'ऑपरेशन के दौरान या बाद में रक्तस्राव।' },
          { en: 'Infection at the surgical site or in the body.', hi: 'ऑपरेशन स्थल या शरीर में संक्रमण।' },
          { en: 'Allergic reaction or adverse effects from anaesthesia.', hi: 'एनेस्थीसिया से एलर्जी या हानिकारक प्रभाव।' },
          { en: 'Injury to surrounding organs, tissues, or blood vessels.', hi: 'आसपास के अंगों, ऊतकों या रक्त वाहिकाओं को चोट।' },
          { en: 'Risk of incomplete cure or recurrence of the problem.', hi: 'बीमारी का पूरी तरह से न ठीक होना या दोबारा होना।' },
          { en: 'Need for further surgery if complications arise.', hi: 'जटिलताओं की स्थिति में पुनः सर्जरी की आवश्यकता।' },
          { en: 'Post-operative pain, swelling, delayed wound healing.', hi: 'ऑपरेशन के बाद दर्द, सूजन, घाव भरने में देरी।' },
          { en: 'Rare but serious risks including disability or death.', hi: 'दुर्लभ लेकिन गंभीर जोखिम जैसे विकलांगता या मृत्यु।' }
        ] },
        list('3. Consent Statement', 'सहमति वक्तव्य', [
          { en: 'I was given the opportunity to ask questions and all my questions were satisfactorily answered and with the understanding that any operation/procedure involves risks and I give my consent to perform required operation/procedure.', hi: 'मुझे प्रश्न पूछने का अवसर दिया गया था और मेरी संतुष्टि तक उनका उत्तर दिया गया था और शल्य चिकित्सा / प्रक्रियाओं में सम्मिलित जोखिमों को समझते हुए मैं शल्य चिकित्सा / प्रक्रियाओं को करने के लिए अपनी सहमति देता हूँ।' },
          { en: 'I consent to the performance of operations/procedures in addition to or different from those now contemplated whether or not arising from presently unforeseen conditions.', hi: 'मैं वर्तमान में निर्धारित शल्य चिकित्सा / प्रक्रियाओं के अतिरिक्त या अलग से उन शल्य चिकित्सा / प्रक्रियाओं को करने की सहमति देता हूँ जो वर्तमान में अप्रत्याशित स्थितियों से उत्पन्न होने वाले हों या नहीं।' }
        ])
      ] },
      { sections: [
        list('', '', [
          { en: 'I consent and understand that the health care establishment may at its sole discretion, photograph or video tape the operation/procedure for scientific and/or educational purposes. I further consent to the presence of observers, which may include medical trainees, nursing trainees, paramedical trainees, among others as approved by my doctors in the operating/procedure room.', hi: 'मैं सहमति देता हूँ और समझता हूँ कि स्वास्थ्य देखभाल प्रतिष्ठान अपने विवेकानुसार वैज्ञानिक और / या शैक्षिक उद्देश्यों के लिए शल्य चिकित्सा / प्रक्रिया को फोटोग्राफ या वीडियो टेप कर सकता है। मैं शल्य चिकित्सा / प्रक्रिया कक्ष में पर्यवेक्षकों की उपस्थिति के लिए सहमति देता हूँ, जिसमें चिकित्सा प्रशिक्षु, नर्सिंग प्रशिक्षु, पैरा मेडिकल प्रशिक्षु और मेरे डॉक्टरों द्वारा अनुमोदित अन्य लोग शामिल हो सकते हैं।' },
          { en: 'I consent to usage and disposal of any tissue or body parts which may be there during the surgery/procedure(s).', hi: 'मैं शल्य चिकित्सा / प्रक्रिया के दौरान जा सकने वाले किसी भी ऊतक या शरीर के हिस्से के उपयोग और निपटान के लिए सहमति देता हूँ।' },
          { en: 'I have been explained about the usage of resterilised items during procedures as per the best practices of infection control guidelines and I give my consent for the usage of resterilised items.', hi: 'मुझे संक्रमण नियंत्रण दिशानिर्देशों के सर्वोत्तम प्रथाओं के अनुसार प्रक्रियाओं के दौरान पुनः स्टेरिलाइज्ड की गई वस्तुओं के उपयोग के बारे में समझाया गया है और मैं पुनः स्टेरिलाइज्ड की गई वस्तुओं के उपयोग के लिए मेरी सहमति देता हूँ।' },
          { en: 'I understand that the hospital and its doctors/staff are acting in good faith and with good intentions following the best clinical practice guidelines and therefore I indemnify the hospital and its doctor/staff from any consequential or consequential damages and/or liabilities. I understand that I have been explained about seeking second opinion from any doctor before giving consent for the operation/procedure and even after signing the consent I am free to request for further clarification and even withdraw my consent before the onset of the operation/procedure.', hi: 'मैं समझता हूँ कि अस्पताल और उसके डॉक्टर / कर्मचारी अच्छे विश्वास में और सर्वोत्तम नैदानिक अभ्यास दिशा निर्देशों के अपने इरादे से काम कर रहे हैं और इसलिए मैं अस्पताल और उसके डॉक्टरों / कर्मचारियों को किसी भी परिणाम और देनदारियों से मुक्त करता हूँ। मैं समझता हूँ कि मुझे शल्य चिकित्सा / प्रक्रिया के लिए सहमति देने से पहले किसी भी डॉक्टर से दूसरी राय मांगने के बारे में समझाया गया है और सहमति पर हस्ताक्षर करने के बाद भी मैं स्पष्टीकरण के लिए अनुरोध करने के लिए स्वतंत्र हूँ और शल्य चिकित्सा / प्रक्रिया की शुरुआत से पहले अपनी सहमति वापस ले सकता हूँ।' },
          { en: 'I have been explained the details of the surgery, its benefits, possible risks, and alternatives. I understand the information and give my voluntary consent for the procedure mentioned above.', hi: 'मुझे ऑपरेशन की पूरी जानकारी, इसके लाभ, संभावित जोखिम तथा अन्य विकल्पों के बारे में बताया गया है। मैंने सारी जानकारी समझ ली है और मैं अपनी इच्छा से उपरोक्त प्रक्रिया के लिए सहमति देता/देती हूँ।' }
        ]),
        signatureTable(['patient', 'surgeon', 'witness', 'interpreter']),
        standardNotes
      ] }
    ]
  }
];

module.exports = { version: '4.0', templates };
