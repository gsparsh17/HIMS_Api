'use strict';

const cron = require('node-cron');
const { processDueNotifications } = require('../services/nabhNotification.service');
const { archiveDueRecords } = require('../controllers/nabh.controller');

let started = false;

function startNabhJobs() {
  if (started || String(process.env.DISABLE_NABH_JOBS || 'false').toLowerCase() === 'true') {
    return;
  }
  started = true;

  cron.schedule('*/5 * * * *', async () => {
    try {
      await processDueNotifications({ limit: 100 });
    } catch (error) {
      console.error('[NABH] Notification retry job failed:', error.message);
    }
  });

  cron.schedule('30 2 * * *', async () => {
    try {
      const archived = await archiveDueRecords();
      if (archived) console.info(`[NABH] Archived ${archived} compliance record(s)`);
    } catch (error) {
      console.error('[NABH] Archive job failed:', error.message);
    }
  });
}

module.exports = { startNabhJobs };
