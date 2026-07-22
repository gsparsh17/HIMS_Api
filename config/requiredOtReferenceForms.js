const field = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const section = (title, fields, extra = {}) => ({ title, fields, ...extra });

const yesNoNa = ['Yes', 'No', 'Not Applicable'];
const yesNo = ['Yes', 'No'];

module.exports = [
  {
    id: 'pre_op_safety_checklist', version: 2, title: 'Pre OP Safety Checklist', shortTitle: 'Pre OP Safety',
    category: 'ot', stage: 'preop', required: true, implementation: 'structured', rendererId: 'pre-op-safety-checklist', pageCount: 1,
    sourceReference: 'Pre OP and Surgical Safety Checklist.pdf - page 1', referencePages: ['Pre OP Checklist p1'],
    description: 'Role-wise pre-operative ward safety checklist completed by surgeon, staff nurse and anaesthetist.',
    signatureRoles: ['surgeon', 'staff_nurse', 'anaesthetist'],
    sections: [
      section('Surgery details', [
        field('dateOfSurgery', 'Date of surgery', 'date', { required: true }),
        field('diagnosis', 'Diagnosis', 'textarea', { required: true }),
        field('surgery', 'Surgery / procedure', 'textarea', { required: true }),
      ]),
      section('To be done by Surgeon', [
        field('surgeonItems', 'Surgeon safety items', 'checklist', { required: true, options: [
          'History, examination and investigations completed', 'Pre-op orders written', 'PAC findings checked and reconfirmed',
          'Co-morbid conditions assessed and documented', 'Drug allergy prominently recorded on case sheet',
          'Grouping and cross-match sample sent where required', 'Blood availability / donation checked where required',
          'Transfusion risk explained to patient / relatives', 'Written informed consent countersigned by surgeon',
          'OT in-charge informed regarding special equipment'
        ] }),
        field('surgeonRemarks', 'Surgeon remarks', 'textarea'),
        field('surgeonName', 'Surgeon name', 'text', { required: true }),
        field('surgeonSignedAt', 'Surgeon attestation date/time', 'datetime-local'),
      ]),
      section('To be done by Staff Nurse', [
        field('staffNurseItems', 'Staff nurse safety items', 'checklist', { required: true, options: [
          'Patient consent obtained and countersigned by surgeon', 'Part preparation completed as ordered',
          'Identification tag on wrist with name/age/sex/UHID/unit/diagnosis', 'Pre-op orders followed',
          'Antibiotic sensitivity test completed where ordered'
        ] }),
        field('staffNurseRemarks', 'Staff nurse remarks', 'textarea'),
        field('staffNurseName', 'Staff nurse name', 'text', { required: true }),
        field('staffNurseSignedAt', 'Staff nurse attestation date/time', 'datetime-local'),
      ]),
      section('To be done by Anaesthetist', [
        field('anaesthetistItems', 'Anaesthetist safety items', 'checklist', { required: true, options: [
          'PAC findings checked', 'Co-morbid conditions assessed', 'History of drug allergy reviewed', 'Consent checked'
        ] }),
        field('anaesthetistRemarks', 'Anaesthetist remarks', 'textarea'),
        field('anaesthetistName', 'Anaesthetist name', 'text', { required: true }),
        field('anaesthetistSignedAt', 'Anaesthetist attestation date/time', 'datetime-local'),
      ]),
    ],
  },
  {
    id: 'surgical_safety_checklist', version: 2, title: 'Surgical Safety Checklist', shortTitle: 'Surgical Safety',
    category: 'ot', stage: 'intraop', required: true, implementation: 'structured', rendererId: 'surgical-safety-checklist', pageCount: 1,
    sourceReference: 'Pre OP and Surgical Safety Checklist.pdf - page 2', referencePages: ['Surgical Safety p2'],
    description: 'WHO-style sign-in, time-out and sign-out checklist before induction, incision and leaving the operating room.',
    signatureRoles: ['anaesthetist', 'surgeon', 'scrub_nurse'],
    sections: [
      section('Before induction of anaesthesia - Sign In', [
        field('timeIn', 'Time in', 'time', { required: true }),
        field('identitySiteProcedureConsent', 'Identity, site, procedure and consent confirmed', 'select', { required: true, options: yesNo }),
        field('siteMarked', 'Site marked', 'select', { required: true, options: yesNoNa }),
        field('anaesthesiaMachineMedicationCheck', 'Anaesthesia machine and medication check complete', 'select', { required: true, options: yesNo }),
        field('pulseOximeterFunctioning', 'Pulse oximeter on patient and functioning', 'select', { required: true, options: yesNo }),
        field('knownAllergy', 'Known allergy', 'select', { required: true, options: ['No', 'Yes - documented'] }),
        field('difficultAirwayAspirationRisk', 'Difficult airway / aspiration risk', 'select', { required: true, options: ['No', 'Yes - equipment and assistance available'] }),
        field('bloodLossRisk', 'Risk of >500 ml blood loss / >7 ml/kg in children', 'select', { required: true, options: ['No', 'Yes - two IVs/central access and fluids planned'] }),
        field('signInNotes', 'Sign-in notes', 'textarea'),
        field('signInAnaesthetist', 'Anaesthetist name', 'text', { required: true }),
      ]),
      section('Before skin incision - Time Out', [
        field('timeOut', 'Time out', 'time', { required: true }),
        field('teamIntroduced', 'All team members introduced by name and role', 'checkbox', { required: true }),
        field('patientProcedureIncisionSiteConfirmed', 'Patient name, procedure and incision site confirmed', 'checkbox', { required: true }),
        field('antibioticProphylaxis', 'Antibiotic prophylaxis within last 60 minutes', 'select', { required: true, options: yesNoNa }),
        field('surgeonCriticalSteps', 'Critical / non-routine steps', 'textarea'),
        field('caseDuration', 'Expected case duration'),
        field('anticipatedBloodLoss', 'Anticipated blood loss'),
        field('anaesthesiaSpecificConcerns', 'Anaesthesia patient-specific concerns', 'textarea'),
        field('sterilityConfirmed', 'Sterility including indicator results confirmed', 'checkbox'),
        field('equipmentConcerns', 'Equipment issues / nursing concerns', 'textarea'),
        field('essentialImagingDisplayed', 'Essential imaging displayed', 'select', { options: yesNoNa }),
        field('timeOutSurgeon', 'Surgeon name', 'text', { required: true }),
      ]),
      section('Before patient leaves operating room - Sign Out', [
        field('procedureNameConfirmed', 'Name of procedure confirmed', 'checkbox', { required: true }),
        field('countsComplete', 'Instrument, sponge and needle counts complete', 'checkbox', { required: true }),
        field('specimenLabellingComplete', 'Specimen labelling complete including patient name', 'checkbox'),
        field('equipmentProblems', 'Equipment problems to be addressed', 'textarea'),
        field('recoveryConcerns', 'Key concerns for recovery and management', 'textarea', { required: true }),
        field('signOutScrubNurse', 'Scrub nurse name', 'text', { required: true }),
      ]),
    ],
  },
  {
    id: 'checklist_verification_pre_post_op', version: 2, title: 'Checklist Verification (Pre and Post OP)', shortTitle: 'Pre/Post OP Verification',
    category: 'ot', stage: 'preop', required: true, implementation: 'structured', rendererId: 'pre-post-op-verification', pageCount: 2,
    sourceReference: 'Checklist Pre and Post OP.pdf - pages 1-2', referencePages: ['Pre/Post Verification p1-2'],
    description: 'Two-page ward pre-op verification and OT post-op verification/handover checklist.',
    signatureRoles: ['ward_nurse', 'surgeon', 'ot_staff', 'receiving_nurse'],
    sections: [
      section('Pre OP verification - Ward staff', [
        field('proposedOperation', 'Proposed operation', 'textarea', { required: true }),
        field('npoStatus', 'NPO status', 'text', { required: true }),
        field('premedications', 'Premedication', 'table', { columns: [field('drug', 'Drug'), field('dose', 'Dose'), field('route', 'Route'), field('dateTime', 'Time & date', 'datetime-local'), field('givenBy', 'Given by'), field('checkedBy', 'Checked by')] }),
        field('bloodGroup', 'Blood group'), field('height', 'Height'), field('weight', 'Weight'),
        field('bloodOrdered', 'Blood ordered', 'table', { columns: [field('component', 'Component', 'select', { options: ['Whole Blood', 'Packed Cells', 'FFP', 'Platelets', 'Other'] }), field('quantity', 'Qty')] }),
        field('serologyAndLabs', 'Serology / laboratory summary', 'table', { columns: [field('test', 'Test', 'select', { options: ['Hb', 'TLC', 'FBS/RBS', 'Urea/Creatinine', 'DLC', 'INR/Platelets', 'Other'] }), field('result', 'Result'), field('comments', 'Comments')] }),
        field('preOpChecks', 'Pre-op checks', 'table', { required: true, defaultRows: [
          { item: 'ID Band (identification belt)' }, { item: 'Consent for surgery' }, { item: 'Finance clearance' }, { item: 'Prosthesis' }, { item: 'Allergies' }, { item: 'Infections' }, { item: 'Pressure areas' }, { item: 'Operation site examined' }, { item: 'Shaving & skin preparation' }, { item: 'Dentures & crowns' }, { item: 'Bridges' }, { item: 'Jewellery' }, { item: 'Make-up & nail polish' }, { item: 'X-ray & investigations' }, { item: 'Case notes' }, { item: 'Fluid balance chart' }, { item: 'Urine output last hours' }, { item: 'Information to relative' }
        ], columns: [field('item', 'Verification item'), field('status', 'Status', 'select', { options: yesNoNa }), field('remarks', 'Remarks')] }),
        field('wardNurseName', 'Ward nurse name', 'text', { required: true }), field('wardNurseDateTime', 'Ward nurse date/time', 'datetime-local'),
        field('surgeonName', 'Surgeon name', 'text', { required: true }), field('surgeonDateTime', 'Surgeon date/time', 'datetime-local'),
      ]),
      section('OT staff details and relative information', [
        field('financeClearance', 'Finance clearance'), field('procedure', 'Procedure'), field('cathDetails', 'Cath details'), field('angioNumber', 'Angio number'),
        field('ecgSeenBy', 'ECG seen by'), field('echoSeenBy', 'ECHO seen by'), field('otherDetails', 'Others'),
        field('relativeName', 'Name of relative'), field('relativeRelation', 'Relation'), field('informationExplained', 'Patient information / explanation to relative', 'textarea'),
        field('otStaffName', 'Name of OT staff', 'text', { required: true }),
      ]),
      section('Post OP Verification checklist - OT staff', [
        field('operation', 'Operation performed', 'textarea', { required: true }),
        field('surgeons', 'Surgeons'), field('anaesthetists', 'Anaesthetists'), field('perfusionists', 'Perfusionists'), field('scrubNurses', 'Scrub nurses'),
        field('postOpChecks', 'Post-op details', 'table', { required: true, defaultRows: [
          { item: 'Wound information' }, { item: 'Antibiotics given' }, { item: 'Fluid balance - peri-op anaesthetist' }, { item: 'Fluid balance - peri-op perfusionist' }, { item: 'Blood transfusion' }, { item: 'Infusion' }, { item: 'Pressure area' }, { item: 'Swab counts' }, { item: 'Suture / clips' }, { item: 'Drains inserted' }, { item: 'Pacing wires' }, { item: 'LA line' }, { item: 'PA line' }, { item: 'Swan Ganz catheter' }, { item: 'Packs in situ' }, { item: 'Catheter in situ' }, { item: 'Check notes / post-op orders / OT notes / diagram' }
        ], columns: [field('item', 'Post-op verification item'), field('details', 'Details / status')] }),
        field('icuInformation', 'Information for ITU / ICU staff', 'textarea'),
        field('handoverGivenBy', 'Handover given by (OT)', 'text', { required: true }), field('handoverGivenAt', 'Handover given date/time', 'datetime-local'),
        field('handoverTakenBy', 'Handover taken by (post-operative ward)', 'text', { required: true }), field('handoverTakenAt', 'Handover taken date/time', 'datetime-local'),
      ]),
    ],
  },
  {
    id: 'intra_post_anaesthesia_record', version: 2, title: 'Intra and Post Operative Anaesthesia Record', shortTitle: 'Intra/Post Anaesthesia',
    category: 'anesthesia', stage: 'intraop', required: true, implementation: 'structured', rendererId: 'intra-post-anesthesia-record', pageCount: 2, printOrientation: 'landscape-page-2',
    sourceReference: 'Intra Operative Anaesthesia Notes.pdf - pages 1-2', referencePages: ['Intra Anaesthesia p1-2'],
    description: 'Immediate pre-operative re-evaluation, anaesthesia technique, induction, regional blocks, drug timeline and graphical monitoring.',
    signatureRoles: ['anaesthetist'],
    sections: [
      section('Immediate pre-operative re-evaluation', [
        field('patientIdentified', 'Patient identified', 'select', { required: true, options: yesNo }), field('npoDurationHours', 'NPO duration in hours', 'number'),
        field('denturesContactLens', 'Artificial dentures / contact lens status'), field('hearingAidsOrnamentsRemoved', 'Hearing aids / ornaments removed', 'select', { options: yesNo }),
        field('anaesthesiaConsentChecked', 'Anaesthesia consent checked', 'select', { required: true, options: yesNo }), field('surgeryConsentChecked', 'Surgery consent checked', 'select', { required: true, options: yesNo }),
        field('recentInvestigationsChecked', 'Recent investigations checked', 'select', { required: true, options: yesNo }),
        field('preAnaestheticState', 'Pre-anaesthetic state', 'select', { options: ['Awake', 'Apprehensive', 'Uncooperative', 'Calm', 'Asleep', 'Confused', 'Unresponsive'] }),
        field('anaesthesiaMachineChecked', 'Anaesthesia machine checked', 'select', { options: yesNo }), field('pressurePointsChecked', 'Pressure points checked', 'select', { options: yesNo }), field('eyeCare', 'Eye care ointment / pad'),
      ]),
      section('Premedication and induction (GA)', [
        field('premedication', 'Premedication', 'table', { columns: [field('drug', 'Drug'), field('doseMg', 'Dose mg'), field('time', 'Time', 'time')] }),
        field('preoxygenationAgent', 'Preoxygenation / induction agent'), field('inductionDoseMg', 'Induction dose mg'),
        field('muscleRelaxantInduction', 'Scoline / Atracurium / Vecuronium'), field('muscleRelaxantDoseMg', 'Dose mg'),
        field('intubationRoute', 'Intubation', 'select', { options: ['Oral', 'Nasal', 'Not applicable'] }), field('tubeType', 'Tube type'), field('tubeSize', 'Tube size'), field('tubeCuff', 'Cuffed / uncuffed'), field('tubeFixedAtCm', 'Fixed at cm'),
        field('ventilation', 'Ventilation', 'select', { options: ['Spontaneous', 'Controlled (IPPV)', 'Assisted'] }),
        field('maintenanceAgents', 'Maintenance agents', 'checklist', { options: ['O2', 'N2O', 'Isoflurane', 'Sevoflurane', 'Halothane', 'TIVA', 'Other'] }),
        field('maintenanceRelaxant', 'Maintenance muscle relaxant'), field('reversal', 'Reversal drugs / dose'), field('analgesic', 'Analgesic / dose'),
      ]),
      section('Spinal / Epidural / Regional anaesthesia', [
        field('regionalBlocks', 'Regional techniques', 'table', { columns: [field('technique', 'Technique', 'select', { options: ['Spinal', 'Epidural', 'Regional block'] }), field('siteLevel', 'Site / level'), field('needleCatheter', 'Needle / catheter'), field('drug', 'Drug'), field('concentration', 'Concentration'), field('volume', 'Volume'), field('guidance', 'Guidance'), field('effect', 'Effect'), field('complications', 'Complications')] }),
      ]),
      section('Intra-operative anaesthesia monitoring', [
        field('monitoringModalities', 'Monitoring', 'checklist', { required: true, options: ['NIBP/IAP', 'ECG', 'Pulse Oximeter', 'Temperature', 'Capnograph', 'Respiration', 'Urinary Output', 'Arterial Line', 'CVP'] }),
        field('drugTimeline', 'Drug / unit / time chart', 'table', { columns: [field('drug', 'Drug'), field('unit', 'Unit'), field('time', 'Time', 'time'), field('dose', 'Dose / amount'), field('route', 'Route')] }),
        field('observations', 'Graph observations', 'table', { required: true, columns: [field('time', 'Time', 'time'), field('bpSystolic', 'BP systolic', 'number'), field('bpDiastolic', 'BP diastolic', 'number'), field('pulse', 'Pulse', 'number'), field('spo2', 'SpO2', 'number'), field('rr', 'RR', 'number'), field('temperature', 'Temp', 'number'), field('etco2', 'EtCO2', 'number'), field('cvp', 'CVP', 'number')] }),
        field('fluidBalance', 'Fluids / outputs', 'table', { columns: [field('time', 'Time', 'time'), field('rl', 'RL ml', 'number'), field('ns', 'NS ml', 'number'), field('dns', 'DNS ml', 'number'), field('blood', 'Blood ml', 'number'), field('ffp', 'FFP ml', 'number'), field('platelet', 'Platelet ml', 'number'), field('albumin', 'Albumin ml', 'number'), field('colloid', 'Colloid ml', 'number'), field('bloodLoss', 'Blood loss ml', 'number'), field('urineOutput', 'Urine output ml', 'number')] }),
        field('criticalEvents', 'Critical events / complications', 'textarea'), field('anaesthetistName', 'Anaesthetist name', 'text', { required: true }), field('anaesthetistSignedAt', 'Date/time', 'datetime-local'),
      ]),
    ],
  },
  {
    id: 'operation_notes', version: 2, title: 'Operation Record / OT Notes', shortTitle: 'Operation Record',
    category: 'ot', stage: 'intraop', required: true, implementation: 'structured', rendererId: 'operation-record', pageCount: 2,
    sourceReference: 'OT Notes.pdf - pages 1-2', referencePages: ['OT Notes p1-2'],
    description: 'Operation record with surgical team, diagnosis, timing, surgical notes, HPE sample and critical events.',
    signatureRoles: ['surgeon'],
    sections: [
      section('Operation record', [
        field('operationDate', 'Date', 'date', { required: true }), field('surgeon', 'Surgeon', 'text', { required: true }), field('assistantSurgeon', 'Assistant surgeon'),
        field('anaesthesiologist', 'Anaesthesiologist', 'text', { required: true }), field('scrubNurse', 'Scrub nurse'),
        field('preOpDiagnosis', 'Pre-op diagnosis', 'textarea', { required: true }), field('postOpDiagnosis', 'Post-op diagnosis', 'textarea'),
        field('surgery', 'Surgery / procedure performed', 'textarea', { required: true }), field('startTime', 'Start time', 'time', { required: true }), field('stopTime', 'Stop time', 'time', { required: true }),
        field('surgicalNotes', 'Surgical notes', 'textarea', { required: true }), field('sampleForHPE', 'Sample for HPE', 'textarea'),
        field('findings', 'Operative findings', 'textarea'), field('estimatedBloodLoss', 'Estimated blood loss'), field('drainsImplants', 'Drains / implants / prosthesis', 'textarea'), field('countsStatus', 'Instrument / swab / needle counts'),
        field('surgeonNameDesignation', 'Surgeon name and designation', 'text', { required: true }),
      ]),
      section('Critical events and post-operative plan', [
        field('criticalEvents', 'Critical events', 'textarea'), field('complications', 'Complications', 'textarea'), field('postOpPlan', 'Post-operative plan / orders', 'textarea'), field('diagramNotes', 'Diagram / additional notes', 'textarea'),
      ]),
    ],
  },
  {
    id: 'pre_anaesthesia_assessment', version: 2, title: 'Preoperative Anaesthesia Record (PAC)', shortTitle: 'PAC',
    category: 'anesthesia', stage: 'preop', required: true, implementation: 'structured', rendererId: 'pac-record', pageCount: 2,
    sourceReference: 'PAC.pdf - pages 1-2', referencePages: ['PAC p1-2'],
    description: 'Comprehensive pre-anaesthetic assessment, examination, airway, investigations, plan, advice and fitness.',
    signatureRoles: ['anaesthetist'],
    sections: [
      section('Clinical details and history', [
        field('assessmentDate', 'Date', 'date', { required: true }), field('anesthesiologist', 'Anesthesiologist', 'text', { required: true }), field('surgeon', 'Surgeon'),
        field('preOpDiagnosis', 'Pre-op diagnosis', 'textarea', { required: true }), field('anesthesiaPlan', 'Anaesthesia plan', 'textarea', { required: true }), field('surgery', 'Surgery', 'textarea', { required: true }), field('electiveEmergency', 'Elective / Emergency', 'select', { required: true, options: ['Elective', 'Emergency', 'Urgent'] }),
        field('coMorbidities', 'Past history / co-morbidities', 'checklist', { options: ['DM', 'HTN', 'Bronchial Asthma', 'COPD', 'CAD', 'CVA', 'Convulsion', 'CKD', 'CLD', 'Anaemia', 'Sickling', 'Other'] }),
        field('addiction', 'Addiction'), field('pastAnaesthesiaSurgery', 'Past history of anaesthesia / surgery', 'textarea'), field('currentMedications', 'Current medications', 'textarea'), field('drugAllergies', 'Drug allergies', 'textarea'),
        field('ivAccess', 'IV access', 'select', { options: ['Peripheral', 'Central line', 'Both', 'Not established'] }), field('ivAccessSite', 'IV access site'),
      ]),
      section('Physical and general examination', [
        field('physicalExamination', 'Physical examination', 'table', { defaultRows: [{ item: 'Pallor' }, { item: 'Icterus' }, { item: 'Cyanosis' }, { item: 'Clubbing' }, { item: 'Pedal oedema' }, { item: 'JVP' }], columns: [field('item', 'Finding'), field('status', 'Status / remarks')] }),
        field('generalExamination', 'General examination', 'table', { defaultRows: [{ item: 'HR', unit: '/min' }, { item: 'BP', unit: 'mmHg' }, { item: 'RR', unit: '/min' }, { item: 'SpO2', unit: '%' }, { item: 'Temperature', unit: '°F/°C' }, { item: 'Hydration' }], columns: [field('item', 'Parameter'), field('value', 'Value'), field('unit', 'Unit')] }),
        field('systemicExamination', 'Systemic examination', 'table', { defaultRows: [{ system: 'CVS' }, { system: 'Chest' }, { system: 'CNS' }, { system: 'Abdomen' }], columns: [field('system', 'System'), field('findings', 'Findings')] }),
      ]),
      section('Airway and spine', [
        field('asaGrade', 'ASA grade', 'select', { required: true, options: ['I', 'II', 'III', 'IV', 'V', 'E'] }), field('difficultAirway', 'Difficult airway', 'select', { options: yesNo }),
        field('mouthOpening', 'Mouth opening'), field('neckMovement', 'Neck movement'), field('denture', 'Denture'), field('mallampatiGrade', 'Mallampati grade', 'select', { options: ['I', 'II', 'III', 'IV'] }),
        field('spineHistory', 'Spine previous surgery / trauma', 'textarea'),
      ]),
      section('Investigations', [
        field('laboratoryInvestigations', 'Laboratory investigations', 'table', { columns: [field('test', 'Test', 'select', { options: ['CBC', 'Na/K', 'Blood Sugar', 'PT/INR', 'Urea/Creatinine', 'LFT', 'Bilirubin', 'SGOT/SGPT', 'Protein/Albumin', 'ALP', 'HIV', 'HCV', 'HBsAg', 'GGT', 'Other'] }), field('result', 'Result'), field('date', 'Date', 'date'), field('acceptable', 'Acceptable', 'checkbox')] }),
        field('imagingInvestigations', 'Imaging / cardiac investigations', 'table', { columns: [field('test', 'Test', 'select', { options: ['Chest X-ray', 'ECG', 'USG', 'CT/MRI', '2D ECHO', 'Other'] }), field('result', 'Result / impression'), field('date', 'Date', 'date')] }),
      ]),
      section('Premedication, advice and fitness', [
        field('premedication', 'Premedication', 'table', { columns: [field('medicine', 'Medicine'), field('dose', 'Dose'), field('route', 'Route'), field('time', 'Time')] }),
        field('preOpAdvice', 'Pre-op advice / instructions', 'checklist', { required: true, options: ['Informed written high-risk consent', 'Operative consent', 'Post-op ICU / ventilator support consent', 'NBM for >6-8 hours', 'Part preparation', 'Routine pre-op preparation', 'Continue required medication', 'Blood products arranged where required'] }),
        field('riskSummary', 'Risk summary / optimization plan', 'textarea'), field('fitnessStatus', 'Fitness', 'select', { required: true, options: ['Fit for surgery', 'Fit with high risk', 'Optimization required', 'Temporarily unfit', 'Unfit'] }),
        field('anaesthetistName', 'Anaesthetist name', 'text', { required: true }), field('signedAt', 'Date/time', 'datetime-local'),
      ]),
    ],
  },
  {
    id: 'post_anaesthesia_recovery_record', version: 2, title: 'Post Operative Anaesthesia Instructions', shortTitle: 'Post Anaesthesia',
    category: 'recovery', stage: 'postop', required: true, implementation: 'structured', rendererId: 'post-anesthesia-instructions', pageCount: 1,
    sourceReference: 'Post Anaesthesia Notes.pdf - page 1', referencePages: ['Post Anaesthesia p1'],
    description: 'Post-operative transfer instructions, monitoring, analgesia, critical events, vitals and Modified Aldrete score.',
    signatureRoles: ['anaesthetist'],
    sections: [
      section('Transfer and post-operative instructions', [
        field('transferTo', 'Transfer to', 'select', { required: true, options: ['General Ward', 'Post OP / PACU', 'ICU', 'HDU', 'Other'] }),
        field('nbmHours', 'NBM hours / till order'), field('position', 'Position', 'select', { options: ['Supine', 'Head Up', 'Head Low', 'Leg Up', 'Other'] }),
        field('ivFluids', 'IV fluids', 'checklist', { options: ['DNS / D5', 'ISOP', 'RL', 'NS / 1/2 NS', 'Other'] }), field('oxygenInhalation', 'O2 inhalation ordered', 'checkbox'),
        field('monitoring', 'Post-op monitoring', 'checklist', { required: true, options: ['GCS', 'HR', 'BP', 'SpO2', 'RR', 'Temperature', 'Urine output', 'Drain output', 'Bleeding'] }),
        field('antibiotics', 'Antibiotics / continue post-op orders / ICU physician instructions', 'textarea'),
        field('analgesics', 'Analgesics', 'table', { columns: [field('medicine', 'Medicine', 'select', { options: ['Diclofenac', 'Aceclofenac', 'Ketorolac', 'Tramadol', 'PCM', 'Other'] }), field('dose', 'Dose mg'), field('route', 'Route'), field('frequency', 'Frequency')] }),
        field('specialInstructions', 'Special instructions', 'textarea'), field('criticalEvents', 'Critical events', 'textarea'),
      ]),
      section('Modified Aldrete score and shifting vitals', [
        field('aldrete', 'Modified Aldrete Score', 'table', { required: true, defaultRows: [{ criterion: 'Activity' }, { criterion: 'Respiration' }, { criterion: 'Circulation' }, { criterion: 'Consciousness' }, { criterion: 'Oxygen saturation' }], columns: [field('criterion', 'Criterion'), field('assessment', 'Selected characteristic'), field('points', 'Points', 'number')] }),
        field('aldreteTotal', 'Aldrete total /10', 'number', { required: true }),
        field('shiftingVitals', 'Post-op monitoring and shifting vitals', 'table', { columns: [field('time', 'Time', 'time'), field('bp', 'BP'), field('pulse', 'Pulse', 'number'), field('rr', 'RR', 'number'), field('spo2', 'SpO2', 'number')] }),
        field('anaesthetistName', 'Anaesthetist name', 'text', { required: true }), field('signedAt', 'Date/time', 'datetime-local'),
      ]),
    ],
  },
];
