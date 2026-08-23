const cron = require('node-cron');
const nodemailer = require('nodemailer');
const MISSchedule = require('../models/MISSchedule');
const MISExportJob = require('../models/MISExportJob');
const { processExportJob, nextScheduleRun } = require('../controllers/mis.controller');
const { authorizeDelegatedJob, authorizationSnapshot } = require('../services/delegatedJobAuthorization.service');

function mailTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function runDueSchedules() {
  const due = await MISSchedule.find({ isActive: true, nextRunAt: { $lte: new Date() } }).limit(50);
  for (const schedule of due) {
    try {
      const currentUser = await authorizeDelegatedJob({
        userId: schedule.createdBy,
        hospitalId: schedule.hospitalId,
        moduleKey: 'reports',
        minimumAccess: 'view',
        action: 'mis_export'
      });
      const job = await MISExportJob.create({
        hospitalId: schedule.hospitalId,
        requestedBy: schedule.createdBy,
        reportKey: schedule.reportKey,
        filters: schedule.filters || {},
        format: schedule.format,
        requestedAt: new Date(),
        authorizationSnapshot: authorizationSnapshot(currentUser, { moduleKey: 'reports', action: 'mis_export' })
      });
      await processExportJob(job);
      schedule.lastRunAt = new Date();
      schedule.lastStatus = job.status;
      schedule.lastExportJobId = job._id;
      schedule.nextRunAt = nextScheduleRun(schedule, new Date());
      await schedule.save();

      const transport = mailTransport();
      if (transport && job.status === 'Completed' && schedule.recipients?.length) {
        await transport.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: schedule.recipients.join(','),
          subject: `${schedule.name} - ${job.filename}`,
          text: `Scheduled HIMS MIS report generated at ${job.completedAt?.toISOString()}. SHA-256: ${job.checksum}`,
          attachments: [{ filename: job.filename, content: job.output, contentType: job.mimeType }]
        });
      }
    } catch (error) {
      schedule.lastRunAt = new Date();
      if (error.code === 'AUTHORIZATION_REVOKED') {
        schedule.lastStatus = 'AUTHORIZATION_REVOKED';
        schedule.authorizationRevokedAt = new Date();
        schedule.authorizationError = String(error.message || error).slice(0, 1000);
        schedule.isActive = false;
      } else {
        schedule.lastStatus = `Failed: ${error.message}`;
      }
      schedule.nextRunAt = nextScheduleRun(schedule, new Date());
      await schedule.save().catch(() => null);
    }
  }
}

function startMISScheduleJob() {
  cron.schedule('* * * * *', () => runDueSchedules().catch((error) => console.error('MIS schedule job failed:', error)));
  console.log('✅ MIS scheduled report worker started');
}

module.exports = { startMISScheduleJob, runDueSchedules };
