'use strict';

const Medicine = require('../models/Medicine');
const Patient = require('../models/Patient');


function rangeScore(value, bands) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  for (const band of bands) {
    if ((band.min === undefined || number >= band.min)
      && (band.max === undefined || number <= band.max)) return band.score;
  }
  return 0;
}

function news2Score(input = {}) {
  const respiration = rangeScore(input.respiratoryRate, [
    { max: 8, score: 3 }, { min: 9, max: 11, score: 1 },
    { min: 12, max: 20, score: 0 }, { min: 21, max: 24, score: 2 },
    { min: 25, score: 3 }
  ]);
  const oxygenSaturation = rangeScore(input.spo2, [
    { max: 91, score: 3 }, { min: 92, max: 93, score: 2 },
    { min: 94, max: 95, score: 1 }, { min: 96, score: 0 }
  ]);
  const temperature = rangeScore(input.temperature, [
    { max: 35, score: 3 }, { min: 35.1, max: 36, score: 1 },
    { min: 36.1, max: 38, score: 0 }, { min: 38.1, max: 39, score: 1 },
    { min: 39.1, score: 2 }
  ]);
  const systolic = rangeScore(input.systolicBp, [
    { max: 90, score: 3 }, { min: 91, max: 100, score: 2 },
    { min: 101, max: 110, score: 1 }, { min: 111, max: 219, score: 0 },
    { min: 220, score: 3 }
  ]);
  const pulse = rangeScore(input.pulse, [
    { max: 40, score: 3 }, { min: 41, max: 50, score: 1 },
    { min: 51, max: 90, score: 0 }, { min: 91, max: 110, score: 1 },
    { min: 111, max: 130, score: 2 }, { min: 131, score: 3 }
  ]);
  const consciousness = String(input.consciousness || 'alert').toLowerCase() === 'alert' ? 0 : 3;
  const supplementalOxygen = input.supplementalOxygen ? 2 : 0;
  return respiration + oxygenSaturation + temperature + systolic + pulse + consciousness + supplementalOxygen;
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function calculateClinicalScores(input = {}) {
  const scores = {};

  if (input.fallRisk) {
    const f = input.fallRisk;
    scores.fallRisk = [
      numeric(f.historyOfFalling),
      numeric(f.secondaryDiagnosis),
      numeric(f.ambulatoryAid),
      numeric(f.ivTherapy),
      numeric(f.gait),
      numeric(f.mentalStatus)
    ].reduce((sum, value) => sum + value, 0);
  }

  if (input.pressureUlcer) {
    const p = input.pressureUlcer;
    scores.pressureUlcer = [
      p.sensoryPerception, p.moisture, p.activity,
      p.mobility, p.nutrition, p.frictionShear
    ].reduce((sum, value) => sum + numeric(value), 0);
  }

  if (input.dvt) {
    scores.dvt = Object.values(input.dvt)
      .reduce((sum, value) => sum + numeric(value), 0);
  }

  if (input.earlyWarning) {
    const hasClinicalObservations = [
      'respiratoryRate', 'spo2', 'temperature', 'systolicBp', 'pulse'
    ].some((key) => input.earlyWarning[key] !== undefined && input.earlyWarning[key] !== '');
    scores.earlyWarning = hasClinicalObservations
      ? news2Score(input.earlyWarning)
      : Object.values(input.earlyWarning).reduce((sum, value) => sum + numeric(value), 0);
  }

  return scores;
}

function normalizeMedicineName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function medicationSafetyCheck({ hospitalId, patientId, medicineIds = [], medicineNames = [] }) {
  const query = { hospitalId };
  const nameList = medicineNames.map(normalizeMedicineName).filter(Boolean);
  const ors = [];
  if (medicineIds.length) ors.push({ _id: { $in: medicineIds } });
  if (nameList.length) {
    ors.push({
      $or: [
        { name: { $in: nameList.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) } },
        { generic_name: { $in: nameList.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) } }
      ]
    });
  }
  if (ors.length) query.$or = ors;
  const medicines = ors.length ? await Medicine.find(query).lean() : [];
  const patient = patientId ? await Patient.findOne({ _id: patientId, hospitalId }).lean() : null;

  const alerts = [];
  const selectedNames = new Set();
  for (const medicine of medicines) {
    const safety = medicine.medicationSafety || {};
    const name = medicine.name || medicine.generic_name;
    const normalized = normalizeMedicineName(name);
    if (selectedNames.has(normalized)) {
      alerts.push({ level: 'warning', type: 'duplicate', medicine: name, message: 'Duplicate medicine detected' });
    }
    selectedNames.add(normalized);
    if (safety.highRisk) alerts.push({ level: 'critical', type: 'high_risk', medicine: name, message: 'High-risk medicine requires independent double-check' });
    if (safety.lasa) alerts.push({ level: 'warning', type: 'lasa', medicine: name, message: 'Look-alike/sound-alike medicine' });
    if (safety.formularyStatus === 'non_formulary') {
      alerts.push({
        level: 'info',
        type: 'non_formulary',
        medicine: name,
        message: 'Non-formulary medicine',
        alternatives: safety.alternatives || []
      });
    }
    const allergyTerms = [
      ...(patient?.allergies || []),
      ...(patient?.medical_history?.allergies || [])
    ].map((value) => normalizeMedicineName(value?.name || value));
    const medicineTerms = [medicine.name, medicine.generic_name, medicine.category]
      .map(normalizeMedicineName).filter(Boolean);
    if (allergyTerms.some((allergy) => medicineTerms.some((term) => allergy && term.includes(allergy)))) {
      alerts.push({ level: 'critical', type: 'allergy', medicine: name, message: 'Possible medicine-allergy match' });
    }
  }
  return { patientId, medicines, alerts, requiresDoubleCheck: alerts.some((a) => a.type === 'high_risk') };
}

