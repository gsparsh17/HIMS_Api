const FinanceFeatureFlag = require('../models/FinanceFeatureFlag');

const DEFAULTS = Object.freeze({
  financeCanonicalKpis: false,
  canonicalIpdChargePosting: false,
  ipdSelectedChargeBillNow: false,
  deskModule: false,
  appointmentIdempotency: false,
  opdSettlementPreview: false,
  sourceBillingStateSync: false,
  disableLegacyIpdDirectBilling: false
});

async function getFlags(hospitalId) {
  const rows = await FinanceFeatureFlag.find({ hospitalId }).lean();
  return rows.reduce((result, row) => ({ ...result, [row.key]: Boolean(row.enabled) }), { ...DEFAULTS });
}

async function isEnabled(hospitalId, key) {
  if (!hospitalId || !Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return false;
  const row = await FinanceFeatureFlag.findOne({ hospitalId, key }).select('enabled').lean();
  return row ? Boolean(row.enabled) : DEFAULTS[key];
}

async function updateFlags(hospitalId, changes, userId) {
  const operations = Object.entries(changes || {})
    .filter(([key, value]) => Object.prototype.hasOwnProperty.call(DEFAULTS, key) && typeof value === 'boolean')
    .map(([key, enabled]) => ({
      updateOne: {
        filter: { hospitalId, key },
        update: {
          $set: {
            enabled,
            updatedBy: userId,
            ...(enabled ? { enabledAt: new Date(), enabledBy: userId } : {})
          },
          $setOnInsert: { hospitalId, key }
        },
        upsert: true
      }
    }));
  if (operations.length) await FinanceFeatureFlag.bulkWrite(operations);
  return getFlags(hospitalId);
}

module.exports = { DEFAULTS, getFlags, isEnabled, updateFlags };
