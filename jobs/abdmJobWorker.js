const AbdmJob = require('../models/AbdmJob');
const { processAbdmJob, markJobFailed } = require('../services/abdmCallbackProcessor.service');

let timer = null;
let running = false;

function retentionDate() {
  const days = Math.max(1, Number(process.env.ABDM_JOB_RETENTION_DAYS || 30));
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function recoverStaleJobs() {
  const staleMs = Math.max(60_000, Number(process.env.ABDM_JOB_STALE_LOCK_MS || 10 * 60 * 1000));
  const staleBefore = new Date(Date.now() - staleMs);
  const result = await AbdmJob.updateMany(
    { status: 'RUNNING', lockedAt: { $lt: staleBefore } },
    {
      $set: {
        status: 'PENDING',
        runAfter: new Date(),
        lockedAt: null,
        lastError: { message: 'Recovered stale ABDM worker lock', at: new Date() }
      }
    }
  );
  return result.modifiedCount || 0;
}

async function claimJob() {
  return AbdmJob.findOneAndUpdate(
    { status: 'PENDING', runAfter: { $lte: new Date() } },
    { status: 'RUNNING', lockedAt: new Date() },
    { sort: { runAfter: 1, createdAt: 1 }, new: true }
  );
}

async function processOne(job) {
  try {
    await processAbdmJob(job);
    await AbdmJob.findByIdAndUpdate(job._id, {
      status: 'COMPLETED',
      payload: undefined,
      lockedAt: null,
      purgeAt: retentionDate()
    });
  } catch (error) {
    console.error('ABDM job failed:', error.message);
    await markJobFailed(job, error);
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await recoverStaleJobs();
    const batchSize = Math.max(1, Math.min(25, Number(process.env.ABDM_JOB_BATCH_SIZE || 5)));
    for (let index = 0; index < batchSize; index += 1) {
      // Claim sequentially to keep MongoDB locking simple; process jobs concurrently after claiming.
      // eslint-disable-next-line no-await-in-loop
      const job = await claimJob();
      if (!job) break;
      // eslint-disable-next-line no-await-in-loop
      await processOne(job);
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

module.exports = { startAbdmJobWorker, tick, recoverStaleJobs };