function buildCdssRecommendations(input = {}) {
  const settings = input.settings || {};
  if (settings.clinical?.enableCdss === false) return [];
  const alerts = [];
  const scores = calculateClinicalScores(input);
  if (scores.fallRisk >= numeric(settings.clinical?.fallRiskThreshold, 45)) {
    alerts.push({ level: 'warning', rule: 'fall_risk', message: 'Initiate fall-prevention care plan', score: scores.fallRisk });
  }
  if (scores.pressureUlcer > 0 && scores.pressureUlcer <= numeric(settings.clinical?.pressureUlcerRiskThreshold, 18)) {
    alerts.push({ level: 'warning', rule: 'pressure_ulcer', message: 'Initiate pressure-injury prevention plan', score: scores.pressureUlcer });
  }
  if (scores.dvt >= numeric(settings.clinical?.dvtRiskThreshold, 2)) {
    alerts.push({ level: 'warning', rule: 'dvt', message: 'Review DVT prophylaxis', score: scores.dvt });
  }
  if (scores.earlyWarning >= 7) {
    alerts.push({ level: 'critical', rule: 'early_warning', message: 'Urgent senior clinical review required', score: scores.earlyWarning });
  } else if (scores.earlyWarning >= 5) {
    alerts.push({ level: 'warning', rule: 'early_warning', message: 'Escalate for clinical review', score: scores.earlyWarning });
  }
  if (input.diagnosisCode && (settings.clinical?.notifiableDiseaseCodes || []).includes(input.diagnosisCode)) {
    alerts.push({ level: 'critical', rule: 'notifiable_disease', message: 'Notifiable disease workflow required', code: input.diagnosisCode });
  }
  return alerts;
}

function staffingForecast(rows = [], options = {}) {
  const horizonDays = Math.max(1, Math.min(31, Number(options.horizonDays || 7)));
  const byDepartment = new Map();
  for (const row of rows) {
    const department = row.department || row.departmentName || 'Unassigned';
    const current = byDepartment.get(department) || { workload: [], staffedHours: [] };
    current.workload.push(numeric(row.patientCount ?? row.workload ?? row.encounters));
    current.staffedHours.push(numeric(row.staffedHours ?? row.hours));
    byDepartment.set(department, current);
  }
  return [...byDepartment.entries()].map(([department, values]) => {
    const averageWorkload = values.workload.length
      ? values.workload.reduce((a, b) => a + b, 0) / values.workload.length : 0;
    const averageHours = values.staffedHours.length
      ? values.staffedHours.reduce((a, b) => a + b, 0) / values.staffedHours.length : 0;
    const ratio = averageHours > 0 ? averageWorkload / averageHours : 0;
    return {
      department,
      historicalDays: values.workload.length,
      averageDailyWorkload: Number(averageWorkload.toFixed(2)),
      averageStaffedHours: Number(averageHours.toFixed(2)),
      workloadPerStaffedHour: Number(ratio.toFixed(2)),
      forecast: Array.from({ length: horizonDays }, (_value, index) => ({
        dayOffset: index + 1,
        expectedWorkload: Math.ceil(averageWorkload),
        recommendedStaffedHours: Math.ceil(averageHours * numeric(options.serviceLevel, 1))
      }))
    };
  });
}

module.exports = {
  calculateClinicalScores,
  medicationSafetyCheck,
  buildCdssRecommendations,
  staffingForecast,
  news2Score
};
