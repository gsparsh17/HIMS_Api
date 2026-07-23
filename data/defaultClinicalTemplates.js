const sharedEmergencyAdvice = [
  'Return immediately for breathing difficulty, chest pain, altered sensorium, persistent vomiting, uncontrolled bleeding, or worsening symptoms.',
  'Seek urgent review if fever persists or the patient is unable to maintain oral intake.'
].join('\n');

const roundTemplates = [
  {
    slug: 'round-community-acquired-pneumonia',
    name: 'Pneumonia Daily Round',
    diseaseName: 'Community-acquired pneumonia',
    diagnosisKeywords: ['pneumonia', 'lower respiratory infection', 'LRTI'],
    content: {
      patientCondition: 'Stable',
      complaints: 'Review fever, cough, sputum, breathlessness, pleuritic pain, oral intake, and sleep.',
      examinationFindings: 'Document respiratory rate, oxygen requirement, SpO2 trend, chest findings, hydration, and mental status.',
      diagnosis: 'Community-acquired pneumonia',
      treatmentPlan: 'Review response to current treatment, oxygen requirement, culture results, fluid status, and need for escalation or de-escalation.',
      advice: 'Continue monitoring temperature, respiratory rate, oxygen saturation, intake/output, and warning signs.',
      painScore: 0
    }
  },
  {
    slug: 'round-acute-gastroenteritis',
    name: 'Gastroenteritis / Dehydration Round',
    diseaseName: 'Acute gastroenteritis with dehydration',
    diagnosisKeywords: ['gastroenteritis', 'diarrhoea', 'vomiting', 'dehydration'],
    content: {
      patientCondition: 'Improving',
      complaints: 'Review vomiting, stool frequency, abdominal pain, fever, urine output, and oral tolerance.',
      examinationFindings: 'Document hydration status, pulse, blood pressure, capillary refill, abdominal findings, and urine output.',
      diagnosis: 'Acute gastroenteritis with dehydration',
      treatmentPlan: 'Review fluid balance, electrolyte results, oral rehydration tolerance, and need for ongoing intravenous fluids.',
      advice: 'Continue intake/output charting, oral fluid trial as tolerated, and monitor for reduced urine output or worsening abdominal symptoms.',
      painScore: 2
    }
  },
  {
    slug: 'round-copd-exacerbation',
    name: 'COPD Exacerbation Round',
    diseaseName: 'Acute exacerbation of COPD',
    diagnosisKeywords: ['COPD', 'AECOPD', 'chronic obstructive pulmonary disease'],
    content: {
      patientCondition: 'Stable',
      complaints: 'Review breathlessness, cough, sputum volume/colour, wheeze, sleep, and activity tolerance.',
      examinationFindings: 'Document respiratory effort, wheeze/air entry, oxygen target, SpO2 trend, and signs of carbon dioxide retention.',
      diagnosis: 'Acute exacerbation of COPD',
      treatmentPlan: 'Review bronchodilator response, oxygen target, respiratory support, infection markers, and readiness for step-down.',
      advice: 'Maintain prescribed oxygen target, monitor work of breathing, and escalate for drowsiness, rising oxygen need, or exhaustion.',
      painScore: 0
    }
  },
  {
    slug: 'round-dengue-febrile-illness',
    name: 'Dengue / Febrile Illness Round',
    diseaseName: 'Dengue or acute febrile illness',
    diagnosisKeywords: ['dengue', 'viral fever', 'febrile illness', 'thrombocytopenia'],
    content: {
      patientCondition: 'Stable',
      complaints: 'Review fever pattern, vomiting, abdominal pain, bleeding, dizziness, oral intake, and urine output.',
      examinationFindings: 'Document haemodynamic status, capillary refill, rash/bleeding signs, hydration, abdominal tenderness, and urine output.',
      diagnosis: 'Acute febrile illness / dengue under evaluation',
      treatmentPlan: 'Review haematocrit and platelet trend, fluid balance, warning signs, and need for monitored escalation.',
      advice: 'Strict intake/output and warning-sign monitoring; avoid unnecessary intramuscular injections and document any bleeding.',
      painScore: 2
    }
  },
  {
    slug: 'round-uti-pyelonephritis',
    name: 'UTI / Pyelonephritis Round',
    diseaseName: 'Urinary tract infection / pyelonephritis',
    diagnosisKeywords: ['UTI', 'urinary tract infection', 'pyelonephritis'],
    content: {
      patientCondition: 'Improving',
      complaints: 'Review dysuria, frequency, flank pain, fever, nausea, and urine output.',
      examinationFindings: 'Document temperature, hydration, abdominal/flank tenderness, haemodynamic status, and urine output.',
      diagnosis: 'Urinary tract infection / pyelonephritis',
      treatmentPlan: 'Review urine culture, renal function, response to current therapy, hydration, and obstruction risk.',
      advice: 'Maintain hydration as clinically appropriate and monitor fever, pain, urine output, and culture-guided treatment response.',
      painScore: 2
    }
  },
  {
    slug: 'round-diabetes-hypertension',
    name: 'Diabetes / Hypertension Monitoring Round',
    diseaseName: 'Diabetes mellitus with hypertension',
    diagnosisKeywords: ['diabetes', 'hypertension', 'hyperglycaemia', 'high blood pressure'],
    content: {
      patientCondition: 'Stable',
      complaints: 'Review appetite, symptoms of hypo/hyperglycaemia, headache, dizziness, chest pain, and medication tolerance.',
      examinationFindings: 'Document glucose trend, blood pressure trend, hydration, oedema, neurological status, and relevant foot/skin findings.',
      diagnosis: 'Diabetes mellitus with hypertension',
      treatmentPlan: 'Review glucose and blood pressure chart, renal function, current medication response, diet, and discharge readiness.',
      advice: 'Continue glucose and blood pressure monitoring, diet counselling, and education on warning symptoms.',
      painScore: 0
    }
  }
];

