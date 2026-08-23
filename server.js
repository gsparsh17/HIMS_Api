const dotenv = require('dotenv');
dotenv.config();

const connectDB = require('./config/db');
const abdmConfig = require('./config/abdm.config');
const { assertRuntimeConfig } = require('./config/runtime.config');
assertRuntimeConfig();
const app = require('./app');

function validateProductionConfiguration() {
  // if (process.env.NODE_ENV !== 'production') return;
  const corsOrigins = String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '').trim();

  // if (jwtSecret.length < 32) {
  //   throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production');
  // }
  if (!corsOrigins) {
    throw new Error('CORS_ORIGINS or FRONTEND_URL must be configured in production');
  }
}

const startServer = async () => {
  try {
    validateProductionConfiguration();
    if (abdmConfig.isProduction && (abdmConfig.featureM2 || abdmConfig.featureM3)) {
      abdmConfig.assertHospitalConnector();
      abdmConfig.assertEncryptionKey();
      abdmConfig.assertSharedServiceConfiguration();
      abdmConfig.assertProfileConfiguration();
      abdmConfig.assertPacketConfiguration();
      if (abdmConfig.consentProvider === 'local' && abdmConfig.requireConsentValidation) {
        const consentToken = process.env.ABDM_CONSENT_VALIDATOR_TOKEN || abdmConfig.internalServiceAuthToken;
        if (!consentToken || String(consentToken).length < 32) {
          throw new Error('A strong local consent-validator service token is required for production M2/M3');
        }
      }
    }
    await connectDB();
    console.log('✅ MongoDB Connected');

    const PORT = process.env.PORT || (abdmConfig.isMaster && !abdmConfig.isHospital ? 5004 : 5000);
    const HOST = process.env.HOST || '127.0.0.1';
    const server = app.listen(PORT, HOST, () => {
      console.log(`🚀 ${abdmConfig.appRole} server listening on ${HOST}:${PORT}`);
    });

    // Conservative HTTP timeouts reduce exposure to slow-request attacks.
    server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
    server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 65000);
    server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 5000);

    if (abdmConfig.isHospital) {
      const { startPlatformSyncJob } = require('./jobs/platformSyncJob');
      startPlatformSyncJob();

      const { startCalendarJob } = require('./jobs/calendarJob');
      startCalendarJob();
    }
    if (abdmConfig.isHospital && (abdmConfig.featureM2 || abdmConfig.featureM3)) {
      const { startAbdmHospitalJobWorker } = require('./jobs/abdmHospitalJobWorker');
      startAbdmHospitalJobWorker();
      const { startAbdmOperationReconciliationJob } = require('./jobs/abdmOperationReconciliationJob');
      startAbdmOperationReconciliationJob();
    }

    if (abdmConfig.isHospital) {
      const { startMISScheduleJob } = require('./jobs/misScheduleJob');
      startMISScheduleJob();
    }

    if (abdmConfig.isHospital) {
      const { startNabhJobs } = require('./jobs/nabhJob');
      startNabhJobs();
    }

    if (abdmConfig.isHospital) {
      const { startIPDRecurringChargeJob } = require('./jobs/ipdRecurringChargeJob');
      startIPDRecurringChargeJob();
    }

    const shutdown = (signal) => {
      console.log(`\n${signal} received. Closing HTTP server...`);
      if (abdmConfig.isHospital) {
        try { require('./jobs/platformSyncJob').stopPlatformSyncJob(); } catch (_) {}
      }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
