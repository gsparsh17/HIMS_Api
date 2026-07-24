const commonSignatureFields = [
  { key: 'patientOrRepresentativeName', label: 'Patient / Authorized Representative Name', type: 'text', required: true },
  { key: 'relationship', label: 'Relationship with Patient', type: 'text' },
  { key: 'patientSignature', label: 'Patient / Representative Signature Confirmation', type: 'text', helpText: 'Signatory full name or confirmation note.' },
  { key: 'patientSignatureUrl', label: 'Patient / Representative Signature / Thumb Impression Photo', type: 'image-upload', helpText: 'Upload photo of signature or thumb impression.' },
  { key: 'doctorName', label: 'Doctor Name', type: 'text', required: true },
  { key: 'doctorSignature', label: 'Doctor Signature Confirmation', type: 'text' },
  { key: 'doctorSignatureUrl', label: 'Doctor Digital Signature Image / Cloudinary Link', type: 'image-upload', helpText: 'Upload signature image or apply verified doctor signature.' },
  { key: 'doctorSealUrl', label: 'Hospital Official Seal Image / Cloudinary Link', type: 'image-upload', helpText: 'Upload seal image or apply verified hospital seal.' },
  { key: 'witnessName', label: 'Witness Name', type: 'text' },
  { key: 'witnessSignature', label: 'Witness Signature Confirmation', type: 'text' },
  { key: 'witnessSignatureUrl', label: 'Witness Signature Photo', type: 'image-upload', helpText: 'Upload photo of witness signature.' },
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
      { title: 'Local Anaesthesia / MAC', text: 'Local injection of numbing medicine with optional IV sedation. Benefits include fast recovery and minimal systemic side-effects. Risks may include local pain, toxicity or partial pain control.' }
    ]
  },
  {
    id: 'blood-transfusion-consent',
    name: 'Blood & Blood Product Transfusion Consent',
    bilingualName: 'रक्त एवं रक्त घटक चढ़ाने हेतु सहमति',
    version: '1.0',
    description: 'Informed consent for transfusion of whole blood, packed cells, plasma, platelets or other blood products.',
    fields: [
      { key: 'bloodComponents', label: 'Blood Components Required', type: 'checkbox-group', required: true, options: ['Whole Blood', 'Packed Red Blood Cells (PRBC)', 'Fresh Frozen Plasma (FFP)', 'Platelets / RDP / SDP', 'Cryoprecipitate'] },
      { key: 'bloodGroup', label: 'Blood Group (If Known)', type: 'select', options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Not yet grouped'] },
      { key: 'rhType', label: 'Rh Type', type: 'select', options: ['Positive', 'Negative', 'Unknown'] },
      { key: 'indication', label: 'Clinical Indication for Transfusion', type: 'textarea', required: true },
      { key: 'benefitsExplained', label: 'Benefits explained to patient / representative', type: 'checkbox', required: true },
      { key: 'risksExplained', label: 'Known risks, adverse reactions and limitations explained', type: 'checkbox', required: true },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Benefits / लाभ', text: 'Transfusion may restore blood volume, improve oxygen delivery, correct severe anaemia, control bleeding and support recovery.' },
      { title: 'Risks / जोखिम', text: 'Possible risks include fever, chills, allergic reaction, breathing difficulty, infection despite screening, lung injury or rare severe transfusion reactions.' }
    ]
  },
  {
    id: 'high-risk-consent',
    name: 'High Risk Informed Consent Form',
    bilingualName: 'उच्च जोखिम सहमति पत्र',
    version: '1.0',
    description: 'Special informed consent for high-risk patients, emergency procedures or complex interventions.',
    fields: [
      { key: 'diagnosis', label: 'Clinical Diagnosis / Medical Condition', type: 'textarea', required: true },
      { key: 'procedureName', label: 'Proposed High Risk Procedure / Treatment', type: 'text', required: true },
      { key: 'highRiskReasons', label: 'High Risk Factors / Comorbidities', type: 'textarea', required: true },
      { key: 'risksAccepted', label: 'Specific High Risks Explained & Understood', type: 'textarea', required: true },
      { key: 'alternativesExplained', label: 'Alternative options and non-treatment consequences explained', type: 'checkbox', required: true },
      { key: 'guaranteeDisclaimer', label: 'Understood that medical outcomes cannot be guaranteed despite best clinical care', type: 'checkbox', required: true },
      { key: 'questionsAnswered', label: 'Questions answered satisfactorily', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'High Risk Factors', text: 'The treating doctor has explained the illness, proposed high-risk treatment, expected benefits, alternatives and potential life-threatening complications.' }
    ]
  },
  {
    id: 'mlc-refusal-consent',
    name: 'MLC / Treatment Against Medical Advice (LAMA) Refusal',
    bilingualName: 'चिकित्सकीय सलाह के विरुद्ध प्रस्थान / इनकार',
    version: '1.0',
    description: 'Refusal of treatment, investigation, admission or leave against medical advice (LAMA/DAMA).',
    fields: [
      { key: 'refusalType', label: 'Type of Refusal', type: 'select', required: true, options: ['Leave Against Medical Advice (LAMA)', 'Discharge Against Medical Advice (DAMA)', 'Refusal of Specific Investigation / Treatment', 'Refusal of Hospital Admission'] },
      { key: 'reasonForRefusal', label: 'Reason for Refusal', type: 'textarea', required: true },
      { key: 'risksOfRefusalExplained', label: 'Risks of non-treatment, deterioration or death explained', type: 'checkbox', required: true },
      { key: 'hospitalNotResponsible', label: 'Understood that hospital and doctors are not responsible for consequences of refusal', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Refusal Statement', text: 'I am leaving or refusing treatment against medical advice. All risks of deterioration, complications or death have been explained, and I release the hospital from liability.' }
    ]
  },
  {
    id: 'restraint-consent',
    name: 'Patient Physical / Chemical Restraint Consent',
    bilingualName: 'रोगी संयम / रिस्ट्रेंट सहमति पत्र',
    version: '1.0',
    description: 'Consent for therapeutic physical or chemical restraint for patient safety.',
    fields: [
      { key: 'restraintReason', label: 'Clinical Reason / Safety Risk', type: 'textarea', required: true },
      { key: 'restraintType', label: 'Type of Restraint', type: 'checkbox-group', required: true, options: ['Limb Restraint', 'Bed Side Rails', 'Chest / Belt Restraint', 'Chemical Sedation'] },
      { key: 'alternativesAttempted', label: 'Alternative safety measures attempted', type: 'textarea' },
      { key: 'monitoringPlanExplained', label: 'Regular monitoring and skin/circulation checks explained', type: 'checkbox', required: true },
      ...commonSignatureFields
    ],
    printSections: [
      { title: 'Restraint Safety Statement', text: 'Restraint is ordered solely for patient safety to prevent falls, self-harm or disruption of life-support lines.' }
    ]
  }
];

module.exports = { version: '1.0', templates };