const dischargeTemplates = [
  {
    slug: 'discharge-community-acquired-pneumonia',
    name: 'Pneumonia Discharge Summary',
    diseaseName: 'Community-acquired pneumonia',
    diagnosisKeywords: ['pneumonia', 'lower respiratory infection', 'LRTI'],
    content: {
      finalDiagnosis: 'Community-acquired pneumonia',
      chiefComplaints: 'Fever, cough, sputum, and breathlessness.',
      historyOfPresentIllness: 'Patient was admitted with an acute respiratory illness and monitored for oxygen requirement and clinical response.',
      examinationFindings: 'Respiratory findings and oxygen saturation improved during admission. Record final examination findings before discharge.',
      investigations: 'Summarise chest imaging, blood counts, inflammatory markers, cultures, and other relevant investigations.',
      treatmentGiven: 'Supportive care and disease-directed treatment were provided with serial clinical monitoring.',
      proceduresDone: '',
      surgeriesDone: '',
      conditionOnDischarge: 'Improved',
      followUpAdvice: 'Clinical review as advised. Bring all reports and seek earlier review for recurrent fever, worsening cough, or breathlessness.',
      emergencyInstructions: sharedEmergencyAdvice,
      dietAdvice: 'Balanced diet and adequate oral fluids unless otherwise restricted.',
      activityAdvice: 'Gradually increase activity according to tolerance.'
    }
  },
  {
    slug: 'discharge-acute-gastroenteritis',
    name: 'Gastroenteritis / Dehydration Discharge Summary',
    diseaseName: 'Acute gastroenteritis with dehydration',
    diagnosisKeywords: ['gastroenteritis', 'diarrhoea', 'vomiting', 'dehydration'],
    content: {
      finalDiagnosis: 'Acute gastroenteritis with dehydration',
      chiefComplaints: 'Vomiting, loose stools, abdominal discomfort, and reduced oral intake.',
      historyOfPresentIllness: 'Patient required admission for hydration, monitoring, and correction of fluid/electrolyte disturbance.',
      examinationFindings: 'Hydration and haemodynamic status improved. Record final abdominal and hydration findings before discharge.',
      investigations: 'Summarise blood counts, electrolytes, renal function, stool studies, and other relevant results.',
      treatmentGiven: 'Fluid replacement, symptom control, dietary progression, and monitoring were provided.',
      proceduresDone: '',
      surgeriesDone: '',
      conditionOnDischarge: 'Improved',
      followUpAdvice: 'Continue oral fluids and return for persistent vomiting, blood in stool, reduced urine output, or worsening abdominal pain.',
      emergencyInstructions: sharedEmergencyAdvice,
      dietAdvice: 'Small frequent meals and oral rehydration as tolerated; avoid unsafe food and water.',
      activityAdvice: 'Resume routine activity gradually after hydration and strength recover.'
    }
  },
  {
    slug: 'discharge-copd-exacerbation',
    name: 'COPD Exacerbation Discharge Summary',
    diseaseName: 'Acute exacerbation of COPD',
    diagnosisKeywords: ['COPD', 'AECOPD', 'chronic obstructive pulmonary disease'],
    content: {
      finalDiagnosis: 'Acute exacerbation of COPD',
      chiefComplaints: 'Worsening breathlessness, cough, sputum, and wheeze.',
      historyOfPresentIllness: 'Patient was admitted for respiratory monitoring and treatment of an acute COPD exacerbation.',
      examinationFindings: 'Breathing effort and oxygen requirement improved. Record final respiratory findings and prescribed oxygen target.',
      investigations: 'Summarise chest imaging, blood gas where performed, blood counts, cultures, and relevant cardiac evaluation.',
      treatmentGiven: 'Respiratory support, bronchodilator therapy, supportive care, and disease-directed treatment were provided.',
      proceduresDone: '',
      surgeriesDone: '',
      conditionOnDischarge: 'Improved',
      followUpAdvice: 'Review with respiratory/medical team as advised. Reinforce inhaler technique and smoking cessation where applicable.',
      emergencyInstructions: sharedEmergencyAdvice,
      dietAdvice: 'Balanced diet with adequate protein and fluids unless restricted.',
      activityAdvice: 'Pacing, breathing exercises, and gradual mobilisation according to tolerance.'
    }
  },
  {
    slug: 'discharge-dengue-febrile-illness',
    name: 'Dengue / Febrile Illness Discharge Summary',
    diseaseName: 'Dengue or acute febrile illness',
    diagnosisKeywords: ['dengue', 'viral fever', 'febrile illness', 'thrombocytopenia'],
    content: {
      finalDiagnosis: 'Acute febrile illness / dengue',
      chiefComplaints: 'Fever with associated constitutional symptoms.',
      historyOfPresentIllness: 'Patient was admitted for monitoring of warning signs, hydration, haemodynamic status, and laboratory trends.',
      examinationFindings: 'Haemodynamic status remained stable or improved. Record final bleeding, hydration, and abdominal findings.',
      investigations: 'Summarise serial blood counts, haematocrit/platelet trend, liver/renal function, and relevant infection testing.',
      treatmentGiven: 'Supportive treatment, fluid management, symptom control, and serial monitoring were provided.',
      proceduresDone: '',
      surgeriesDone: '',
      conditionOnDischarge: 'Improved',
      followUpAdvice: 'Repeat blood counts or clinical review as advised. Return urgently for bleeding, severe abdominal pain, persistent vomiting, fainting, or reduced urine output.',
      emergencyInstructions: sharedEmergencyAdvice,
      dietAdvice: 'Adequate oral fluids and light balanced meals unless otherwise restricted.',
      activityAdvice: 'Rest until clinically recovered; avoid strenuous activity until reviewed.'
    }
  },
  {
    slug: 'discharge-uti-pyelonephritis',
    name: 'UTI / Pyelonephritis Discharge Summary',
    diseaseName: 'Urinary tract infection / pyelonephritis',
    diagnosisKeywords: ['UTI', 'urinary tract infection', 'pyelonephritis'],
    content: {
      finalDiagnosis: 'Urinary tract infection / pyelonephritis',
      chiefComplaints: 'Fever, dysuria, urinary frequency, or flank pain.',
      historyOfPresentIllness: 'Patient was admitted for infection management, hydration, and monitoring of renal/urinary status.',
      examinationFindings: 'Fever and urinary symptoms improved. Record final hydration, abdominal/flank, and haemodynamic findings.',
      investigations: 'Summarise urine analysis/culture, renal function, blood counts, imaging, and other relevant results.',
      treatmentGiven: 'Hydration, symptom control, and culture-guided disease-directed treatment were provided.',
      proceduresDone: '',
      surgeriesDone: '',
      conditionOnDischarge: 'Improved',
      followUpAdvice: 'Complete prescribed treatment and review culture results as advised. Return for fever, vomiting, worsening flank pain, or reduced urine output.',
      emergencyInstructions: sharedEmergencyAdvice,
      dietAdvice: 'Maintain oral fluids unless restricted for another condition.',
      activityAdvice: 'Resume normal activity gradually as fever and pain resolve.'
    }
  },
  {
    slug: 'discharge-diabetes-hypertension',
    name: 'Diabetes / Hypertension Discharge Summary',
    diseaseName: 'Diabetes mellitus with hypertension',
    diagnosisKeywords: ['diabetes', 'hypertension', 'hyperglycaemia', 'high blood pressure'],
    content: {
      finalDiagnosis: 'Diabetes mellitus with hypertension',
      chiefComplaints: 'Document the presenting symptoms and reason for admission.',
      historyOfPresentIllness: 'Patient was admitted for evaluation and stabilisation of glucose and/or blood pressure control.',
      examinationFindings: 'Record final blood pressure, glucose trend, hydration, oedema, neurological, and relevant foot/skin findings.',
      investigations: 'Summarise glucose monitoring, HbA1c where available, renal function, electrolytes, ECG, and relevant complication screening.',
      treatmentGiven: 'Monitoring, education, diet review, and adjustment of the ongoing treatment plan were provided.',
      proceduresDone: '',
      surgeriesDone: '',
      conditionOnDischarge: 'Stable',
      followUpAdvice: 'Maintain home glucose and blood pressure records and bring them to follow-up. Seek review for recurrent hypoglycaemia, very high readings, chest pain, or neurological symptoms.',
      emergencyInstructions: sharedEmergencyAdvice,
      dietAdvice: 'Follow the advised diabetic and low-salt meal plan.',
      activityAdvice: 'Regular activity as advised, with precautions based on comorbidities and glucose control.'
    }
  }
];

module.exports = {
  roundTemplates,
  dischargeTemplates
};
