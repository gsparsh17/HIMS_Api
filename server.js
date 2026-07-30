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
      abdmConfig.assertCryptoConfiguration();
      abdmConfig.assertProfileConfiguration();
      abdmConfig.assertPacketConfiguration();
      abdmConfig.assertTrustedInternalServices();
      if (abdmConfig.requireConsentValidation) {
        if (!abdmConfig.consentValidatorUrl) {
          throw new Error('ABDM_CONSENT_VALIDATOR_URL is required for production M2/M3');
        }
        let consentValidatorUrl;
        try {
          consentValidatorUrl = new URL(abdmConfig.consentValidatorUrl);
        } catch (_error) {
          throw new Error('ABDM_CONSENT_VALIDATOR_URL must be a valid URL');
        }
        if (!/\/v1\/validate\/?$/i.test(consentValidatorUrl.pathname)) {
          throw new Error('ABDM_CONSENT_VALIDATOR_URL must use the versioned /v1/validate endpoint');
        }
        const consentToken = process.env.ABDM_CONSENT_VALIDATOR_TOKEN || abdmConfig.internalServiceAuthToken;
        if (!consentToken || String(consentToken).length < 32) {
          throw new Error('A strong consent-validator service token is required for production M2/M3');
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
      const { startCalendarJob } = require('./jobs/calendarJob');
      startCalendarJob();
    }
    if (abdmConfig.isHospital && (abdmConfig.featureM2 || abdmConfig.featureM3)) {
      const { startAbdmHospitalJobWorker } = require('./jobs/abdmHospitalJobWorker');
      startAbdmHospitalJobWorker();
    }

    if (abdmConfig.isHospital) {
      const { startMISScheduleJob } = require('./jobs/misScheduleJob');
      startMISScheduleJob();
    }

    const shutdown = (signal) => {
      console.log(`\n${signal} received. Closing HTTP server...`);
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
