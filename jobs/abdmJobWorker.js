const AbdmJob = require('../models/AbdmJob');
const { processAbdmJob, markJobFailed } = require('../services/abdmCallbackProcessor.service');

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const job = await AbdmJob.findOneAndUpdate(
      { status: 'PENDING', runAfter: { $lte: new Date() } },
      { status: 'RUNNING', lockedAt: new Date() },
      { sort: { runAfter: 1, createdAt: 1 }, new: true }
    );
    if (!job) return;

    try {
      await processAbdmJob(job);
      await AbdmJob.findByIdAndUpdate(job._id, {
        status: 'COMPLETED',
        payload: undefined,
        lockedAt: null
      });
    } catch (error) {
      console.error('ABDM job failed:', error.message);
      await markJobFailed(job, error);
    }
  } catch (error) {
    console.error('ABDM worker error:', error.message);
  } finally {
    running = false;
  }
}

function startAbdmJobWorker() {
  if (timer) return;
  const intervalMs = Number(process.env.ABDM_JOB_POLL_INTERVAL_MS || 1000);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`✅ ABDM job worker started (${intervalMs}ms poll interval)`);
}

module.exports = { startAbdmJobWorker, tick };
