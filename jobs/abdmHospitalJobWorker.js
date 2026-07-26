const AbdmHospitalJob = require('../models/AbdmHospitalJob');
const { processJob } = require('../services/abdmHospitalJob.service');
const { configuredHospitalId } = require('../services/hospitalIdentity.service');

let timer;
let running = false;

async function recoverStaleJobs() {
  const hospitalId = await configuredHospitalId();
  const staleBefore = new Date(
    Date.now() - Number(process.env.ABDM_HOSPITAL_JOB_STALE_MS || 10 * 60 * 1000)
  );
  await AbdmHospitalJob.updateMany(
    { hospitalId, status: 'RUNNING', lockedAt: { $lt: staleBefore } },
    { $set: { status: 'PENDING', runAfter: new Date(), lockedAt: null } }
  );
}

async function claimJob() {
  const hospitalId = await configuredHospitalId();
  return AbdmHospitalJob.findOneAndUpdate(
    { hospitalId, status: 'PENDING', runAfter: { $lte: new Date() } },
    { $set: { status: 'RUNNING', lockedAt: new Date() } },
    {
      sort: { runAfter: 1, createdAt: 1 },
      new: true
    }
  ).select('+payload');
}

async function failJob(job, error) {
  const attempts = Number(job.attempts || 0) + 1;
  const dead = attempts >= Number(job.maxAttempts || 5);
  await AbdmHospitalJob.findByIdAndUpdate(job._id, {
    status: dead ? 'DEAD' : 'PENDING',
    attempts,
    runAfter: new Date(
      Date.now() + Math.min(30 * 60 * 1000, 30000 * 2 ** attempts)
    ),
    lockedAt: null,
    lastError: { message: error.message, details: error.details, at: new Date() }
  });
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await recoverStaleJobs();
    const batch = Math.max(
      1,
      Math.min(20, Number(process.env.ABDM_HOSPITAL_JOB_BATCH_SIZE || 3))
    );
    for (let index = 0; index < batch; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const job = await claimJob();
      if (!job) break;
      try {
        // eslint-disable-next-line no-await-in-loop
        await processJob(job);
        // eslint-disable-next-line no-await-in-loop
        await AbdmHospitalJob.findByIdAndUpdate(job._id, {
          status: 'COMPLETED',
          payload: undefined,
          completedAt: new Date(),
          lockedAt: null,
          purgeAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await failJob(job, error);
      }
    }
  } catch (error) {
    console.error('Hospital ABDM worker error:', error.message);
  } finally {
    running = false;
  }
}

function startAbdmHospitalJobWorker() {
  if (timer) return;
  const interval = Number(process.env.ABDM_HOSPITAL_JOB_POLL_INTERVAL_MS || 1000);
  timer = setInterval(tick, interval);
  timer.unref?.();
  console.log(`✅ Hospital ABDM job worker started (${interval}ms)`);
}

module.exports = { startAbdmHospitalJobWorker, tick, recoverStaleJobs };
