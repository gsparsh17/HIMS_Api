'use strict';

// Current diagnostic workflows use reportFinalisation.isFinal as the
// authoritative release marker. Status-only fallbacks are retained only for
// legacy records that pre-date reportFinalisation; an explicit false marker
// must never be overridden by a status such as Verified/Completed/Amended.
const LEGACY_FINAL_LAB_STATUSES = new Set(['Reported', 'Released']);
const LEGACY_FINAL_RADIOLOGY_STATUSES = new Set(['Reported']);

function hasExplicitFinalisationState(row) {
  return row?.reportFinalisation && row.reportFinalisation.isFinal !== undefined;
}

function isFinalDiagnosticRequest(row, kind) {
  if (hasExplicitFinalisationState(row)) {
    return row.reportFinalisation.isFinal === true;
  }

  const status = String(row?.status || '');
  return kind === 'LAB'
    ? LEGACY_FINAL_LAB_STATUSES.has(status)
    : LEGACY_FINAL_RADIOLOGY_STATUSES.has(status);
}

function isFinalLabRequest(row) {
  return isFinalDiagnosticRequest(row, 'LAB');
}

function isFinalRadiologyRequest(row) {
  return isFinalDiagnosticRequest(row, 'RADIOLOGY');
}

module.exports = {
  isFinalDiagnosticRequest,
  isFinalLabRequest,
  isFinalRadiologyRequest,
};
