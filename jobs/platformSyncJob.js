const SupportTicketOutbox = require('../models/SupportTicketOutbox');
const { refreshLicense, getSnapshot } = require('../services/licenseSnapshot.service');
const { _sendOutbox } = require('../controllers/supportTicket.controller');

let timer;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const { snapshot } = await getSnapshot();
    if (snapshot?.nextCheckAt && new Date(snapshot.nextCheckAt).getTime() <= Date.now()) {
      await refreshLicense().catch((error) => console.warn('Daily license refresh failed:', error.message));
    }

    const rows = await SupportTicketOutbox.find({ status: 'PENDING', nextRetryAt: { $lte: new Date() } })
      .sort({ nextRetryAt: 1 })
      .limit(Number(process.env.SUPPORT_OUTBOX_BATCH_SIZE || 10));
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await _sendOutbox(row).catch(() => {});
    }
  } catch (error) {
    console.error('Platform sync job failed:', error);
  } finally {
    running = false;
  }
}

function startPlatformSyncJob() {
  if (timer) return;
  timer = setInterval(tick, Number(process.env.PLATFORM_SYNC_POLL_MS || 5 * 60 * 1000));
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
}

function stopPlatformSyncJob() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

module.exports = { startPlatformSyncJob, stopPlatformSyncJob, tick };
