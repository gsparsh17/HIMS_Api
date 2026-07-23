const field = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const section = (title, fields, extra = {}) => ({ title, fields, ...extra });

const templates = [
  {
    id: 'general_consent',
    version: 1,
    title: 'General Consent Form',
    shortTitle: 'General Consent',
    category: 'consent', stage: 'preop', required: true, implementation: 'structured',
    referencePages: [5],
    description: 'General admission, examination, treatment, investigation, photography and hospital-care consent.',
    sections: [
      section('Patient and representative', [
        field('patientName', 'Patient name', 'text', { required: true }),
        field('representativeName', 'Representative / attendant name'),
        field('relationship', 'Relationship with patient'),
        field('languageExplained', 'Language used for explanation'),
        field('interpreterName', 'Interpreter / witness name'),
      ]),
      section('Consent statements', [
        field('consentToAdmission', 'Consent to admission and hospital care', 'checkbox', { required: true }),
        field('consentToExamination', 'Consent to clinical examination and investigations', 'checkbox', { required: true }),
        field('consentToTreatment', 'Consent to medicines, procedures and supportive treatment', 'checkbox', { required: true }),
        field('consentToEmergencyCare', 'Consent to emergency and life-saving treatment', 'checkbox'),
        field('consentToPhotography', 'Consent to clinical photography / imaging for care', 'checkbox'),
        field('informationExplained', 'Information, risks and hospital policies explained', 'checkbox', { required: true }),
      ]),
      section('Acknowledgement', [
        field('questionsAnswered', 'Questions answered to satisfaction', 'checkbox'),
        field('remarks', 'Remarks / limitations', 'textarea'),
        field('consentDateTime', 'Consent date and time', 'datetime-local', { required: true }),
        field('patientOrRepresentativeName', 'Name of patient / representative signing', 'text', { required: true }),
        field('witnessName', 'Witness name'),
        field('explainedBy', 'Explained by'),
      ]),
    ],
  },
  {
    id: 'communicable_disease_testing_consent', version: 1,
    title: 'HIV / HBsAg / HCV Testing Consent', shortTitle: 'Infectious Disease Test Consent',
    category: 'consent', stage: 'preop', required: true, implementation: 'structured', referencePages: [6],
    description: 'Pre-test informed consent for HIV, hepatitis B and hepatitis C testing.',
    sections: [
      section('Requested tests', [
        field('tests', 'Tests consented', 'checklist', { required: true, options: ['HIV', 'HBsAg', 'HCV', 'Other communicable disease test'] }),
        field('clinicalReason', 'Clinical reason for testing', 'textarea'),
      ]),
      section('Pre-test counselling', [
        field('purposeExplained', 'Purpose and procedure explained', 'checkbox', { required: true }),
        field('resultPossibilitiesExplained', 'Positive, negative and indeterminate results explained', 'checkbox', { required: true }),
        field('confidentialityExplained', 'Confidentiality and disclosure policy explained', 'checkbox', { required: true }),
        field('voluntaryConsent', 'Consent given voluntarily without pressure', 'checkbox', { required: true }),
        field('counsellorNotes', 'Counselling notes', 'textarea'),
      ]),
      section('Consent details', [
        field('patientOrRepresentativeName', 'Patient / representative name', 'text', { required: true }),
        field('relationship', 'Relationship'),
        field('doctorName', 'Doctor / counsellor name', 'text', { required: true }),
        field('consentDateTime', 'Date and time', 'datetime-local', { required: true }),
      ]),
    ],
  },
  {
    id: 'high_risk_consent', version: 1,
    title: 'High Risk Consent', shortTitle: 'High Risk Consent', category: 'consent', stage: 'preop', required: false,
    implementation: 'structured', referencePages: [8, 9, 16],
    description: 'Procedure-specific high-risk consent with expected benefits, material risks and alternatives.',
    sections: [
      section('Clinical context', [
        field('diagnosis', 'Diagnosis / condition', 'textarea', { required: true }),
        field('proposedProcedure', 'Proposed operation / procedure', 'textarea', { required: true }),
        field('reasonHighRisk', 'Reason the patient is high risk', 'textarea', { required: true }),
      ]),
      section('Risk disclosure', [
        field('materialRisks', 'Material risks and possible complications', 'table', {
          required: true,
          columns: [field('risk', 'Risk / complication'), field('severity', 'Severity'), field('explained', 'Explained', 'checkbox')],
        }),
        field('riskOfDeathExplained', 'Risk of death / permanent disability explained where applicable', 'checkbox'),
        field('icuVentilatorPossibility', 'ICU / ventilator / prolonged stay possibility explained', 'checkbox'),
        field('bloodTransfusionPossibility', 'Blood transfusion possibility explained', 'checkbox'),
        field('additionalProcedurePossibility', 'Additional or alternative procedure possibility explained', 'checkbox'),
      ]),
      section('Decision', [
        field('alternatives', 'Available alternatives and consequences of refusal', 'textarea'),
        field('questionsAnswered', 'Questions answered', 'checkbox', { required: true }),
        field('decision', 'Decision', 'select', { required: true, options: ['Consent given', 'Consent refused', 'Deferred for discussion'] }),
        field('patientOrRepresentativeName', 'Patient / representative name', 'text', { required: true }),
        field('relationship', 'Relationship'),
        field('doctorName', 'Doctor explaining risk', 'text', { required: true }),
        field('witnessName', 'Witness / interpreter'),
        field('consentDateTime', 'Date and time', 'datetime-local', { required: true }),
      ]),
    ],
  },
  {
    id: 'surgery_procedure_consent', version: 1,
    title: 'Consent for Operation / Procedure', shortTitle: 'Surgery Consent', category: 'consent', stage: 'preop', required: true,
    implementation: 'structured', referencePages: [17],
    description: 'Procedure-specific informed consent covering benefits, risks, alternatives, blood, implants and additional procedures.',
    sections: [
      section('Proposed procedure', [
        field('consultantInCharge', 'Consultant in charge', 'text', { required: true }),
        field('diagnosis', 'Diagnosis', 'textarea', { required: true }),
        field('procedureName', 'Operation / procedure name', 'textarea', { required: true }),
        field('siteAndSide', 'Site and side', 'text'),
        field('expectedBenefits', 'Expected benefits', 'textarea'),
      ]),
      section('Material information', [
        field('risks', 'Risks and possible complications', 'table', {
          required: true,
          columns: [field('risk', 'Risk / complication'), field('likelihood', 'Likelihood'), field('notes', 'Patient-specific notes')],
        }),
        field('alternatives', 'Reasonable alternatives', 'textarea'),
        field('consequencesOfNoTreatment', 'Likely consequences of no treatment', 'textarea'),
        field('bloodConsentIncluded', 'Blood / blood product administration authorised if clinically required', 'checkbox'),
        field('implantConsentIncluded', 'Implants / prosthesis authorised where required', 'checkbox'),
        field('additionalProcedureConsent', 'Necessary additional procedure authorised if unforeseen findings occur', 'checkbox'),
        field('teachingPhotographyConsent', 'Teaching / photography consent', 'checkbox'),
      ]),
      section('Consent and witnesses', [
        field('patientOrRepresentativeName', 'Patient / representative name', 'text', { required: true }),
        field('relationship', 'Relationship'),
        field('doctorName', 'Doctor obtaining consent', 'text', { required: true }),
        field('nurseInterpreterName', 'Nurse / interpreter / witness'),
        field('consentDateTime', 'Consent date and time', 'datetime-local', { required: true }),
        field('remarks', 'Remarks', 'textarea'),
      ]),
    ],
  },
  {
    id: 'anesthesia_consent', version: 1,
    title: 'Consent for Anaesthesia and Sedation', shortTitle: 'Anaesthesia Consent', category: 'consent', stage: 'preop', required: true,
    implementation: 'structured', referencePages: [18],
    description: 'Consent for general, neuraxial, regional, local anaesthesia and sedation techniques.',
    sections: [
      section('Planned anaesthesia', [
        field('plannedTechniques', 'Anaesthesia techniques discussed', 'checklist', { required: true, options: ['General anaesthesia', 'Spinal anaesthesia', 'Epidural anaesthesia', 'Combined spinal-epidural', 'Regional / nerve block', 'Local anaesthesia', 'Intravenous sedation', 'Other'] }),
        field('plannedTechniqueNotes', 'Planned technique / site / block details', 'textarea'),
      ]),
      section('Risks discussed', [
        field('commonRisks', 'Common risks discussed', 'checklist', { options: ['Nausea / vomiting', 'Sore throat / dental injury', 'Headache', 'Pain / bruising at injection site', 'Temporary weakness / numbness', 'Allergic reaction'] }),
        field('seriousRisks', 'Serious risks discussed', 'checklist', { options: ['Difficult airway', 'Aspiration', 'Severe drug reaction', 'Nerve injury', 'Awareness', 'Cardiac / respiratory arrest', 'ICU / ventilator support', 'Death'] }),
        field('conversionPossibility', 'Possibility of conversion to another anaesthesia technique explained', 'checkbox'),
        field('bloodProductsPossibility', 'Possibility of blood / blood products explained', 'checkbox'),
      ]),
      section('Consent', [
        field('questionsAnswered', 'Questions answered to satisfaction', 'checkbox', { required: true }),
        field('patientOrRepresentativeName', 'Patient / representative name', 'text', { required: true }),
        field('relationship', 'Relationship'),
        field('anaesthetistName', 'Anaesthetist obtaining consent', 'text', { required: true }),
        field('witnessName', 'Witness / interpreter'),
        field('consentDateTime', 'Date and time', 'datetime-local', { required: true }),
      ]),
    ],
  },
  {
    id: 'blood_transfusion_consent', version: 1,
    title: 'Consent for Blood and Blood Product Transfusion', shortTitle: 'Blood Transfusion Consent', category: 'consent', stage: 'preop', required: false,
    implementation: 'structured', referencePages: [57],
    description: 'Informed consent for whole blood, packed cells, platelets, plasma and other products.',
    sections: [
      section('Indication and products', [
        field('indication', 'Indication for transfusion', 'textarea', { required: true }),
        field('plannedProducts', 'Blood products planned', 'checklist', { required: true, options: ['Whole blood', 'Packed red cells', 'Platelets', 'Fresh frozen plasma', 'Cryoprecipitate', 'Other'] }),
        field('estimatedUnits', 'Estimated number of units / volume'),
      ]),
      section('Information disclosed', [
        field('benefitsExplained', 'Expected benefits explained', 'checkbox', { required: true }),
        field('reactionRisksExplained', 'Febrile, allergic, haemolytic and other reactions explained', 'checkbox', { required: true }),
        field('infectionRiskExplained', 'Residual infection-transmission risk explained', 'checkbox', { required: true }),
        field('alternativesExplained', 'Alternatives and consequences of refusal explained', 'checkbox'),
        field('emergencyProductsAuthorised', 'Compatible emergency blood products authorised when delay is unsafe', 'checkbox'),
      ]),
      section('Consent', [
        field('decision', 'Decision', 'select', { required: true, options: ['Consent given', 'Consent refused', 'Deferred'] }),
        field('patientOrRepresentativeName', 'Patient / representative name', 'text', { required: true }),
        field('relationship', 'Relationship'),
        field('doctorName', 'Doctor obtaining consent', 'text', { required: true }),
        field('witnessName', 'Witness'),
        field('consentDateTime', 'Date and time', 'datetime-local', { required: true }),
      ]),
    ],
  },
  {
    id: 'patient_history_physical_examination', version: 1,
    title: 'Patient History and Physical Examination', shortTitle: 'History & Physical', category: 'assessment', stage: 'preop', required: true,
    implementation: 'structured', referencePages: [19, 20],
    description: 'Comprehensive pre-operative clinical history, examination, diagnosis, investigations and treatment plan.',
    sections: [
      section('History', [
        field('sourceOfHistory', 'Source of history'),
        field('chiefComplaints', 'Chief complaints', 'table', { required: true, columns: [field('complaint', 'Complaint'), field('duration', 'Duration')] }),
        field('historyPresentIllness', 'History of present illness', 'textarea'),
        field('pastMedicalHistory', 'Past medical history', 'textarea'),
        field('pastSurgicalHistory', 'Past surgical / anaesthesia history', 'textarea'),
        field('personalHistory', 'Personal / addiction / diet / sleep history', 'textarea'),
        field('allergies', 'Allergies', 'textarea'),
        field('currentMedications', 'Current medications', 'textarea'),
      ]),
      section('Pain and examination', [
        field('painScore', 'Pain score (0-10)', 'number'),
        field('painSite', 'Pain site / character / radiation'),
        field('generalExamination', 'General examination', 'textarea'),
        field('vitals', 'Vitals', 'table', { columns: [field('parameter', 'Parameter'), field('value', 'Value'), field('unit', 'Unit')], defaultRows: [{ parameter: 'Pulse' }, { parameter: 'Blood pressure' }, { parameter: 'Respiratory rate' }, { parameter: 'SpO2' }, { parameter: 'Temperature' }] }),
        field('systemicExamination', 'Systemic examination', 'table', { columns: [field('system', 'System'), field('findings', 'Findings')], defaultRows: [{ system: 'CVS' }, { system: 'Respiratory' }, { system: 'CNS' }, { system: 'Abdomen' }, { system: 'Local examination' }] }),
      ]),
      section('Assessment and plan', [
        field('provisionalDiagnosis', 'Provisional diagnosis', 'textarea', { required: true }),
        field('differentialDiagnosis', 'Differential diagnosis', 'textarea'),
        field('investigationsAdvised', 'Investigations advised', 'table', { columns: [field('test', 'Investigation'), field('priority', 'Priority'), field('notes', 'Notes')] }),
        field('treatmentAdvised', 'Treatment advised', 'textarea'),
        field('assessedBy', 'Assessed by', 'text', { required: true }),
        field('assessmentDateTime', 'Assessment date and time', 'datetime-local', { required: true }),
      ]),
    ],
  },
  {
    id: 'preoperative_checklist', version: 1,
    title: 'Pre-Operative Checklist', shortTitle: 'Pre-Op Checklist', category: 'ot', stage: 'preop', required: true,
    implementation: 'structured', referencePages: [15],
    description: 'Ward-to-OT checklist covering consent, preparation, investigations, blood and premedication.',
    sections: [
      section('Case confirmation', [
        field('diagnosis', 'Diagnosis'), field('operation', 'Planned operation', 'text', { required: true }),
        field('sideOfOperation', 'Side / site'), field('allergies', 'Allergies'),
        field('lastFoodDate', 'Last food date', 'date'), field('lastFoodTime', 'Last food time', 'time'),
      ]),
      section('Checklist', [
        field('checklist', 'Pre-operative readiness items', 'checklist', { required: true, options: [
          'Proper consent form signed with witness', 'Patient identity and procedure verified', 'Surgical site marked',
          'Identification mark documented', 'Bath / hygiene / mouth care completed', 'Bladder emptied / urinary catheter in place',
          'Required enema completed', 'Hair clipping completed where ordered', 'Jewellery removed', 'Nail polish removed',
          'Dentures removed', 'Contact lenses removed', 'Hearing aid / prosthesis managed', 'Theatre gown on',
          'Blood available as ordered', 'IV line secured', 'Ryles tube in place where ordered',
          'X-ray / CT / MRI films or images available', 'HIV / HBsAg / HCV and blood group reports reviewed',
          'Other required investigations attached', 'Attendant available and informed'
        ] }),
        field('premedications', 'Premedications given', 'table', { columns: [field('medicine', 'Medicine'), field('dose', 'Dose'), field('route', 'Route'), field('time', 'Time')] }),
        field('timeSentToOT', 'Time sent to OT', 'datetime-local'),
        field('nursingInCharge', 'Nursing in-charge name'), field('staffNurse', 'Staff nurse name'),
        field('remarks', 'Remarks', 'textarea'),
      ]),
    ],
  },
  {
    id: 'surgeon_postoperative_orders', version: 1,
    title: 'Post-Operative Orders and Instructions', shortTitle: 'Post-Op Orders', category: 'recovery', stage: 'postop', required: true,
    implementation: 'structured', referencePages: [14],
    description: 'Immediate post-operative transfer, monitoring, diet, fluids, antibiotics, analgesia and special instructions.',
    sections: [
      section('Transfer and monitoring', [
        field('transferTo', 'Transfer destination', 'select', { required: true, options: ['Recovery / PACU', 'General ward', 'HDU', 'ICU', 'Day care', 'Other'] }),
        field('position', 'Position'), field('nbmDuration', 'NBM duration / till order'),
        field('monitoringRequired', 'Monitoring required', 'checklist', { options: ['GCS', 'Pulse', 'Blood pressure', 'Respiratory rate', 'SpO2', 'Temperature', 'Urine output', 'Drain output', 'Bleeding', 'Pain score'] }),
      ]),
      section('Treatment orders', [
        field('ivFluids', 'IV fluids', 'table', { columns: [field('fluid', 'Fluid'), field('volume', 'Volume'), field('rate', 'Rate'), field('duration', 'Duration')] }),
        field('oxygenOrder', 'Oxygen order'), field('antibiotics', 'Antibiotics', 'table', { columns: [field('medicine', 'Medicine'), field('dose', 'Dose'), field('route', 'Route'), field('frequency', 'Frequency')] }),
        field('analgesics', 'Analgesics', 'table', { columns: [field('medicine', 'Medicine'), field('dose', 'Dose'), field('route', 'Route'), field('frequency', 'Frequency')] }),
        field('otherMedications', 'Other medication orders', 'table', { columns: [field('medicine', 'Medicine'), field('dose', 'Dose'), field('route', 'Route'), field('frequency', 'Frequency')] }),
      ]),
      section('Plan', [
        field('specialInstructions', 'Special instructions', 'textarea'), field('criticalEvents', 'Critical events / concerns', 'textarea'),
        field('orderedBy', 'Ordered by', 'text', { required: true }), field('orderDateTime', 'Order date and time', 'datetime-local', { required: true }),
      ]),
    ],
  },
  {
    id: 'anesthesia_monitoring_chart', version: 1,
    title: 'Anaesthesia Monitoring Chart', shortTitle: 'Anaesthesia Chart', category: 'anesthesia', stage: 'intraop', required: true,
    implementation: 'structured', referencePages: [58, 59, 72, 85],
    description: 'Time-series intra-operative anaesthesia observations, agents, airway, fluids and events.',
    sections: [
      section('Anaesthesia setup', [
        field('technique', 'Anaesthesia technique'), field('airway', 'Airway device / size / fixation'),
        field('monitoringModalities', 'Monitoring modalities', 'checklist', { options: ['ECG', 'NIBP', 'SpO2', 'EtCO2', 'Temperature', 'Urine output', 'CVP', 'Arterial line', 'Other'] }),
      ]),
      section('Time-series observations', [
        field('observations', 'Observations', 'table', { required: true, columns: [
          field('time', 'Time', 'time'), field('pulse', 'Pulse'), field('bp', 'BP'), field('spo2', 'SpO2'), field('etco2', 'EtCO2'), field('temp', 'Temp'), field('rr', 'RR'), field('notes', 'Events / interventions')
        ] }),
        field('medications', 'Anaesthesia medications', 'table', { columns: [field('time', 'Time', 'time'), field('medicine', 'Medicine'), field('dose', 'Dose'), field('route', 'Route')] }),
        field('fluidsBlood', 'Fluids and blood products', 'table', { columns: [field('time', 'Time', 'time'), field('product', 'Fluid / product'), field('volume', 'Volume'), field('lotBagNumber', 'Bag / lot number')] }),
      ]),
      section('Totals and events', [
        field('estimatedBloodLossMl', 'Estimated blood loss (ml)', 'number'), field('urineOutputMl', 'Urine output (ml)', 'number'),
        field('criticalEvents', 'Critical events / complications', 'textarea'), field('anaesthetistName', 'Anaesthetist name', 'text', { required: true }),
      ]),
    ],
  },
  {
    id: 'ot_handover_sheet', version: 1,
    title: 'OT / Recovery Handover Sheet', shortTitle: 'OT Handover', category: 'recovery', stage: 'postop', required: true,
    implementation: 'structured', referencePages: [11, 28, 29, 30, 31, 32, 33, 34],
    description: 'Structured handover from ward to OT and OT/recovery to ward or critical care.',
    sections: [
      section('Transfer details', [
        field('handoverType', 'Handover type', 'select', { required: true, options: ['Ward to OT', 'OT to Recovery', 'Recovery to Ward', 'Recovery to ICU/HDU', 'Inter-shift handover'] }),
        field('handoverDateTime', 'Date and time', 'datetime-local', { required: true }),
        field('fromLocation', 'From'), field('toLocation', 'To'),
        field('handedOverBy', 'Handed over by', 'text', { required: true }), field('receivedBy', 'Received by', 'text', { required: true }),
      ]),
      section('Clinical handover', [
        field('procedureAndFindings', 'Procedure and important findings', 'textarea'), field('anaesthesiaSummary', 'Anaesthesia summary', 'textarea'),
        field('currentCondition', 'Current condition and vitals', 'textarea'), field('airwayAndOxygen', 'Airway / oxygen support'),
        field('linesTubesDrains', 'Lines, tubes, drains and catheters', 'table', { columns: [field('device', 'Device'), field('site', 'Site'), field('status', 'Status / output')] }),
        field('medicationAndFluids', 'Medication / fluids / blood in progress', 'textarea'), field('pendingInvestigations', 'Pending reports / investigations', 'textarea'),
        field('risksAndConcerns', 'Risks, allergies and key concerns', 'textarea'), field('nextActions', 'Next actions / monitoring plan', 'textarea'),
      ]),
    ],
  },
  {
    id: 'blood_transfusion_adverse_effect', version: 1,
    title: 'Blood Transfusion and Adverse Effect Record', shortTitle: 'Transfusion Record', category: 'transfusion', stage: 'ongoing', required: false,
    implementation: 'structured', referencePages: [55, 56],
    description: 'Blood product verification, transfusion observations and adverse-reaction documentation.',
    sections: [
      section('Transfusion order', [
        field('diagnosis', 'Diagnosis'), field('indication', 'Indication for transfusion', 'textarea', { required: true }),
        field('patientBloodGroup', 'Patient blood group'), field('previousReactionHistory', 'Previous transfusion / reaction history', 'textarea'),
      ]),
      section('Units / products administered', [
        field('units', 'Blood products', 'table', { required: true, columns: [
          field('sequence', 'No.'), field('date', 'Date', 'date'), field('product', 'Product'), field('bagNumber', 'Bag number'), field('bloodGroup', 'Group'),
          field('expiryDate', 'Expiry', 'date'), field('compatibilityChecked', 'Compatible', 'checkbox'), field('checkedByDoctor', 'Doctor'), field('checkedByNurse', 'Nurse'),
          field('startTime', 'Start', 'time'), field('stopTime', 'Stop', 'time'), field('reaction', 'Reaction / notes')
        ] }),
      ]),
      section('Adverse reaction', [
        field('adverseReactionOccurred', 'Adverse reaction occurred', 'checkbox'),
        field('reactionType', 'Reaction type', 'checklist', { options: ['Fever / chills', 'Rash / urticaria', 'Dyspnoea', 'Chest pain', 'Hypotension', 'Haemolysis', 'Reduced urine output', 'Other'] }),
        field('onsetTime', 'Time of onset', 'datetime-local'), field('treatmentGiven', 'Treatment / actions taken', 'textarea'),
        field('samplesSent', 'Blood bag / patient samples sent for investigation', 'checkbox'), field('outcome', 'Outcome', 'textarea'),
      ]),
    ],
  },
  {
    id: 'post_op_monitoring_chart', version: 1,
    title: 'Post-Operative Monitoring Chart', shortTitle: 'Post-Op Monitoring', category: 'recovery', stage: 'postop', required: true,
    implementation: 'structured', referencePages: [58, 59],
    description: 'Post-operative observations, pain, drains, intake/output and interventions.',
    sections: [
      section('Monitoring entries', [
        field('observations', 'Post-operative observations', 'table', { required: true, columns: [
          field('dateTime', 'Date / time', 'datetime-local'), field('gcs', 'GCS'), field('pulse', 'Pulse'), field('bp', 'BP'), field('rr', 'RR'), field('spo2', 'SpO2'), field('temperature', 'Temp'),
          field('painScore', 'Pain'), field('urineOutput', 'Urine'), field('drainOutput', 'Drain'), field('bleeding', 'Bleeding'), field('intervention', 'Intervention / initials')
        ] }),
      ]),
      section('Escalation', [
        field('abnormalFindings', 'Abnormal findings / deterioration', 'textarea'), field('doctorInformed', 'Doctor informed', 'checkbox'),
        field('doctorInformedAt', 'Doctor informed at', 'datetime-local'), field('actionsTaken', 'Actions taken', 'textarea'),
      ]),
    ],
  },
  {
    id: 'critical_care_flow_chart', version: 1,
    title: 'Critical Care Flow Chart', shortTitle: 'Critical Care Flow', category: 'nursing', stage: 'postop', required: false,
    implementation: 'structured', referencePages: [87, 90, 95, 98, 101],
    description: 'Critical-care hourly observations, ventilator parameters, infusions, outputs and nursing care.',
    sections: [
      section('Hourly critical-care observations', [
        field('hourlyRows', 'Hourly chart', 'table', { required: true, columns: [
          field('dateTime', 'Date / time', 'datetime-local'), field('pulse', 'Pulse'), field('bp', 'BP'), field('map', 'MAP'), field('rr', 'RR'), field('spo2', 'SpO2'), field('temp', 'Temp'),
          field('gcs', 'GCS'), field('ventilator', 'Ventilator / O2'), field('ivIntake', 'IV intake'), field('oralIntake', 'Oral'), field('urine', 'Urine'), field('drains', 'Drains'), field('notes', 'Notes / initials')
        ] }),
      ]),
      section('Support and devices', [
        field('airwayVentilator', 'Airway / ventilator settings', 'textarea'), field('infusions', 'Continuous infusions', 'table', { columns: [field('medicine', 'Medicine'), field('concentration', 'Concentration'), field('rate', 'Rate'), field('startStop', 'Start / stop')] }),
        field('linesAndTubes', 'Lines / tubes / drains', 'table', { columns: [field('device', 'Device'), field('site', 'Site'), field('insertedAt', 'Inserted at'), field('careDue', 'Care / change due')] }),
      ]),
    ],
  },
  {
    id: 'icu_nursing_sheet', version: 1,
    title: 'ICU Nursing Sheet', shortTitle: 'ICU Nursing Sheet', category: 'nursing', stage: 'postop', required: false,
    implementation: 'structured', referencePages: [88, 91, 96, 99, 102],
    description: 'ICU nursing assessment, systems review, care plan, infusions, intake/output and shift summary.',
    sections: [
      section('Shift assessment', [
        field('shift', 'Shift', 'select', { options: ['Morning', 'Evening', 'Night'] }), field('assessmentDateTime', 'Assessment date and time', 'datetime-local'),
        field('neurological', 'Neurological assessment', 'textarea'), field('respiratory', 'Respiratory assessment', 'textarea'),
        field('cardiovascular', 'Cardiovascular assessment', 'textarea'), field('gastrointestinal', 'Gastrointestinal / nutrition', 'textarea'),
        field('renal', 'Renal / fluid balance', 'textarea'), field('skinWounds', 'Skin / wounds / pressure-area care', 'textarea'),
      ]),
      section('Care and safety', [
        field('careProvided', 'Nursing care provided', 'checklist', { options: ['Oral care', 'Eye care', 'Back care', 'Position change', 'DVT prophylaxis', 'Pressure-area care', 'Catheter care', 'Line care', 'Drain care', 'Physiotherapy', 'Suctioning', 'Other'] }),
        field('medicationsInfusions', 'Medications and infusions', 'textarea'), field('investigations', 'Investigations / samples', 'textarea'),
        field('events', 'Events / procedures / communication', 'textarea'), field('handoverSummary', 'Shift handover summary', 'textarea'),
        field('nurseName', 'Nurse name', 'text', { required: true }),
      ]),
    ],
  },
  {
    id: 'investigation_chart', version: 1,
    title: 'Investigation Chart', shortTitle: 'Investigation Chart', category: 'investigation', stage: 'ongoing', required: true,
    implementation: 'structured', referencePages: [69, 75],
    description: 'Longitudinal chart of common laboratory and bedside investigation results.',
    sections: [
      section('Investigation results', [
        field('results', 'Investigation chart', 'table', { required: true, columns: [
          field('dateTime', 'Date / time', 'datetime-local'), field('testName', 'Investigation'), field('result', 'Result'), field('unit', 'Unit'), field('referenceRange', 'Reference range'), field('flag', 'Flag / remarks')
        ] }),
      ]),
      section('Clinical review', [
        field('criticalResults', 'Critical / abnormal results', 'textarea'), field('reviewedBy', 'Reviewed by'), field('reviewedAt', 'Reviewed at', 'datetime-local'),
      ]),
    ],
  },
  {
    id: 'intake_output_chart', version: 1,
    title: 'Intake and Output Chart', shortTitle: 'Intake / Output', category: 'nursing', stage: 'ongoing', required: false,
    implementation: 'structured', referencePages: [89, 92, 93, 94, 97, 100, 103],
    description: 'Hourly fluid intake, urine, drains, losses and cumulative balance.',
    sections: [
      section('Fluid balance entries', [
        field('entries', 'Intake / output entries', 'table', { required: true, columns: [
          field('dateTime', 'Date / time', 'datetime-local'), field('oral', 'Oral'), field('ivFluids', 'IV fluids'), field('bloodProducts', 'Blood'), field('otherIntake', 'Other intake'),
          field('urine', 'Urine'), field('drain1', 'Drain 1'), field('drain2', 'Drain 2'), field('vomit', 'Vomit'), field('otherOutput', 'Other output'), field('balance', 'Balance'), field('initials', 'Initials')
        ] }),
      ]),
      section('Daily totals', [
        field('totalIntake', 'Total intake (ml)', 'number'), field('totalOutput', 'Total output (ml)', 'number'), field('netBalance', 'Net balance (ml)', 'number'), field('remarks', 'Remarks', 'textarea'),
      ]),
    ],
  },
  {
    id: 'implant_device_register', version: 1,
    title: 'Implant and Device Register', shortTitle: 'Implants / Devices', category: 'ot', stage: 'intraop', required: false,
    implementation: 'structured', referencePages: [10, 11],
    description: 'Implant, prosthesis, device and traceability register for surgery.',
    sections: [
      section('Implants and devices used', [
        field('items', 'Implants / devices', 'table', { required: true, columns: [
          field('itemName', 'Item / implant'), field('manufacturer', 'Manufacturer'), field('catalogueNumber', 'Catalogue no.'), field('lotBatchNumber', 'Lot / batch'), field('serialNumber', 'Serial no.'),
          field('expiryDate', 'Expiry', 'date'), field('quantity', 'Qty', 'number'), field('site', 'Implant site'), field('stickerPhoto', 'Sticker photo', 'file'), field('patientCharge', 'Patient charge'), field('remarks', 'Remarks')
        ] }),
      ]),
      section('Traceability confirmation', [
        field('labelsAttached', 'Implant labels / stickers attached', 'checkbox'), field('registerUpdated', 'Hospital implant register updated', 'checkbox'),
        field('confirmedBy', 'Confirmed by'), field('confirmationDateTime', 'Confirmation date and time', 'datetime-local'),
      ]),
    ],
  },
  {
    id: 'surgical_specimen_handover', version: 1,
    title: 'Surgical Specimen Handover Record', shortTitle: 'Specimen Handover', category: 'ot', stage: 'intraop', required: false,
    implementation: 'structured', referencePages: [10, 11],
    description: 'Specimen identity, container, test request, label verification and laboratory handover.',
    sections: [
      section('Specimens', [
        field('specimens', 'Specimen register', 'table', { required: true, columns: [
          field('specimenId', 'Specimen ID'), field('specimenType', 'Specimen type'), field('anatomicalSite', 'Anatomical site'), field('container', 'Container / preservative'),
          field('testsRequested', 'Tests requested'), field('collectedAt', 'Collected at', 'datetime-local'), field('labelVerified', 'Label verified', 'checkbox'), field('handedOverTo', 'Handed over to'), field('handoverAt', 'Handover at', 'datetime-local')
        ] }),
      ]),
      section('Verification', [
        field('surgeonConfirmation', 'Surgeon confirmation / notes', 'textarea'), field('circulatingNurseName', 'Circulating nurse'), field('laboratoryReceiverName', 'Laboratory receiver'),
      ]),
    ],
  },
  {
    id: 'surgical_team_progress_note', version: 1,
    title: 'Surgical Team Progress Note', shortTitle: 'Surgical Progress Note', category: 'progress', stage: 'ongoing', required: false,
    implementation: 'structured', referencePages: [7, 8, 9, 22, 23, 24, 25, 26, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53],
    description: 'Doctor or nurse progress notes associated with the surgical episode.',
    sections: [
      section('Progress entry', [
        field('noteDateTime', 'Date and time', 'datetime-local', { required: true }), field('authorRole', 'Author role', 'select', { options: ['Surgeon', 'Anaesthetist', 'Doctor', 'Nurse', 'OT technician', 'Other'] }),
        field('painScore', 'Pain score (0-10)', 'number'), field('patientStatus', 'Patient status'),
        field('progressNote', 'Progress note', 'textarea', { required: true }), field('plan', 'Plan / instructions', 'textarea'), field('authorName', 'Name', 'text', { required: true }),
      ]),
    ],
  },

  // Existing dedicated OT modules are surfaced in the same form registry.
  {
    id: 'ot_readiness', version: 2, title: 'OT Readiness and Clearance Checklist', shortTitle: 'Readiness',
    category: 'ot', stage: 'preop', required: true, implementation: 'native', nativeTab: 'readiness',
    sourceModel: 'OTReadinessChecklist', referencePages: [15], pageCount: 2,
    signatureRoles: ['ot_staff'],
    sections: [
      { title: 'Readiness status', fields: [
        { key: 'overallStatus', label: 'Overall status', type: 'text' },
        { key: 'evaluatedAt', label: 'Evaluated at', type: 'datetime-local' },
        { key: 'notes', label: 'Readiness notes / exception plan', type: 'textarea' },
      ] },
      { title: 'Readiness requirements', fields: [
        { key: 'items', label: 'Readiness requirements', type: 'table', columns: [
          { key: 'label', label: 'Requirement' }, { key: 'category', label: 'Category' },
          { key: 'required', label: 'Required', type: 'checkbox' }, { key: 'status', label: 'Status' },
          { key: 'value', label: 'Value / evidence' }, { key: 'notes', label: 'Remarks' },
          { key: 'bypassReason', label: 'Bypass reason' }, { key: 'completedAt', label: 'Completed at' },
        ] },
      ] },
    ],
  },
  { id: 'surgical_safety_checklist', version: 1, title: 'Surgical Safety Checklist', shortTitle: 'Safety Checklist', category: 'ot', stage: 'intraop', required: true, implementation: 'native', nativeTab: 'safety', sourceModel: 'OTSurgicalSafetyChecklist', referencePages: [11] },
  { id: 'pre_anaesthesia_assessment', version: 1, title: 'Preoperative Anaesthesia Record (PAC)', shortTitle: 'PAC', category: 'anesthesia', stage: 'preop', required: true, implementation: 'native', nativeTab: 'pac', sourceModel: 'OTPreAnaesthesiaAssessment', referencePages: [12] },
  { id: 'intra_post_anaesthesia_record', version: 1, title: 'Intra and Post Operative Anaesthesia Record', shortTitle: 'Anaesthesia Record', category: 'anesthesia', stage: 'intraop', required: true, implementation: 'native', nativeTab: 'anesthesia-record', sourceModel: 'OTAnesthesiaRecord', referencePages: [13] },
  { id: 'operation_notes', version: 1, title: 'Operation Notes', shortTitle: 'Operation Notes', category: 'ot', stage: 'intraop', required: true, implementation: 'native', nativeTab: 'operative-note', sourceModel: 'OTOperativeNote', referencePages: [10] },
  { id: 'post_anaesthesia_recovery_record', version: 1, title: 'Post Anaesthesia Recovery and Aldrete Record', shortTitle: 'Recovery / Aldrete', category: 'recovery', stage: 'postop', required: true, implementation: 'native', nativeTab: 'recovery', sourceModel: 'OTRecoveryRecord', referencePages: [14] },
  {
    id: 'ot_consumables_implants', version: 2, title: 'OT Consumables and Implant Reconciliation', shortTitle: 'Consumables',
    category: 'ot', stage: 'intraop', required: true, implementation: 'native', nativeTab: 'inventory',
    sourceModel: 'OTCaseInventoryUsage', referencePages: [10, 11], pageCount: 2,
    signatureRoles: ['scrub_nurse', 'store_officer'],
    sections: [
      { title: 'Reconciliation status', fields: [
        { key: 'status', label: 'Reconciliation status', type: 'text' },
        { key: 'notes', label: 'Inventory / implant reconciliation notes', type: 'textarea' },
      ] },
      { title: 'Consumables, implants and devices', fields: [
        { key: 'lines', label: 'Issued and consumed items', type: 'table', columns: [
          { key: 'itemId', label: 'Item' }, { key: 'lotId', label: 'Lot / batch' }, { key: 'serialNumber', label: 'Serial' },
          { key: 'reservedQuantity', label: 'Reserved' }, { key: 'issuedQuantity', label: 'Issued' },
          { key: 'usedQuantity', label: 'Used' }, { key: 'wastedQuantity', label: 'Wasted' },
          { key: 'returnedQuantity', label: 'Returned' }, { key: 'unitCost', label: 'Unit cost' },
          { key: 'patientCharge', label: 'Patient charge' }, { key: 'reconciliationStatus', label: 'Status' },
        ] },
      ] },
    ],
  },
];

const requiredReferenceTemplates = require('./requiredOtReferenceForms');
const overriddenIds = new Set(requiredReferenceTemplates.map((template) => template.id));
// The exact reference forms replace earlier generic/native entries with the same IDs.
// The older generic preoperative checklist is hidden to avoid duplicate patient-file documents.
const effectiveTemplates = [
  ...templates.filter((template) => !overriddenIds.has(template.id)).map((template) => template.id === 'preoperative_checklist' ? { ...template, hidden: true } : template),
  ...requiredReferenceTemplates,
];
const map = new Map(effectiveTemplates.map((template) => [template.id, template]));

function getTemplate(id) {
  return map.get(String(id || '')) || null;
}

function publicTemplate(template) {
  return JSON.parse(JSON.stringify(template));
}

function listTemplates(filters = {}) {
  return effectiveTemplates
    .filter((template) => !template.hidden)
    .filter((template) => !filters.category || template.category === filters.category)
    .filter((template) => !filters.stage || template.stage === filters.stage)
    .map(publicTemplate);
}

module.exports = { templates: effectiveTemplates, getTemplate, listTemplates };
