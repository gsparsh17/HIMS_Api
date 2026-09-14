'use strict';

function asTime(value, fallback = Number.NEGATIVE_INFINITY) {
  if (value === null || value === undefined || value === '') return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function selectEffectiveHospitalCharges(rows, effectiveAt = new Date()) {
  const target = new Date(effectiveAt).getTime();
  if (!Number.isFinite(target)) return null;

  const eligible = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.is_active !== false)
    .filter((row) => asTime(row.effectiveFrom) <= target)
    .sort((a, b) => {
      const byEffective = asTime(b.effectiveFrom) - asTime(a.effectiveFrom);
      if (byEffective) return byEffective;
      return asTime(b.createdAt) - asTime(a.createdAt);
    });

  return eligible[0] || null;
}

function recurringFallbackRates(rows, effectiveAt = new Date()) {
  const row = selectEffectiveHospitalCharges(rows, effectiveAt);
  return {
    nursing: Number(row?.ipdCharges?.nursingCharges || 0),
    rmo: Number(row?.ipdCharges?.rmoDutyDoctorCharges || 0),
    masterId: row?._id || null,
    effectiveFrom: row?.effectiveFrom || null
  };
}

module.exports = {
  selectEffectiveHospitalCharges,
  recurringFallbackRates
};
