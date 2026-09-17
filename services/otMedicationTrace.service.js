'use strict';

const mongoose = require('mongoose');
const IPDMedicationChart = require('../models/IPDMedicationChart');

function normalizeMedicationName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(inj(?:ection)?|tab(?:let)?|cap(?:sule)?|syr(?:up)?|amp(?:oule)?|vial)\.?\b/g, ' ')
    .replace(/[^a-z0-9%+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function medicationName(row = {}) {
  return row.name || row.drug || row.medicine || row.medication || '';
}

function chartNames(chart = {}) {
  const values = [
    chart.medicineName,
    chart.genericName,
    chart.pharmacyRequest?.dispensedMedicineName,
    chart.medicineId?.name,
    chart.medicineId?.generic_name,
    ...(chart.pharmacyRequest?.dispenseHistory || []).flatMap((entry) => [entry.medicineId?.name, entry.medicineId?.generic_name])
  ];
  return new Set(values.map(normalizeMedicationName).filter(Boolean));
}


function normalizeOTMedicationPayload(kind, payload = {}) {
  const next = { ...payload };
  if (kind === 'anesthesia' && Array.isArray(payload.events)) {
    next.events = payload.events.map((row = {}) => {
      const name = medicationName(row);
      return {
        ...row,
        ...(name ? { name } : {}),
        ...(row.occurredAt || row.administeredAt || row.givenAt || row.time ? { occurredAt: row.occurredAt || row.administeredAt || row.givenAt || row.time } : {}),
        type: row.type || (name ? 'Medication' : 'Clinical Event')
      };
    });
  }
  if (kind === 'recovery' && Array.isArray(payload.medications)) {
    next.medications = payload.medications.map((row = {}) => {
      const name = medicationName(row);
      return {
        ...row,
        ...(name ? { name } : {}),
        ...(row.givenAt || row.administeredAt || row.occurredAt || row.time ? { givenAt: row.givenAt || row.administeredAt || row.occurredAt || row.time } : {})
      };
    });
  }
  return next;
}

async function loadAdmissionMedicationCharts({ hospitalId, admissionId }) {
  if (!hospitalId || !admissionId) return [];
  return IPDMedicationChart.find({ hospitalId, admissionId })
    .select('medicineId medicineName genericName dosage route status pharmacyRequest stockReceiptStatus')
    .populate('medicineId', 'name generic_name')
    .populate('pharmacyRequest.dispenseHistory.medicineId', 'name generic_name')
    .populate('pharmacyRequest.dispenseHistory.batchId', 'batch_number expiry_date')
    .lean();
}

function resolveChart(row, charts) {
  const explicitId = row?.ipdMedicationChartId || row?.pharmacyLink?.ipdMedicationChartId;
  if (explicitId) {
    const direct = charts.find((chart) => String(chart._id) === String(explicitId));
    if (direct) return { status: 'LINKED', matchedBy: 'EXPLICIT', chart: direct };
  }

  const normalized = normalizeMedicationName(medicationName(row));
  if (!normalized) return { status: 'UNLINKED', matchedBy: '', chart: null };
  const matches = charts.filter((chart) => chartNames(chart).has(normalized));
  if (matches.length === 1) return { status: 'LINKED', matchedBy: 'EXACT_NAME', chart: matches[0] };
  if (matches.length > 1) return { status: 'AMBIGUOUS', matchedBy: 'EXACT_NAME', chart: null, candidateChartIds: matches.map((row) => row._id) };
  return { status: 'UNLINKED', matchedBy: '', chart: null };
}

function dispenseHistory(chart = {}) {
  return (chart.pharmacyRequest?.dispenseHistory || []).map((entry) => ({
    saleId: entry.saleId || null,
    medicineId: entry.medicineId?._id || entry.medicineId || null,
    medicineName: entry.medicineId?.name || chart.pharmacyRequest?.dispensedMedicineName || chart.medicineName || '',
    batchId: entry.batchId?._id || entry.batchId || null,
    batchNumber: entry.batchId?.batch_number || '',
    expiryDate: entry.batchId?.expiry_date || null,
    quantityBaseUnits: Number(entry.quantityBaseUnits || 0),
    dispensedAt: entry.dispensedAt || null,
    receivedAt: entry.receivedAt || null
  }));
}

function traceRow({ phase, row, resolution }) {
  const chart = resolution.chart;
  const history = chart ? dispenseHistory(chart) : [];
  return {
    phase,
    clinicalEventId: row?._id || null,
    name: medicationName(row) || 'Medication',
    dose: row?.dose || row?.quantity || '',
    route: row?.route || '',
    givenAt: row?.occurredAt || row?.givenAt || row?.administeredAt || row?.time || null,
    linkStatus: resolution.status,
    matchedBy: resolution.matchedBy || '',
    candidateChartIds: (resolution.candidateChartIds || []).map(String),
    ipdMedicationChartId: chart?._id || row?.ipdMedicationChartId || null,
    orderedMedicineName: chart?.medicineName || '',
    pharmacyRequestNumber: chart?.pharmacyRequest?.pharmacyRequestNumber || '',
    pharmacyStatus: chart?.pharmacyRequest?.pharmacyStatus || '',
    stockReceiptStatus: chart?.stockReceiptStatus || '',
    requestedQuantity: Number(chart?.pharmacyRequest?.requestedQuantity || 0),
    dispensedQuantity: Number(chart?.pharmacyRequest?.dispensedQuantity || 0),
    dispensedFromPharmacy: Boolean(chart?.pharmacyRequest?.dispensedFromPharmacy),
    saleId: chart?.pharmacyRequest?.saleId || null,
    saleIds: (chart?.pharmacyRequest?.saleIds || []).map(String),
    medicineId: chart?.pharmacyRequest?.dispensedMedicineId || chart?.medicineId?._id || chart?.medicineId || null,
    medicineName: chart?.pharmacyRequest?.dispensedMedicineName || chart?.medicineId?.name || chart?.medicineName || '',
    batchId: chart?.pharmacyRequest?.dispensedBatchId || history.at(-1)?.batchId || null,
    batchNumber: history.at(-1)?.batchNumber || '',
    dispenseHistory: history
  };
}

function medicationRows({ anesthesia, recovery }) {
  const anesthesiaRows = (anesthesia?.events || []).filter((row) => {
    const type = String(row?.type || '').toLowerCase();
    return Boolean(medicationName(row)) && (!type || /med|drug|anaesth|anesth/.test(type) || row?.dose || row?.route);
  });
  const recoveryRows = (recovery?.medications || []).filter((row) => Boolean(medicationName(row)));
  return [
    ...anesthesiaRows.map((row) => ({ phase: 'Anaesthesia', row })),
    ...recoveryRows.map((row) => ({ phase: 'Recovery', row }))
  ];
}

async function buildOTMedicationTrace({ hospitalId, admissionId, anesthesia, recovery, charts = null }) {
  const medicationCharts = charts || await loadAdmissionMedicationCharts({ hospitalId, admissionId });
  const rows = medicationRows({ anesthesia, recovery }).map(({ phase, row }) => traceRow({ phase, row, resolution: resolveChart(row, medicationCharts) }));
  return {
    rows,
    options: medicationCharts.map((chart) => ({
      id: String(chart._id),
      medicineName: chart.medicineName || chart.genericName || 'Medication',
      dosage: chart.dosage || '',
      route: chart.route || '',
      status: chart.status || '',
      pharmacyRequestNumber: chart.pharmacyRequest?.pharmacyRequestNumber || '',
      pharmacyStatus: chart.pharmacyRequest?.pharmacyStatus || '',
      dispensedFromPharmacy: Boolean(chart.pharmacyRequest?.dispensedFromPharmacy),
      label: [
        chart.medicineName || chart.genericName || 'Medication',
        chart.dosage || '',
        chart.route || '',
        chart.pharmacyRequest?.pharmacyStatus ? `Pharmacy: ${chart.pharmacyRequest.pharmacyStatus}` : ''
      ].filter(Boolean).join(' · ')
    })),
    summary: {
      total: rows.length,
      linked: rows.filter((row) => row.linkStatus === 'LINKED').length,
      unlinked: rows.filter((row) => row.linkStatus === 'UNLINKED').length,
      ambiguous: rows.filter((row) => row.linkStatus === 'AMBIGUOUS').length,
      dispensed: rows.filter((row) => row.linkStatus === 'LINKED' && row.dispensedFromPharmacy).length
    }
  };
}

async function attachMedicationChartLinks({ hospitalId, admissionId, record, recordType }) {
  if (!record) return { changed: false, trace: { rows: [], summary: { total: 0, linked: 0, unlinked: 0, ambiguous: 0, dispensed: 0 } } };
  const charts = await loadAdmissionMedicationCharts({ hospitalId, admissionId });
  const list = recordType === 'anesthesia' ? record.events : record.medications;
  let changed = false;
  for (const row of list || []) {
    if (row.ipdMedicationChartId) continue;
    const resolution = resolveChart(row, charts);
    if (resolution.status === 'LINKED' && resolution.chart?._id) {
      row.ipdMedicationChartId = resolution.chart._id;
      row.pharmacyLinkMatchedBy = resolution.matchedBy;
      changed = true;
    }
  }
  if (changed) await record.save();
  const trace = recordType === 'anesthesia'
    ? await buildOTMedicationTrace({ hospitalId, admissionId, anesthesia: record, recovery: null, charts })
    : await buildOTMedicationTrace({ hospitalId, admissionId, anesthesia: null, recovery: record, charts });
  return { changed, trace };
}

module.exports = {
  normalizeMedicationName,
  normalizeOTMedicationPayload,
  loadAdmissionMedicationCharts,
  resolveChart,
  buildOTMedicationTrace,
  attachMedicationChartLinks
};
