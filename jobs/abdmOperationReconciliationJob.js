const cron = require('node-cron');
const AbdmOperationLedger = require('../models/AbdmOperationLedger');

async function flagStaleOperations() {
  const staleBefore = new Date(Date.now() - Number(process.env.ABDM_OPERATION_STALE_MINUTES || 10) * 60 * 1000);
  const rows = await AbdmOperationLedger.find({
    status: { $in: ['SENT', 'EXTERNAL_ACCEPTED', 'UNKNOWN'] },
    updatedAt: { $lte: staleBefore }
  }).limit(100);
  for (const row of rows) {
    const staleStatus = row.status;
    row.status = 'RECONCILIATION_REQUIRED';
    row.reconciliation = {
      ...(row.reconciliation?.toObject?.() || row.reconciliation || {}),
      requiredAt: row.reconciliation?.requiredAt || new Date(),
      reason: row.reconciliation?.reason || `Operation remained ${staleStatus} beyond reconciliation SLA`
    };
    await row.save().catch(() => {});
  }
}

function startAbdmOperationReconciliationJob() {
  if (String(process.env.ABDM_RECONCILIATION_WORKER_ENABLED || 'true').toLowerCase() !== 'true') {
    console.warn('⚠️ ABDM operation reconciliation scanner is disabled');
    return;
  }
  cron.schedule('*/5 * * * *', () => flagStaleOperations().catch((error) => console.error('ABDM operation reconciliation scan failed:', error.message)));
  console.log('✅ ABDM operation reconciliation scanner started');
}

module.exports = { flagStaleOperations, startAbdmOperationReconciliationJob };
