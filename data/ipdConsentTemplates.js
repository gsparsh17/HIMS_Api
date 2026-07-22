const commonSignatureFields = [
  { key: 'patientOrRepresentativeName', label: 'Patient / Authorized Representative Name', type: 'text', required: true },
  { key: 'relationship', label: 'Relationship with Patient', type: 'text' },
  { key: 'patientSignature', label: 'Patient / Representative Signature or Thumb Impression', type: 'text', helpText: 'Record how the signed paper copy was obtained, or type the signatory name for electronic record.' },
  { key: 'doctorName', label: 'Doctor Name', type: 'text', required: true },
  { key: 'doctorSignature', label: 'Doctor Signature / Confirmation', type: 'text' },
  { key: 'witnessName', label: 'Witness Name', type: 'text' },
  { key: 'witnessSignature', label: 'Witness Signature / Confirmation', type: 'text' },
  { key: 'interpreterName', label: 'Interpreter Name (if applicable)', type: 'text' },
  { key: 'signedDate', label: 'Date of Consent', type: 'date', required: true },
  { key: 'signedTime', label: 'Time of Consent', type: 'time', required: true }
];

const templates = [
  {
    id: 'general-consent',
    name: 'General Consent Form',
    bilingualName: 'सामान्य सहमति / मान्यता पत्र',
    version: '1.0',
    description: 'General consent for admission, examination, investigations, medicines, supportive care and emergency treatment.',
    fields: [
      { key: 'admissionAndCareConsent', label: 'Consent to admission and routine hospital care', type: 'checkbox', required: true },
      { key: 'examinationInvestigationConsent', label: 'Consent to examination and clinically required investigations', type: 'checkbox', required: true },
      { key: 'medicineTreatmentConsent', label: 'Consent to medicines, injections, IV treatment and supportive care', type: 'checkbox', required: true },
      { key: 'emergencyTreatmentConsent', label: 'Consent to emergency and life-saving treatment when delay is unsafe', type: 'checkbox', required: true },
      { key: 'informationExplained', label: 'Hospital policies, expected care, limitations and responsibilities explained', type: 'checkbox', required: true },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      { key: 'specialLimitations', label: 'Special limitations / remarks', type: 'textarea' },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'General Authorization', text: 'I authorize admission, clinical examination, appropriate investigations, medicines, injections, IV fluids and other supportive care considered necessary by the treating team.' },
      { title: 'Emergency Care', text: 'When delay may threaten life or health, I authorize the hospital to provide reasonable emergency and life-saving care according to clinical judgement.' },
      { title: 'Acknowledgement', text: 'The proposed care, hospital policies, possible limitations and my opportunity to ask questions have been explained in a language I understand.' }
    ]
  },
  {
    id: 'infectious-disease-screening-consent',
    name: 'Consent for HIV / HBsAg / HCV Testing',
    bilingualName: 'एचआईवी / एचबीएसएजी / एचसीवी जांच हेतु सहमति',
    version: '1.0',
    description: 'Voluntary informed consent and pre-test counselling record for HIV, hepatitis B and hepatitis C screening.',
    fields: [
      { key: 'testsRequested', label: 'Tests Requested', type: 'checkbox-group', required: true, options: ['HIV', 'HBsAg', 'HCV', 'Other communicable disease test'] },
      { key: 'clinicalReason', label: 'Clinical Reason / Indication', type: 'textarea' },
      { key: 'purposeExplained', label: 'Purpose and testing procedure explained', type: 'checkbox', required: true },
      { key: 'possibleResultsExplained', label: 'Reactive, non-reactive and inconclusive result possibilities explained', type: 'checkbox', required: true },
      { key: 'confidentialityExplained', label: 'Confidentiality and disclosure policy explained', type: 'checkbox', required: true },
      { key: 'voluntaryConsent', label: 'Consent is voluntary and without pressure', type: 'checkbox', required: true },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Information and Counselling', text: 'The purpose, procedure, limitations and possible results of HIV, hepatitis B and hepatitis C testing have been explained in an understandable language.' },
      { title: 'Confidentiality', text: 'Results will be handled confidentially and disclosed only according to applicable law, hospital policy and clinical necessity.' },
      { title: 'Voluntary Consent', text: 'I voluntarily consent to the selected tests and understand that appropriate post-test counselling and follow-up will be offered.' }
    ]
  },
  {
    id: 'surgery-consent',
    name: 'Surgery Consent Form',
    bilingualName: 'शल्य चिकित्सा सहमति पत्र',
    version: '1.0',
    description: 'Consent for an operation or invasive procedure, including expected benefits, material risks and permission for necessary additional procedures.',
    fields: [
      { key: 'procedureName', label: 'Procedure / Surgery Name', type: 'text', required: true },
      { key: 'diagnosis', label: 'Diagnosis', type: 'textarea', required: true },
      { key: 'benefitsExplained', label: 'Benefits explained to patient / representative', type: 'checkbox', required: true },
      { key: 'risksExplained', label: 'Risks and possible complications explained', type: 'checkbox', required: true },
      { key: 'alternativesExplained', label: 'Alternatives and consequences of refusing treatment explained', type: 'checkbox' },
      { key: 'specificRisks', label: 'Patient-specific risks / limitations', type: 'textarea' },
      { key: 'additionalProcedureConsent', label: 'Consent for additional or different procedures if unforeseen conditions arise', type: 'checkbox' },
      { key: 'questionsAnswered', label: 'Opportunity to ask questions was given and questions were answered', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Benefits / लाभ', text: 'The proposed operation may correct or improve the condition, prevent deterioration or life-threatening complications, relieve pain, improve function and quality of life, and may be the only effective treatment in some cases.' },
      { title: 'Risks / जोखिम', text: 'Possible risks include bleeding, infection, reaction to anaesthesia, injury to nearby organs or blood vessels, incomplete cure or recurrence, need for further surgery, pain, swelling, delayed healing, disability or death.' },
      { title: 'Consent Statement / सहमति वक्तव्य', text: 'I understand that every operation or procedure involves risks. I authorize the required operation or procedure and, when medically necessary, additional or different procedures arising from unforeseen conditions.' }
    ]
  },
  {
    id: 'anaesthesia-consent',
    name: 'Anaesthesia Consent Form',
    bilingualName: 'एनेस्थीसिया सहमति प्रपत्र',
    version: '1.0',
    description: 'Consent for general, regional, local or monitored anaesthesia.',
    fields: [
      { key: 'plannedAnaesthesia', label: 'Planned Anaesthesia Type', type: 'checkbox-group', required: true, options: ['General Anaesthesia', 'Regional Anaesthesia', 'Local Anaesthesia', 'Sedation / MAC'] },
      { key: 'plannedProcedure', label: 'Planned Procedure', type: 'text', required: true },
      { key: 'anaesthesiaBenefitsExplained', label: 'Benefits of the selected anaesthesia explained', type: 'checkbox', required: true },
      { key: 'anaesthesiaRisksExplained', label: 'Anaesthesia risks and complications explained', type: 'checkbox', required: true },
      { key: 'specialAnaesthesiaRisks', label: 'Patient-specific anaesthesia risks', type: 'textarea' },
      { key: 'bloodConsentDiscussed', label: 'Possibility of blood transfusion discussed when relevant', type: 'checkbox' },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'General Anaesthesia', text: 'The patient is fully unconscious. Benefits include complete pain relief and no memory of the procedure. Risks may include nausea, vomiting, sore throat, breathing or cardiac problems and rare awareness.' },
      { title: 'Regional Anaesthesia', text: 'A specific region is numbed. Benefits include avoiding full unconsciousness, faster recovery and effective pain control. Risks may include headache, low blood pressure, incomplete block and rare nerve injury.' },
      { title: 'Local Anaesthesia / Sedation', text: 'A small area is numbed or conscious sedation is provided. Risks include allergy, inadequate pain control, swelling, bruising, breathing difficulty or excessive sedation.' }
    ]
  },
  {
    id: 'blood-transfusion-consent',
    name: 'Blood Transfusion Consent Form',
    bilingualName: 'रक्त चढ़ाने की सहमति पत्र',
    version: '1.0',
    description: 'Consent for blood or blood-component transfusion.',
    fields: [
      { key: 'bloodComponents', label: 'Blood / Components Planned', type: 'checkbox-group', required: true, options: ['Whole Blood', 'Packed Red Cells', 'Platelets', 'Fresh Frozen Plasma (FFP)', 'Cryoprecipitate', 'Other'] },
      { key: 'otherComponent', label: 'Other Component', type: 'text' },
      { key: 'bloodGroup', label: 'Blood Group', type: 'text' },
      { key: 'rhType', label: 'Rh Type', type: 'select', options: ['Positive', 'Negative', 'Unknown'] },
      { key: 'benefitsExplained', label: 'Benefits explained', type: 'checkbox', required: true },
      { key: 'transfusionRisksExplained', label: 'Transfusion reactions and infection risks explained', type: 'checkbox', required: true },
      { key: 'alternativesExplained', label: 'Alternatives and consequences of refusing transfusion explained', type: 'checkbox' },
      { key: 'previousReaction', label: 'Previous transfusion reaction / relevant history', type: 'textarea' },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Benefits / लाभ', text: 'Transfusion can restore blood volume, improve oxygen delivery, correct anaemia, control bleeding and support recovery from surgery, injury or severe illness.' },
      { title: 'Possible Risks and Complications', text: 'Risks include rash, itching, fever, chills, breathing difficulty, low blood pressure, infection transmission despite screening, iron overload, lung injury and complications related to venous access.' },
      { title: 'Severe Outcomes', text: 'Rare severe reactions may cause acute haemolysis, kidney failure, shock, anaphylaxis, cardiac arrest, sepsis, multi-organ failure or death.' }
    ]
  },
  {
    id: 'high-risk-consent',
    name: 'High Risk Consent Form',
    bilingualName: 'उच्च-जोखिम सहमति पत्र',
    version: '1.0',
    description: 'Acknowledgement and consent for a high-risk illness, procedure or surgery.',
    fields: [
      { key: 'diagnosis', label: 'Primary Diagnosis / Illness', type: 'textarea', required: true },
      { key: 'procedureName', label: 'Procedure / Surgery (if applicable)', type: 'text' },
      { key: 'highRiskReasons', label: 'Reasons why this is a high-risk case', type: 'textarea', required: true },
      { key: 'risksAccepted', label: 'Risks discussed', type: 'checkbox-group', options: ['Bleeding', 'Infection', 'Damage to surrounding organs', 'Anaesthesia-related risk', 'Worsening of condition', 'Permanent disability', 'Death', 'Other'] },
      { key: 'otherRisks', label: 'Other Patient-Specific Risks', type: 'textarea' },
      { key: 'alternativesExplained', label: 'Alternatives, limitations and likely outcomes explained', type: 'checkbox', required: true },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      { key: 'voluntaryConsent', label: 'Consent is voluntary and without pressure', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'High-Risk Declaration', text: 'The doctor has explained the present illness, advised treatment or surgery, expected benefits, limitations and alternative options. The patient or representative understands that the clinical condition carries an increased risk of complications.' },
      { title: 'Possible Complications', text: 'Complications may include bleeding, infection, damage to surrounding organs, anaesthesia-related events, worsening of the current condition, permanent disability or death.' },
      { title: 'Consent', text: 'Having understood the above, I voluntarily consent to the proposed treatment or procedure and authorize the medical team to provide care considered necessary in the patient’s best interest.' }
    ]
  },
  {
    id: 'lama-dor-consent',
    name: 'Consent - LAMA / DOR',
    bilingualName: 'चिकित्सकीय सलाह के विरुद्ध छुट्टी',
    version: '1.0',
    description: 'Discharge on request or leaving against medical advice.',
    fields: [
      { key: 'requestingPersonName', label: 'Person Requesting Discharge', type: 'text', required: true },
      { key: 'requestingPersonRelation', label: 'Relationship with Patient', type: 'text', required: true },
      { key: 'reasonForLeaving', label: 'Reason for Leaving / Discharge on Request', type: 'textarea', required: true },
      { key: 'conditionExplained', label: 'Current condition and consequences of leaving were explained', type: 'checkbox', required: true },
      { key: 'riskAccepted', label: 'Responsibility for risks and outcomes accepted', type: 'checkbox', required: true },
      { key: 'transportAdvice', label: 'Transport, medicines and follow-up advice given', type: 'textarea' },
      { key: 'doctorCertification', label: 'Doctor Certification / Clinical Advice', type: 'textarea', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Patient / Representative Declaration', text: 'I request discharge against medical advice / on request and accept full responsibility for the decision. The condition of the patient, recommended treatment and possible consequences have been explained to me.' },
      { title: 'Hospital Responsibility', text: 'I understand that the hospital and its staff cannot be held responsible for adverse outcomes caused by refusal of recommended treatment or premature discharge.' },
      { title: 'Doctor Certification', text: 'The treating doctor certifies that the risks, benefits, possible complications and recommended continuation of treatment were discussed with the patient or authorized representative.' }
    ]
  },
  {
    id: 'mlc-refusal-consent',
    name: 'Medical Legal Case (MLC) Refusal Consent Form',
    bilingualName: 'मेडिकल लीगल केस अस्वीकृति सहमति प्रपत्र',
    version: '1.0',
    description: 'Record of informed refusal of medico-legal case registration.',
    fields: [
      { key: 'reasonMLCRecommended', label: 'Why MLC registration was recommended', type: 'textarea', required: true },
      { key: 'mlcMeaningExplained', label: 'Meaning and purpose of MLC explained', type: 'checkbox', required: true },
      { key: 'legalImplicationsExplained', label: 'Legal, insurance and medico-legal implications explained', type: 'checkbox', required: true },
      { key: 'refusalReason', label: 'Reason for refusing MLC registration', type: 'textarea', required: true },
      { key: 'voluntaryRefusal', label: 'Refusal is voluntary and without pressure or coercion', type: 'checkbox', required: true },
      { key: 'responsibilityAccepted', label: 'Responsibility for legal consequences accepted', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Information Provided', text: 'The attending doctor has explained what a Medical Legal Case means, why this case may qualify for registration, the legal implications of registration or refusal and possible effects on legal protection, insurance claims and medico-legal support.' },
      { title: 'Statement of Refusal', text: 'Despite being informed, I voluntarily refuse MLC registration of my own free will and without pressure, influence or coercion.' },
      { title: 'Declaration of Responsibility', text: 'I understand that refusal may reduce legal protection and affect claims or medico-legal support. I accept responsibility for the consequences of this decision.' }
    ]
  },
  {
    id: 'restraint-consent',
    name: 'Restraint Consent Form',
    bilingualName: 'अंग प्रतिबंधित सहमति प्रपत्र',
    version: '1.0',
    description: 'Informed consent for temporary physical restraint of an agitated patient.',
    fields: [
      { key: 'guardianName', label: 'Legal Guardian / Authorized Representative', type: 'text', required: true },
      { key: 'reasonForRestraint', label: 'Reason for Physical Restraint', type: 'textarea', required: true },
      { key: 'alternativesAttempted', label: 'Alternatives attempted before restraint', type: 'textarea' },
      { key: 'limbsOrDevices', label: 'Limbs / Devices to be restrained', type: 'text' },
      { key: 'monitoringPlan', label: 'Monitoring and reassessment plan', type: 'textarea', required: true },
      { key: 'dignityExplained', label: 'Humane care, dignity and comfort safeguards explained', type: 'checkbox', required: true },
      { key: 'temporaryUseExplained', label: 'Temporary use and periodic reassessment explained', type: 'checkbox', required: true },
      { key: 'clarificationQuestions', label: 'Clarifications / Additional Remarks', type: 'textarea' },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Reason and Objective', text: 'Physical restraint may be applied only when necessary to protect the patient, staff or other persons and to prevent injury caused by severe agitation or aggressive behaviour.' },
      { title: 'Procedure and Care', text: 'Restraint will be applied humanely with appropriate equipment. The team will protect dignity and comfort, monitor vital signs and limb circulation, provide hygiene and repositioning, and reassess the need at regular intervals.' },
      { title: 'Consent', text: 'I understand the reasons, expected benefits and possible risks of restraint and authorize its temporary use with continuous clinical monitoring and removal as soon as it is safe.' }
    ]
  },
  {
    id: 'hiv-serology-consent',
    name: 'Informed Consent for HIV Testing',
    bilingualName: 'एचआईवी परीक्षण हेतु सूचित सहमति',
    version: '1.0',
    description: 'Voluntary informed consent and counselling record for HIV serology testing.',
    fields: [
      { key: 'reasonForTest', label: 'Reason / Indication for HIV Test', type: 'textarea' },
      { key: 'preTestCounselling', label: 'Pre-test counselling completed', type: 'checkbox', required: true },
      { key: 'testMeaningExplained', label: 'Meaning of reactive, non-reactive and inconclusive results explained', type: 'checkbox', required: true },
      { key: 'windowPeriodExplained', label: 'Window period and possible repeat testing explained', type: 'checkbox', required: true },
      { key: 'confidentialityExplained', label: 'Confidentiality and disclosure policy explained', type: 'checkbox', required: true },
      { key: 'voluntaryConsent', label: 'Consent is voluntary and may be withdrawn before testing', type: 'checkbox', required: true },
      { key: 'benefitAcknowledged', label: 'Benefits of knowing HIV status and accessing care explained', type: 'checkbox' },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Introduction', text: 'HIV is a virus that may cause AIDS. The test looks for evidence of infection. A reactive result requires confirmatory testing; a non-reactive result may not exclude very recent infection during the window period.' },
      { title: 'Confidentiality and Counselling', text: 'The result will be kept confidential and shared according to law and hospital policy. Pre-test and post-test counselling, prevention information and referral for care will be provided as appropriate.' },
      { title: 'Voluntary Consent', text: 'I have received understandable information about the test, its benefits, limitations and possible results. I voluntarily consent to HIV testing and understand that I may withdraw consent before the sample is tested.' }
    ]
  }
];

module.exports = { version: '2026.07.20', templates };
